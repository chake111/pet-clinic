// node tools/audit_regression.mjs [--config=<runtime.json>]
//
// 首轮审计 F1—F3 的修复后回归入口。运行配置由 tools/qa_env.py init 生成：
//   { "db", "api", "mysqlDefaultsFile" }
// 同目录需有 jwt-secret.txt 与 actors.json（与 business_rules_check.mjs 一致）。
//
// 脚本只操作隔离测试库：启动时校验库名、端口、受限账号授权与后端地址；
// 本轮创建的宠物、会话、消息按精确 ID 在 finally 中删除，并恢复被临时停用的账号状态。
// 日志写入 runtime.json 同目录的 audit-regression.jsonl，不记录令牌与密码。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import http from 'node:http'

const argv = process.argv.slice(2)
const configFlag = argv.findIndex(a => a === '--config')
const argConfig = argv.find(a => a.startsWith('--config='))?.slice('--config='.length)
  ?? (configFlag >= 0 ? argv[configFlag + 1] : null)
const configPath = resolve(argConfig ?? process.env.PETQA_CONFIG ?? 'runtime.json')
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
const root = dirname(configPath)
const logPath = resolve(root, 'audit-regression.jsonl')

// ---------------------------------------------------------------- 环境与工具

assert.match(cfg.db, /^pet_clinic_test_[a-f0-9]{8}$/, '只允许在隔离测试库运行')
assert.equal(cfg.api, 'http://127.0.0.1:8082/api', '后端地址必须是隔离实例 8082')
const mysqlArgs = ['--defaults-extra-file=' + cfg.mysqlDefaultsFile, '-BN', '--default-character-set=utf8mb4']
const rawSql = q => execFileSync('mysql', [...mysqlArgs, '-e', q], { encoding: 'utf8' }).trim()
function guard() {
  assert.equal(rawSql('SELECT DATABASE(),@@port'), cfg.db + '\t3307', '数据库名或端口与隔离配置不一致')
}
function sql(q) {
  guard()
  return rawSql(q)
}

// 实例校验必须在任何写入之前（登录本身也会更新 last_login_time）
const instance = spawnSync(process.env.PYTHON ?? 'python',
  [fileURLToPath(new URL('./qa_env.py', import.meta.url)), 'instance', '--config', configPath],
  { encoding: 'utf8' })
if (instance.status !== 0) {
  throw new Error(`实例校验未通过，拒绝写入：${(instance.stderr || instance.stdout).trim()}`)
}
console.log((instance.stdout || '').trim())
const secret = readFileSync(resolve(root, 'jwt-secret.txt'), 'utf8').trim()
const actors = JSON.parse(readFileSync(resolve(root, 'actors.json'), 'utf8'))

// 参与方契约与版本刷新：见 business_rules_check 同名段落
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
  actor.tokenVersion = Number(version)
}

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

const token = (who, seconds = 1800) => {
  // 默认有效期直接用真实登录的令牌；只有"过期令牌"用例才现签
  const live = liveTokens.get(who)
  if (seconds === 1800 && live) return live
  const a = actors[who]
  const now = Math.floor(Date.now() / 1000)
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = enc({ alg: 'HS512' }) + '.' + enc({
    sub: String(a.id), typ: a.typ, role: a.role, doctorId: a.doctorId, name: a.name,
    ver: a.tokenVersion,
    iat: now, exp: now + seconds
  })
  return body + '.' + createHmac('sha512', secret).update(body).digest('base64url')
}
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
writeFileSync(logPath, '')
function log(label, data = {}) {
  const entry = { time: new Date().toISOString(), label, ...data }
  appendFileSync(logPath, JSON.stringify(entry) + '\n')
  console.log(label, JSON.stringify(data))
}

// 启动检查：库名/端口已由 guard 覆盖，这里再核对受限账号只有目标库权限。
guard()
const grants = sql('SHOW GRANTS').split(/\r?\n/)
assert.equal(grants.length, 2, '账号授权范围异常')
assert.ok(grants[0].includes('GRANT USAGE ON *.*'))
assert.ok(grants[1].includes('ON `' + cfg.db + '`.*'))
log('ENV_OK', { db: cfg.db, api: cfg.api })

