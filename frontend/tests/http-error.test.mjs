// node tests/http-error.test.mjs
//
// silent 只抑制提示：业务失败、断网、超时都不该让未读轮询周期性弹窗；
// 业务 401 例外，仍必须清理登录态并跳转。
import assert from 'node:assert/strict'
import { httpFailureAction } from '../src/api/httpError.js'

const business = (code, msg, silent = false) =>
  httpFailureAction({ business: true, code, msg, silent })
const network = (timeout, silent = false) =>
  httpFailureAction({ business: false, timeout, silent })

assert.deepEqual(business(400, '该时段已约满'), { type: 'notify', message: '该时段已约满' })
assert.deepEqual(business(400, ''), { type: 'notify', message: '操作未成功' })
assert.deepEqual(business(400, '该时段已约满', true), { type: 'silent' })
assert.deepEqual(business(403, '无权访问', true), { type: 'silent' })
assert.deepEqual(business(401, '请先登录'), { type: 'reauth' })
assert.deepEqual(business(401, '请先登录', true), { type: 'reauth' }, '静默请求的 401 仍需重新登录')

assert.deepEqual(network(false), { type: 'notify', message: '连接失败，请稍后重试' })
assert.deepEqual(network(true), { type: 'notify', message: '请求超时，请稍后重试' })
assert.deepEqual(network(false, true), { type: 'silent' })
assert.deepEqual(network(true, true), { type: 'silent' })

console.log('http-error passed: business/network/timeout, silent and 401')
