// node tools/business_rules_check.mjs [--config=<runtime.json>]
// 配置也可用 PETQA_CONFIG 指定；未给时取当前目录 runtime.json。
// 运行前用 business_qa.py snapshot 备份，结束后用 restore 恢复。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'

const argv = process.argv.slice(2)
const configFlag = argv.findIndex(a => a === '--config')
const argConfig = argv.find(a => a.startsWith('--config='))?.slice('--config='.length)
  ?? (configFlag >= 0 ? argv[configFlag + 1] : null)
const configPath = resolve(argConfig ?? process.env.PETQA_CONFIG ?? 'runtime.json')
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
assert.match(cfg.db, /^yuzhua_test_[a-f0-9]{8}$/)
assert.equal(cfg.api, 'http://127.0.0.1:8082/api')
const sql = query => execFileSync('mysql', ['--defaults-extra-file=' + cfg.mysqlDefaultsFile,
  '-BN', '--default-character-set=utf8mb4', '-e', query], { encoding: 'utf8' }).trim()
assert.equal(sql('SELECT DATABASE(),@@port'), cfg.db + '\t3307')
const grants = sql('SHOW GRANTS').split(/\r?\n/)
assert.equal(grants.length, 2)
assert.ok(grants[0].includes('GRANT USAGE ON *.*'))
assert.ok(grants[1].includes('ON `' + cfg.db + '`.*'))

// 实例校验必须在任何写入之前：库里有连接不等于 8082 就是被测实例
const instance = spawnSync(process.env.PYTHON ?? 'python',
  [fileURLToPath(new URL('./qa_env.py', import.meta.url)), 'instance', '--config', configPath],
  { encoding: 'utf8' })
if (instance.status !== 0) {
  throw new Error(`实例校验未通过，拒绝写入：${(instance.stderr || instance.stdout).trim()}`)
}
console.log((instance.stdout || '').trim())
// department.code 上有唯一索引，而本脚本结尾刻意保留了"删除被拦截"的科室。
// 用固定编码重复跑会撞上一轮的残留（400 科室编码已存在），故编码带运行后缀。
const RUN = Date.now().toString(36).slice(-6)
const secret = readFileSync(resolve(dirname(configPath), 'jwt-secret.txt'), 'utf8')
const actors = JSON.parse(readFileSync(resolve(dirname(configPath), 'actors.json'), 'utf8'))

// 参与方契约：三套脚本共用的键与字段。缺键时在这里就报清楚，
// 不要等到某个断言里出现 undefined.id 才发现 actors.json 是旧格式。
for (const key of ['admin', 'doctor01', 'doctor02', 'zhangsan']) {
  const actor = actors[key]
  assert.ok(actor, `actors.json 缺少 ${key}，请重新执行 python tools/qa_env.py prepare`)
  for (const field of ['id', 'typ', 'role', 'name', 'side', 'username']) {
    assert.ok(actor[field] !== undefined && actor[field] !== null, `actors.json 的 ${key} 缺少 ${field}`)
  }
  assert.equal(actor.side, actor.typ === 'ADMIN' ? 'admin' : 'client', `${key} 的 side 与 typ 不一致`)
  const table = actor.typ === 'ADMIN' ? 'admin_user' : 'sys_user'
  const version = sql(`SELECT token_version FROM ${table} WHERE id=${actor.id} AND deleted=0`)
  assert.ok(version, `${key} 在库中不存在`)
  // 以库为准：acceptance 改密会递增版本，actors.json 里的是 prepare 时的旧值
  actor.tokenVersion = Number(version)
}