async function request(who, method, path, body, expected = 200) {
  guard()
  const response = await fetch(cfg.api + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(who) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  const json = await response.json()
  log('HTTP', { who, method, path, http: response.status, code: json.code })
  assert.equal(json.code, expected, `${method} ${path}: ${JSON.stringify(json)}`)
  return json.data
}
const ok = (who, method, path, body) => request(who, method, path, body, 200)

/** 原始 HTTP 握手，用状态码验证失效账号重连被拒（Node WebSocket 不暴露 401） */
function handshakeStatus(who, sessionId, seconds = 1800) {
  const query = `token=${encodeURIComponent(token(who, seconds))}&sessionId=${sessionId}`
  return new Promise((resolvePromise, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: 8082, path: `/api/ws/consult?${query}`,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64')
      }
    })
    req.on('upgrade', res => { res.socket?.destroy(); resolvePromise(101) })
    req.on('response', res => { res.resume(); resolvePromise(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
}

const BUSINESS_TYPES = new Set(['HISTORY', 'MSG', 'ACK', 'READ', 'PRESENCE', 'SESSION', 'MESSAGE_VISIBILITY', 'MODERATION'])
const sockets = []

/** 建一条真实 WebSocket 连接，等待 READY/HISTORY，并保留带序号的帧用于"零业务帧"断言 */
async function room(who, sessionId, { seconds = 1800, expectHistory = true } = {}) {
  guard()
  assert.ok(sessionId, 'room 缺少 sessionId')
  const url = `ws://127.0.0.1:8082/api/ws/consult?token=${encodeURIComponent(token(who, seconds))}&sessionId=${sessionId}`
  const ws = new WebSocket(url)
  const conn = { who, sessionId, ws, frames: [], closed: false, closeCode: null, closeReason: '', history: null }
  sockets.push(conn)
  const waiters = []
  let seq = 0
  const wake = () => { for (const w of [...waiters]) w() }
  ws.onmessage = e => {
    let frame
    try {
      frame = JSON.parse(e.data)
    } catch {
      return
    }
    frame._seq = ++seq
    conn.frames.push(frame)
    wake()
  }
  ws.onclose = e => {
    conn.closed = true
    conn.closeCode = e.code
    conn.closeReason = e.reason
    wake()
  }
  ws.onerror = () => {}
  const until = (predicate, timeout, label) => new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error(`等待超时：${label}`)) }, timeout)
    function check() {
      if (predicate()) { clean(); resolvePromise() }
    }
    function clean() {
      clearTimeout(timer)
      const i = waiters.indexOf(check)
      if (i >= 0) waiters.splice(i, 1)
    }
    waiters.push(check)
    check()
  })
  conn.until = until
  conn.mark = () => seq
  conn.businessSince = mark => conn.frames.filter(f => f._seq > mark && BUSINESS_TYPES.has(f.type))
  conn.take = async (type, predicate = () => true, timeout = 7000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const i = conn.frames.findIndex(f => f.type === type && predicate(f))
      if (i >= 0) return conn.frames.splice(i, 1)[0]
      await delay(20)
    }
    throw new Error(`等待超时：${who} 未收到 ${type}`)
  }
  conn.send = payload => ws.send(JSON.stringify({ sessionId, ...payload }))
  conn.close = () => { try { ws.close() } catch { /* 已关闭 */ } }
  await until(() => ws.readyState === 1 || conn.closed, 7000, `${who} 建立连接`)
  if (conn.closed) throw new Error(`${who} 连接失败 code=${conn.closeCode}`)
  // take() 会把帧从队列移除；首帧 HISTORY 单独留存，供历史可见性断言直接检查
  if (expectHistory) conn.history = await conn.take('HISTORY')
  return conn
}

/** 窗口内必须没有任何业务帧；最后一条连接应已被服务端关闭 */
async function expectNoBusiness(conn, mark, label, windowMs = 2500) {
  await delay(windowMs)
  const leaked = conn.businessSince(mark)
  assert.equal(leaked.length, 0, `${label}：收到业务帧 ${leaked.map(f => f.type).join(',')}`)
  log('NO_BUSINESS_FRAMES', { label, windowMs, closed: conn.closed })
}

/** 会话行锁夹具：独立 MySQL 连接持有 FOR UPDATE，release 必须幂等且在 finally 调用 */
async function lockSession(sessionId) {
  guard()
  const child = spawn('mysql', [...mysqlArgs, '--unbuffered'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', d => { output += String(d) })
  child.stderr.on('data', d => log('LOCK_STDERR', { message: String(d).trim() }))
  child.stdin.write(`START TRANSACTION; SELECT id FROM consult_session WHERE id=${Number(sessionId)} FOR UPDATE; SELECT 'LOCK_READY';\n`)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !output.includes('LOCK_READY')) await delay(20)
  assert.ok(output.includes('LOCK_READY'), `会话 ${sessionId} 行锁未取得`)
  log('LOCK_ACQUIRED', { sessionId })
  let released = false
  return async () => {
    if (released) return
    released = true
    child.stdin.end('COMMIT;\n')
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      delay(3000)
    ])
    log('LOCK_RELEASED', { sessionId })
  }
}

// 本轮创建的记录，finally 精确清理
const createdPets = []
const createdSessions = []
let originalUserStatus = null
let originalDoctorOnline = null
let historyReview = null
let recordTest = null

async function newSession(label) {
  const pet = await ok('zhangsan', 'POST', '/client/pet', {
    name: `回归-${label}`, species: '猫'
  })
  createdPets.push(pet.id)
  const session = await ok('zhangsan', 'POST', '/client/consult/sessions', {
    petId: pet.id, doctorId: 1, symptom: `审计回归 ${label}`
  })
  createdSessions.push(session.id)
  log('SESSION_CREATED', { label, sessionId: session.id, petId: pet.id })
  return session
}

function sessionState(sessionId) {
  return sql(`SELECT status, moderate_status, summary, COALESCE(last_message,'') FROM consult_session WHERE id=${sessionId}`)
}

