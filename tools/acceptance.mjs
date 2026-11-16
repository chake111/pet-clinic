// node tools/acceptance.mjs --config <runtime.json> [--preflight-only]
//
// 真实链路验收（需要 qa_env prepare/start 已经跑通的最小隔离环境）：
//   T1a 登录 → 改密 → 旧令牌访问 REST / 握手 / 入站 / 出站 → 重新登录
//   T4  对方在线但接收方不发 READ → 断连 → 重连不清未读 → 显式 READ 才归零
//   T6  夹具持有科室行锁，另一侧调用真实接口（新增/转科/删除），验证服务实现的锁
//
// 写入前必须先过 preflight：复用 qa_env.check 校验落点库/端口/账号/授权，
// 再确认 8082 上确实有以该受限账号连到该库的实例、actors.json 与库中记录一致。
// 任一不符就以 2 退出，不会发生任何写入。`--preflight-only` 只做这一步，便于反向测试。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const configFlag = argv.findIndex(a => a === '--config')
const argConfig = argv.find(a => a.startsWith('--config='))?.slice('--config='.length)
  ?? (configFlag >= 0 ? argv[configFlag + 1] : null)
const configPath = resolve(argConfig ?? process.env.PETQA_CONFIG ?? 'runtime.json')
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
const root = dirname(configPath)
assert.match(cfg.db, /^pet_clinic_test_[a-f0-9]{8}$/, '只允许在隔离测试库运行')
assert.equal(cfg.api, 'http://127.0.0.1:8082/api')
const actors = JSON.parse(readFileSync(resolve(root, 'actors.json'), 'utf8'))
const SEED_PASSWORD = '123456'
const TEMP_PASSWORD = 'qa-temp-20261019'
const PREFLIGHT_ONLY = argv.includes('--preflight-only')

const failures = []
async function check(name, action) {
  try {
    await action()
    console.log('PASS', name)
  } catch (error) {
    failures.push(name)
    console.error('FAIL', name, error?.message ?? error)
  }
}

// ---------------------------------------------------------------- 基础工具

const mysql = (query, db = cfg.db) => execFileSync('mysql',
  ['--defaults-extra-file=' + cfg.mysqlDefaultsFile, '-BN', '--default-character-set=utf8mb4',
    db, '-e', query], { encoding: 'utf8' }).trim()

// ---------------------------------------------------------------- 写入前预检

const QA_ENV_CLI = fileURLToPath(new URL('./qa_env.py', import.meta.url))

/**
 * 写入前的实例校验，复用 qa_env.instance：
 *   1. qa_env.check 的落点库/端口/账号/授权；
 *   2. 8082 的监听 PID 必须等于配置里的 backendPid；
 *   3. 该 PID 的启动命令必须是本项目 jar、8082 端口、指向测试库；
 *   4. 该账号确实连在测试库上。
 * 之后再核对 actors.json 与库中记录一致（文件可能过期）。
 */
async function preflight() {
  const checked = spawnSync(process.env.PYTHON ?? 'python',
    [QA_ENV_CLI, 'instance', '--config', configPath], { encoding: 'utf8' })
  if (checked.status !== 0) {
    throw new Error(`实例校验未通过：${(checked.stderr || checked.stdout).trim()}`)
  }
  const connections = Number(/connections=(\d+)/.exec(checked.stdout)?.[1] ?? 0)

  const docs = await fetch(cfg.api + '/v3/api-docs').catch(() => null)
  if (!docs || !docs.ok) throw new Error(`8082 没有可用后端：${cfg.api}/v3/api-docs`)

  for (const key of ['admin', 'doctor01', 'doctor02', 'zhangsan']) {
    const actor = actors[key]
    if (!actor) throw new Error(`actors.json 缺少 ${key}，请重新执行 prepare`)
    const table = actor.typ === 'ADMIN' ? 'admin_user' : 'sys_user'
    const row = mysql(`SELECT id, username FROM ${table} WHERE id=${actor.id} AND deleted=0`).split('\t')
    if (row[0] !== String(actor.id) || row[1] !== actor.username) {
      throw new Error(`actors.json 的 ${key} 与库中记录不一致：${row.join('/')}`)
    }
  }
  return { connections, pid: cfg.backendPid }
}

