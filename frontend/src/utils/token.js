/**
 * 两套登录体系的 token 存放。
 *
 * 单独一个模块而不是放进 pinia store，是为了让 axios 拦截器也能直接读——
 * store 依赖 api、api 再依赖 store 会绕成循环引用。
 * 用户端和后台各存一份，同一浏览器里可以同时挂着两个身份，演示时很省事。
 */
const KEYS = { client: 'pet_clinic_client_token', admin: 'pet_clinic_admin_token' }

export function getToken(kind = 'client') {
  return localStorage.getItem(KEYS[kind]) || ''
}

export function setToken(kind, token) {
  localStorage.setItem(KEYS[kind], token)
}

export function clearToken(kind) {
  localStorage.removeItem(KEYS[kind])
}
