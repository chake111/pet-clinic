// node tools/dashboard_query_check.mjs --config <isolated runtime.json>
//
// H3 回归：看板今日五格来自一次条件聚合，且按就诊日期取数命中索引。
//
// 断言三段：
//   1. 旧口径（4×COUNT + 1×SUM）与新口径（1 条条件聚合）五项逐一相同，
//      全院与两种医生口径都验。注意：这两段 SQL 都是**脚本内复刻**的写法，
//      验证的是"合并前后口径等价"这一点，不覆盖生产 mapper 的 SQL 漂移；
//      生产 SQL 由第 3 节（接口返回 vs 直接查库）兜住。
//   2. EXPLAIN 命中 idx_visit_date，不是 type=ALL；医生视角命中 idx_doctor_date
//   3. 接口返回的五个数字等于直接查库的结果
//
// 不验的：单次 HTTP 请求发了几条 SELECT。受限测试账号读不到 performance_schema，
// 用独立 mysql 连接数 Com_select 也数不到后端进程的语句。那个数字是一次性手工测量的，
// 记在 docs/技术亮点改造记录 里，这里不冒充回归。
//
// 冻结"今天"：脚本开头取一次 CURDATE() 写进 SQL 常量，避免跨零点时
// legacy() 与 combined() 落在不同的日期上造成偶发失败。
//
// 不改数据，只读。
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

/**
 * 冻结"今天"。脚本里所有需要"今日"的 SQL 都用这个常量，不用 CURDATE()：
 * legacy() 与 combined() 原本各自求值一次 CURDATE()，跨零点运行时两者会落在
 * 不同的日期上，等价性断言随机失败。
 */
const TODAY = sql('SELECT CURDATE()')

const failures = []
function check(name, action) {
  try {
    action()
    console.log('PASS', name)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.error('FAIL', name, error.message)
  }
}

// ---------------------------------------------------------------- 1. 口径等价

/**
 * 旧写法：五条独立语句。
 *
 * 这是脚本内复刻，不读生产 mapper —— 它证明的是"合并前后口径等价"这一个命题。
 * 生产 SQL 是否漂移由第 3 节（接口返回 vs 直接查库）覆盖。
 */