async function api(method, path, token, body) {
  const response = await fetch(cfg.api + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return response.json()
}

async function login(scope, username, password) {
  return api('POST', `/${scope}/auth/login`, null, { username, password })
}

function payloadOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

/** 打开问诊房间，等到 HISTORY 视为成功；握手被拒或提前关闭则失败 */
function openRoom(token, sessionId, timeout = 8000) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:8082/api/ws/consult?token=${encodeURIComponent(token)}&sessionId=${sessionId}`)
    const frames = []
    const timer = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('等待 HISTORY 超时')) }, timeout)
    ws.onmessage = event => {
      const frame = JSON.parse(event.data)
      frames.push(frame)
      if (frame.type === 'HISTORY') {
        clearTimeout(timer)
        resolvePromise({ ws, frames, closed: false, closeReason: '' })
      }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 握手被拒')) }
    ws.onclose = event => {
      if (frames.some(f => f.type === 'HISTORY')) return
      clearTimeout(timer)
      reject(new Error(`WebSocket 提前关闭 code=${event.code} reason=${event.reason}`))
    }
  })
}

function waitFor(conn, predicate, timeout = 6000) {
  return new Promise((resolvePromise, reject) => {
    const existing = conn.frames.find(predicate)
    if (existing) return resolvePromise(existing)
    const timer = setTimeout(() => reject(new Error('等待帧超时')), timeout)
    const onMessage = event => {
      const frame = JSON.parse(event.data)
      conn.frames.push(frame)
      if (predicate(frame)) { clearTimeout(timer); resolvePromise(frame) }
    }
    conn.ws.addEventListener('message', onMessage)
  })
}

const closeQuietly = conn => { try { conn.ws.close() } catch {} }

// ---------------------------------------------------------------- 预检（任何写入之前）

try {
  const info = await preflight()
  console.log(`PREFLIGHT OK pid=${info.pid} db=${cfg.db} connections=${info.connections}`)
} catch (error) {
  console.error('PREFLIGHT FAILED:', error.message)
  process.exit(2)
}
if (PREFLIGHT_ONLY) process.exit(0)

// ---------------------------------------------------------------- T1a 令牌撤销

await check('T1a 登录→改密→旧令牌四路失效→重新登录', async () => {
  // 上次中断可能停在临时口令上，先恢复到种子口令
  let baseline = await login('client', 'zhangsan', SEED_PASSWORD)
  if (baseline.code !== 200) {
    const recover = await login('client', 'zhangsan', TEMP_PASSWORD)
    assert.equal(recover.code, 200, '临时口令也无法登录，需人工恢复 zhangsan')
    await api('PUT', '/client/auth/password', recover.data.token,
      { oldPassword: TEMP_PASSWORD, newPassword: SEED_PASSWORD })
    baseline = await login('client', 'zhangsan', SEED_PASSWORD)
  }
  assert.equal(baseline.code, 200, '种子口令登录失败')
  const oldToken = baseline.data.token
  const oldVersion = payloadOf(oldToken).ver
  assert.equal(typeof oldVersion, 'number', '令牌必须携带 ver')

  const before = await api('GET', '/client/auth/profile', oldToken)
  assert.equal(before.code, 200, '改密前旧令牌应可用')

  const created = await api('POST', '/client/consult/sessions', oldToken,
    { petId: 1, doctorId: 1, symptom: '令牌撤销验收：改密后旧连接不应继续收发' })
  assert.equal(created.code, 200, '创建问诊会话失败')
  const sessionId = created.data.id

  // 改密前先建立长连接，稍后验证"既有连接"是否被撤销
  const room = await openRoom(oldToken, sessionId)

  const changed = await api('PUT', '/client/auth/password', oldToken,
    { oldPassword: SEED_PASSWORD, newPassword: TEMP_PASSWORD })
  assert.equal(changed.code, 200, '改密失败')

  const afterRest = await api('GET', '/client/auth/profile', oldToken)
  assert.equal(afterRest.code, 401, '旧令牌访问 REST 应被拒')

  await assert.rejects(openRoom(oldToken, sessionId, 5000), /握手被拒|提前关闭|超时/,
    '旧令牌不应能建立新的 WebSocket 连接')

  // 既有连接：入站帧先被账号校验拦下，错误帧与关闭都是可接受结果
  const outcome = await new Promise(resolvePromise => {
    const timer = setTimeout(() => resolvePromise('timeout'), 5000)
    room.ws.addEventListener('message', event => {
      const frame = JSON.parse(event.data)
      if (frame.type === 'ERROR' && /账号状态或权限已变化/.test(frame.msg || '')) {
        clearTimeout(timer); resolvePromise('error-frame')
      }
    })
    room.ws.addEventListener('close', () => { clearTimeout(timer); resolvePromise('closed') })
    room.ws.send(JSON.stringify({ type: 'CHAT', sessionId, msgType: 'TEXT', content: '旧连接不应写入', requestId: 'stale-1' }))
  })
  assert.notEqual(outcome, 'timeout', '既有连接在改密后仍可收发')
  closeQuietly(room)

  const fresh = await login('client', 'zhangsan', TEMP_PASSWORD)
  assert.equal(fresh.code, 200, '新口令登录失败')
  assert.equal(payloadOf(fresh.data.token).ver, oldVersion + 1, '新令牌的 ver 应递增')

  const restored = await api('PUT', '/client/auth/password', fresh.data.token,
    { oldPassword: TEMP_PASSWORD, newPassword: SEED_PASSWORD })
  assert.equal(restored.code, 200, '恢复种子口令失败')
  const again = await login('client', 'zhangsan', SEED_PASSWORD)
  assert.equal(again.code, 200, '恢复后种子口令应可登录')
  assert.equal(payloadOf(again.data.token).ver, oldVersion + 2, '恢复口令也应继续递增版本')
})

// ---------------------------------------------------------------- T1a 出站帧

await check('T1a 出站帧：医生改密后旧连接不再收到业务消息', async () => {
  let baseline = await login('admin', 'doctor01', SEED_PASSWORD)
  if (baseline.code !== 200) {
    const recover = await login('admin', 'doctor01', TEMP_PASSWORD)
    assert.equal(recover.code, 200, '临时口令也无法登录，需人工恢复 doctor01')
    await api('PUT', '/admin/auth/password', recover.data.token,
      { oldPassword: TEMP_PASSWORD, newPassword: SEED_PASSWORD })
    baseline = await login('admin', 'doctor01', SEED_PASSWORD)
  }
  assert.equal(baseline.code, 200, '医生登录失败')
  const doctorToken = baseline.data.token

  const client = await login('client', 'zhangsan', SEED_PASSWORD)
  const created = await api('POST', '/client/consult/sessions', client.data.token,
    { petId: 1, doctorId: actors.doctor01.doctorId, symptom: '出站帧验收：改密后旧连接应被清退' })
  assert.equal(created.code, 200, '创建会话失败')
  const sessionId = created.data.id

  const room = await openRoom(doctorToken, sessionId)
  const closed = new Promise(resolvePromise => {
    room.ws.addEventListener('close', () => resolvePromise(true))
    setTimeout(() => resolvePromise(false), 6000)
  })
  const delivered = []
  room.ws.addEventListener('message', event => {
    const frame = JSON.parse(event.data)
    if (frame.type === 'MSG') delivered.push(frame.message?.content)
  })

  const changed = await api('PUT', '/admin/auth/password', doctorToken,
    { oldPassword: SEED_PASSWORD, newPassword: TEMP_PASSWORD })
  assert.equal(changed.code, 200, '医生改密失败')

  const requestId = 't1a-out-' + Date.now()
  // 医生连接已失效：这条消息不应送达既有连接，连接应被服务端关闭
  const senderRoom = await openRoom(client.data.token, sessionId)
  senderRoom.ws.send(JSON.stringify({ type: 'CHAT', sessionId, msgType: 'TEXT', content: '出站校验消息', requestId }))
  assert.equal(await closed, true, '改密后医生旧连接仍保持，未被出站校验清退')
  assert.ok(!delivered.includes('出站校验消息'), '改密后的旧连接仍收到了业务消息')
  closeQuietly(senderRoom)

  const fresh = await login('admin', 'doctor01', TEMP_PASSWORD)
  assert.equal(fresh.code, 200, '医生新口令登录失败')
  const restored = await api('PUT', '/admin/auth/password', fresh.data.token,
    { oldPassword: TEMP_PASSWORD, newPassword: SEED_PASSWORD })
  assert.equal(restored.code, 200, '恢复医生种子口令失败')
})

// ---------------------------------------------------------------- T4 未读一致性

await check('T4 对方在线不发 READ、重连也不清未读，只有显式 READ 才归零', async () => {
  const client = await login('client', 'zhangsan', SEED_PASSWORD)
  const doctor = await login('admin', 'doctor01', SEED_PASSWORD)
  assert.equal(client.code, 200, '用户端登录失败')
  assert.equal(doctor.code, 200, '医生登录失败')

  const created = await api('POST', '/client/consult/sessions', client.data.token,
    { petId: 1, doctorId: actors.doctor01.doctorId, symptom: '未读计数验收：对方在线也不代表已读' })
  assert.equal(created.code, 200, '创建会话失败')
  const sessionId = created.data.id

  // 先把接收方挂进房间并完成订阅。订阅只补历史，不清未读（H2）：
  // 已读的唯一触发点是上行 READ 帧，重连本身不构成"有人看见了"。
  const receiver = await openRoom(client.data.token, sessionId)
  const sender = await openRoom(doctor.data.token, sessionId)

  const requestId = 't4-' + Date.now()
  sender.ws.send(JSON.stringify({ type: 'CHAT', sessionId, msgType: 'TEXT', content: '计数校验', requestId }))
  const ack = await waitFor(sender, f => f.type === 'ACK' && f.requestId === requestId)
  assert.ok(ack.message.id > 0, '医生消息未落库')

  // 接收方收到了推送但不发 READ，随后断连
  const delivered = await waitFor(receiver, f => f.type === 'MSG' && f.message.id === ack.message.id)
  assert.equal(delivered.message.isRead, 0, '新消息应为未读')
  closeQuietly(receiver)
  await new Promise(r => setTimeout(r, 300))

  const counter = Number(mysql(`SELECT user_unread FROM consult_session WHERE id=${sessionId}`))
  const unread = Number(mysql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${sessionId}
    AND sender_role='DOCTOR' AND is_read=0 AND hidden=0`))
  assert.equal(counter, unread, `会话计数(${counter}) 与可见未读消息(${unread}) 不一致`)
  assert.ok(counter >= 1, '至少应有一条未读')
  const unreadBefore = counter

  // 只重连、不发 READ：计数必须原样保留。这一条正是 H2 的不变量——
  // 原先"重新订阅即 markRead"会让未读在没人查看的情况下消失。
  const back = await openRoom(client.data.token, sessionId)
  await new Promise(r => setTimeout(r, 400))
  const afterReconnect = Number(mysql(`SELECT user_unread FROM consult_session WHERE id=${sessionId}`))
  const stillUnread = Number(mysql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${sessionId}
    AND sender_role='DOCTOR' AND is_read=0 AND hidden=0`))
  assert.equal(afterReconnect, unreadBefore, `仅重连不得清未读，期望 ${unreadBefore}，实际 ${afterReconnect}`)
  assert.equal(stillUnread, unreadBefore, `仅重连不得标记已读，期望 ${unreadBefore} 条未读，实际 ${stillUnread}`)

  // 显式发 READ 才归零
  back.ws.send(JSON.stringify({ type: 'READ', sessionId }))
  await new Promise(r => setTimeout(r, 400))
  closeQuietly(back); closeQuietly(sender)
  const cleared = Number(mysql(`SELECT user_unread FROM consult_session WHERE id=${sessionId}`))
  const remaining = Number(mysql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${sessionId}
    AND sender_role='DOCTOR' AND is_read=0 AND hidden=0`))
  assert.equal(cleared, 0, '显式 READ 后计数应清零')
  assert.equal(remaining, 0, '显式 READ 后未读消息应全部标记已读')
})

