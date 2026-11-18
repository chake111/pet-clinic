// Start Vite, then run with PLAYWRIGHT_PACKAGE pointing to an installed Playwright.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const base = process.env.PAYMENT_TEST_URL || 'http://127.0.0.1:5189'
const shots = new URL('../../output/playwright/payment-ticket/', import.meta.url)
await mkdir(shots, { recursive: true })
let count = 0
try {
  for (let round = 0; round < 4; round++) {
    for (const scenario of ['success', 'retry', 'lost-response', 'unknown', 'expired', 'missing', 'later', 'escape']) {
      const context = await browser.newContext({ viewport: { width: round === 0 ? 1440 : round === 1 ? 390 : 320, height: round === 3 ? 568 : 900 }, reducedMotion: round === 2 ? 'reduce' : 'no-preference' })
      const page = await context.newPage()
      async function capture(name) {
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
        })
        await page.screenshot({ path: fileURLToPath(new URL(name, shots)) })
      }
      const errors = []
      page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message) })
      await context.addInitScript(() => {
        localStorage.setItem('yuzhua_client_token', 'isolated-browser-test')
        localStorage.setItem('yuzhua_client_user', JSON.stringify({ id: 1, nickname: '测试' }))
      })
      let requests = 0, release
      const order = { id: 99, status: 0, payStatus: 0, orderNo: 'AP202610200028', amount: 60, petName: '奶糖', doctorName: '陈医生', queueNo: 6, appointmentDate: '2099-10-22', period: 1, startTime: '09:00:00', endTime: '12:00:00' }
      await page.route(base + '/api/**', async route => {
        const url = new URL(route.request().url()).pathname
        let data = null, code = 200, msg = ''
        if (url.endsWith('/pay')) {
          requests++
          await new Promise(resolve => { release = resolve })
          if (scenario === 'success' || (scenario === 'retry' && requests > 1)) order.payStatus = 1
          else { code = 500; msg = round === 3 ? '支付暂时未完成，预约信息已保留。请检查网络连接后重试，如仍无法完成，请稍后在预约详情中确认支付状态。' : '支付暂时未完成，请重试'; if (scenario === 'lost-response') order.payStatus = 1 }
        } else if (url.endsWith('/appointment/99')) {
          if (scenario === 'unknown') { code = 500; msg = '暂不可用' }
          data = order
        } else if (url.endsWith('/appointment') && route.request().method() === 'POST') {
          order.payDeadline = scenario === 'missing' ? null : new Date(Date.now() + (scenario === 'expired' ? 1500 : 1800000)).toISOString()
          data = order
        } else if (url.endsWith('/schedules')) data = [{ id: 10, workDate: '2099-10-22', period: 1, startTime: '09:00:00', endTime: '12:00:00', remainNum: 5, status: 1 }]
        else if (url.endsWith('/doctors/1')) data = { id: 1, name: '陈医生', status: 1, consultationFee: 60, departmentName: '内科' }
        else if (url.endsWith('/pet')) data = [{ id: 1, name: '奶糖', species: '猫' }]
        else if (url.endsWith('/unread')) data = 0
        await route.fulfill({ json: { code, msg, data } })
      })
      await page.goto(base + '/book/1?scheduleId=10')
      console.log('scenario', round, scenario, page.url());
      await page.locator('textarea').waitFor({timeout:8000}).catch(async e => { console.log(await page.locator('body').innerText()); throw e });
      await page.locator('textarea').fill('食欲下降两天')
      await page.getByRole('button', { name: '提交挂号' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.equal(await dialog.getByText('模拟支付', { exact: false }).count(), 0)
      await page.waitForFunction(() => document.querySelector('.ticket-primary') === document.activeElement)
      await page.keyboard.press('Shift+Tab')
      assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)))
      await page.keyboard.press('Tab')
      if (round === 0 && scenario === 'success') await capture('desktop.png')
      if (scenario === 'expired' || scenario === 'missing') {
        await dialog.getByRole('button', { name: '查看预约' }).waitFor()
        assert.equal(requests, 0)
      } else if (scenario === 'later' || scenario === 'escape') {
        if (scenario === 'later') await dialog.getByRole('button', { name: '稍后支付' }).click()
        else await page.keyboard.press('Escape')
        await page.waitForURL('**/order/99')
        assert.equal(requests, 0)
      } else {
        const beforePayment = await dialog.locator('.ticket-primary').boundingBox()
        await dialog.getByRole('button', { name: /确认支付/ }).click()
        await page.waitForFunction(() => document.querySelector('.ticket-primary')?.disabled)
        await page.waitForFunction(() => document.querySelector('.ticket-close')?.disabled)
        await page.keyboard.press('Escape')
        assert.ok(await dialog.isVisible())
        // Programmatic duplicate click also must not issue a second request.
        await dialog.locator('.ticket-primary').evaluate(el => el.click())
        while (!release) await new Promise(r => setTimeout(r, 10))
        assert.equal(requests, 1)
        if (round < 3) assert.ok(Math.abs((await dialog.locator('.ticket-primary').boundingBox()).y - beforePayment.y) < 2, 'payment button stays in place while processing')
        const animation = await dialog.locator('.ticket-spinner').evaluate(el => getComputedStyle(el).animationName)
        assert.equal(animation, round === 2 ? 'none' : 'ticket-spin')
        if (round === 0 && scenario === 'success') await capture('processing.png')
        release()
        if (scenario === 'retry') {
          await dialog.getByRole('button', { name: /重新支付/ }).waitFor()
          assert.ok(await dialog.getByText('奶糖', { exact: true }).isVisible())
          if (round === 0) { await dialog.getByRole('alert').waitFor(); await capture('retry.png') }
          if (round < 3) assert.ok(Math.abs((await dialog.locator('.ticket-primary').boundingBox()).y - beforePayment.y) < 2, 'retry button stays in place')
          if (round === 3) {
            await dialog.getByRole('alert').waitFor()
            await dialog.locator('.ticket-primary').scrollIntoViewIfNeeded()
            const box = await dialog.locator('.ticket-primary').boundingBox()
            assert.ok(box.y >= 0 && box.y + box.height <= 568, 'short viewport payment button is reachable')
            await capture('short-screen-long-error.png')
          }
          release = null
          await dialog.getByRole('button', { name: /重新支付/ }).click()
          while (!release) await new Promise(r => setTimeout(r, 10))
          release()
        }
        await dialog.getByRole('button', { name: '查看预约' }).waitFor()
        if (scenario === 'unknown') await dialog.getByText('暂时无法确认支付结果，请查看预约后确认。').waitFor()
        else await dialog.getByText('支付成功，请按预约时间到院').waitFor()
        if (scenario === 'success') {
          await capture(`success-${round}.png`)
          await dialog.getByRole('button', { name: '查看预约' }).click()
          await page.waitForURL('**/order/99')
        }
      }
      assert.deepEqual(errors, [])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await context.close()
      count++
    }
  }
  console.log(`PASS ${count} payment scenarios: desktop, 390px, 320px/reduced-motion, 320x568/long-error`)
} finally { await browser.close() }
