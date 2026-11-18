#!/usr/bin/env node
/**
 * 按 manifest 重拍 docs/screenshots/ 的品牌截图。
 *
 * 采集模式：
 *   viewport  manifest 基线视口大小，fullPage=false，只截首屏
 *   table     定位表格/主卡片元素，按基线 CSS 高度裁切，宽度随元素自然宽
 *   full      fullPage 截图，整页高度必须与基线一致，上限 2500 CSS
 *
 * 前置：临时 MySQL 3307 + 后端 8081 + 前端 5197，演示数据已就绪。
 * Playwright 默认取 'playwright'，可用 PLAYWRIGHT_PACKAGE 指向全局安装；
 * 浏览器默认 msedge，失败回退 chromium。
 */
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'tools', 'screenshots.manifest.json')
const shotsDir = join(root, 'docs', 'screenshots')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const shots = manifest.screenshots || []
const README_RATIO_FILES = new Set([
  '04-client-doctors.png', '06-client-booking.png', '10-client-consultroom.png',
  '11-client-records.png', '21-admin-dashboard.png', '23-admin-schedule.png',
  '24-admin-doctors.png', '28-admin-users.png', '29-admin-pets.png',
  '31-doctor-workbench.png', '33-admin-consult-records.png'
])
const FULL_MAX_CSS_HEIGHT = 2500
const CAPTURE_MODES = ['viewport', 'table', 'full']

const argv = process.argv.slice(2)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const only = valueOf('--only')
const base = (valueOf('--base') || manifest.base || 'http://127.0.0.1:5197').replace(/\/+$/, '')
const dryRun = argv.includes('--dry-run')

function fail(message) {
  console.error(`\nERROR: ${message}`)
  process.exit(1)
}

