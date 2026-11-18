// node tools/schedule_status_check.mjs --config <isolated runtime.json>
//
// H1 回归：排班状态下沉为"只在 /stop 与 /resume 写入"。
//
// 断言三段：
//   1. /stop 之后库里的 status = 0
//   2. 用编辑接口提交一份"停诊之前"的表单（请求体故意带 status=1）→ status 仍为 0，
//      而同一请求里的 total_num 必须真的写进去（证明不是整条请求被忽略）
//   3. /resume 之后 status = 1
//
// 只动本次新建的一条排班；结束时物理删除。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const configFlag = process.argv.indexOf('--config')
assert.ok(configFlag >= 0 && process.argv[configFlag + 1], '需要 --config <runtime.json>')
const configPath = resolve(process.argv[configFlag + 1])
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
execFileSync(process.env.PYTHON || 'python', ['tools/qa_env.py', 'instance', '--config', configPath],
  { stdio: 'inherit' })
assert.match(cfg.db, /^yuzhua_test_[a-f0-9]{8}$/, '只允许在隔离测试库运行')
assert.equal(cfg.api, 'http://127.0.0.1:8082/api', '后端地址必须是隔离实例 8082')
const sql = q => execFileSync('mysql',
  ['--defaults-extra-file=' + cfg.mysqlDefaultsFile, '-BN', '--default-character-set=utf8mb4', '-e', q],
  { encoding: 'utf8' }).trim()

async function login(who) {
  const response = await fetch(`${cfg.api}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: '123456' })
  })
  const json = await response.json()
  assert.equal(json.code, 200, `${who} 登录失败：${json.msg}`)
  return json.data.token
}

const token = await login('admin')
const call = async (method, path, body, expected = 200) => {
  const response = await fetch(cfg.api + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  const json = await response.json()
  assert.equal(json.code, expected, `${method} ${path}: ${json.msg}`)
  return json.data
}

/** 挑一个还没排过班的未来日期，避免撞 uk_doctor_date_period */
function freeDate() {
  for (let i = 1; i <= 400; i++) {
    const day = new Date(Date.UTC(2097, 0, i)).toISOString().slice(0, 10)
    if (sql(`SELECT COUNT(*) FROM doctor_schedule WHERE doctor_id=1 AND work_date='${day}' AND period=1`) === '0') {
      return day
    }
  }
  throw new Error('找不到空闲日期')
}

const rowOf = id => {
  const [status, totalNum] = sql(`SELECT status, total_num FROM doctor_schedule WHERE id=${id}`).split('\t')
  return { status: Number(status), totalNum: Number(totalNum) }
}

const failures = []
let scheduleId = null
try {
  const workDate = freeDate()
  const created = await call('POST', '/admin/schedule',
    { doctorId: 1, workDate, period: 1, startTime: '09:00:00', endTime: '11:00:00', totalNum: 10, status: 1 })
  scheduleId = created.id
  assert.deepEqual(rowOf(scheduleId), { status: 1, totalNum: 10 }, '新建应出诊、总量 10')

  await call('PUT', `/admin/schedule/${scheduleId}/stop`)
  assert.equal(rowOf(scheduleId).status, 0, '/stop 之后 status 应为 0')
  console.log('PASS 1 /stop 后 status=0')

  // 核心断言：陈旧表单把 status 一起提交，不得覆盖停诊；但容量要照常生效
  await call('PUT', `/admin/schedule/${scheduleId}`, {
    doctorId: 1, workDate, period: 1, startTime: '09:00:00', endTime: '11:00:00',
    totalNum: 24, status: 1
  })
  const afterStale = rowOf(scheduleId)
  assert.equal(afterStale.status, 0,
    `陈旧表单不得撤销停诊，实际 status=${afterStale.status}`)
  assert.equal(afterStale.totalNum, 24,
    `同一请求的号源数应照常写入，实际 total_num=${afterStale.totalNum}`)
  console.log('PASS 2 陈旧表单带 status=1 保存后 status 仍为 0，total_num 更新为 24')

  await call('PUT', `/admin/schedule/${scheduleId}/resume`)
  assert.equal(rowOf(scheduleId).status, 1, '/resume 之后 status 应为 1')
  console.log('PASS 3 /resume 后 status=1')
} catch (error) {
  failures.push(error.message)
  console.error('FAIL', error.message)
} finally {
  if (scheduleId) {
    try {
      sql(`DELETE FROM doctor_schedule WHERE id=${scheduleId}`)
    } catch (error) {
      console.error('CLEANUP_FAILED', error.message)
    }
  }
}

if (failures.length) {
  console.error(`SCHEDULE STATUS CHECK FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('SCHEDULE STATUS CHECK PASSED')
