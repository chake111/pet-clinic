import { del, get, post, put } from './http'

/**
 * 用户端（宠物主人）接口，按后端 controller 分组。
 * 路径都相对 /api，见 src/api/http.js。
 */

// —— 认证 ——
export const login = (d) => post('/client/auth/login', d)
export const register = (d) => post('/client/auth/register', d)
export const profile = () => get('/client/auth/profile')
export const updateProfile = (d) => put('/client/auth/profile', d)
export const changePassword = (d) => put('/client/auth/password', d)

// —— 公开目录：未登录也能浏览，登录态只影响"我的"数据 ——
export const departments = () => get('/client/catalog/departments')
export const doctors = (params) => get('/client/catalog/doctors', params)
export const doctorDetail = (id) => get(`/client/catalog/doctors/${id}`)
export const doctorReviews = (id, params) => get(`/client/catalog/doctors/${id}/reviews`, params)
export const doctorSchedules = (id, params) => get(`/client/catalog/doctors/${id}/schedules`, params)
export const homeData = () => get('/client/catalog/home')
export const notices = (params) => get('/client/catalog/notices', params)
export const noticeDetail = (id) => get(`/client/catalog/notices/${id}`)

// —— 宠物档案 ——
export const pets = () => get('/client/pet')
export const createPet = (d) => post('/client/pet', d)
export const updatePet = (id, d) => put(`/client/pet/${id}`, d)
export const removePet = (id) => del(`/client/pet/${id}`)

// —— 预约与模拟支付 ——
export const createAppointment = (d, config) => post('/client/appointment', d, config)
export const payAppointment = (id, config) => post(`/client/appointment/${id}/pay`, undefined, config)
export const cancelAppointment = (id, d) => post(`/client/appointment/${id}/cancel`, d)
export const appointmentPage = (params) => get('/client/appointment/page', params)
export const appointmentDetail = (id, config) => get(`/client/appointment/${id}`, undefined, config)
export const appointmentRecord = (id) => get(`/client/appointment/${id}/record`)

// —— 病历、评价、图文问诊 ——
export const recordPage = (params) => get('/client/record/page', params)
export const recordDetail = (id) => get(`/client/record/${id}`)
export const submitReview = (d) => post('/client/review', d)
export const consultSessions = (params) => get('/client/consult/sessions', params)
export const consultDetail = (id) => get(`/client/consult/sessions/${id}`)
export const createConsult = (d) => post('/client/consult/sessions', d)
export const consultUnread = () => get('/client/consult/unread', null, { silent: true })
export const consultMessages = (id, params) => get(`/client/consult/${id}/messages`, params)
export const closeConsult = (id) => post(`/client/consult/${id}/close`)