/** 会话摘要与未读必须和"最后一条可见消息"一致 */
function assertAggregates(sessionId, label) {
  const [userUnread, doctorUnread, lastMessage] = sql(`SELECT user_unread, doctor_unread, COALESCE(last_message,'') FROM consult_session WHERE id=${sessionId}`).split('\t')
  const [visibleUserUnread, visibleDoctorUnread, visibleLast] = sql(`SELECT
      (SELECT COUNT(*) FROM consult_message WHERE session_id=${sessionId} AND hidden=0 AND is_read=0 AND sender_role='DOCTOR'),
      (SELECT COUNT(*) FROM consult_message WHERE session_id=${sessionId} AND hidden=0 AND is_read=0 AND sender_role='USER'),
      COALESCE((SELECT content FROM consult_message WHERE session_id=${sessionId} AND hidden=0 ORDER BY id DESC LIMIT 1),'')`).split('\t')
  assert.equal(Number(userUnread), Number(visibleUserUnread), `${label}：主人未读数与可见未读消息不一致`)
  assert.equal(Number(doctorUnread), Number(visibleDoctorUnread), `${label}：医生未读数与可见未读消息不一致`)
  assert.equal(lastMessage, visibleLast, `${label}：摘要不是最后一条可见消息`)
  log('AGGREGATES_OK', { label, sessionId, userUnread, doctorUnread, lastMessage })
}

// ---------------------------------------------------------------- F1

async function f1DisabledChat() {
  const session = await newSession('F1-CHAT')
  const user = await room('zhangsan', session.id)
  const doctor = await room('doctor01', session.id)
  await ok('admin', 'PUT', `/admin/user/${actors.zhangsan.id}/status?status=0`)
  const mark = user.mark()
  doctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F1_CHAT', requestId: 'f1-chat' })
  const ack = await doctor.take('ACK', f => f.requestId === 'f1-chat')
  log('F1_CHAT_SENT', { messageId: ack.message.id })
  await expectNoBusiness(user, mark, 'F1 停用账号仍静默：CHAT 广播')
  await user.until(() => user.closed, 3000, 'F1 CHAT 后连接关闭')
  assert.equal(user.closeCode, 1008, '失效账号连接应以 POLICY_VIOLATION 关闭')
  assert.equal(await handshakeStatus('zhangsan', session.id), 401, '停用账号重连应被拒绝')
  await ok('admin', 'PUT', `/admin/user/${actors.zhangsan.id}/status?status=1`)
  log('F1_CHAT_PASS', { sessionId: session.id, closeCode: user.closeCode })
}

async function f1DisabledRestClose() {
  const session = await newSession('F1-CLOSE')
  const user = await room('zhangsan', session.id)
  const doctor = await room('doctor01', session.id)
  await ok('admin', 'PUT', `/admin/user/${actors.zhangsan.id}/status?status=0`)
  const mark = user.mark()
  await ok('doctor01', 'POST', `/admin/consult/${session.id}/close`, { summary: 'AUDIT_F1_CLOSE' })
  await doctor.take('SESSION', f => f.sessionId === session.id && f.status === 2)
  await expectNoBusiness(user, mark, 'F1 停用账号仍静默：REST 结束会话通知')
  await user.until(() => user.closed, 3000, 'F1 结束会话后连接关闭')
  assert.equal(sql(`SELECT status FROM consult_session WHERE id=${session.id}`), '2')
  await ok('admin', 'PUT', `/admin/user/${actors.zhangsan.id}/status?status=1`)
  log('F1_REST_CLOSE_PASS', { sessionId: session.id })
}

async function f1DisabledRestoreMessage() {
  const session = await newSession('F1-RESTORE')
  const doctor = await room('doctor01', session.id)
  doctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F1_RESTORE', requestId: 'f1-restore' })
  const ack = await doctor.take('ACK', f => f.requestId === 'f1-restore')
  const messageId = ack.message.id
  await ok('admin', 'PUT', `/admin/consult/message/${messageId}/hidden?hidden=1&reason=audit`)
  await doctor.take('MESSAGE_VISIBILITY', f => f.messageId === messageId && f.hidden === 1)
  const user = await room('zhangsan', session.id)
  await ok('admin', 'PUT', `/admin/user/${actors.zhangsan.id}/status?status=0`)
  const mark = user.mark()
  await ok('admin', 'PUT', `/admin/consult/message/${messageId}/hidden?hidden=0`)
  await doctor.take('MESSAGE_VISIBILITY', f => f.messageId === messageId && f.hidden === 0)
  await expectNoBusiness(user, mark, 'F1 停用账号仍静默：恢复消息正文')
  await user.until(() => user.closed, 3000, 'F1 恢复消息后连接关闭')
  // 管理员审计视图仍能读到被恢复的消息
  const audit = await ok('admin', 'GET', `/admin/consult/${session.id}/messages?pageSize=100`)
  assert.ok(audit.records.some(m => m.id === messageId && m.content === 'AUDIT_F1_RESTORE'))
  await ok('admin', 'PUT', `/admin/user/${actors.zhangsan.id}/status?status=1`)
  log('F1_RESTORE_PASS', { sessionId: session.id, messageId })
}

async function f1ExpiredToken() {
  const session = await newSession('F1-EXPIRY')
  const user = await room('zhangsan', session.id, { seconds: 2 })
  const doctor = await room('doctor01', session.id)
  await delay(2400)
  const mark = user.mark()
  doctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F1_EXPIRY', requestId: 'f1-expiry' })
  const ack = await doctor.take('ACK', f => f.requestId === 'f1-expiry')
  log('F1_EXPIRY_SENT', { messageId: ack.message.id })
  await expectNoBusiness(user, mark, 'F1 令牌过期仍静默')
  await user.until(() => user.closed, 3000, 'F1 过期后连接关闭')
  log('F1_EXPIRY_PASS', { sessionId: session.id })
}

// ---------------------------------------------------------------- F2