// ---------------------------------------------------------------- T6 科室行锁（服务实现）

const QA_LOCK = 'qa-t6-lock'

/** 夹具：一个数据库连接先锁住科室行，再放行信号，随后按脚本提交 */
function holdLock(depId, commitSql, sleepSeconds = 2.5) {
  const script = 'BEGIN;\n' +
    `SELECT id FROM department WHERE id=${depId} AND deleted=0 FOR UPDATE;\n` +
    `SELECT GET_LOCK('${QA_LOCK}', 0);\n` +
    `SELECT SLEEP(${sleepSeconds});\n` +
    `${commitSql}\n` +
    'COMMIT;\n' +
    `SELECT RELEASE_LOCK('${QA_LOCK}');`
  const child = spawn('mysql', ['--defaults-extra-file=' + cfg.mysqlDefaultsFile, '-BN',
    '--default-character-set=utf8mb4', cfg.db, '-e', script])
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { out += chunk })
  return { done: new Promise(done => child.on('close', code => done({ code, out }))) }
}

/** 等夹具真正拿到行锁（不是固定 sleep），再发起被测调用 */
async function waitLock(timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (Number(mysql(`SELECT IFNULL(IS_USED_LOCK('${QA_LOCK}'), 0)`)) > 0) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('等待夹具行锁超时')
}

