import { ref } from 'vue'
import { clearToken, getToken, setToken } from '@/utils/token'

/**
 * 两套登录态共用的会话持久化内部实现：写入、刷新、退出。
 *
 * 每次调用各自创建独立的响应式状态——两端（用户端/后台）互不共享，
 * 同一浏览器可以同时挂着两个身份。token 分类与 localStorage 键由调用方给定，
 * 公开形状（token/user + apply/refresh/logout）保持与原两份实现一致。
 */
export function createSession({ kind, userKey, fetchProfile }) {
  const token = ref(getToken(kind))
  const user = ref(JSON.parse(localStorage.getItem(userKey) || 'null'))

  function apply(vo) {
    token.value = vo.token
    user.value = vo
    setToken(kind, vo.token)
    localStorage.setItem(userKey, JSON.stringify(vo))
  }

  async function refresh() {
    if (!token.value) return null
    const p = await fetchProfile()
    user.value = { ...user.value, ...p }
    localStorage.setItem(userKey, JSON.stringify(user.value))
    return user.value
  }

  function logout() {
    token.value = ''
    user.value = null
    clearToken(kind)
    localStorage.removeItem(userKey)
  }

  return { token, user, apply, refresh, logout }
}
