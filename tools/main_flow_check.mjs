// node tools/main_flow_check.mjs --config <isolated runtime.json>
// Fixtures stay in the dedicated test database for inspection. Each run selects unused dates.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const configPath = resolve(process.argv[process.argv.indexOf('--config') + 1])
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
execFileSync(process.env.PYTHON || 'python', ['tools/qa_env.py', 'instance', '--config', configPath], { stdio: 'inherit' })
assert.match(cfg.db, /^pet_clinic_test_[a-f0-9]{8}$/)
assert.equal(cfg.api, 'http://127.0.0.1:8082/api')
const sql = q => execFileSync('mysql', ['--defaults-extra-file=' + cfg.mysqlDefaultsFile, '-BN', '--default-character-set=utf8mb4', '-e', q], { encoding: 'utf8' }).trim()
const tokens = {}, results = []
async function call(who, method, path, body, expected = 200) {
  const response = await fetch(cfg.api + path, { method, headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: 'Bearer ' + tokens[who] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const r = await response.json()
  if (expected !== null) assert.equal(r.code, expected, `${method} ${path}: ${r.msg}`)
  return expected === null ? r : r.data
}
async function check(id, action) {
  try { await action(); results.push({ id, status: 'PASS' }); console.log('PASS', id) }
  catch (e) { results.push({ id, status: 'FAIL', detail: e.message }); console.error('FAIL', id, e.stack) }
}
for (const who of ['admin', 'doctor01', 'doctor02', 'zhangsan', 'lisi']) {
  const side = ['zhangsan', 'lisi'].includes(who) ? 'client' : 'admin'
  tokens[who] = (await call(who, 'POST', `/${side}/auth/login`, { username: who, password: '123456' })).token
}
const pet = who => call(who, 'POST', '/client/pet', { name: '主流程测试', species: '猫' })
let dateIndex = 0
async function schedule(totalNum = 10) {
  let workDate
  do { workDate = new Date(Date.UTC(2098, 0, ++dateIndex)).toISOString().slice(0, 10) }
  while (sql(`SELECT COUNT(*) FROM doctor_schedule WHERE doctor_id=1 AND work_date='${workDate}' AND period=1`) !== '0')
  return call('admin', 'POST', '/admin/schedule', { doctorId: 1, workDate, period: 1, startTime: '09:00:00', endTime: '11:00:00', totalNum, status: 1 })
}
const book = (p, s, expected = 200, who = 'zhangsan') => call(who, 'POST', '/client/appointment', { petId: p.id, doctorId: 1, scheduleId: s.id, symptom: '食欲下降两天' }, expected)
const remain = s => Number(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${s.id}`))
const detail = id => call('zhangsan', 'GET', `/client/appointment/${id}`)
let p, s, a
await check('M01', async () => {
  p = await pet('zhangsan'); s = await schedule();
  await call('zhangsan', 'GET', '/client/catalog/doctors/1')
  await call('zhangsan', 'GET', '/client/catalog/doctors/1/schedules')
  a = await book(p, s)
  assert.equal(remain(s), 9); assert.ok(a.payDeadline); assert.equal(a.petId, p.id)
})
await check('M02', async () => { await book(p, s, 400); assert.equal(remain(s), 9) })
await check('M03', async () => {
  await call('doctor01', 'POST', `/admin/appointment/${a.id}/accept`, undefined, 400)
  for (let i = 0; i < 2; i++) assert.equal((await call('zhangsan', 'POST', `/client/appointment/${a.id}/pay`)).payStatus, 1)
  assert.equal(remain(s), 9)
})
await check('M04', async () => {
  for (const [method, suffix] of [['GET', ''], ['POST', '/pay'], ['POST', '/cancel']]) await call('lisi', method, `/client/appointment/${a.id}${suffix}`, undefined, 404)
  for (const who of ['doctor02', 'admin']) await call(who, 'POST', `/admin/appointment/${a.id}/accept`, undefined, 403)
  assert.equal((await detail(a.id)).status, 0)
})
await check('M05', async () => {
  await call('doctor01', 'POST', `/admin/appointment/${a.id}/accept`)
  assert.equal((await detail(a.id)).status, 1)
  await call('zhangsan', 'POST', `/client/appointment/${a.id}/cancel`, undefined, 400)
  await call('doctor01', 'POST', `/admin/record/appointment/${a.id}`, { diagnosis: '测试诊断', advice: '测试建议' })
  await call('doctor01', 'POST', `/admin/appointment/${a.id}/finish`)
  assert.equal((await detail(a.id)).status, 2)
  assert.equal((await call('zhangsan', 'GET', `/client/appointment/${a.id}/record`)).diagnosis, '测试诊断')
  await call('zhangsan', 'POST', '/client/review', { appointmentId: a.id, rating: 5, content: '测试评价' })
  assert.equal((await detail(a.id)).isReviewed, 1)
})
await check('M06', async () => {
  await call('zhangsan', 'POST', '/client/review', { appointmentId: a.id, rating: 5 }, 400)
  await call('doctor01', 'POST', `/admin/appointment/${a.id}/accept`, undefined, 400)
})
await check('M07', async () => {
  for (const paid of [false, true]) {
    const x = await book(await pet('zhangsan'), s), before = remain(s)
    if (paid) await call('zhangsan', 'POST', `/client/appointment/${x.id}/pay`)
    await call('zhangsan', 'POST', `/client/appointment/${x.id}/cancel`)
    await call('zhangsan', 'POST', `/client/appointment/${x.id}/cancel`, undefined, 400)
    assert.equal(remain(s), before + 1)
    const d = await detail(x.id); assert.equal(d.status, 3); assert.equal(d.payStatus, paid ? 2 : 0)
  }
})
await check('M08', async () => {
  const one = await schedule(1), pets = [await pet('zhangsan'), await pet('zhangsan')]
  const responses = await Promise.all(pets.map(x => book(x, one, null)))
  assert.equal(responses.filter(x => x.code === 200).length, 1); assert.equal(remain(one), 0)
  assert.ok(responses.every(x => [200, 400].includes(x.code)))
  const many = await schedule(5), same = await pet('zhangsan')
  const duplicate = await Promise.all(Array.from({ length: 8 }, () => book(same, many, null)))
  assert.equal(duplicate.filter(x => x.code === 200).length, 1); assert.equal(remain(many), 4)
  assert.ok(duplicate.every(x => [200, 400].includes(x.code)))
})
await check('M09', async () => {
  const x = await book(await pet('zhangsan'), s), before = remain(s)
  sql(`UPDATE appointment SET create_time=DATE_SUB(NOW(),INTERVAL 31 MINUTE) WHERE id=${x.id}`)
  await call('zhangsan', 'POST', `/client/appointment/${x.id}/pay`, undefined, 400)
  const deadline = Date.now() + 75000
  while ((await detail(x.id)).status !== 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 1000))
  assert.equal((await detail(x.id)).status, 3); assert.equal(remain(s), before + 1)
})
await check('M10', async () => {
  for (const action of ['accept', 'cancel']) {
    const x = await book(await pet('zhangsan'), s)
    await call('zhangsan', 'POST', `/client/appointment/${x.id}/pay`)
    sql(`UPDATE appointment SET appointment_date=DATE_SUB(CURDATE(),INTERVAL 1 DAY) WHERE id=${x.id}`)
    const before = remain(s)
    await call(action === 'accept' ? 'doctor01' : 'zhangsan', 'POST', `/${action === 'accept' ? 'admin' : 'client'}/appointment/${x.id}/${action}`, undefined, 400)
    const d = await detail(x.id); assert.equal(d.status, 4); assert.equal(d.payStatus, 1); assert.equal(remain(s), before)
  }
})
let session
await check('C01', async () => {
  const count = sql('SELECT COUNT(*) FROM appointment'), before = remain(s)
  session = await call('zhangsan', 'POST', '/client/consult/sessions', { petId: p.id, doctorId: 1, symptom: '免费咨询' })
  await call('doctor01', 'POST', `/admin/consult/${session.id}/accept`)
  assert.equal((await call('zhangsan', 'GET', `/client/consult/sessions/${session.id}`)).status, 1)
  assert.equal(sql('SELECT COUNT(*) FROM appointment'), count); assert.equal(remain(s), before)
})
await check('C03-close', async () => {
  await call('zhangsan', 'POST', `/client/consult/${session.id}/close`, undefined, 400)
  await call('doctor01', 'POST', `/admin/consult/${session.id}/close`, { summary: '建议观察，必要时到院检查' })
  assert.equal((await call('zhangsan', 'GET', `/client/consult/sessions/${session.id}`)).status, 2)
  await call('zhangsan', 'GET', `/client/consult/${session.id}/messages`)
})
console.log(JSON.stringify({ results, passed: results.filter(x => x.status === 'PASS').length, failed: results.filter(x => x.status === 'FAIL').length }))
process.exitCode = results.some(x => x.status === 'FAIL') ? 1 : 0