async function f2ModerationEviction() {
  const session = await newSession('F2')
  const healthy = await newSession('F2-HEALTHY')
  const doctor = await room('doctor01', session.id)
  doctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F2_HIDDEN', requestId: 'f2-hidden' })
  const ack = await doctor.take('ACK', f => f.requestId === 'f2-hidden')
  const messageId = ack.message.id
  await ok('admin', 'PUT', `/admin/consult/message/${messageId}/hidden?hidden=1&reason=audit`)
  await doctor.take('MESSAGE_VISIBILITY', f => f.messageId === messageId && f.hidden === 1)
  // 留一条可见消息，HISTORY 断言才有可验证内容，不会在空数组上空转通过
  doctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F2_VISIBLE', requestId: 'f2-visible' })
  const visible = await doctor.take('ACK', f => f.requestId === 'f2-visible')

  const user = await room('zhangsan', session.id)
  assert.ok(user.history, '首次 HISTORY 未保留')
  const historyIds = (user.history.messages ?? []).map(m => m.id)
  assert.ok(historyIds.includes(visible.message.id), 'HISTORY 应包含可见消息')
  assert.equal(historyIds.includes(messageId), false, 'HISTORY 不应包含被屏蔽消息')
  assert.equal((user.history.messages ?? []).find(m => m.id === visible.message.id)?.content,
    'AUDIT_F2_VISIBLE', 'HISTORY 中可见消息内容不符')

  // 同一连接加入另一条合法会话，用于验证清退单个房间不影响其他房间
  user.send({ type: 'SUBSCRIBE', sessionId: healthy.id })
  await user.take('HISTORY', f => f.sessionId === healthy.id)

  // 处置校验失败不得发送 MODERATION，也不得清退订阅
  await request('admin', 'PUT', `/admin/consult/${session.id}/moderate?moderateStatus=2&reason=`, undefined, 400)
  const afterReject = user.mark()
  doctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F2_STILL_SUBSCRIBED', requestId: 'f2-still' })
  await user.take('MSG', f => f.message?.content === 'AUDIT_F2_STILL_SUBSCRIBED')
  assert.equal(user.businessSince(afterReject).some(f => f.type === 'MODERATION'), false)
  assert.equal(user.closed, false, '处置校验失败不应关闭连接')
  log('F2_MODERATION_REJECT_CONTROL', { sessionId: session.id })

  const mark = user.mark()
  await ok('admin', 'PUT', `/admin/consult/${session.id}/moderate?moderateStatus=2&reason=audit`)
  const notice = await user.take('MODERATION', f => f.sessionId === session.id && f.moderateStatus === 2)
  assert.deepEqual(Object.keys(notice).sort(), ['_seq', 'moderateStatus', 'sessionId', 'type'], '处置通知不应携带正文')
  await doctor.take('MODERATION', f => f.sessionId === session.id)
  await delay(300)
  assert.equal(user.closed, false, '清退房间不应关闭整条连接')
  assert.equal(sql(`SELECT status, moderate_status FROM consult_session WHERE id=${session.id}`), '2\t2')

  // 恢复被屏蔽消息：原连接不再是该房间订阅者，收不到正文
  await expectNoBusinessAfterRestore(user, session, messageId)
  // 同一连接的其他合法房间仍能收发。同账号只保留一条连接，医生改连健康会话会顶掉旧连接，
  // 此时处置通知已收到，正好用来验证"清退房间不等于断开账号"。
  const doctorHealthy = await room('doctor01', healthy.id)
  doctorHealthy.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F2_HEALTHY_ROOM', requestId: 'f2-healthy' })
  await user.take('MSG', f => f.message?.content === 'AUDIT_F2_HEALTHY_ROOM')
  // 管理员审计仍可读取被恢复正文
  const audit = await ok('admin', 'GET', `/admin/consult/${session.id}/messages?pageSize=100`)
  assert.ok(audit.records.some(m => m.id === messageId && m.content === 'AUDIT_F2_HIDDEN'))
  await request('zhangsan', 'GET', `/client/consult/sessions/${session.id}`, undefined, 404)
  // 重连对照：协议握手仍可建立，但进房被拒，且不下发 HISTORY（会顶掉上面的旧连接，故放在最后）
  const retry = await room('zhangsan', session.id, { expectHistory: false })
  const rejected = await retry.take('ERROR')
  assert.equal(rejected.msg, '问诊会话不存在')
  assert.equal(retry.frames.some(f => f.type === 'HISTORY'), false, '已处置会话不应下发历史')
  log('F2_PASS', { sessionId: session.id, healthySessionId: healthy.id, messageId })
}

async function expectNoBusinessAfterRestore(user, session, messageId) {
  const mark = user.mark()
  await ok('admin', 'PUT', `/admin/consult/message/${messageId}/hidden?hidden=0`)
  await expectNoBusiness(user, mark, 'F2 处置后恢复消息正文', 1500)
}

// ---------------------------------------------------------------- F3

