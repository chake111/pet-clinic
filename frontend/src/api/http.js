import axios from 'axios'
import { ElMessage } from 'element-plus'
import { clearToken, getToken } from '@/utils/token'
import { httpFailureAction } from './httpError'

/**
 * 全站唯一的 axios 实例。
 *
 * 应用业务响应约定 HTTP 状态恒为 200，业务码在 body.code（200/400/401/403/404/405/500），
 * 所以业务成败只看 body.code，不看 res.status。HTTP / 代理 / 网络层错误（502、连接失败、
 * 超时）不适用这套约定，会落到下面的错误分支统一提示。
 * 用户端与后台共用这个实例：带哪个 token 由请求路径前缀决定。
 */
const http = axios.create({ baseURL: '/api', timeout: 20000 })

http.interceptors.request.use((cfg) => {
  // 少数接口（如后台里传图片到 /common/upload）需要显式指定身份，走 config.kind
  const kind = cfg.kind || (String(cfg.url).startsWith('/admin') ? 'admin' : 'client')
  const token = getToken(kind)
  if (token) cfg.headers.Authorization = 'Bearer ' + token
  // FormData 交给浏览器自己带 boundary，写死 JSON 头会让上传失败
  if (cfg.data instanceof FormData) delete cfg.headers['Content-Type']
  return cfg
})

http.interceptors.response.use(
  (res) => {
    const body = res.data
    if (!body || typeof body.code === 'undefined') return body
    const kind = res.config.kind || (String(res.config.url).startsWith('/admin') ? 'admin' : 'client')
    if (body.code === 200) return body
    const action = httpFailureAction({
      business: true, code: body.code, msg: body.msg, silent: res.config.silent
    })
    if (action.type === 'reauth') {
      clearToken(kind)
      const target = kind === 'admin' ? '/admin/login' : '/login'
      if (location.pathname !== target) {
        // 整页跳转而非路由跳转：顺手把内存里的登录态一起清掉，比逐个 reset store 可靠
        location.replace(`${target}?redirect=${encodeURIComponent(location.pathname + location.search)}`)
      }
    } else if (action.type === 'notify') {
      ElMessage.error(action.message)
    }
    return Promise.reject(Object.assign(new Error(body.msg || '业务失败'), { code: body.code }))
  },
  (err) => {
    const action = httpFailureAction({
      business: false, timeout: err.message?.includes('timeout'), silent: err.config?.silent
    })
    if (action.type === 'notify') {
      ElMessage.error(action.message)
    }
    return Promise.reject(err)
  }
)

/** 只取 Result.data；需要 msg 的场景直接用 http */
const unwrap = (p) => p.then((r) => r.data)

export const get = (url, params, cfg) => unwrap(http.get(url, { params, ...cfg }))
export const post = (url, data, cfg) => unwrap(http.post(url, data, cfg))
export const put = (url, data, cfg) => unwrap(http.put(url, data, cfg))
export const del = (url, cfg) => unwrap(http.delete(url, cfg))
/** 公共上传接口只认 file/files 两个参数名；kind 决定带哪一侧的 token */
export const upload = (file, kind) => {
  const fd = new FormData()
  fd.append('file', file)
  return unwrap(http.post('/common/upload', fd, { kind }))
}

export default http
