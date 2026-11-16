// k6 压测脚本: 同排班并发下单
//
// 两个场景通过 SCENARIO 选择:
//   race     schedule 9001, 100 个号 / 100 VU, 期望全部成功
//   oversell schedule 9002, 20 个号 / 100 VU, 期望 20 成功 + 80 "号源已约满"
//
// 业务失败与鉴权失败在 HTTP 层仍是 200, 真实结果看响应体 code:
//   code=200 -> 成功
//   code=400 且 msg 含 "号源已约满" -> 正常拒绝
//   其他 (400 数据已存在 / 500 / HTTP 非 200) -> unexpected, 必须为 0
//
// 环境变量:
//   BASE_URL  默认 http://127.0.0.1:8081/api
//   SCENARIO  默认 race, 可选 race / oversell

import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:8081/api').replace(/\/+$/, '');
const SCENARIO = __ENV.SCENARIO || 'race';

const SCENARIOS = {
  race: { scheduleId: 9001, expectedSuccess: 100, expectedRejected: 0 },
  oversell: { scheduleId: 9002, expectedSuccess: 20, expectedRejected: 80 },
};

const cfg = SCENARIOS[SCENARIO];
if (!cfg) {
  throw new Error(`unknown SCENARIO "${SCENARIO}", expected race or oversell`);
}

const bookingSuccess = new Counter('booking_success');
const bookingRejected = new Counter('booking_rejected');
const bookingUnexpected = new Counter('booking_unexpected');

const scenarios = {};
scenarios[SCENARIO] = {
  executor: 'per-vu-iterations',
  vus: 100,
  iterations: 1,
  maxDuration: '60s',
};

export const options = {
  scenarios,
  thresholds: {
    [`booking_success{scenario:${SCENARIO}}`]: [`count==${cfg.expectedSuccess}`],
    [`booking_rejected{scenario:${SCENARIO}}`]: [`count==${cfg.expectedRejected}`],
    [`booking_unexpected{scenario:${SCENARIO}}`]: ['count==0'],
    'http_req_duration{phase:booking}': ['p(95)<1000'],
  },
};

function parseJson(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

export function setup() {
  const res = http.post(
    `${BASE_URL}/client/auth/login`,
    JSON.stringify({ username: 'itload', password: '123456' }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { phase: 'setup' },
    },
  );

  const body = parseJson(res);
  if (res.status !== 200 || !body || body.code !== 200 || !body.data || !body.data.token) {
    throw new Error(
      `login failed: HTTP ${res.status}, body=${String(res.body).slice(0, 300)}`,
    );
  }
  return { token: body.data.token };
}

export default function (data) {
  const payload = JSON.stringify({
    petId: 90000 + __VU,
    doctorId: 9001,
    scheduleId: cfg.scheduleId,
    symptom: 'k6 load test',
  });

  const res = http.post(`${BASE_URL}/client/appointment`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.token}`,
    },
    tags: { phase: 'booking' },
  });

  const body = parseJson(res);
  const code = body ? body.code : undefined;
  const msg = body && body.msg != null ? String(body.msg) : '';
  const tags = { scenario: SCENARIO };

  if (res.status === 200 && code === 200) {
    bookingSuccess.add(1, tags);
  } else if (res.status === 200 && code === 400 && msg.includes('号源已约满')) {
    bookingRejected.add(1, tags);
  } else {
    bookingUnexpected.add(1, tags);
    console.warn(
      `unexpected booking response VU=${__VU}: HTTP ${res.status}, code=${code}, msg=${msg}`,
    );
  }
}