// node tools/trace_id_check.mjs --config <isolated runtime.json>
//
// H4 回归：500 的追踪号要能从响应体拿到、与响应头一致、并且真能在日志里定位到那一次。
//
// 断言四段：
//   1. 触发一个真实的 500 → 响应头有 X-Trace-Id，响应 msg 里回显同一个号
//   2. 该号出现在应用日志里，且那一行带 method 与 uri
//   3. 合法入站 X-Trace-Id 被沿用（网关串联场景）
//   4. 只沿用 32 位小写 hex 的入站头；超长/含空白/自定义前缀/W3C traceparent 一律换新号
//
// 500 由 `GET /admin/user/abc`（路径变量类型不匹配）稳定触发，不写库。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const configFlag = process.argv.indexOf('--config')
assert.ok(configFlag >= 0 && process.argv[configFlag + 1], '需要 --config <runtime.json>')
const configPath = resolve(process.argv[configFlag + 1])
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
execFileSync(process.env.PYTHON || 'python', ['tools/qa_env.py', 'instance', '--config', configPath],
  { stdio: 'inherit' })
assert.match(cfg.db, /^yuzhua_test_[a-f0-9]{8}$/, '只允许在隔离测试库运行')
assert.equal(cfg.api, 'http://127.0.0.1:8082/api', '后端地址必须是隔离实例 8082')
// backendLog 是相对仓库根的路径（qa_env.py 的约定），不能叠加配置目录
const logPath = resolve(cfg.backendLog ?? '.tmp/qa/backend.log')

async function login() {
  const response = await fetch(`${cfg.api}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' })
  })
  const json = await response.json()
  assert.equal(json.code, 200, `admin 登录失败：${json.msg}`)
  return json.data.token
}

const token = await login()
const failures = []

async function probe(headers = {}) {
  const response = await fetch(`${cfg.api}/admin/user/abc`, {
    headers: { Authorization: 'Bearer ' + token, ...headers },
    signal: AbortSignal.timeout(15000)
  })
  return { status: response.status, traceId: response.headers.get('x-trace-id'), body: await response.json() }
}

/** 日志按平台编码落盘，gbk 解出来的中文才可读；解码失败时退回 utf-8 */
function readLog() {
  const raw = readFileSync(logPath)
  for (const encoding of ['utf8', 'gbk']) {
    try {
      return new TextDecoder(encoding, { fatal: encoding === 'utf8' }).decode(raw)
    } catch { /* 换下一种 */ }
  }
  return raw.toString('latin1')
}

try {
  // 1. 响应头与响应体必须是同一个号
  const first = await probe()
  assert.equal(first.body.code, 500, `应触发 500，实际 ${first.body.code}`)
  assert.ok(first.traceId, '响应头缺少 X-Trace-Id')
  assert.match(first.traceId, /^[A-Za-z0-9-]{8,64}$/, `追踪号格式异常：${first.traceId}`)
  assert.ok(first.body.msg.includes(first.traceId),
    `响应 msg 未回显追踪号 ${first.traceId}：${first.body.msg}`)
  console.log('PASS 1 响应头与响应 msg 的追踪号一致', first.traceId)

  // 2. 这个号要能在日志里定位到具体那一次（含 method 与 uri）
  const log = readLog()
  const line = log.split(/\r?\n/).find(l => l.includes(first.traceId) && l.includes('系统异常'))
  assert.ok(line, `日志里找不到追踪号 ${first.traceId} 对应的异常行`)
  assert.ok(line.includes('method=GET'), `异常行缺少 method：${line.slice(0, 160)}`)
  assert.ok(line.includes('uri=/api/admin/user/abc'), `异常行缺少 uri：${line.slice(0, 160)}`)
  console.log('PASS 2 日志里有该号的异常行，含 method 与 uri')

  // 同一次请求的其它日志行也应带上这个号，不只是异常那一行。
  // 只断言 ">=1" 是空断言——上面的 PASS 2 已经保证了至少一行。
  const traceLines = log.split(/\r?\n/).filter(l => l.includes(first.traceId))
  assert.ok(traceLines.length >= 2,
    `该追踪号只出现在 ${traceLines.length} 行；至少要有一条异常之外的日志才叫"贯穿"`)
  assert.ok(traceLines.some(l => !/\sERROR\s/.test(l)),
    `含该号的日志行全是 ERROR，说明没有贯穿业务日志：${traceLines[0].slice(0, 120)}`)
  console.log('PASS 3 同一追踪号贯穿该请求的日志行数', traceLines.length, '（含非 ERROR 行）')

  // 3. 合法入站号沿用
  const inbound = '9d47a390ecb540fba0328bacf05658a0'
  const reused = await probe({ 'X-Trace-Id': inbound })
  assert.equal(reused.traceId, inbound, `合法入站号应沿用，实际 ${reused.traceId}`)
  assert.ok(reused.body.msg.includes(inbound), '响应 msg 未沿用入站追踪号')
  console.log('PASS 4 合法入站 X-Trace-Id 被沿用')

  // 4. 只认自己生成的形状。泛化白名单会让匿名客户端指定固定号、把多条请求的日志并成一条，
  //    所以连"看起来像 ID"的值也要拒：W3C traceparent、自定义前缀、大写 hex。
  for (const bad of [
    'x'.repeat(200),                                            // 超长会刷屏
    'has space',                                                // 含空白破坏格式
    'a',                                                        // 过短
    'AAAAAAAA',                                                 // 匿名固定值
    'gateway-abc-12345',                                        // 自定义前缀
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',  // W3C traceparent
    '9D47A390ECB540FBA0328BACF05658A0'                          // 大写不是本系统形状
  ]) {
    const replaced = await probe({ 'X-Trace-Id': bad })
    assert.notEqual(replaced.traceId, bad, `不合规入站号不应原样回写：${bad.slice(0, 24)}`)
    assert.match(replaced.traceId, /^[0-9a-f]{32}$/, `替换后的号形状不对：${replaced.traceId}`)
  }
  console.log('PASS 5 非本系统形状的入站 X-Trace-Id 被替换为新号')
} catch (error) {
  failures.push(error.message)
  console.error('FAIL', error.message)
}

if (failures.length) {
  console.error(`TRACE ID CHECK FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('TRACE ID CHECK PASSED')