function pngSize(file) {
  const buffer = readFileSync(file)
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error(`不是 PNG: ${file}`)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function targetCss(shot) {
  return {
    width: Math.round(shot.target.width / shot.deviceScaleFactor),
    height: Math.round(shot.target.height / shot.deviceScaleFactor)
  }
}

function validateManifest() {
  if (!shots.length) fail('manifest 没有 screenshots')
  const files = new Set()
  for (const shot of shots) {
    if (!shot.file || !shot.path || !shot.viewport || !shot.deviceScaleFactor) {
      fail(`manifest 条目缺少字段: ${JSON.stringify(shot)}`)
    }
    if (!CAPTURE_MODES.includes(shot.capture)) fail(`${shot.file}: capture 必须是 ${CAPTURE_MODES.join(' / ')}`)
    if (!shot.target?.width || !shot.target?.height) fail(`${shot.file}: 缺少 target.width/height`)
    if (shot.capture === 'table' && !shot.tableSelector) fail(`${shot.file}: table 模式缺少 tableSelector`)
    if (files.has(shot.file)) fail(`manifest 文件名重复: ${shot.file}`)
    files.add(shot.file)
    if (!manifest.roles?.[shot.role] && !shot.guest) fail(`${shot.file}: 未定义角色 ${shot.role}`)
    if (![1, 2, 3].includes(shot.deviceScaleFactor)) fail(`${shot.file}: deviceScaleFactor 只支持 1/2/3`)
    if (shot.target.width % shot.deviceScaleFactor !== 0) {
      fail(`${shot.file}: target.width ${shot.target.width} 不能被 DPR ${shot.deviceScaleFactor} 整除`)
    }
    if (shot.capture === 'viewport') {
      const css = targetCss(shot)
      if (shot.viewport.width !== css.width) fail(`${shot.file}: viewport 宽 ${shot.viewport.width} 与 target/DPR ${css.width} 不一致`)
      if (Math.abs(shot.viewport.height - css.height) > 1) fail(`${shot.file}: viewport 高 ${shot.viewport.height} 与 target/DPR ${css.height} 误差超过 1px`)
    }
    if (shot.capture === 'full' && Math.abs(shot.viewport.width - shot.target.width / shot.deviceScaleFactor) > 1) {
      fail(`${shot.file}: full 模式 viewport 宽必须等于 target/DPR`)
    }
  }
}

function selectedShots() {
  if (!only) return shots
  const matches = shots.filter((s) => s.file === only || s.file.includes(only))
  if (!matches.length) fail(`--only 没有匹配项: ${only}`)
  return matches
}

function describeShot(shot) {
  const css = targetCss(shot)
  return `${shot.file}  [${shot.capture}] target ${shot.target.width}x${shot.target.height}px (${css.width}x${css.height} CSS @${shot.deviceScaleFactor}x)` +
    (shot.tableSelector ? `  selector ${shot.tableSelector}` : '') +
    `  ${shot.path}`
}

async function main() {
  validateManifest()
  const list = selectedShots()

  if (dryRun) {
    const counts = Object.fromEntries(CAPTURE_MODES.map((mode) => [mode, list.filter((s) => s.capture === mode).length]))
    console.log(`[dry-run] ${list.length}/${shots.length} 项，目标目录 ${shotsDir}`)
    console.log(`[dry-run] 模式分布: ${CAPTURE_MODES.map((mode) => `${mode} ${counts[mode]}`).join(' / ')}`)
    for (const shot of list) console.log(`  - ${describeShot(shot)}  [${shot.role}${shot.guest ? ' / guest' : ''}]`)
    console.log('[dry-run] manifest 校验通过，浏览器未启动。')
    return
  }

  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright')
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'msedge'
  let browser
  try {
    browser = await chromium.launch({ channel, headless: true })
    console.log(`[browser] ${channel}`)
  } catch (error) {
    console.warn(`[browser] ${channel} 启动失败，回退 chromium: ${error.message.split('\n')[0]}`)
    browser = await chromium.launch({ headless: true })
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'yuzhua-shots-'))
  const roleStates = new Map()
  const failures = []
  const warnings = []
  const results = []

  async function loginRole(role) {
    if (roleStates.has(role)) return roleStates.get(role)
    const cfg = manifest.roles?.[role]
    if (!cfg) throw new Error(`未定义角色 ${role}`)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    try {
      await page.goto(`${base}${cfg.login}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.getByPlaceholder('请输入登录账号').fill(cfg.username)
      await page.getByPlaceholder('请输入密码', { exact: true }).fill(cfg.password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20000 })
      await page.waitForTimeout(300)
      const state = await context.storageState()
      roleStates.set(role, state)
      console.log(`[login] ${role} -> ${cfg.username}`)
      return state
    } finally {
      await context.close()
    }
  }

  function attachErrors(page) {
    const collected = []
    let active = true
    page.on('pageerror', (error) => {
      if (active) collected.push(`pageerror: ${error.message}`)
    })
    page.on('console', (message) => {
      if (active && message.type() === 'error') collected.push(`console: ${message.text()}`)
    })
    return { collected, stop: () => { active = false } }
  }

  async function waitForImages(page) {
    await page.evaluate(async () => {
      const images = [...document.images]
      await Promise.all(images.map((img) => {
        if (img.complete) return Promise.resolve()
        return new Promise((resolve) => {
          const done = () => resolve()
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
          setTimeout(done, 4000)
        })
      }))
    }).catch(() => {})
    await page.evaluate(() => document.fonts?.ready).catch(() => {})
  }

  async function runAction(page, action) {
    switch (action.type) {
      case 'click':
        await page.locator(action.selector).first().click()
        break
      case 'fill':
        await page.locator(action.selector).first().fill(action.value ?? '')
        break
      case 'hover':
        await page.locator(action.selector).first().hover()
        break
      case 'wait':
        await page.waitForTimeout(action.ms ?? 300)
        break
      case 'waitFor':
        await page.waitForSelector(action.selector, { state: 'visible', timeout: 20000 })
        break
      case 'press':
        await page.locator(action.selector).first().press(action.key)
        break
      default:
        throw new Error(`未知 action 类型: ${action.type}`)
    }
  }

  function assertTexts(bodyText, shot) {
    for (const required of shot.assertText || []) {
      const needle = required.replace(/\s+/g, ' ')
      if (!bodyText.includes(needle)) throw new Error(`缺少文案「${required}」`)
    }
  }

  async function fullPageHeight(page) {
    return page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0
    ))
  }

  async function fitFullPage(page, shot) {
    const width = Math.round(shot.target.width / shot.deviceScaleFactor)
    for (let i = 0; i < 5; i += 1) {
      const current = page.viewportSize().height
      const height = Math.min(await fullPageHeight(page), FULL_MAX_CSS_HEIGHT)
      const target = Math.max(Math.min(shot.viewport.height, FULL_MAX_CSS_HEIGHT), height)
      if (Math.abs(target - current) <= 1) return
      await page.setViewportSize({ width, height: target })
      await page.waitForTimeout(300)
    }
  }

  async function fitTableElement(page, shot) {
    const css = targetCss(shot)
    const selector = shot.tableSelector
    let box = await page.locator(selector).first().boundingBox()
    for (let i = 0; i < 5; i += 1) {
      if (!box) throw new Error(`找不到表格元素 ${selector}`)
      if (Math.abs(box.width - css.width) <= 1.5) break
      const viewport = page.viewportSize()
      const chrome = viewport.width - box.width
      const nextWidth = Math.max(320, Math.round(css.width + chrome))
      if (Math.abs(nextWidth - viewport.width) <= 1) break
      await page.setViewportSize({ width: nextWidth, height: viewport.height })
      await page.waitForTimeout(350)
      await page.evaluate(() => window.scrollTo(0, 0))
      box = await page.locator(selector).first().boundingBox()
    }
    if (!box) throw new Error(`找不到表格元素 ${selector}`)
    return box
  }

  async function capture(shot, index) {
    const dsf = shot.deviceScaleFactor
    const css = targetCss(shot)
    const targetWidth = shot.target.width
    const targetHeight = shot.target.height
    const initialViewport = shot.capture === 'viewport'
      ? { width: css.width, height: css.height }
      : shot.capture === 'table'
        ? { width: shot.viewport.width, height: shot.viewport.height }
        : { width: css.width, height: shot.viewport.height }

    const storageState = shot.guest ? undefined : await loginRole(shot.role)
    const context = await browser.newContext({
      viewport: { ...initialViewport },
      deviceScaleFactor: dsf,
      reducedMotion: 'reduce',
      storageState
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    const tracker = attachErrors(page)
    const tempFile = join(tempDir, shot.file)
    let tableBox = null

    try {
      await page.goto(`${base}${shot.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.evaluate(() => document.fonts?.ready).catch(() => {})
      if (shot.waitFor) await page.waitForSelector(shot.waitFor, { state: 'visible', timeout: 25000 })
      for (const action of shot.actions || []) await runAction(page, action)
      await waitForImages(page)
      await page.evaluate(() => window.scrollTo(0, 0))

      let overflowX = 0
      if (shot.capture === 'viewport') {
        await page.setViewportSize({ width: css.width, height: css.height })
        await page.waitForTimeout(250)
        const bodyText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
        assertTexts(bodyText, shot)
        overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.screenshot({ path: tempFile, fullPage: false, animations: 'disabled' })
      } else if (shot.capture === 'table') {
        const clipCssHeight = Math.min(css.height, FULL_MAX_CSS_HEIGHT)
        const viewportHeight = Math.max(800, Math.min(clipCssHeight + 400, FULL_MAX_CSS_HEIGHT + 200))
        await page.setViewportSize({ width: page.viewportSize().width, height: viewportHeight })
        await page.waitForTimeout(300)
        const box = await fitTableElement(page, shot)
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.waitForTimeout(250)
        const finalBox = await page.locator(shot.tableSelector).first().boundingBox()
        if (!finalBox) throw new Error(`找不到表格元素 ${shot.tableSelector}`)
        const bodyText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
        assertTexts(bodyText, shot)
        overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        const clip = {
          x: Math.max(0, Math.round(finalBox.x)),
          y: Math.max(0, Math.round(finalBox.y)),
          width: Math.round(finalBox.width),
          height: Math.min(clipCssHeight, Math.floor(finalBox.height))
        }
        tableBox = { width: finalBox.width, height: finalBox.height, clipWidth: clip.width, clipHeight: clip.height, selector: shot.tableSelector }
        await page.screenshot({ path: tempFile, fullPage: true, clip, animations: 'disabled' })
        // 保留一次宽度复核，实际宽度以 PNG 为准
        void box
      } else {
        await fitFullPage(page, shot)
        await page.waitForTimeout(300)
        const bodyText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
        assertTexts(bodyText, shot)
        overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.screenshot({ path: tempFile, fullPage: true, animations: 'disabled' })
      }

      const size = pngSize(tempFile)
      const widthError = Math.abs(size.width - targetWidth)
      const heightError = Math.abs(size.height - targetHeight)
      if (shot.capture === 'full') {
        if (widthError > 2) throw new Error(`截图宽 ${size.width} 与基线 ${targetWidth} 误差超过 2px`)
        if (heightError > 2) throw new Error(`full 截图高 ${size.height} 与基线 ${targetHeight} 误差超过 2px`)
        if (size.height > FULL_MAX_CSS_HEIGHT * dsf) throw new Error(`full 截图高度 ${size.height}px 超过 ${FULL_MAX_CSS_HEIGHT} CSS 上限`)
      } else if (shot.capture === 'table') {
        if (widthError > Math.max(2, Math.round(targetWidth * 0.05))) {
          throw new Error(`表格截图宽 ${size.width} 与目标 ${targetWidth} 误差超过 5%`)
        }
        if (heightError > 2) throw new Error(`表格截图高 ${size.height} 与目标 ${targetHeight} 误差超过 2px`)
      } else {
        if (widthError > 2) throw new Error(`截图宽 ${size.width} 与目标 ${targetWidth} 误差超过 2px`)
        if (heightError > 2) throw new Error(`截图高 ${size.height} 与目标 ${targetHeight} 误差超过 2px`)
      }
      const ratio = size.height / size.width
      if (README_RATIO_FILES.has(shot.file) && ratio > 3.0) {
        throw new Error(`README 引用图高/宽 ${ratio.toFixed(2)} 超过 3.0`)
      }
      if (tracker.collected.length) {
        throw new Error(`页面错误:\n    ${tracker.collected.join('\n    ')}`)
      }

      mkdirSync(shotsDir, { recursive: true })
      copyFileSync(tempFile, join(shotsDir, shot.file))
      results.push({ file: shot.file, capture: shot.capture, targetWidth, targetHeight, size, widthError, heightError, ratio, tableBox })
      if (overflowX > 2) warnings.push(`${shot.file}: 文档横向溢出 ${overflowX}px`)
      console.log(`[${index}/${list.length}] ${shot.file}  [${shot.capture}]  ${size.width}x${size.height}  target ${targetWidth}x${targetHeight}  ✓`)
    } finally {
      tracker.stop()
      await context.close().catch(() => {})
      if (existsSync(tempFile)) rmSync(tempFile, { force: true })
    }
    return tableBox
  }

  try {
    for (let i = 0; i < list.length; i += 1) {
      const shot = list[i]
      try {
        await capture(shot, i + 1)
      } catch (error) {
        failures.push({ file: shot.file, capture: shot.capture, message: error.message })
        console.error(`[${i + 1}/${list.length}] ${shot.file}  [${shot.capture}]  ✗\n    ${error.message}`)
      }
    }
  } finally {
    await browser.close().catch(() => {})
    rmSync(tempDir, { recursive: true, force: true })
  }

  console.log(`\n完成：成功 ${results.length}/${list.length}，失败 ${failures.length}`)
  if (results.length) {
    console.log('\n| 文件 | 模式 | 目标 px | 实际 px | Δ宽 | Δ高 | 高/宽 | 元素宽 CSS |')
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const r of results) {
      const tableWidth = r.tableBox ? r.tableBox.width.toFixed(1) : '—'
      console.log(`| ${r.file} | ${r.capture} | ${r.targetWidth}x${r.targetHeight} | ${r.size.width}x${r.size.height} | ${r.widthError} | ${r.heightError} | ${r.ratio.toFixed(2)} | ${tableWidth} |`)
    }
  }
  if (warnings.length) {
    console.log(`\n横向溢出提示 ${warnings.length} 条：`)
    for (const warning of warnings) console.log(`  - ${warning}`)
  }
  if (failures.length) {
    console.log('\n失败项：')
    for (const failure of failures) console.log(`  - ${failure.file} [${failure.capture}]: ${failure.message}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