// 优先用真实登录换取令牌；签发只作为"需要自定义有效期"时的退路
const liveTokens = new Map()
async function login(who) {
  const actor = actors[who]
  const response = await fetch(`${cfg.api}/${actor.side}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: actor.username, password: '123456' })
  })
  const result = await response.json()
  assert.equal(result.code, 200, `${who} 真实登录失败：${result.msg}`)
  liveTokens.set(who, result.data.token)
  return result.data.token
}
for (const who of Object.keys(actors)) await login(who)

const token = who => {
  const live = liveTokens.get(who)
  if (live) return live
  const a = actors[who], now = Math.floor(Date.now() / 1000)
  const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url')
  const body = b64({ alg: 'HS512' }) + '.' + b64({ sub: String(a.id), typ: a.typ, role: a.role,
    doctorId: a.doctorId, name: a.name, ver: a.tokenVersion, iat: now, exp: now + 1800 })
  return body + '.' + createHmac('sha512', secret).update(body).digest('base64url')
}
async function request(who, method, path, data, expected = 200) {
  const response = await fetch(cfg.api + path, { method, headers: {
    Authorization: 'Bearer ' + token(who), 'Content-Type': 'application/json'
  }, body: data === undefined ? undefined : JSON.stringify(data) })
  const result = await response.json()
  assert.equal(result.code, expected, `${method} ${path}: ${JSON.stringify(result)}`)
  return result.data
}
const get = (who, path) => request(who, 'GET', path)
const ok = label => console.log('PASS', label)
const sockets = []
async function room(who, id) {
  const ws = new WebSocket(`ws://127.0.0.1:8082/api/ws/consult?token=${token(who)}&sessionId=${id}`)
  sockets.push(ws)
  const frames = [], waiters = []
  ws.onmessage = e => {
    const frame = JSON.parse(e.data)
    frames.push(frame)
    for (const wake of [...waiters]) wake()
  }
  const take = (type, matches = () => true) => new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error(`No ${type} for ${who}`)) }, 7000)
    function clean() { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1) }
    function check() {
      const i = frames.findIndex(f => f.type === type && matches(f))
      if (i >= 0) { clean(); resolveFrame(frames.splice(i, 1)[0]) }
    }
    waiters.push(check); check()
  })
  await take('HISTORY')
  return { ws, take, send: payload => ws.send(JSON.stringify({ sessionId: id, ...payload })) }
}