async function f3CloseFirst() {
  const session = await newSession('F3-CLOSE-FIRST')
  const user = await room('zhangsan', session.id)
  const release = await lockSession(session.id)
  try {
    let closeSettled = false
    const closing = ok('doctor01', 'POST', `/admin/consult/${session.id}/close`, { summary: 'AUDIT_F3_CLOSE_FIRST' })
      .then(data => { closeSettled = true; return data })
    await delay(350)
    assert.equal(closeSettled, false, '关闭请求未等待会话行锁，夹具无效')
    user.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F3_RACE_A', requestId: 'f3-race-a' })
    await delay(350)
    await release()
    await closing
    const notice = await user.take('SESSION', f => f.sessionId === session.id && f.status === 2)
    const rejection = await user.take('ERROR', f => f.requestId === 'f3-race-a')
    // 帧到达顺序受 afterCommit 与网络调度影响，单独记录；提交结果以数据库为准
    log('F3_CLOSE_FIRST_FRAMES', { sessionSeq: notice._seq, errorSeq: rejection._seq })
    assert.equal(rejection.msg, '问诊已结束，会话已关闭')
    assert.equal(Number(sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${session.id} AND content='AUDIT_F3_RACE_A'`)), 0)
    assert.equal(sessionState(session.id), '2\t0\tAUDIT_F3_CLOSE_FIRST\t医生已结束本次问诊。')
    assertAggregates(session.id, 'F3 关闭先取得锁')
    user.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F3_AFTER_CLOSE', requestId: 'f3-after-close' })
    await user.take('ERROR', f => f.requestId === 'f3-after-close')
    assert.equal(Number(sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${session.id} AND content='AUDIT_F3_AFTER_CLOSE'`)), 0)
    // 正常结束只关闭会话，不收回历史：REST 与重新进房都应可读
    const closedHistory = await ok('zhangsan', 'GET', `/client/consult/${session.id}/messages?pageSize=20`)
    assert.ok(closedHistory.records.some(m => m.content === '医生已结束本次问诊。'))
    const reopened = await room('zhangsan', session.id)
    log('F3_CLOSED_HISTORY_PASS', { sessionId: session.id, restRecords: closedHistory.records.length, wsHistory: true })
    assert.equal(reopened.closed, false)
    log('F3_CLOSE_FIRST_PASS', { sessionId: session.id })
  } finally {
    await release()
  }
}

async function f3SendFirst() {
  const session = await newSession('F3-SEND-FIRST')
  const user = await room('zhangsan', session.id)
  const release = await lockSession(session.id)
  try {
    user.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F3_RACE_B', requestId: 'f3-race-b' })
    await delay(350)
    assert.equal(user.frames.some(f => f.type === 'ACK' && f.requestId === 'f3-race-b'), false, '发送未等待会话行锁，夹具无效')
    const closing = ok('doctor01', 'POST', `/admin/consult/${session.id}/close`, { summary: 'AUDIT_F3_SEND_FIRST' })
    await delay(350)
    await release()
    await closing
    const ack = await user.take('ACK', f => f.requestId === 'f3-race-b')
    const notice = await user.take('SESSION', f => f.sessionId === session.id && f.status === 2)
    log('F3_SEND_FIRST_FRAMES', { ackSeq: ack._seq, sessionSeq: notice._seq })
    const rows = sql(`SELECT sender_role, content FROM consult_message WHERE session_id=${session.id} ORDER BY id`).split(/\r?\n/)
    assert.equal(rows.length, 2, '应有用户消息与结束提示两条')
    assert.equal(rows[0], 'USER\tAUDIT_F3_RACE_B')
    assert.equal(rows[1], 'SYSTEM\t医生已结束本次问诊。')
    assert.equal(sessionState(session.id), '2\t0\tAUDIT_F3_SEND_FIRST\t医生已结束本次问诊。')
    assertAggregates(session.id, 'F3 发送先取得锁')
    log('F3_SEND_FIRST_PASS', { sessionId: session.id, messageId: ack.message.id })
  } finally {
    await release()
  }
}

/**
 * 屏蔽旧消息与新消息的定序：屏蔽事务先做普通读建快照、再等会话锁；
 * 等待期间新消息提交。摘要重算若用旧快照，会把 last_message 清空。
 */
async function f3HideBeforeNewMessage() {
  const session = await newSession('F3-HIDE-RACE')
  const user = await room('zhangsan', session.id)
  const doctor = await room('doctor01', session.id)
  doctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_HIDE_RACE_OLD', requestId: 'hide-race-old' })
  const oldAck = await doctor.take('ACK', f => f.requestId === 'hide-race-old')
  await user.take('MSG', f => f.message?.id === oldAck.message.id)
  // 医生离线，新消息才会累加医生未读，便于同时核对未读聚合
  doctor.close()
  await delay(200)

  const release = await lockSession(session.id)
  try {
    user.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_HIDE_RACE_NEW', requestId: 'hide-race-new' })
    await delay(350)
    let hideSettled = false
    const hiding = ok('admin', 'PUT', `/admin/consult/message/${oldAck.message.id}/hidden?hidden=1&reason=audit`)
      .then(data => { hideSettled = true; return data })
    // 让屏蔽请求完成普通读并停在会话锁上，再释放锁
    await delay(350)
    assert.equal(hideSettled, false, '屏蔽请求未等待会话行锁，夹具无效')
    await release()
    const newAck = await user.take('ACK', f => f.requestId === 'hide-race-new')
    await hiding
    assert.ok(newAck.message.id > oldAck.message.id)
    assert.equal(sessionState(session.id), '0\t0\tNULL\tAUDIT_HIDE_RACE_NEW',
      '屏蔽旧消息后摘要应指向等待期间提交的新消息')
    assertAggregates(session.id, 'F3 屏蔽旧消息与新消息定序')
    log('F3_HIDE_RACE_PASS', {
      sessionId: session.id, hiddenMessageId: oldAck.message.id, newMessageId: newAck.message.id
    })
  } finally {
    await release()
  }
}

