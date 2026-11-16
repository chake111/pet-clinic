// node tests/consult-send.test.mjs
//
// F3 回归：发送必须以"后端已保存"的回执为准，失败时草稿不能丢，
// 发送期间新输入的文字也不能被回执一并清掉。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import * as viewer from '../src/utils/imageViewer.js'
import { ConsultSocket } from '../src/utils/consultSocket.js'

const script = readFileSync(new URL('../src/components/ConsultPanel.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '')

let behaviour = async () => {}
const toasts = []

class FakeSocket {
  connect() {}
  close() {}
  read() {}
  chatConfirmed(content, msgType) {
    return behaviour(content, msgType)
  }
}

function panel(kind = 'client') {
  const bindings = {
    computed, nextTick, reactive, ref, watch,
    onMounted: () => {}, onBeforeUnmount: () => {},
    defineEmits: () => () => {}, defineProps: () => ({
      sessionId: 9, kind, closed: false, previewOwner: null, peerLabel: '医生', doctorId: null
    }),
    useRouter: () => ({}),
    ElMessage: {
      error: m => toasts.push(['error', m]),
      warning: m => toasts.push(['warning', m]),
      success: m => toasts.push(['success', m])
    },
    consultMessages: async () => ({ records: [], total: 0 }),
    adminMessages: async () => ({ records: [], total: 0 }),
    upload: async () => ({ url: '/api/uploads/sent.png' }),
    ...viewer,
    toClock: v => v || '', toDate: v => v || '', toDateTime: v => v || '',
    ConsultSocket: FakeSocket
  }
  const api = new Function(...Object.keys(bindings), script +
    '\nreturn { send, sendImage, draft, sending, sendingImage, onFrame, openConsult, get sock() { return sock } }'
  )(...Object.values(bindings))
  api.openConsult()
  api.onFrame({ type: 'HISTORY', sessionId: 9, messages: [] })
  return api
}

const failures = []
async function check(name, action) {
  toasts.length = 0
  behaviour = async () => {}
  try {
    await action()
    console.log('PASS', name)
  } catch (error) {
    failures.push(name)
    console.error('FAIL', name, error.message)
  }
}

await check('保存回执到达后才清空草稿', async () => {
  const p = panel()
  p.draft.value = '呕吐两天了'
  await p.send()
  assert.equal(p.draft.value, '')
  assert.equal(p.sending.value, false)
})

await check('业务拒绝保留草稿并提示原因', async () => {
  const p = panel()
  behaviour = async () => { throw new Error('问诊已结束，会话已关闭') }
  p.draft.value = '还需要注意什么'
  await p.send()
  assert.equal(p.draft.value, '还需要注意什么')
  assert.equal(p.sending.value, false)
  assert.deepEqual(toasts.at(-1), ['error', '问诊已结束，会话已关闭'])
})

await check('非预期异常与断连同样保留草稿', async () => {
  for (const message of ['消息未保存，请稍后重试', '连接已断开，消息未发送']) {
    const p = panel()
    behaviour = async () => { throw new Error(message) }
    p.draft.value = '它今天不怎么吃东西'
    await p.send()
    assert.equal(p.draft.value, '它今天不怎么吃东西')
    assert.deepEqual(toasts.at(-1), ['error', message])
  }
})

await check('发送期间新输入的文字不被回执清掉', async () => {
  const p = panel()
  let confirm
  behaviour = () => new Promise(resolve => { confirm = resolve })
  p.draft.value = '第一段'
  const sending = p.send()
  p.draft.value = '第一段，补充：还伴随打喷嚏'
  confirm()
  await sending
  assert.equal(p.draft.value, '，补充：还伴随打喷嚏')
})

await check('草稿被改写时整段保留，不吞用户新内容', async () => {
  const p = panel()
  let confirm
  behaviour = () => new Promise(resolve => { confirm = resolve })
  p.draft.value = '旧的描述'
  const sending = p.send()
  p.draft.value = '完全重写的一段'
  confirm()
  await sending
  assert.equal(p.draft.value, '完全重写的一段')
})

await check('空白草稿不触发发送', async () => {
  const p = panel()
  let calls = 0
  behaviour = async () => { calls++ }
  p.draft.value = '   \n  '
  await p.send()
  assert.equal(calls, 0)
})

await check('图片与文字共用保存回执', async () => {
  const p = panel()
  let seen = null
  behaviour = async (content, type) => { seen = [content, type] }
  await p.sendImage({ target: { files: [new File(['x'], 'x.png')], value: '' } })
  assert.deepEqual(seen, ['/api/uploads/sent.png', 'IMAGE'])
  assert.equal(p.sendingImage.value, false)
})

await check('图片已上传但保存失败时明确提示', async () => {
  const p = panel()
  behaviour = async () => { throw new Error('连接已断开，消息未发送') }
  await p.sendImage({ target: { files: [new File(['x'], 'x.png')], value: '' } })
  assert.deepEqual(toasts.at(-1), ['error', '图片未发送：连接已断开，消息未发送'])
})

// ---------------------------------------------------------------- 协议层
// ACK 与 ERROR 都带 requestId；连接断开则整批拒绝，调用方据此保留草稿。
const sockets = []
class FakeWebSocket {
  static OPEN = 1
  constructor(url) {
    this.url = url
    this.readyState = 1
    this.sent = []
    sockets.push(this)
  }
  send(raw) { this.sent.push(JSON.parse(raw)) }
  close() {}
}
globalThis.WebSocket = FakeWebSocket
globalThis.location = { protocol: 'http:', host: '127.0.0.1:5173' }
globalThis.localStorage = { getItem: () => 'token', setItem() {}, removeItem() {} }

function openSocket() {
  const socket = new ConsultSocket({})
  socket.connect(9)
  const ws = sockets.at(-1)
  ws.onopen()
  return { socket, ws }
}

await check('ACK 按 requestId 对应到具体一次发送', async () => {
  const { socket, ws } = openSocket()
  const first = socket.chatConfirmed('一', 'TEXT')
  const second = socket.chatConfirmed('二', 'TEXT')
  assert.notEqual(ws.sent[0].requestId, ws.sent[1].requestId)
  ws.onmessage({ data: JSON.stringify({ type: 'ACK', requestId: ws.sent[1].requestId, message: { id: 2 } }) })
  assert.deepEqual(await second, { id: 2 })
  ws.onmessage({ data: JSON.stringify({ type: 'ACK', requestId: ws.sent[0].requestId, message: { id: 1 } }) })
  assert.deepEqual(await first, { id: 1 })
  socket.close()
})

await check('ERROR 帧按 requestId 拒绝并带上服务端原因', async () => {
  const { socket, ws } = openSocket()
  const pending = socket.chatConfirmed('嗨', 'TEXT')
  socket.chatConfirmed('另一条', 'TEXT').catch(() => {})
  ws.onmessage({
    data: JSON.stringify({ type: 'ERROR', msg: '问诊已结束，会话已关闭', requestId: ws.sent[0].requestId })
  })
  await assert.rejects(pending, /问诊已结束/)
  socket.close()
})

await check('连接断开时待确认的发送全部拒绝', async () => {
  const { socket, ws } = openSocket()
  const pending = socket.chatConfirmed('嗨', 'TEXT')
  ws.onclose({})
  await assert.rejects(pending, /连接已断开/)
  socket.close()
})

assert.deepEqual(failures, [], '发送回执回归失败')