async function createDepartment(token, name) {
  const created = await api('POST', '/admin/department', token,
    { name, code: 'QA-' + Date.now() + '-' + Math.floor(Math.random() * 1000), status: 1, sort: 99 })
  assert.equal(created.code, 200, `创建科室失败：${created.msg}`)
  return created.data.id
}

await check('T6 新增医生：删除方先持锁，接口等待后按"科室不存在"拒绝', async () => {
  const admin = await login('admin', 'admin', SEED_PASSWORD)
  const token = admin.data.token
  const depId = await createDepartment(token, 'QA-T6 新增')
  const fixture = holdLock(depId, `UPDATE department SET deleted=1 WHERE id=${depId};`)
  await waitLock()

  const started = Date.now()
  const created = await api('POST', '/admin/doctor', token,
    { name: 'QA-T6 医生A', departmentId: depId, consultationFee: 1, status: 1 })
  const elapsed = Date.now() - started
  const fixtureResult = await fixture.done

  assert.equal(fixtureResult.code, 0, fixtureResult.out)
  assert.notEqual(created.code, 200, `科室已被删除，新增应失败：${JSON.stringify(created)}`)
  assert.match(created.msg ?? '', /科室/, '失败原因应指向科室')
  assert.ok(elapsed >= 1500, `接口应在科室行锁上等待，实际 ${elapsed}ms`)
  assert.equal(Number(mysql(`SELECT COUNT(*) FROM doctor WHERE name='QA-T6 医生A'`)), 0, '不得留下悬空医生')
  assert.equal(Number(mysql(`SELECT deleted FROM department WHERE id=${depId}`)), 1)
  mysql(`DELETE FROM department WHERE id=${depId}`)
})