function legacy(doctorId) {
  const filter = doctorId === null ? '1=1' : `doctor_id = ${doctorId}`
  return sql(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM appointment WHERE deleted=0 AND appointment_date='${TODAY}' AND ${filter}), '/',
      (SELECT COUNT(*) FROM appointment WHERE deleted=0 AND status=0 AND appointment_date='${TODAY}' AND ${filter}), '/',
      (SELECT COUNT(*) FROM appointment WHERE deleted=0 AND status=1 AND appointment_date='${TODAY}' AND ${filter}), '/',
      (SELECT COUNT(*) FROM appointment WHERE deleted=0 AND status=2 AND appointment_date='${TODAY}' AND ${filter}), '/',
      (SELECT IFNULL(SUM(amount),0) FROM appointment WHERE deleted=0 AND pay_status=1 AND appointment_date='${TODAY}' AND ${filter})
    )`)
}

/**
 * 新写法：一条条件聚合，语句形状与 AppointmentMapper#todayCard 一致。
 *
 * 同样是脚本内复刻；"生产 mapper 的这条 SQL 是否还等价"由第 3 节兜住。
 */
function combined(doctorId) {
  const filter = doctorId === null ? '1=1' : `doctor_id = ${doctorId}`
  return sql(`
    SELECT CONCAT(
      COUNT(*), '/',
      IFNULL(SUM(status = 0), 0), '/',
      IFNULL(SUM(status = 1), 0), '/',
      IFNULL(SUM(status = 2), 0), '/',
      IFNULL(SUM(CASE WHEN pay_status = 1 THEN amount ELSE 0 END), 0)
    )
    FROM appointment WHERE deleted=0 AND appointment_date='${TODAY}' AND ${filter}`)
}

for (const [label, doctorId] of [['全院', null], ['医生 1', 1], ['医生 2', 2]]) {
  check(`${label}口径：旧 5 条与新 1 条结果一致`, () => {
    const a = legacy(doctorId)
    const b = combined(doctorId)
    assert.equal(a, b, `${label}：旧=${a} 新=${b}`)
  })
}

// ---------------------------------------------------------------- 2. 索引命中

function explainRow(query) {
  const line = sql(`EXPLAIN ${query}`).split(/\r?\n/)[0]
  const cols = line.split('\t')
  // 列序：id select_type table partitions type possible_keys key key_len ref rows filtered Extra
  return { type: cols[4], key: cols[6], rows: Number(cols[9]) }
}

const todayCardSql = `
  SELECT COUNT(*) AS orders,
         IFNULL(SUM(status = 0), 0) AS pending,
         IFNULL(SUM(status = 1), 0) AS accepted,
         IFNULL(SUM(status = 2), 0) AS finished,
         IFNULL(SUM(CASE WHEN pay_status = 1 THEN amount ELSE 0 END), 0) AS income
  FROM appointment WHERE deleted = 0 AND appointment_date = '${TODAY}'`

check('今日五格命中 idx_visit_date（不再是全表扫）', () => {
  const plan = explainRow(todayCardSql)
  assert.notEqual(plan.type, 'ALL', `仍是全表扫：${JSON.stringify(plan)}`)
  assert.equal(plan.key, 'idx_visit_date', `走的不是 idx_visit_date：${JSON.stringify(plan)}`)
})

check('医生视角走 idx_doctor_date（新索引未取代组合索引）', () => {
  const withDoctor = todayCardSql.replace(
    `appointment_date = '${TODAY}'`, `appointment_date = '${TODAY}' AND doctor_id = 1`)
  const plan = explainRow(withDoctor)
  assert.equal(plan.key, 'idx_doctor_date', `期望 idx_doctor_date，实际 ${JSON.stringify(plan)}`)
})

// 单次 HTTP 请求发了几条 SELECT 这件事，本脚本不验：受限测试账号读不到
// performance_schema（events_statements_summary_by_digest 被拒），而用独立 mysql 连接
// 数 Com_select 只能数到脚本自己的语句，数不到后端进程的。那条数字来自一次性的手工测量，
// 记在 docs/技术亮点改造记录 里并标注了测量方式，不在此处冒充回归。

// ---------------------------------------------------------------- 3. 接口与库一致

async function login(side, who) {
  const response = await fetch(`${cfg.api}/${side}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: '123456' })
  })
  const json = await response.json()
  assert.equal(json.code, 200, `${who} 登录失败：${json.msg}`)
  return json.data.token
}

const adminToken = await login('admin', 'admin')
const doctorToken = await login('admin', 'doctor01')

async function dashboard(token) {
  const response = await fetch(`${cfg.api}/admin/stats/dashboard?days=14`, {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(15000)
  })
  const json = await response.json()
  assert.equal(json.code, 200, `看板接口失败：${json.msg}`)
  return json.data
}

const fieldNames = ['orders', 'pending', 'accepted', 'finished', 'income']

for (const [label, token, doctorId] of [['管理员', adminToken, null], ['医生', doctorToken, 1]]) {
  try {
    const vo = await dashboard(token)
    const expected = combined(doctorId).split('/').map(Number)
    const actual = [vo.todayOrders, vo.todayPending, vo.todayAccepted, vo.todayFinished, Number(vo.todayIncome)]
    assert.deepEqual(actual, expected,
      `${label}看板的今日五格与直接查库不一致：接口=${JSON.stringify(actual)} 库=${JSON.stringify(expected)}`)
    console.log('PASS', `${label}看板今日五格与库内一致`, JSON.stringify(Object.fromEntries(
      fieldNames.map((name, i) => [name, actual[i]]))))
  } catch (error) {
    failures.push(`${label}看板: ${error.message}`)
    console.error('FAIL', `${label}看板`, error.message)
  }
}

if (failures.length) {
  console.error(`DASHBOARD QUERY CHECK FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('DASHBOARD QUERY CHECK PASSED')
