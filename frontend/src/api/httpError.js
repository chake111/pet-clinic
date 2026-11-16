/**
 * HTTP 失败的决策函数：只回答"该提示什么、该重新登录、还是什么都不做"。
 *
 * 刻意不依赖 Vue、Element Plus 或浏览器全局对象，便于直接跑单元测试。
 * 业务 401 无论请求是否静默，都必须清理登录态并跳转——静默只抑制消息提示，
 * 不能把已失效的会话留在页面上继续轮询。
 *
 * @param {object} input
 * @param {boolean} input.business true=应用业务响应（body.code），false=HTTP/网络层错误
 * @param {number} [input.code] 业务码
 * @param {string} [input.msg] 业务提示
 * @param {boolean} [input.timeout] 是否超时
 * @param {boolean} [input.silent] 是否静默（如未读轮询）
 * @returns {{type: 'reauth'}|{type: 'silent'}|{type: 'notify', message: string}}
 */
export function httpFailureAction({ business, code, msg, timeout = false, silent = false }) {
  if (business && code === 401) {
    return { type: 'reauth' }
  }
  if (silent) {
    return { type: 'silent' }
  }
  if (business) {
    return { type: 'notify', message: msg || '操作未成功' }
  }
  return { type: 'notify', message: timeout ? '请求超时，请稍后重试' : '连接失败，请稍后重试' }
}
