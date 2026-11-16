// node tests/consult-governance.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import * as viewer from '../src/utils/imageViewer.js'

const script = readFileSync(new URL('../src/components/ConsultPanel.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '')
/**
 * 建一个面板测试实例。
 *
 * 显式传入 `doc` 时会装成 `globalThis.document` 并**真正执行 onMounted 回调**，
 * 这样 `addEventListener('visibilitychange', ...)` 的接线本身也在测试范围内；
 * 不传时行为与之前一致（不挂载），供只看 onFrame 行为的用例使用。
 */
function panel(kind = 'client', previewOwner = null, doc = null) {
  let reads = 0
  // read() 被调用的次数（含连接不可写、返回 false 的那次）。用它区分
  // "压根没尝试发" 与 "尝试了但发不出去" —— 前者是正确行为，后者才需要担忧。
  let attempts = 0
  // read() 的返回值：真实 ConsultSocket#read 在连接非 OPEN 时返回 false。
  let writable = true
  const events = []
  const mounted = []
  let unmount
  const bindings = {
    computed, nextTick, reactive, ref, watch,
    onMounted: fn => mounted.push(fn),
    onBeforeUnmount: fn => { unmount = fn },
    defineEmits: () => (...args) => events.push(args), defineProps: () => ({ sessionId: 9, kind, closed: false, previewOwner, peerLabel: '医生' }),
    useRouter: () => ({}), ElMessage: { error() {} }, ...viewer,
    toDateTime: value => value || '',
    ConsultSocket: class {
      connect() {}
      close() {}
      read() {
        attempts++
        if (!writable) return false
        reads++
        return true
      }
    }
  }
  // doc 在实例生命周期内必须一直挂着：卸载时组件要通过 globalThis.document 解绑监听，
  // 提前还原会让 removeEventListener 落在 undefined 上，测试就测不出漏解绑。
  const restoreDoc = doc ? Object.getOwnPropertyDescriptor(globalThis, 'document') : null
  if (doc) globalThis.document = doc
  const result = new Function(...Object.keys(bindings), script +
    '\nreturn { onFrame, onState, openConsult, openShot, rows, historyReady, pageVisible, markReadIfSeen, onVisibilityChange }')(...Object.values(bindings))
  // 先跑 openConsult 让 historyReady 可被后续 HISTORY 置位，再执行 onMounted（它内部也会调）
  result.openConsult()
  for (const fn of mounted) fn()
  return {
    ...result,
    events,
    reads: () => reads,
    readAttempts: () => attempts,
    setReadWritable: value => { writable = value },
    unmount: () => unmount(),
    restore: () => {
      if (doc && restoreDoc) Object.defineProperty(globalThis, 'document', restoreDoc)
      else if (doc) delete globalThis.document
    }
  }
}

/** 最小 document 桩：只关心 visibilityState 与 visibilitychange 的注册/注销 */
function fakeDocument(visibilityState = 'visible') {
  const listeners = new Set()
  return {
    visibilityState,
    addEventListener(type, fn) { if (type === 'visibilitychange') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'visibilitychange') listeners.delete(fn) },
    get listenerCount() { return listeners.size },
    /** 模拟浏览器切换可见性：改状态并派发事件 */
    fire(next) {
      this.visibilityState = next
      for (const fn of [...listeners]) fn()
    }
  }
}
function symptomGallery(previewOwner) {
  const source = readFileSync(new URL('../src/components/ImageGallery.vue', import.meta.url), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '')
  return new Function('computed', 'defineProps', 'openImageViewer', source + '\nreturn { open }')(
    computed, () => ({ urls: ['/symptom-1.png', '/symptom-2.png'], captions: [], label: '症状照片', previewOwner }), viewer.openImageViewer)
}
const image = (id, url = `/test-${id}.png`) => ({ id, sessionId: 9, senderRole: 'DOCTOR', msgType: 'IMAGE', content: url })
const history = (p, messages) => p.onFrame({ type: 'HISTORY', sessionId: 9, messages })
const hide = (p, id) => p.onFrame({ type: 'MESSAGE_VISIBILITY', sessionId: 9, messageId: id, hidden: 1 })
const restore = (p, message) => p.onFrame({ type: 'MESSAGE_VISIBILITY', sessionId: 9, messageId: message.id, hidden: 0, message })
const failures = []
async function check(name, action) {
  try { viewer.closeImageViewer(); await action(); console.log('PASS', name) }
  catch (error) { failures.push(name); console.error('FAIL', name, error.message) }
}
await check('屏蔽当前图片关闭预览并清理切换列表', () => {
  const p = panel(); history(p, [image(1), image(2)]); p.openShot(image(1)); hide(p, 1)
  assert.equal(viewer.imageViewer.open, false)
  assert.deepEqual([...viewer.imageViewer.urls], [])
})
await check('屏蔽整场会话清理该面板预览', () => {
  const p = panel(); history(p, [image(1)]); p.openShot(image(1))
  p.onFrame({ type: 'MODERATION', sessionId: 9, moderateStatus: 2 })
  assert.equal(viewer.imageViewer.open, false)
  assert.deepEqual([...viewer.imageViewer.urls], [])
})
for (const kind of ['client', 'admin']) {
  await check(`${kind}：会话处置和离开页面清理症状照片，保留其他会话预览`, () => {
    const room = readFileSync(new URL(`../src/views/${kind}/ConsultRoom.vue`, import.meta.url), 'utf8')
    for (const component of ['ImageGallery', 'ConsultPanel']) {
      assert.match(room.match(new RegExp(`<${component}\\b[^>]*>`))[0], /:preview-owner="previewOwner"/)
    }
    const owner = new Function(room.match(/const previewOwner = [^\r\n]+/)[0] + '; return previewOwner')()
    for (const status of [1, 2]) {
      const p = panel(kind, owner)
      symptomGallery(owner).open(0)
      assert.equal(viewer.imageViewer.open, true)
      p.onFrame({ type: 'MODERATION', sessionId: 9, moderateStatus: status })
      assert.equal(viewer.imageViewer.open, false)
      assert.deepEqual([...viewer.imageViewer.urls], [])
    }
    const p = panel(kind, owner)
    symptomGallery(owner).open(1)
    p.unmount()
    assert.equal(viewer.imageViewer.open, false)
    symptomGallery(Symbol('other-consult')).open(0)
    p.onFrame({ type: 'MODERATION', sessionId: 9, moderateStatus: 2 })
    assert.equal(viewer.imageViewer.open, true)
  })
}
await check('屏蔽非当前图片后切换列表清除该图片', () => {
  const p = panel(); history(p, [image(1), image(2)]); p.openShot(image(1)); hide(p, 2)
  assert.ok(!viewer.imageViewer.urls.includes(image(2).content))
})
await check('治理当前面板时保留其他来源的预览', () => {
  const p = panel(); viewer.openImageViewer(['/unrelated.png']); hide(p, 1)
  assert.equal(viewer.imageViewer.open, true)
  assert.deepEqual([...viewer.imageViewer.urls], ['/unrelated.png'])
})
await check('断线期间恢复的消息随新连接历史显示', () => {
  const p = panel(); history(p, [image(1)]); hide(p, 1)
  p.onState('close'); p.onState('connect'); p.onState('open'); history(p, [image(1)])
  assert.deepEqual(p.rows.value.map(m => m.id), [1])
})
await check('新连接同步期间屏蔽事件继续过滤随后到达的旧快照', () => {
  const p = panel(); p.onState('connect'); p.onState('open'); hide(p, 1)
  history(p, [image(1), image(2)])
  assert.deepEqual(p.rows.value.map(m => m.id), [2])
})
await check('双方在线恢复对方消息发送READ，恢复本人消息不发送', () => {
  for (const kind of ['client', 'admin']) {
    const p = panel(kind); history(p, [])
    const before = p.reads()
    restore(p, { ...image(1), senderRole: kind === 'client' ? 'DOCTOR' : 'USER', isRead: 0 })
    assert.equal(p.reads(), before + 1)
    restore(p, { ...image(2), senderRole: kind === 'client' ? 'USER' : 'DOCTOR', isRead: 0 })
    assert.equal(p.reads(), before + 1)
  }
})
await check('同步期间恢复的消息在历史就绪后确认已读', () => {
  const p = panel(); restore(p, image(1)); assert.equal(p.reads(), 0)
  history(p, []); assert.equal(p.reads(), 1)
  assert.deepEqual(p.rows.value.map(m => m.id), [1])
})
await check('页面不可见时收到对侧消息不标已读，切回可见才补标', () => {
  const p = panel(); history(p, [])
  const before = p.reads()
  // 后台标签页/锁屏：连接照常收帧，但没有人看见内容
  p.pageVisible.value = false
  p.onFrame({ type: 'MSG', sessionId: 9, message: { ...image(1), senderRole: 'DOCTOR', msgType: 'TEXT', content: '在吗' } })
  assert.equal(p.reads(), before, '不可见页面上收到消息不应标已读')
  // 切回前台，用户这时才看见这条消息
  p.pageVisible.value = true
  p.markReadIfSeen()
  assert.equal(p.reads(), before + 1)
})

await check('onState(error) 不清 historyReady，已读不会被永久卡住', () => {
  const p = panel()
  p.onState('open')
  history(p, [])
  assert.equal(p.historyReady.value, true)
  const before = p.reads()

  // ws.onerror 可能在没有紧接 close 的情况下单独触发：连接其实还开着。
  // 这时若把 historyReady 清成 false，就再也不会收到新 HISTORY（没断就不重连），
  // markReadIfSeen 会永久提前返回。
  p.onState('error')
  assert.equal(p.historyReady.value, true, 'error 状态不应清掉 historyReady')

  p.onFrame({ type: 'MSG', sessionId: 9, message: { ...image(1), senderRole: 'DOCTOR', msgType: 'TEXT', content: '还能收到' } })
  assert.equal(p.reads(), before + 1, 'error 之后仍应能标已读')
})

await check('historyReady 是 read 的前置门：断线期间根本不尝试发，重连后由 HISTORY 补上', () => {
  const p = panel()
  p.onState('open')
  history(p, [])
  const sent = p.reads()
  const tried = p.readAttempts()

  // 真实重连时序：close → connect → open → HISTORY。
  // 断线与退避期间 historyReady 已被清掉，所以 markReadIfSeen 连 read() 都不会调——
  // 不存在"发出去了但被丢掉"的帧，也就不需要补发队列。
  p.setReadWritable(false)
  p.onState('close')
  p.onState('connect')
  p.markReadIfSeen()                 // 模拟切回前台
  assert.equal(p.readAttempts(), tried, '断线期间不应尝试发 READ')
  assert.equal(p.reads(), sent, '断线期间没有发出去')

  p.setReadWritable(true)
  p.onState('open')
  assert.equal(p.readAttempts(), tried, 'open 本身不尝试，等服务端 HISTORY')
  assert.equal(p.reads(), sent, 'open 本身不补发')

  // 服务端每次建连都回 HISTORY，渲染完成时才是真正发 READ 的时刻。
  history(p, [])
  assert.equal(p.reads(), sent + 1, '重连后的 HISTORY 发一次 READ')
})

await check('visibilitychange 真的接线：挂 1 次、卸载解 1 次、切回前台补发 READ', () => {
  const doc = fakeDocument('hidden')
  const p = panel('client', null, doc)
  try {
    // 挂载后只注册一个监听器
    assert.equal(doc.listenerCount, 1, `应只挂一个 visibilitychange 监听，实际 ${doc.listenerCount}`)
    // 初始不可见：HISTORY 渲染完成也不该发 READ
    const before = p.reads()
    history(p, [])
    assert.equal(p.reads(), before, '初始不可见时 HISTORY 不应触发 READ')
    assert.equal(p.pageVisible.value, false, '初始值应取自 document.visibilityState')

    // 浏览器切回前台 → 走真实的事件回调，不是手动调 markReadIfSeen
    doc.fire('visible')
    assert.equal(p.pageVisible.value, true)
    assert.equal(p.reads(), before + 1, '切回前台应补发一次 READ')

    // 卸载必须解绑，否则组件反复挂载会累积监听
    p.unmount()
    assert.equal(doc.listenerCount, 0, `卸载后应解绑，实际还剩 ${doc.listenerCount}`)
  } finally {
    p.restore()
  }
})
await check('标题栏在线状态随同步、断线和结束更新', async () => {
  const p = panel()
  const presence = () => p.events.filter(([name]) => name === 'presenceChanged').at(-1)?.[1]
  assert.equal(presence(), '')
  p.onState('open'); history(p, [])
  await nextTick()
  assert.equal(presence(), '医生暂时离线，可先留言')
  p.onFrame({ type: 'PRESENCE', sessionId: 9, doctorOnline: true })
  await nextTick()
  assert.equal(presence(), '医生在线')
  p.onState('close')
  await nextTick()
  assert.equal(presence(), '')
  p.onState('open'); history(p, [])
  p.onFrame({ type: 'PRESENCE', sessionId: 9, doctorOnline: true })
  await nextTick()
  assert.equal(presence(), '医生在线')
  p.onFrame({ type: 'SESSION', sessionId: 9, status: 2 })
  await nextTick()
  assert.equal(presence(), '')
})
viewer.closeImageViewer()
assert.deepEqual(failures, [], '问诊治理回归失败')
