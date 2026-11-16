// node tools/read_receipt_check.mjs --config <isolated runtime.json>
//
// H2 回归：进房/重连不得写已读，已读只能由显式 READ 帧触发。
//
// 断言三段：
//   1. 医生发一条消息 → 主人侧 user_unread = 1，消息 is_read = 0
//   2. 主人只建连、只收 HISTORY/PRESENCE、不发 READ → user_unread 仍为 1
//   3. 主人显式发 READ → user_unread = 0，该条消息 is_read = 1，
//      且对侧（医生连接）收到 role=USER 的 READ 回执
//
// 只读断言 + 一条临时会话；结束时删掉本次创建的会话与消息。
// 不依赖前端：验证的是服务端的已读触发面。前端"页面可见才发 READ"的判据由
// frontend/tests/consult-governance.test.mjs 覆盖。
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
assert.match(cfg.db, /^pet_clinic_test_[a-f0-9]{8}$/, '只允许在隔离测试库运行')
assert.equal(cfg.api, 'http://127.0.0.1:8082/api', '后端地址必须是隔离实例 8082')
const sql = q => execFileSync('mysql',
  ['--defaults-extra-file=' + cfg.mysqlDefaultsFile, '-BN', '--default-character-set=utf8mb4', '-e', q],
  { encoding: 'utf8' }).trim()

async function login(who, side) {
  const response = await fetch(`${cfg.api}/${side}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: '123456' })
  })
  const json = await response.json()
  assert.equal(json.code, 200, `${who} 登录失败：${json.msg}`)
  return json.data.token
}

const call = async (token, method, path, body) => {
  const response = await fetch(cfg.api + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  const json = await response.json()
  assert.equal(json.code, 200, `${method} ${path}: ${json.msg}`)
  return json.data
}

/** 建连并收集帧；只等 HISTORY，不发任何上行帧 */
async function connectOnly(token, sessionId) {
  const ws = new WebSocket(
    `ws://127.0.0.1:8082/api/ws/consult?token=${encodeURIComponent(token)}&sessionId=${sessionId}`)
  const frames = []
  ws.onmessage = e => {
    try { frames.push(JSON.parse(e.data)) } catch { /* 非 JSON 帧忽略 */ }
  }
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('建连超时')), 8000)
    ws.onerror = () => { clearTimeout(timer); reject(new Error('建连失败')) }
    ws.onclose = () => { clearTimeout(timer); reject(new Error('连接被服务端关闭')) }
    const tick = setInterval(() => {
      if (frames.some(f => f.type === 'HISTORY')) {
        clearInterval(tick)
        clearTimeout(timer)
        resolvePromise()
      }
    }, 20)
  })
  // 给 PRESENCE / 可能的迟到帧一点时间，避免"还没收到就断言"
  await new Promise(r => setTimeout(r, 400))
  return { ws, frames }
}

/** 显式发一帧，等对应的下行 */
async function sendAndWait(ws, payload, type, timeout = 8000) {
  const pending = waitForFrame(ws, type, timeout)
  ws.send(JSON.stringify(payload))
  return pending
}

/**
 * 等待指定类型的下行帧。
 *
 * <p>回执类帧只发给对侧（broadcastRead 排除发送方所在连接），所以"发帧的连接"
 * 与"收到帧的连接"经常不是同一条：调用方先挂 waitForFrame，再用另一条连接观察。
 */
async function waitForFrame(ws, type, timeout = 8000) {
  const seen = []
  const listener = e => {
    try { seen.push(JSON.parse(e.data)) } catch { /* 忽略非 JSON */ }
  }
  ws.addEventListener('message', listener)
  const started = Date.now()
  try {
    while (Date.now() - started < timeout) {
      const hit = seen.find(f => f.type === type)
      if (hit) return hit
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`未收到 ${type}`)
  } finally {
    ws.removeEventListener('message', listener)
  }
}

