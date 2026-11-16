import { getToken } from './token.js'

/**
 * 图文问诊的 WebSocket 客户端。
 *
 * 浏览器建连时不能自定义请求头，token 只能挂在 query 上（后端也只在这里接受 query token）。
 * 协议四类上行 / 数类下行，见后端 ConsultWebSocketHandler 的类注释。
 *
 * 握手携带 sessionId 自动订阅；每次 HISTORY 重置最近消息窗口，更早记录按 beforeId 查询。
 */
export class ConsultSocket {
  constructor({ kind = 'client', onFrame, onState } = {}) {
    this.kind = kind
    this.onFrame = onFrame || (() => {})
    this.onState = onState || (() => {})
    this.room = null
    this.ws = null
    this.pingTimer = null
    this.retry = 0
    this.dead = false
    this.timer = null
    this.pending = new Map()
    this.sequence = 0
  }

  buildUrl(sessionId) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let url = `${proto}://${location.host}/api/ws/consult?token=${encodeURIComponent(getToken(this.kind))}`
    if (sessionId) url += `&sessionId=${sessionId}`
    return url
  }

  connect(sessionId) {
    if (sessionId) this.room = sessionId
    if (this.dead || this.ws) return
    if (!getToken(this.kind)) {
      this.dead = true
      this.onState('failed')
      return
    }
    clearTimeout(this.timer)
    this.timer = null
    this.onState('connect')
    const ws = new WebSocket(this.buildUrl(this.room))
    this.ws = ws
    const current = () => !this.dead && this.ws === ws
    ws.onopen = () => {
      if (!current()) return
      this.onState('open')
      this.startPing()
    }
    ws.onmessage = (e) => {
      if (!current()) return
      let frame
      try { frame = JSON.parse(e.data) } catch { return }
      if (!frame || typeof frame !== 'object') return
      const request = this.pending.get(frame.requestId)
      if (request && (frame.type === 'ACK' || frame.type === 'ERROR')) {
        clearTimeout(request.timer)
        this.pending.delete(frame.requestId)
        frame.type === 'ACK' ? request.resolve(frame.message) : request.reject(new Error(frame.msg || '发送失败'))
        return
      }
      if (frame.type === 'HISTORY') {
        if (frame.sessionId !== this.room) return
        this.retry = 0
      }
      this.onFrame(frame)
    }
    ws.onclose = (e) => {
      if (!current()) return
      this.ws = null
      this.rejectPending()
      this.stopPing()
      if (e.reason === 'replaced') {
        this.dead = true
        this.onState('replaced')
        return
      }
      if (this.retry >= 4) {
        this.dead = true
        this.onState('failed')
        return
      }
      this.onState('close')
      const wait = 500 * 2 ** this.retry++
      this.timer = setTimeout(() => this.connect(), wait)
    }
    ws.onerror = () => {
      if (current()) this.onState('error')
    }
  }

  startPing() {
    this.stopPing()
    // 空闲连接会被中间层掐掉，30s 一次 PING 保活
    this.pingTimer = setInterval(() => this.send({ type: 'PING' }), 30000)
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
      return true
    }
    return false
  }

  /**
   * 发一条需要保存确认的消息。
   *
   * 只有收到后端 ACK（消息已落库）才 resolve；业务拒绝、连接断开、回执超时都 reject，
   * 调用方据此保留草稿。不再提供"发出即成功"的 fire-and-forget 版本——浏览器发送成功
   * 只代表字节进了 socket，后端可能因会话已结束等原因拒收。
   */
  chatConfirmed(content, msgType) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('连接已断开，消息未发送'))
    }
    const requestId = String(++this.sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('尚未收到保存回执，请核对聊天记录后重试'))
      }, 10000)
      this.pending.set(requestId, { resolve, reject, timer })
      if (!this.send({ type: 'CHAT', sessionId: this.room, msgType, content, requestId })) this.rejectPending()
    })
  }

  rejectPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('连接已断开，请核对聊天记录后重试'))
    }
    this.pending.clear()
  }

  read() {
    return this.send({ type: 'READ', sessionId: this.room })
  }

  close() {
    this.rejectPending()
    this.dead = true
    this.stopPing()
    clearTimeout(this.timer)
    this.timer = null
    this.ws?.close()
    this.ws = null
  }
}