await check('T6 转科：删除方先持锁，接口拒绝并保留原科室', async () => {
  const admin = await login('admin', 'admin', SEED_PASSWORD)
  const token = admin.data.token
  const depB = await createDepartment(token, 'QA-T6 转科')
  const doc = await api('POST', '/admin/doctor', token,
    { name: 'QA-T6 转科医生', departmentId: 1, consultationFee: 1, status: 1 })
  assert.equal(doc.code, 200, `创建医生失败：${doc.msg}`)
  const doctorId = doc.data.id

  const fixture = holdLock(depB, `UPDATE department SET deleted=1 WHERE id=${depB};`)
  await waitLock()
  const started = Date.now()
  const updated = await api('PUT', `/admin/doctor/${doctorId}`, token,
    { name: 'QA-T6 转科医生', departmentId: depB, consultationFee: 1, status: 1 })
  const elapsed = Date.now() - started
  await fixture.done

  assert.notEqual(updated.code, 200, `目标科室已删除，转科应失败：${JSON.stringify(updated)}`)
  assert.ok(elapsed >= 1500, `接口应在科室行锁上等待，实际 ${elapsed}ms`)
  assert.equal(Number(mysql(`SELECT department_id FROM doctor WHERE id=${doctorId}`)), 1, '转科失败后应保持原科室')
  mysql(`DELETE FROM doctor WHERE id=${doctorId}; DELETE FROM department WHERE id=${depB};`)
})

await check('T6 删除科室：新增方先持锁，接口等待后看到医生并拒绝', async () => {
  const admin = await login('admin', 'admin', SEED_PASSWORD)
  const token = admin.data.token
  const depC = await createDepartment(token, 'QA-T6 删除')
  const fixture = holdLock(depC,
    `INSERT INTO doctor (name, department_id, status) VALUES ('QA-T6 并发医生C', ${depC}, 1);`)
  await waitLock()

  const started = Date.now()
  const removed = await api('DELETE', `/admin/department/${depC}`, token)
  const elapsed = Date.now() - started
  await fixture.done

  assert.notEqual(removed.code, 200, `仍有医生挂靠，删除应失败：${JSON.stringify(removed)}`)
  assert.match(removed.msg ?? '', /医生/, '失败原因应指向挂靠医生')
  assert.ok(elapsed >= 1500, `接口应在科室行锁上等待，实际 ${elapsed}ms`)
  assert.equal(Number(mysql(`SELECT deleted FROM department WHERE id=${depC}`)), 0, '科室不应被删除')
  mysql(`DELETE FROM doctor WHERE department_id=${depC}; DELETE FROM department WHERE id=${depC};`)
})

console.log(failures.length ? `\n${failures.length} 项失败：${failures.join('、')}` : '\nACCEPTANCE PASSED')
process.exit(failures.length ? 1 : 0)