/** 主人侧未读数与"医生发的未读消息条数"必须一致 */
function receipt(sessionId) {
  const [userUnread, unreadMessages, readMessages] = sql(
    `SELECT (SELECT user_unread FROM consult_session WHERE id=${sessionId}),
            (SELECT COUNT(*) FROM consult_message WHERE session_id=${sessionId}
               AND hidden=0 AND is_read=0 AND sender_role='DOCTOR'),
            (SELECT COUNT(*) FROM consult_message WHERE session_id=${sessionId}
               AND hidden=0 AND is_read=1 AND sender_role='DOCTOR')`).split('\t')
  return { userUnread: Number(userUnread), unreadMessages: Number(unreadMessages), readMessages: Number(readMessages) }
}

const userToken = await login('zhangsan', 'client')
const doctorToken = await login('doctor01', 'admin')
const failures = []
let sessionId = null

try {
  const created = await call(userToken, 'POST', '/client/consult/sessions',
    { petId: 1, doctorId: 1, symptom: 'read receipt check' })
  sessionId = created.id
  await call(doctorToken, 'POST', `/admin/consult/${sessionId}/accept`)

  // 医生发一条：制造对侧未读
  const doctorRoom = await connectOnly(doctorToken, sessionId)
  const ack = await sendAndWait(doctorRoom.ws,
    { type: 'CHAT', sessionId, msgType: 'TEXT', content: 'READ_RECEIPT_CHECK', requestId: 'rr-1' }, 'ACK')
  doctorRoom.ws.close()
  assert.ok(ack.message.id > 0)

  const afterSend = receipt(sessionId)
  assert.deepEqual(afterSend, { userUnread: 1, unreadMessages: 1, readMessages: 0 },
    `医生发消息后未读应为 1：${JSON.stringify(afterSend)}`)
  console.log('PASS 1 医生发消息后 user_unread=1')

  // 关键断言：只建连不发 READ，未读不得被清
  const userRoom = await connectOnly(userToken, sessionId)
  const types = userRoom.frames.map(f => f.type)
  assert.ok(types.includes('HISTORY'), `建连应收到 HISTORY，实际 ${types.join(',')}`)
  const afterReconnect = receipt(sessionId)
  assert.deepEqual(afterReconnect, { userUnread: 1, unreadMessages: 1, readMessages: 0 },
    `仅建连不得写已读，实际 ${JSON.stringify(afterReconnect)}（收到帧 ${types.join(',')}）`)
  console.log('PASS 2 仅建连不发 READ，user_unread 仍为 1')

  // 显式 READ 才归零。回执只发给对侧（broadcastRead 排除发送方自己），
  // 所以让医生的连接来观察这一帧——顺带验证"对侧确实收到了已读通知"。
  const doctorObserver = await connectOnly(doctorToken, sessionId)
  const readAck = waitForFrame(doctorObserver.ws, 'READ')
  userRoom.ws.send(JSON.stringify({ type: 'READ', sessionId }))
  const readFrame = await readAck
  userRoom.ws.close()
  const afterRead = receipt(sessionId)
  assert.deepEqual(afterRead, { userUnread: 0, unreadMessages: 0, readMessages: 1 },
    `显式 READ 后未读应清零：${JSON.stringify(afterRead)}`)
  console.log('PASS 3 显式 READ 后 user_unread=0')

  assert.equal(readFrame.role, 'USER', `回执的 role 应为 USER，实际 ${readFrame.role}`)
  assert.ok(Array.isArray(readFrame.readMessageIds) && readFrame.readMessageIds.includes(ack.message.id),
    `回执应包含本次标记的消息 id ${ack.message.id}，实际 ${JSON.stringify(readFrame.readMessageIds)}`)
  doctorObserver.ws.close()
  console.log('PASS 4 对侧收到 role=USER 的 READ 回执，含精确消息 id')
} catch (error) {
  failures.push(error.message)
  console.error('FAIL', error.message)
} finally {
  if (sessionId) {
    // 只删本次创建的会话及其消息；论外键是逻辑外键，按 id 精确删除
    try {
      sql(`DELETE FROM consult_message WHERE session_id=${sessionId}`)
      sql(`DELETE FROM consult_session WHERE id=${sessionId}`)
    } catch (error) {
      console.error('CLEANUP_FAILED', error.message)
    }
  }
}

if (failures.length) {
  console.error(`READ RECEIPT CHECK FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('READ RECEIPT CHECK PASSED')