/** 删除测试用 CHECK 约束；约束名固定，残留时先清理 */
function dropCheckConstraint(table, name) {
  const rows = Number(sql(`SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND CONSTRAINT_NAME = '${name}'`))
  if (rows > 0) sql(`ALTER TABLE ${table} DROP CHECK ${name}`)
}

/**
 * 写入后回滚：给本会话的系统消息加 CHECK 约束，让处置的会话更新成功、
 * 随后插入处置系统消息时失败，整个事务回滚。通知与订阅清退都不得发生。
 */
async function f3ModerateRollback() {
  const session = await newSession('F3-ROLLBACK')
  const user = await room('zhangsan', session.id)
  const doctor = await room('doctor01', session.id)
  const constraint = 'audit_block_system_message'
  dropCheckConstraint('consult_message', constraint)
  // 只约束本会话的系统消息；其他会话与普通消息不受影响
  sql(`ALTER TABLE consult_message ADD CONSTRAINT ${constraint}
       CHECK (session_id <> ${session.id} OR content <> '该会话已由管理员处置关闭。')`)
  const mark = user.mark()
  try {
    await request('admin', 'PUT', `/admin/consult/${session.id}/moderate?moderateStatus=2&reason=audit`, undefined, 500)
    await delay(1200)
    assert.equal(user.frames.filter(f => f._seq > mark && f.type === 'MODERATION').length, 0,
      '处置事务回滚后不应发送 MODERATION')
    assert.equal(user.closed, false, '处置事务回滚后不应关闭连接')
    assert.equal(sessionState(session.id), '0\t0\tNULL', '会话更新与系统消息插入应整体回滚')
    // 订阅未被清退：后续消息照常到达
    doctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_ROLLBACK_STILL_SUBSCRIBED', requestId: 'rollback-still' })
    await user.take('MSG', f => f.message?.content === 'AUDIT_ROLLBACK_STILL_SUBSCRIBED')
    log('F3_ROLLBACK_PASS', { sessionId: session.id, constraint })
  } finally {
    dropCheckConstraint('consult_message', constraint)
  }
}

/** 三组双请求：发送/已读、发送/屏蔽、已读/屏蔽。并发完成且摘要与未读一致即无死锁、无聚合漂移 */
async function f3ConcurrentPairs() {
  // 发送与已读
  const readSession = await newSession('F3-SEND-READ')
  const readUser = await room('zhangsan', readSession.id)
  const [sentAck] = await Promise.all([
    (async () => {
      readUser.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F3_SEND_READ', requestId: 'f3-send-read' })
      return readUser.take('ACK', f => f.requestId === 'f3-send-read')
    })(),
    ok('doctor01', 'POST', `/admin/consult/${readSession.id}/read`)
  ])
  assert.ok(sentAck.message.id > 0)
  assertAggregates(readSession.id, 'F3 发送与已读')
  log('F3_SEND_READ_PASS', { sessionId: readSession.id, messageId: sentAck.message.id })

  // 发送与屏蔽（屏蔽会话中原有的一条医生消息）
  const hideSession = await newSession('F3-SEND-HIDE')
  const hideDoctor = await room('doctor01', hideSession.id)
  hideDoctor.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F3_TO_HIDE', requestId: 'f3-to-hide' })
  const hidden = await hideDoctor.take('ACK', f => f.requestId === 'f3-to-hide')
  const hideUser = await room('zhangsan', hideSession.id)
  await Promise.all([
    (async () => {
      hideUser.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F3_SEND_HIDE', requestId: 'f3-send-hide' })
      return hideUser.take('ACK', f => f.requestId === 'f3-send-hide')
    })(),
    ok('admin', 'PUT', `/admin/consult/message/${hidden.message.id}/hidden?hidden=1&reason=audit`)
  ])
  assertAggregates(hideSession.id, 'F3 发送与屏蔽')
  log('F3_SEND_HIDE_PASS', { sessionId: hideSession.id, hiddenMessageId: hidden.message.id })

  // 已读与屏蔽（屏蔽一条主人消息）
  const pairSession = await newSession('F3-READ-HIDE')
  const pairUser = await room('zhangsan', pairSession.id)
  pairUser.send({ type: 'CHAT', msgType: 'TEXT', content: 'AUDIT_F3_READ_HIDE', requestId: 'f3-read-hide' })
  const readHideAck = await pairUser.take('ACK', f => f.requestId === 'f3-read-hide')
  await Promise.all([
    ok('doctor01', 'POST', `/admin/consult/${pairSession.id}/read`),
    ok('admin', 'PUT', `/admin/consult/message/${readHideAck.message.id}/hidden?hidden=1&reason=audit`)
  ])
  assertAggregates(pairSession.id, 'F3 已读与屏蔽')
  log('F3_READ_HIDE_PASS', { sessionId: pairSession.id, hiddenMessageId: readHideAck.message.id })
}

// ---------------------------------------------------------------- F4

/**
 * 删除宠物档案后，评价、预约、病历、问诊都应仍能显示宠物名与种类。
 * 评价原先走 selectBatchIds，会过滤逻辑删除行；改走 selectHistoryDisplay 后与其余三处同口径。
 */