try {
  const dep = await request('admin', 'POST', '/admin/department', { name: '规则回归内科', code: `rc1_${RUN}` })
  const dep2 = await request('admin', 'POST', '/admin/department', { name: '规则回归外科', code: `rc2_${RUN}` })
  let doctor = await get('admin', '/admin/doctor/1')
  doctor.departmentId = dep.id
  doctor.consultationFee = 30
  doctor.status = 1
  await request('admin', 'PUT', '/admin/doctor/1', doctor)
  for (const fee of [-1, 10000, 1.001]) {
    await request('admin', 'POST', '/admin/doctor', { ...doctor, consultationFee: fee }, 400)
    await request('admin', 'PUT', '/admin/doctor/1', { ...doctor, consultationFee: fee }, 400)
  }
  ok('04 医生费用新增和编辑范围、小数位')
  const pet = await request('zhangsan', 'POST', '/client/pet', { name: '规则回归宠物', species: '猫',
    birthday: '2020-01-01', weight: 3 })
  await request('zhangsan', 'PUT', `/client/pet/${pet.id}`, { name: pet.name, species: '猫', birthday: null, weight: null, ageMonth: 12 })
  let saved = (await get('zhangsan', '/client/pet')).find(p => p.id === pet.id)
  assert.equal(saved.birthday ?? null, null); assert.equal(saved.weight ?? null, null); assert.equal(saved.ageMonth, 12)
  await request('admin', 'PUT', `/admin/pet/${pet.id}`, { name: pet.name, species: '猫', ageMonth: 15 })
  saved = (await get('zhangsan', '/client/pet')).find(p => p.id === pet.id)
  assert.equal(saved.ageMonth, 15)
  await request('admin', 'PUT', `/admin/pet/${pet.id}`, { name: pet.name, species: '猫', ageMonth: -1 }, 400)
  sql(`UPDATE pet SET birthday=DATE_SUB(CURDATE(), INTERVAL 25 MONTH), age_month=1 WHERE id=${pet.id}`)
  saved = (await get('zhangsan', '/client/pet')).find(p => p.id === pet.id)
  assert.equal(saved.ageMonth, 25)
  ok('06/10 宠物日期体重清空、手填月龄、读取生日实时推算')
  // 排班也有唯一约束（医生 + 日期 + 时段），固定日期重复跑会撞上残留，挑一个空闲日期。
  const takenDates = new Set(sql("SELECT work_date FROM doctor_schedule WHERE doctor_id=1 "
    + "AND work_date BETWEEN '2099-11-01' AND '2099-11-30'").split(/\r?\n/).filter(Boolean))
  const workDate = Array.from({ length: 30 },
    (_, i) => `2099-11-${String(i + 1).padStart(2, '0')}`).find(d => !takenDates.has(d))
  assert.ok(workDate, '2099-11 的排班已被占满，请清理测试排班后重跑')
  const schedule = await request('admin', 'POST', '/admin/schedule', { doctorId: 1, workDate,
    period: 1, startTime: '09:00:00', endTime: '11:00:00', totalNum: 20, status: 1 })
  sql('UPDATE doctor SET consultation_fee=-1 WHERE id=1')
  await request('zhangsan', 'POST', '/client/appointment', { petId: pet.id, doctorId: 1, scheduleId: schedule.id, symptom: '检查' }, 400)
  sql('UPDATE doctor SET consultation_fee=30 WHERE id=1')
  const order = await request('zhangsan', 'POST', '/client/appointment', { petId: pet.id, doctorId: 1, scheduleId: schedule.id, symptom: '检查' })
  await request('zhangsan', 'POST', `/client/appointment/${order.id}/pay`)
  await request('doctor01', 'POST', `/admin/appointment/${order.id}/accept`)
  const record = await request('doctor01', 'POST', `/admin/record/appointment/${order.id}`, { diagnosis: '复查', nextVisitDate: '2099-12-01' })
  await request('doctor01', 'POST', `/admin/record/appointment/${order.id}`, { diagnosis: '复查更新' })
  assert.equal((await get('doctor01', `/admin/record/${record.id}`)).nextVisitDate, '2099-12-01')
  await request('doctor01', 'POST', `/admin/record/appointment/${order.id}`, { diagnosis: '复查更新', nextVisitDate: null })
  assert.equal((await get('doctor01', `/admin/record/${record.id}`)).nextVisitDate ?? null, null)
  ok('06 病历省略日期保留、显式 null 清空')
  const count = Number(sql('SELECT appointment_count FROM doctor WHERE id=1'))
  await request('doctor01', 'POST', `/admin/appointment/${order.id}/finish`)
  assert.equal(Number(sql('SELECT appointment_count FROM doctor WHERE id=1')), count + 1)
  await request('zhangsan', 'POST', '/client/review', { appointmentId: order.id, rating: 4, content: ' ' }, 400)
  await request('zhangsan', 'POST', '/client/review', { appointmentId: order.id, rating: 5 })
  assert.equal(Number(sql('SELECT appointment_count FROM doctor WHERE id=1')), count + 1)
  ok('12/16 完成即计接诊量、评价不改接诊量、低分说明校验')
  doctor.departmentId = dep2.id
  await request('admin', 'PUT', '/admin/doctor/1', doctor)
  assert.equal((await get('zhangsan', `/client/appointment/${order.id}`)).departmentName, dep.name)
  assert.equal((await get('zhangsan', `/client/record/${record.id}`)).departmentName, dep.name)
  const records = await get('doctor01', '/admin/record/page?pageSize=100')
  assert.equal(records.records.find(r => r.id === record.id).departmentName, dep.name)
  await request('admin', 'DELETE', `/admin/department/${dep.id}`, undefined, 400)
  await request('admin', 'DELETE', '/admin/doctor/1', undefined, 400)
  ok('01/05 关联医生科室删除拦截、转科后历史预约病历归属保留')
  const phone = sql('SELECT phone FROM sys_user WHERE id=1')
  await request('lisi', 'PUT', '/client/auth/profile', { phone }, 400)
  // 迁移只管历史结构：最新建表脚本已包含 active_phone 与唯一索引，重复执行 ADD COLUMN 会报 1060。
  // 先看 information_schema 决定是"执行迁移"还是"直接验证唯一约束"；半套结构不能猜，直接报差异退出。
  const probeColumn = sql(`SELECT COLUMN_TYPE, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'active_phone'`)
  const probeIndexRows = sql(`SELECT NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND INDEX_NAME = 'uk_active_phone'
    ORDER BY SEQ_IN_INDEX`).split(/\r?\n/).filter(Boolean)
  const hasColumn = probeColumn !== ''
  const hasIndex = probeIndexRows.length > 0
  if (!hasColumn && !hasIndex) {
    sql(readFileSync(new URL('../sql/migrations/20261016_unique_active_phone.sql', import.meta.url), 'utf8'))
    console.log('PASS 迁移前结构：已执行 active_phone 迁移')
  } else if (hasColumn && hasIndex) {
    console.log('PASS 当前结构：active_phone 已存在，跳过迁移')
  } else {
    const missing = [!hasColumn && '缺少列 sys_user.active_phone', !hasIndex && '缺少唯一索引 uk_active_phone']
      .filter(Boolean).join('；')
    console.error('STRUCTURE ERROR: ' + missing)
    process.exit(1)
  }
  // 两条路径都核对列定义与索引定义。MySQL 会把表达式重写成带反引号、字符集前导、转义反斜杠
  // 和额外括号的形式，这里统一大小写、反引号、反斜杠、空白与括号后再比较语义。
  // 迁移路径必须重新查询：分支前读到的是迁移前的空结构。
  const columnRow = sql(`SELECT COLUMN_TYPE, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'active_phone'`)
  const indexRows = sql(`SELECT NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND INDEX_NAME = 'uk_active_phone'
    ORDER BY SEQ_IN_INDEX`).split(/\r?\n/).filter(Boolean)
  const normalizeExpr = s => String(s).toLowerCase()
    .replace(/_utf8mb4/g, '')
    .replace(/\\/g, '')
    .replace(/`/g, '')
    .replace(/[\s()]/g, '')
  const [columnType, extra, generation] = columnRow.split('\t')
  const structure = []
  if (columnType.toLowerCase() !== 'varchar(20)') structure.push(`列类型为 ${columnType}，期望 varchar(20)`)
  if (!/stored generated/i.test(extra)) structure.push(`列 EXTRA 为 ${extra}，期望 STORED GENERATED`)
  if (normalizeExpr(generation) !== normalizeExpr("IF(deleted = 0, NULLIF(TRIM(phone), ''), NULL)")) {
    structure.push(`生成表达式为 ${generation}，与迁移定义不一致`)
  }
  if (indexRows.length !== 1) {
    structure.push(`索引 uk_active_phone 有 ${indexRows.length} 列，期望仅 active_phone`)
  } else {
    const [nonUnique, indexColumn] = indexRows[0].split('\t')
    if (nonUnique !== '0') structure.push('索引 uk_active_phone 不是唯一索引')
    if (indexColumn !== 'active_phone') structure.push(`索引列为 ${indexColumn}，期望 active_phone`)
  }
  if (structure.length) {
    console.error('STRUCTURE ERROR: ' + structure.join('；'))
    process.exit(1)
  }
  assert.throws(() => sql(`UPDATE sys_user SET phone='${phone}' WHERE id=2`), /Duplicate entry/)
  ok('11 修改资料去重与数据库唯一约束')
  for (const status of [-1, 3]) await request('admin', 'POST', '/admin/notice', { title: '校验', content: '正文', status }, 400)
  const notice = await request('admin', 'POST', '/admin/notice', { title: '草稿', status: 0 })
  await request('admin', 'PUT', `/admin/notice/${notice.id}/status?status=1`, undefined, 400)
  await request('admin', 'PUT', `/admin/notice/${notice.id}`, { title: '校验', status: 3 }, 400)
  await request('admin', 'PUT', `/admin/notice/${notice.id}`, { title: '校验', content: '正文', status: 1 })
  ok('15 公告新增、编辑和快捷发布共用校验')
  // 真实服务断扫后的取消/接诊入口：直接布置昨天待接诊已支付的预约。
  for (const action of ['cancel', 'accept']) {
    sql(`UPDATE appointment SET status=0,pay_status=1,appointment_date=DATE_SUB(CURDATE(),INTERVAL 1 DAY) WHERE id=${order.id}`)
    const remain = sql(`SELECT remain_num FROM doctor_schedule WHERE id=${schedule.id}`)
    await request(action === 'cancel' ? 'zhangsan' : 'doctor01', 'POST',
      `/${action === 'cancel' ? 'client' : 'admin'}/appointment/${order.id}/${action}`, undefined, 400)
    assert.equal(sql(`SELECT status,pay_status FROM appointment WHERE id=${order.id}`), '4\t1')
    assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${schedule.id}`), remain)
  }
  ok('03 逾期取消与接诊拒绝并提交未到诊，付款及号源保持')
  // 205 条有消息旧会话 + 无消息新会话。
  const values = Array.from({ length: 205 }, () => `(1,1,${pet.id},'旧会话',2,0,0,0,'2001-01-01 00:00:00')`).join(',')
  sql(`INSERT INTO consult_session(user_id,doctor_id,pet_id,symptom,status,user_unread,doctor_unread,moderate_status,last_message_time) VALUES ${values}`)
  // 取全局最旧的那条：排序是 last_message_time DESC, id DESC，重复运行后上一轮的批次
  // 有更小的 id，只按本次 pet_id 取 MIN 就不会落在最后一页上。
  const oldId = Number(sql("SELECT MIN(id) FROM consult_session "
    + "WHERE user_id=1 AND doctor_id=1 AND symptom='旧会话'"))
  const session = await request('zhangsan', 'POST', '/client/consult/sessions', { petId: pet.id, doctorId: 1, symptom: '规则回归' })
  for (const who of ['zhangsan', 'doctor01']) {
    const side = actors[who].side
    const page = await get(who, `/${side}/consult/sessions?pageSize=20`)
    assert.equal(page.records[0].id, session.id)
    const last = await get(who, `/${side}/consult/sessions?pageSize=20&pageNum=${page.pages}`)
    assert.ok(last.records.some(s => s.id === oldId))
    assert.equal((await get(who, `/${side}/consult/sessions/${oldId}`)).id, oldId)
    assert.ok((await get(who, `/${side}/consult/sessions?status=0`)).records.every(s => s.status === 0))
  }
  await request('lisi', 'GET', `/client/consult/sessions/${session.id}`, undefined, 403)
  await request('doctor02', 'GET', `/admin/consult/sessions/${session.id}`, undefined, 403)
  ok('02 超200会话分页、创建时间排序、旧详情及参与方校验')
  const dr = await room('doctor01', session.id)
  const user = await room('zhangsan', session.id)
  assert.equal((await user.take('PRESENCE')).doctorOnline, true)
  ok('20 后进入的主人收到医生在房状态')
  doctor.status = 0
  await request('admin', 'PUT', '/admin/doctor/1', doctor)
  assert.equal(sql('SELECT online_status FROM doctor WHERE id=1'), '0')
  await request('admin', 'PUT', '/admin/doctor/1/status?status=1')
  assert.equal(sql('SELECT online_status FROM doctor WHERE id=1'), '1')
  await request('admin', 'PUT', '/admin/doctor/1/status?status=0')
  assert.equal(sql('SELECT online_status FROM doctor WHERE id=1'), '0')
  await request('admin', 'PUT', '/admin/doctor/1/status?status=1')
  ok('13 编辑和快捷停诊清除在线，恢复按现有连接更新')
  dr.send({ type: 'CHAT', msgType: 'SUGGEST', content: '到院复查', requestId: 'check-1' })
  const ack = await dr.take('ACK', f => f.requestId === 'check-1')
  assert.equal(sql(`SELECT COUNT(*) FROM consult_message WHERE id=${ack.message.id}`), '1')
  await request('admin', 'PUT', `/admin/consult/message/${ack.message.id}/hidden?hidden=1&reason=check`)
  assert.equal((await user.take('MESSAGE_VISIBILITY')).hidden, 1)
  assert.equal((await dr.take('MESSAGE_VISIBILITY')).hidden, 1)
  assert.ok(!(await get('zhangsan', `/client/consult/${session.id}/messages`)).records.some(m => m.id === ack.message.id))
  await request('admin', 'PUT', `/admin/consult/message/${ack.message.id}/hidden?hidden=0`)
  assert.equal((await user.take('MESSAGE_VISIBILITY')).message.id, ack.message.id)
  await request('zhangsan', 'POST', `/client/consult/${session.id}/close`)
  dr.send({ type: 'CHAT', msgType: 'SUGGEST', content: '应保留的附言', requestId: 'check-2' })
  assert.equal((await dr.take('ERROR', f => f.requestId === 'check-2')).msg, '问诊已结束，会话已关闭')
  assert.equal(sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${session.id} AND content='应保留的附言'`), '0')
  await request('admin', 'PUT', `/admin/consult/${session.id}/moderate?moderateStatus=2&reason=check`)
  assert.equal((await user.take('MODERATION')).moderateStatus, 2)
  assert.equal((await dr.take('MODERATION')).moderateStatus, 2)
  await request('zhangsan', 'GET', `/client/consult/sessions/${session.id}`, undefined, 404)
  ok('07/08 屏蔽恢复与处置广播、保存回执、关闭后发送拒绝')
  sql(`INSERT INTO consult_message(session_id,sender_id,sender_role,msg_type,content,is_read,hidden) VALUES ${Array.from({ length: 105 }, () => `(${session.id},1,'USER','TEXT','历史',1,0)`).join(',')}`)
  const first = await get('admin', `/admin/consult/${session.id}/messages?pageSize=100`)
  const earlier = await get('admin', `/admin/consult/${session.id}/messages?pageSize=100&beforeId=${first.records.at(-1).id}`)
  assert.ok(earlier.records.length > 0)
  await request('admin', 'PUT', `/admin/consult/message/${earlier.records.at(-1).id}/hidden?hidden=1&reason=check`)
  ok('09 超100消息游标查阅与屏蔽')
  console.log('BUSINESS RULES INTEGRATION PASSED')
} finally {
  for (const ws of sockets) ws.close()
}
