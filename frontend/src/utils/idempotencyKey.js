/**
 * 下单幂等键：一次下单意图对应一个键。
 * 优先用 crypto.randomUUID；老浏览器没有该 API 时用时间戳+随机串兜底。
 * 键只用于服务端去重，不需要不可预测性。
 */
export function newIdempotencyKey(cryptoImpl = globalThis.crypto) {
  const uuid = cryptoImpl?.randomUUID?.()
  if (uuid) return uuid
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}