async function f4ReviewHistoryAfterPetDeleted() {
  // 只挑同时具备病历与问诊会话的预约，避免两项历史展示检查被 if 跳过
  const row = sql(`SELECT a.id,a.pet_id,a.doctor_id,p.name,p.species,
      COALESCE((SELECT r.id FROM medical_record r
                WHERE r.appointment_id=a.id AND r.deleted=0 ORDER BY r.id LIMIT 1), ''),
      COALESCE((SELECT cs.id FROM consult_session cs
                WHERE cs.pet_id=a.pet_id ORDER BY cs.id LIMIT 1), '')
      FROM appointment a JOIN pet p ON p.id=a.pet_id
      WHERE a.user_id=${actors.zhangsan.id} AND a.status=2 AND a.is_reviewed=0
        AND a.deleted=0 AND p.deleted=0
        AND EXISTS (SELECT 1 FROM medical_record r WHERE r.appointment_id=a.id AND r.deleted=0)
        AND EXISTS (SELECT 1 FROM consult_session cs WHERE cs.pet_id=a.pet_id)
      ORDER BY a.id LIMIT 1`)
  assert.ok(row, '找不到同时具备病历与问诊的可评价预约，无法验证历史展示')
  const [appointmentId, petId, doctorId, petName, petSpecies, recordId, consultId] = row.split('\t')
  assert.ok(recordId, 'F4 测试数据缺少病历')
  assert.ok(consultId, 'F4 测试数据缺少问诊会话')
  // 只按本轮新建的评价清理：先记下已有评价 ID，提交失败时不能误删历史数据
  const existingReviewIds = sql(`SELECT id FROM doctor_review WHERE appointment_id=${appointmentId}`)
  historyReview = {
    appointmentId: Number(appointmentId),
    petId: Number(petId),
    doctorId: Number(doctorId),
    stats: sql(`SELECT rating,review_count FROM doctor WHERE id=${doctorId}`),
    reviewedBefore: Number(sql(`SELECT is_reviewed FROM appointment WHERE id=${appointmentId}`)),
    existingReviewIds: existingReviewIds ? existingReviewIds.split('\n').map(Number) : []
  }
  log('F4_TARGET', { appointmentId, petId, petName, petSpecies, recordId, consultId, existingReviewIds: historyReview.existingReviewIds })

  const created = await ok('zhangsan', 'POST', '/client/review', {
    appointmentId: Number(appointmentId), rating: 5, content: '审计回归：删除档案后展示'
  })
  historyReview.reviewId = created.id
  await ok('admin', 'DELETE', `/admin/pet/${petId}`)

  const reviews = await ok('admin', 'GET', '/admin/review/page?pageNum=1&pageSize=100')
  const review = reviews.records.find(r => r.appointmentId === Number(appointmentId))
  assert.ok(review, '评价列表中找不到刚提交的评价')
  assert.equal(review.petName, petName)
  assert.equal(review.petSpecies, petSpecies)

  const appointment = await ok('admin', 'GET', `/admin/appointment/${appointmentId}`)
  assert.equal(appointment.petName, petName)
  assert.equal(appointment.petSpecies, petSpecies)

  const record = await ok('admin', 'GET', `/admin/record/${recordId}`)
  assert.equal(record.petName, petName)
  assert.equal(record.petSpecies, petSpecies)

  let consult = null
  for (let pageNum = 1; pageNum <= 20 && !consult; pageNum++) {
    const page = await ok('admin', 'GET', `/admin/consult/page?pageNum=${pageNum}&pageSize=100`)
    consult = page.records.find(s => s.id === Number(consultId))
    if (page.records.length < 100) break
  }
  assert.ok(consult, '问诊记录中找不到该宠物的会话')
  assert.equal(consult.petName, petName)

  log('F4_REVIEW_HISTORY_PASS', {
    appointmentId, petId, petName, petSpecies, recordId, consultId, reviewId: historyReview.reviewId
  })
}

// ---------------------------------------------------------------- F5

/**
 * 并发首次保存病历：两个请求同时打到同一张已接诊预约。
 * 预约行锁串行化后，后到者必须看到先到者提交的病历并走修订，
 * 数据库只能留一份有效记录。这里同时记录两次响应与行数。
 */
async function f5ConcurrentRecordFirstSave() {
  const schedule = sql(`SELECT id,remain_num,last_queue_no FROM doctor_schedule
      WHERE doctor_id=1 AND status=1 AND remain_num>0
        AND (work_date>CURDATE() OR (work_date=CURDATE() AND end_time>CURTIME()))
      ORDER BY work_date,period LIMIT 1`)
  assert.ok(schedule, '找不到可约号源，无法创建并发病历用例')
  const [scheduleId, remainNum, lastQueueNo] = schedule.split('\t')
  recordTest = { scheduleId: Number(scheduleId), remainNum: Number(remainNum), lastQueueNo: Number(lastQueueNo) }

  const pet = await ok('zhangsan', 'POST', '/client/pet', { name: '回归-并发病历', species: '猫' })
  createdPets.push(pet.id)
  recordTest.petId = pet.id
  const appointment = await ok('zhangsan', 'POST', '/client/appointment', {
    petId: pet.id, doctorId: 1, scheduleId: recordTest.scheduleId, symptom: '审计回归并发病历'
  })
  recordTest.appointmentId = appointment.id
  await ok('zhangsan', 'POST', `/client/appointment/${appointment.id}/pay`)
  await ok('doctor01', 'POST', `/admin/appointment/${appointment.id}/accept`)

  const body = diagnosis => ({
    chiefComplaint: '呕吐两天', physicalExam: '体温正常', diagnosis,
    prescription: '蒙脱石散', treatment: '补液', advice: '清淡饮食',
    nextVisitDate: '2026-11-01', images: '/api/uploads/xray.png'
  })
  const responses = await Promise.all([
    ok('doctor01', 'POST', `/admin/record/appointment/${appointment.id}`, body('并发首次保存A')),
    ok('doctor01', 'POST', `/admin/record/appointment/${appointment.id}`, body('并发首次保存B'))
  ])
  const count = Number(sql(`SELECT COUNT(*) FROM medical_record WHERE appointment_id=${appointment.id} AND deleted=0`))
  assert.equal(count, 1, '并发首次保存产生了多份病历')
  const diagnosis = sql(`SELECT diagnosis FROM medical_record WHERE appointment_id=${appointment.id} AND deleted=0`)
  assert.ok(['并发首次保存A', '并发首次保存B'].includes(diagnosis), `病历诊断不是任一请求的值：${diagnosis}`)
  log('F5_CONCURRENT_RECORD_PASS', {
    appointmentId: appointment.id, recordId: responses[0].id, count, diagnosis
  })
}

