// k6 稳态读混合压测
//
// 场景: constant-arrival-rate, 默认按 30 req/s 持续 3 分钟. 到达速率是固定的,
//       所以这里测的是该负载下的延迟与错误率, 不是系统上限; README 不要写成最大吞吐.
//       只打读接口, 数据量固定, 3 分钟内不会因写入持续增长而改变口径.
//
// 环境变量:
//   BASE_URL  默认 http://127.0.0.1:8081/api; docker 内运行用 http://backend:8081/api
//   RATE      默认 30, 每秒迭代数 (Number 转换)
//   DURATION  默认 3m, 如 30s / 3m
//   PRE_VUS   默认 30, 同时作为 preAllocatedVUs (Number 转换); maxVUs 固定 100
//
// 请求组合与权重 (计划表格):
//   home 1, doctors 2, doctors/9001/schedules 2, notices 1, pet 1, appointment/page 1
//   pet 与 appointment/page 需要 setup() 登录返回的 Bearer token.
//
// 口径:
//   http_req_failed 只看 HTTP 层; 本项目的业务失败在 HTTP 层仍是 200.
//   响应不是 JSON、解析失败、body.code !== 200 或 HTTP 非 200 都计入 business_error,
//   不静默忽略. dropped_iterations 不为 0 说明目标速率没打满, 本次数字不能按目标速率解读.
//
// 用法 (由 run-steady.sh 调用):
//   k6 run --summary-export=summary-steady.json -e BASE_URL=... api-mix.js

import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:8081/api').replace(/\/+$/, '');
const RATE = Number(__ENV.RATE || 30);
const DURATION = __ENV.DURATION || '3m';
const PRE_VUS = Number(__ENV.PRE_VUS || 30);

if (!Number.isFinite(RATE) || RATE <= 0) {
  throw new Error(`invalid RATE "${__ENV.RATE}", expected a positive number`);
}
if (!Number.isFinite(PRE_VUS) || PRE_VUS <= 0) {
  throw new Error(`invalid PRE_VUS "${__ENV.PRE_VUS}", expected a positive number`);
}

const businessError = new Counter('business_error');

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: 100,
    },
  },
  thresholds: {
    // 引用这个子指标才能让 summary-export 生成它; README 的 QPS 直接取它的 rate
    'http_reqs{phase:steady}': ['count>0'],
    'http_req_failed{phase:steady}': ['rate<0.01'],
    business_error: ['count==0'],
    'http_req_duration{phase:steady}': ['p(95)<1000'],
    dropped_iterations: ['count==0'],
  },
};

// 权重直接写在条目上, 选择时按累计权重随机; 改比例只改 weight, 不用维护重复数组
const ENDPOINTS = [
  { name: 'home', weight: 1, path: '/client/catalog/home', auth: false },
  {
    name: 'doctors',
    weight: 2,
    path: '/client/catalog/doctors?pageNum=1&pageSize=10',
    auth: false,
  },
  {
    name: 'schedules',
    weight: 2,
    path: '/client/catalog/doctors/9001/schedules',
    auth: false,
  },
  {
    name: 'notices',
    weight: 1,
    path: '/client/catalog/notices?pageNum=1&pageSize=10',
    auth: false,
  },
  { name: 'pet', weight: 1, path: '/client/pet', auth: true },
  {
    name: 'appointment',
    weight: 1,
    path: '/client/appointment/page?pageNum=1&pageSize=10',
    auth: true,
  },
];

const TOTAL_WEIGHT = ENDPOINTS.reduce((sum, ep) => sum + ep.weight, 0);

function pickEndpoint() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const ep of ENDPOINTS) {
    roll -= ep.weight;
    if (roll < 0) {
      return ep;
    }
  }
  return ENDPOINTS[ENDPOINTS.length - 1];
}

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
  const ep = pickEndpoint();
  const headers = {};
  if (ep.auth) {
    headers.Authorization = `Bearer ${data.token}`;
  }

  const res = http.get(`${BASE_URL}${ep.path}`, {
    headers,
    tags: { phase: 'steady', endpoint: ep.name },
  });

  const body = parseJson(res);
  if (res.status !== 200 || !body || body.code !== 200) {
    const businessCode = body ? body.code : undefined;
    businessError.add(1, { phase: 'steady', endpoint: ep.name });
    console.warn(
      `business error endpoint=${ep.name}: HTTP ${res.status}, code=${businessCode}, `
        + `body=${String(res.body).slice(0, 200)}`,
    );
  }
}