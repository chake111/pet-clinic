// Real browser + isolated backend. PLAYWRIGHT_PACKAGE may point at an installed package.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const configPath = process.argv[process.argv.indexOf('--config') + 1]
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
execFileSync(process.env.PYTHON || 'python', ['tools/qa_env.py', 'instance', '--config', configPath], { stdio: 'inherit' })
const base = process.env.MAIN_FLOW_URL || 'http://127.0.0.1:5197'
assert.equal(base, 'http://127.0.0.1:5197')
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright')
const out = 'output/playwright/main-flow-20261021'
mkdirSync(out, { recursive: true })
const tokens = {}, errors = [], results = []
async function api(who, method, path, body) {
  const r = await (await fetch(cfg.api + path, { method, headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: 'Bearer ' + tokens[who] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json()
  assert.equal(r.code, 200, `${path}: ${r.msg}`); return r.data
}
for (const who of ['admin', 'zhangsan']) tokens[who] = (await api(who, 'POST', `/${who === 'admin' ? 'admin' : 'client'}/auth/login`, { username: who, password: '123456' })).token
const petName = '浏览器测试' + Date.now().toString(36)
await api('zhangsan', 'POST', '/client/pet', { name: petName, species: '猫' })
let schedules = await api('zhangsan', 'GET', '/client/catalog/doctors/1/schedules')
let sch = schedules.find(s => s.status === 1 && s.remainNum > 0 && s.workDate > new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()))
if (!sch) {
  const workDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() + 86400000 * 3))
  sch = await api('admin', 'POST', '/admin/schedule', { doctorId: 1, workDate, period: 3, startTime: '18:00:00', endTime: '22:00:00', totalNum: 10, status: 1 })
}
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const owner = await browser.newContext({ viewport: { width: 1365, height: 900 } })
const doctor = await browser.newContext({ viewport: { width: 1365, height: 900 } })
const u = await owner.newPage(), d = await doctor.newPage()
for (const page of [u, d]) { page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)) }
async function login(page, side, who) {
  await page.goto(base + (side === 'admin' ? '/admin/login' : '/login'))
  await page.getByPlaceholder('请输入登录账号').fill(who)
  await page.getByPlaceholder('请输入密码', { exact: true }).fill('123456')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(url => !url.pathname.endsWith('/login'))
}
try {
  await login(u, 'client', 'zhangsan'); await login(d, 'admin', 'doctor01')
  console.log('PASS UI-login')
  await u.goto(`${base}/book/1?scheduleId=${sch.id}`)
  await u.locator('label.pet').filter({ has: u.getByRole('radio', { name: petName, exact: true }) }).click()
  await u.getByRole('textbox', { name: '症状描述' }).fill('浏览器主流程：食欲下降两天')
  const created = u.waitForResponse(r => r.url().endsWith('/api/client/appointment') && r.request().method() === 'POST')
  await u.getByRole('button', { name: '提交挂号' }).click()
  const result = await (await created).json(); assert.equal(result.code, 200); const order = result.data
  await u.getByRole('button', { name: /确认支付/ }).click()
  await u.getByRole('button', { name: '查看预约', exact: true }).click()
  await u.waitForURL(`**/order/${order.id}`)
  assert.equal((await api('zhangsan', 'GET', `/client/appointment/${order.id}`)).payStatus, 1)
  console.log('PASS UI-book-pay', order.id)
  await d.goto(`${base}/admin/workbench/${order.id}`)
  await d.getByRole('button', { name: '开始接诊', exact: true }).click()
  await d.locator('.el-form-item').filter({ hasText: '诊断结论' }).locator('textarea').fill('浏览器验证诊断')
  await d.getByRole('button', { name: '保存病历', exact: true }).click()
  await d.getByRole('button', { name: '保存病历', exact: true }).waitFor()
  await d.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存病历' && b.disabled))
  await d.getByRole('button', { name: '结束就诊', exact: true }).click()
  await d.getByRole('button', { name: '确认结束', exact: true }).click()
  await d.getByRole('dialog').waitFor({ state: 'hidden' })
  await u.goto(`${base}/review/${order.id}`)
  await u.getByRole('button', { name: '提交评价', exact: true }).click()
  await u.waitForURL(`**/order/${order.id}`)
  assert.equal((await api('zhangsan', 'GET', `/client/appointment/${order.id}`)).isReviewed, 1)
  await u.screenshot({ path: `${out}/appointment-completed.png`, fullPage: true })
  results.push('appointment'); console.log('PASS UI-record-finish-review')
  await u.goto(`${base}/consult/new/1`)
  await u.locator('label.pet').filter({ has: u.getByRole('radio', { name: petName, exact: true }) }).click()
  await u.getByRole('textbox', { name: '症状描述' }).fill('浏览器双端问诊')
  const consultation = u.waitForResponse(r => r.url().endsWith('/api/client/consult/sessions') && r.request().method() === 'POST')
  await u.getByRole('button', { name: '发起问诊', exact: true }).click()
  const cr = await (await consultation).json(); assert.equal(cr.code, 200); const id = cr.data.id
  await u.waitForURL(`**/consult/${id}`)
  await d.goto(`${base}/admin/consult/${id}`)
  await d.getByRole('button', { name: '接诊', exact: true }).click()
  await u.getByRole('textbox', { name: '问诊消息' }).fill('主人消息验证')
  await u.getByRole('button', { name: '发送消息' }).click()
  await d.getByText('主人消息验证', { exact: true }).waitFor()
  await d.getByRole('textbox', { name: '问诊回复' }).fill('医生回复验证')
  await d.getByRole('button', { name: '发送消息' }).click()
  await u.getByText('医生回复验证', { exact: true }).waitFor()
  await d.getByRole('button', { name: '建议到院', exact: true }).click()
  await d.getByRole('button', { name: '发送建议', exact: true }).click()
  await u.getByRole('button', { name: /挂号|预约/ }).last().waitFor()
  await u.reload(); await u.getByText('医生回复验证', { exact: true }).waitFor()
  await d.setViewportSize({ width: 390, height: 844 })
  await d.screenshot({ path: `${out}/consult-mobile.png`, fullPage: true })
  await d.getByRole('button', { name: '结束问诊', exact: true }).click()
  await d.getByPlaceholder('记录本次沟通要点、观察事项及到院建议（选填）').fill('观察食欲，必要时到院')
  await d.getByRole('button', { name: '确认结束', exact: true }).click()
  await d.getByRole('dialog').waitFor({ state: 'hidden' })
  await u.reload(); await u.getByText('医生回复验证', { exact: true }).waitFor()
  assert.equal((await api('zhangsan', 'GET', `/client/consult/sessions/${id}`)).status, 2)
  assert.equal(await u.getByRole('button', { name: '发送消息' }).count(), 0)
  results.push('consultation'); console.log('PASS UI-consult-send-reload-close', id)
  assert.deepEqual(errors, [])
} catch (e) {
  for (const [name, page] of [['owner', u], ['doctor', d]]) {
    writeFileSync(`${out}/${name}-failure.txt`, await page.locator('body').innerText())
    await page.screenshot({ path: `${out}/${name}-failure.png`, fullPage: true })
  }
  console.error(e); process.exitCode = 1
} finally {
  console.log(JSON.stringify({ results, pageErrors: errors }))
  await browser.close()
}