// ---------------------------------------------------------------- 主流程

async function main() {
  originalUserStatus = sql(`SELECT status FROM sys_user WHERE id=${actors.zhangsan.id}`)
  originalDoctorOnline = sql('SELECT online_status FROM doctor WHERE id=1')

  log('F1_START', {})
  await f1DisabledChat()
  await f1DisabledRestClose()
  await f1DisabledRestoreMessage()
  await f1ExpiredToken()
  log('F1_ALL_PASS', { checks: 4 })

  log('F2_START', {})
  await f2ModerationEviction()
  log('F2_ALL_PASS', { checks: 1 })

  log('F3_START', {})
  await f3CloseFirst()
  await f3SendFirst()
  await f3HideBeforeNewMessage()
  await f3ModerateRollback()
  await f3ConcurrentPairs()
  log('F3_ALL_PASS', { checks: 7 })

  log('F4_START', {})
  await f4ReviewHistoryAfterPetDeleted()
  log('F4_ALL_PASS', { checks: 1 })

  log('F5_START', {})
  await f5ConcurrentRecordFirstSave()
  log('F5_ALL_PASS', { checks: 1 })

  console.log('AUDIT REGRESSION PASSED (F1/F2/F3/F4/F5)')
}

try {
  await main()
} catch (error) {
  console.error('AUDIT REGRESSION FAILED:', error)
  log('REGRESSION_FAILED', { error: error.message })
  process.exitCode = 1
} finally {
  for (const conn of sockets) conn.close()
  await delay(300)
  try {
    guard()
    if (originalUserStatus !== null) {
      sql(`UPDATE sys_user SET status=${Number(originalUserStatus)} WHERE id=${actors.zhangsan.id}`)
    }
    if (createdSessions.length) {
      const ids = createdSessions.join(',')
      sql(`DELETE FROM consult_message WHERE session_id IN (${ids})`)
      sql(`DELETE FROM consult_session WHERE id IN (${ids})`)
    }
    if (recordTest) {
      // 病历与预约是本轮创建的；号源余量与排队序号恢复，即使预约创建中途失败也不会留下扣号
      if (recordTest.appointmentId) {
        sql(`DELETE FROM medical_record WHERE appointment_id=${recordTest.appointmentId}`)
        sql(`DELETE FROM appointment WHERE id=${recordTest.appointmentId}`)
      }
      sql(`UPDATE doctor_schedule SET remain_num=${recordTest.remainNum}, last_queue_no=${recordTest.lastQueueNo} WHERE id=${recordTest.scheduleId}`)
    }
    if (createdPets.length) sql(`DELETE FROM pet WHERE id IN (${createdPets.join(',')})`)
    if (originalDoctorOnline !== null) {
      sql(`UPDATE doctor SET online_status=${Number(originalDoctorOnline)} WHERE id=1`)
    }
    if (historyReview) {
      // 只按本轮成功创建的评价 ID 清理；提交失败时 reviewId 为空，已有评价行原样保留
      const existing = historyReview.existingReviewIds || []
      if (historyReview.reviewId && !existing.includes(historyReview.reviewId)) {
        sql(`DELETE FROM doctor_review WHERE id=${historyReview.reviewId}`)
      }
      // 已评价标志恢复到测试前快照，不假设一定从 0 变成 1
      sql(`UPDATE appointment SET is_reviewed=${historyReview.reviewedBefore} WHERE id=${historyReview.appointmentId}`)
      sql(`UPDATE pet SET deleted=0 WHERE id=${historyReview.petId}`)
      const [rating, reviewCount] = historyReview.stats.split('\t')
      sql(`UPDATE doctor SET rating=${Number(rating)}, review_count=${Number(reviewCount)} WHERE id=${historyReview.doctorId}`)
    }
    log('CLEANUP_DONE', {
      sessions: createdSessions.length,
      pets: createdPets.length,
      userStatus: originalUserStatus,
      doctorOnline: originalDoctorOnline,
      historyReview: historyReview ? historyReview.appointmentId : null,
      recordTest: recordTest ? recordTest.appointmentId : null
    })
  } catch (cleanupError) {
    console.error('CLEANUP FAILED:', cleanupError)
    log('CLEANUP_FAILED', { error: cleanupError.message })
    process.exitCode = 1
  }
}
