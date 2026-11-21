#!/usr/bin/env node
/**
 * 演示视频 Playwright 录制与断言脚本（P2）。
 *
 * 规矩与约束：
 * - 规矩一：动态加载 frontend/src/brand.js，脚本与分镜均不硬编码品牌名。
 * - 规矩二：所有录屏与 timeline.json 输出到 output/demo-video/<日期>/（不入库）。
 * - 规矩三：零 pageerror / console.error、逐镜头 assertText、零账号密码泄露断言、
 *           DPR 2 分辨率与 0 灰边自动校验、北京时间 21:30 门禁。
 * - 时钟校准：每路录屏片头注入 0.45s 绿→蓝数字打板器，录完由 FFmpeg 定位跳变帧 k，
 *             反推 recordedStartEpochMs（误差 ≤±20ms），所有 tSec/trim/gap 统一以原始
 *             WebM 第 0 帧为原点，双路分屏用 leftMinusRightSec = leftAnchorSec - rightAnchorSec 对齐。
 *
 * 用法：
 *   node tools/demo-video/record.mjs --dry-run
 *   node tools/demo-video/record.mjs [--base http://127.0.0.1:8088] [--date 2026-11-21] [--out output/demo-video/2026-11-21]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const DEFAULT_STORYBOARD = join(ROOT, 'tools', 'demo-video', 'storyboard.json')
const BRAND_MODULE_PATH = join(ROOT, 'frontend', 'src', 'brand.js')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    base: process.env.DEMO_VIDEO_BASE || '',
    date: '',
    out: '',
    storyboard: DEFAULT_STORYBOARD,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge'
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--base') args.base = argv[++i]
    else if (a.startsWith('--base=')) args.base = a.slice(7)
    else if (a === '--date') args.date = argv[++i]
    else if (a.startsWith('--date=')) args.date = a.slice(7)
    else if (a === '--out') args.out = argv[++i]
    else if (a.startsWith('--out=')) args.out = a.slice(6)
    else if (a === '--storyboard') args.storyboard = resolve(argv[++i])
    else if (a.startsWith('--storyboard=')) args.storyboard = resolve(a.slice(13))
    else if (a === '--channel') args.channel = argv[++i]
    else if (a.startsWith('--channel=')) args.channel = a.slice(10)
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tools/demo-video/record.mjs [--dry-run] [--base <url>] [--date <YYYY-MM-DD>] [--out <dir>] [--storyboard <path>] [--channel <msedge|chrome|chromium>]')
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${a}`)
    }
  }
  return args
}

function nowInTimezone(tz = 'Asia/Shanghai') {
  const now = new Date()
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now).map((p) => [p.type, p.value])
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
    iso: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000
const round4 = (n) => Math.round(n * 10000) / 10000

async function loadBrand(brandSourceRel = 'frontend/src/brand.js') {
  const abs = resolve(ROOT, brandSourceRel)
  if (!existsSync(abs)) throw new Error(`找不到品牌唯一事实源: ${abs}`)
  const mod = await import(pathToFileURL(abs).href)
  if (!mod.BRAND?.name) throw new Error(`${brandSourceRel} 未导出 BRAND.name`)
  return mod.BRAND
}

function expandBrand(text, brand) {
  if (typeof text !== 'string') return text
  return text.replace(/\{\{\s*brand\.(\w+)\s*\}\}/g, (_, key) => {
    if (!(key in brand)) throw new Error(`未知品牌占位符 {{brand.${key}}}`)
    return String(brand[key])
  })
}

function scanHardcodedBrand(node, brandName, path = '$', hits = []) {
  if (typeof node === 'string') {
    if (node.includes(brandName)) hits.push(`${path}: "${node}"`)
    return hits
  }
  if (Array.isArray(node)) {
    node.forEach((item, idx) => scanHardcodedBrand(item, brandName, `${path}[${idx}]`, hits))
    return hits
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      scanHardcodedBrand(v, brandName, `${path}.${k}`, hits)
    }
  }
  return hits
}

function collectAssertTextArrays(assertField) {
  if (Array.isArray(assertField)) return [{ key: 'default', list: assertField }]
  if (assertField && typeof assertField === 'object') {
    return Object.entries(assertField)
      .filter(([, v]) => Array.isArray(v))
      .map(([key, list]) => ({ key, list }))
  }
  return []
}

function validateStoryboard(storyboard, brand) {
  const issues = []
  if (!storyboard || typeof storyboard !== 'object') {
    throw new Error('storyboard.json 根节点必须是对象')
  }

  const maxSubtitleChars = storyboard.videoSpec?.maxSubtitleChars ?? 14
  const maxTargetBudget = storyboard.videoSpec?.targetDurationSec ?? 58
  const maxHardBudget = storyboard.videoSpec?.maxDurationSec ?? 60

  // 1. 规矩一：严禁硬编码品牌名
  const brandHits = scanHardcodedBrand(storyboard, brand.name)
  if (brandHits.length) {
    issues.push(`发现硬编码品牌名（应改用 {{brand.name}}）：\n  - ${brandHits.join('\n  - ')}`)
  }
  if (storyboard.brandSource !== 'frontend/src/brand.js') {
    issues.push(`brandSource 应为 frontend/src/brand.js（实际 ${storyboard.brandSource}）`)
  }
  if (storyboard.videoSpec?.silent !== true) {
    issues.push('videoSpec.silent 必须为 true（全片静音）')
  }

  // 2. 视口与 DPR 2 / recordSize = 2x 门禁
  const viewports = storyboard.viewports || {}
  for (const key of ['phone', 'desktop', 'fullscreen', 'landing']) {
    const vp = viewports[key]
    if (!vp) {
      issues.push(`缺少 viewports.${key} 配置`)
      continue
    }
    if (vp.dpr !== 2) issues.push(`viewports.${key}.dpr 必须为 2（实际 ${vp.dpr}）`)
    const expW = vp.width * vp.dpr
    const expH = vp.height * vp.dpr
    if (vp.recordSize?.width !== expW || vp.recordSize?.height !== expH) {
      issues.push(`viewports.${key}.recordSize 应为 ${expW}x${expH}（实际 ${vp.recordSize?.width}x${vp.recordSize?.height}）`)
    }
  }

  // 3. 逐镜头校验：数量、预算、字幕 ≤14 字、assertText 占位符、actionId 与 zoomTargets 闭环
  const shots = Array.isArray(storyboard.shots) ? storyboard.shots : []
  if (shots.length !== 8) {
    issues.push(`镜头数应为 8，实际 ${shots.length}`)
  }

  let totalSec = 0
  const shotSummaries = []
  const seenShotIds = new Set()
  const forbiddenSubs = (storyboard.forbiddenVisibleText || []).map((s) => ({
    label: s,
    re: s === 'admin' ? /\badmin\b/i : new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }))

  shots.forEach((shot, idx) => {
    const shotId = shot.shotId || `S${String(idx + 1).padStart(2, '0')}`
    if (seenShotIds.has(shotId)) issues.push(`重复 shotId: ${shotId}`)
    seenShotIds.add(shotId)

    const dur = Number(shot.durationSec)
    if (!Number.isFinite(dur) || dur <= 0) {
      issues.push(`${shotId}: durationSec 无效`)
    } else {
      totalSec += dur
    }

    const subtitle = expandBrand(String(shot.subtitle || ''), brand).trim()
    const subtitleSegments = Array.isArray(shot.subtitles)
      ? shot.subtitles.map((seg, sIdx) => {
          const text = expandBrand(String(seg?.text || ''), brand).trim()
          const ratio = Number(seg?.atRatio)
          if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
            issues.push(`${shotId}.subtitles[${sIdx}]: atRatio 无效（须在 [0, 1]）`)
          }
          return text
        })
      : []

    const allowEmptySubtitle = shot.layout === 'landing_outro' && Boolean(shot.cta)
    const captionTexts = subtitleSegments.length ? subtitleSegments : (subtitle ? [subtitle] : [])
    if (!captionTexts.length && !allowEmptySubtitle) {
      issues.push(`${shotId}: 缺少 subtitle`)
    }
    let maxCaptionLen = 0
    for (const cap of captionTexts) {
      const len = [...cap].length
      if (!cap) {
        issues.push(`${shotId}: subtitles 存在空文案`)
        continue
      }
      if (len > maxCaptionLen) maxCaptionLen = len
      if (len > maxSubtitleChars) {
        issues.push(`${shotId}: 字幕超长（${len} > ${maxSubtitleChars}）：「${cap}」`)
      }
      for (const { label, re } of forbiddenSubs) {
        if (re.test(cap)) issues.push(`${shotId}: 字幕命中禁用词 ${label}：「${cap}」`)
      }
    }
    if (subtitle && !subtitleSegments.length && [...subtitle].length > maxSubtitleChars) {
      // 已在上面循环校验，此处仅作语义保留
    } else if (subtitle && subtitleSegments.length) {
      const compatLen = [...subtitle].length
      if (compatLen > maxSubtitleChars) {
        issues.push(`${shotId}: 兼容字段 subtitle 超长（${compatLen} > ${maxSubtitleChars}）：「${subtitle}」`)
      }
      for (const { label, re } of forbiddenSubs) {
        if (re.test(subtitle)) issues.push(`${shotId}: subtitle 命中禁用词 ${label}：「${subtitle}」`)
      }
    }
    const featureTag = expandBrand(String(shot.featureTag || ''), brand).trim()
    for (const { label, re } of forbiddenSubs) {
      if (featureTag && re.test(featureTag)) issues.push(`${shotId}: featureTag 命中禁用词 ${label}：「${featureTag}」`)
    }

    const assertGroups = collectAssertTextArrays(shot.assertText)
    const assertCount = assertGroups.reduce((sum, g) => sum + g.list.length, 0)
    if (assertCount === 0) issues.push(`${shotId}: 缺少 assertText`)
    for (const g of assertGroups) {
      for (const item of g.list) {
        try { expandBrand(item, brand) } catch (e) { issues.push(`${shotId}.assertText.${g.key}: ${e.message}`) }
      }
    }

    const actionIds = new Set((shot.actions || []).map((a) => a.id).filter(Boolean))
    for (const z of shot.zoomTargets || []) {
      if (z.actionId && !actionIds.has(z.actionId)) {
        issues.push(`${shotId}: zoomTargets 引用了不存在的 actionId「${z.actionId}」`)
      }
    }

    for (const [, vpKey] of Object.entries(shot.viewportRefs || {})) {
      if (!viewports[vpKey]) issues.push(`${shotId}: viewportRefs 引用了未定义视口「${vpKey}」`)
    }

    shotSummaries.push({
      shotId,
      durationSec: dur || 0,
      roles: (shot.roles || []).join('+'),
      layout: shot.layout || '—',
      featureTag: featureTag || '—',
      subtitle: captionTexts.length ? captionTexts.join(' / ') : '（落地页自带文案）',
      subtitleLen: maxCaptionLen,
      assertCount
    })
  })

  if (totalSec > maxTargetBudget) {
    issues.push(`总预算 ${round3(totalSec)}s 超过目标预算 ${maxTargetBudget}s`)
  }
  if (totalSec > maxHardBudget) {
    issues.push(`总预算 ${round3(totalSec)}s 超过硬上限 ${maxHardBudget}s`)
  }

  // 4. 校验 S08 landingCapture 静态源文件存在
  const s8 = shots[7]
  if (s8?.landingCapture?.sourceFile) {
    const absLanding = resolve(ROOT, s8.landingCapture.sourceFile)
    if (!existsSync(absLanding)) {
      issues.push(`S08.landingCapture.sourceFile 不存在: ${absLanding}`)
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    totalSec: round3(totalSec),
    maxTargetBudget,
    maxSubtitleChars,
    shotSummaries
  }
}

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [process.env.PLAYWRIGHT_PACKAGE, 'playwright'].filter(Boolean)
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'playwright'))
  }
  try {
    const globalRoot = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (globalRoot) candidates.push(join(globalRoot, 'playwright'))
  } catch { /* ignore */ }

  for (const candidate of candidates) {
    try {
      const mod = require(candidate)
      return { mod, source: candidate }
    } catch { /* next */ }
  }
  throw new Error('无法加载 Playwright，请设置 PLAYWRIGHT_PACKAGE 指向已安装的 playwright 目录')
}

async function launchDpr2Browser(chromium, preferredChannel) {
  const launchArgs = ['--force-device-scale-factor=2']
  const attempts = [
    preferredChannel ? { channel: preferredChannel, headless: true, args: launchArgs } : null,
    preferredChannel !== 'msedge' ? { channel: 'msedge', headless: true, args: launchArgs } : null,
    preferredChannel !== 'chrome' ? { channel: 'chrome', headless: true, args: launchArgs } : null,
    { channel: 'chromium', headless: true, args: launchArgs },
    { headless: true, args: launchArgs }
  ].filter(Boolean)

  const errs = []
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch(opts)
      console.log(`[browser] ${opts.channel || 'bundled-chromium'} v${browser.version()} (--force-device-scale-factor=2)`)
      return browser
    } catch (err) {
      errs.push(`${opts.channel || 'bundled'}: ${err.message.split('\n')[0]}`)
    }
  }
  throw new Error(`无法启动 Chromium 浏览器:\n  ${errs.join('\n  ')}`)
}

function startReadOnlyStaticServer(rootDir) {
  const absRoot = resolve(ROOT, rootDir)
  return new Promise((resolvePromise, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const pathname = decodeURIComponent((req.url || '/').split('?')[0])
        const rel = pathname === '/' ? 'agent-draft.html' : pathname.replace(/^\/+/, '')
        const abs = resolve(absRoot, rel)
        if (!abs.startsWith(absRoot) || !existsSync(abs) || statSync(abs).isDirectory()) {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
        const ext = extname(abs).toLowerCase()
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' })
        res.end(readFileSync(abs))
      } catch (err) {
        res.writeHead(500)
        res.end(String(err.message))
      }
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

function probeVideo(videoPath) {
  const raw = execFileSync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-count_frames',
    videoPath
  ], { encoding: 'utf8' })
  const info = JSON.parse(raw)
  const vs = info.streams.find((s) => s.codec_type === 'video')
  if (!vs) throw new Error(`ffprobe 未找到视频流: ${videoPath}`)
  const [num, den] = String(vs.r_frame_rate || '25/1').split('/').map(Number)
  const fps = den ? num / den : 25
  const durationSec = Number(info.format.duration || vs.duration || 0)
  return {
    width: Number(vs.width),
    height: Number(vs.height),
    codec: vs.codec_name,
    fps: round3(fps),
    frames: Number(vs.nb_read_frames || Math.round(durationSec * fps)),
    durationSec: round3(durationSec)
  }
}

/**
 * 扫描视频前 3.5s（4×4 RGB），定位非蓝→纯蓝(#0000ff)跳变帧 k（主基准）及
 * 纯蓝结束后的首个业务帧 firstContentFrame（同时可作极端冷启动的备选锚点）。
 */
function detectClapperboard(videoPath, fps) {
  const buf = execFileSync('ffmpeg', [
    '-v', 'error',
    '-t', '3.5',
    '-i', videoPath,
    '-vf', 'scale=4:4',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-'
  ])
  const frameBytes = 4 * 4 * 3
  const count = Math.floor(buf.length / frameBytes)
  const avgRgb = (idx) => {
    const off = idx * frameBytes
    let r = 0; let g = 0; let b = 0
    for (let p = 0; p < 16; p += 1) {
      r += buf[off + p * 3]
      g += buf[off + p * 3 + 1]
      b += buf[off + p * 3 + 2]
    }
    return [r / 16, g / 16, b / 16]
  }
  const isGreenish = ([r, g, b]) => g > r + 15 && g > b + 15
  const isBlue = ([r, g, b]) => b > 170 && r < 80 && g < 80

  let seenPreSlate = false
  let clapperFrame = -1
  let firstBlueFrame = -1
  let firstContentFrame = -1
  for (let i = 0; i < count; i += 1) {
    const rgb = avgRgb(i)
    if (firstBlueFrame < 0 && isBlue(rgb)) firstBlueFrame = i
    if (clapperFrame < 0) {
      if (!isBlue(rgb)) {
        if (isGreenish(rgb) || i === 0) seenPreSlate = true
        continue
      }
      if (seenPreSlate && isBlue(rgb)) {
        clapperFrame = i
      }
      continue
    }
    if (!isBlue(rgb) && !isGreenish(rgb)) {
      firstContentFrame = i
      break
    }
  }
  if (clapperFrame >= 0) {
    if (firstContentFrame < 0) firstContentFrame = clapperFrame + Math.ceil(fps * 0.25)
    return {
      mode: 'green_to_blue',
      clapperFrame,
      clapperSec: round3(clapperFrame / fps),
      firstContentFrame,
      firstContentSec: round3(firstContentFrame / fps)
    }
  }
  // 冷启动极端情况：帧 0 已是纯蓝，则用纯蓝结束帧回推
  if (firstBlueFrame === 0) {
    let blueEndFrame = -1
    for (let i = 1; i < count; i += 1) {
      if (!isBlue(avgRgb(i))) {
        blueEndFrame = i
        break
      }
    }
    if (blueEndFrame > 0) {
      return {
        mode: 'blue_end_fallback',
        clapperFrame: blueEndFrame,
        clapperSec: round3(blueEndFrame / fps),
        firstContentFrame: blueEndFrame,
        firstContentSec: round3(blueEndFrame / fps)
      }
    }
  }
  throw new Error(`数字打板器校准失败：未在前 3.5s 检测到绿→蓝跳变帧 (${videoPath})`)
}

function assertNoGrayPadding(videoPath, durationSec) {
  const sampleSec = Math.max(0.8, Math.min(durationSec - 0.3, durationSec * 0.6))
  const raw = execFileSync('ffmpeg', [
    '-v', 'error',
    '-ss', sampleSec.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'crop=8:8:iw-12:ih-12,scale=1:1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-'
  ])
  const [r, g, b] = [raw[0], raw[1], raw[2]]
  if (Math.abs(r - 128) <= 4 && Math.abs(g - 128) <= 4 && Math.abs(b - 128) <= 4) {
    throw new Error(`检测到 75% 灰边异常（bottom-right RGB=${r},${g},${b}）：${videoPath}`)
  }
}

async function waitForImagesAndFonts(page) {
  await page.evaluate(async () => {
    const imgs = [...document.images]
    await Promise.all(imgs.map((img) => {
      if (img.complete) return Promise.resolve()
      return new Promise((r) => {
        const done = () => r()
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
        setTimeout(done, 4000)
      })
    }))
    await document.fonts?.ready
  }).catch(() => {})
}

function buildForbiddenMatchers(list) {
  const items = list?.length
    ? list
    : ['doctor13', 'zhangsan', 'admin', 'doctor01', 'Yuzhua@2026', '演示视频即将上线']
  return items.map((label) => ({
    label,
    re: label === 'admin'
      ? /\badmin\b/i
      : new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }))
}

async function assertPageState(page, checkLabel, requiredTexts, brand, forbiddenMatchers, assertions) {
  await waitForImagesAndFonts(page)
  const bodyText = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ').trim()
  const expanded = requiredTexts.map((t) => expandBrand(t, brand))
  const missing = expanded.filter((needle) => !bodyText.includes(needle.replace(/\s+/g, ' ')))
  const leaks = forbiddenMatchers.filter(({ re }) => re.test(bodyText)).map(({ label }) => label)

  assertions.shotChecks.push({
    check: checkLabel,
    url: page.url(),
    requiredTexts: expanded,
    missing,
    leaks,
    passed: missing.length === 0 && leaks.length === 0
  })

  if (missing.length) {
    throw new Error(`[${checkLabel}] 断言失败，页面缺少文案：${missing.map((s) => `「${s}」`).join('、')} (${page.url()})`)
  }
  if (leaks.length) {
    assertions.usernameLeakCheck = 'failed'
    throw new Error(`[${checkLabel}] 安全门禁失败，画面文本命中禁用词：${leaks.join(', ')} (${page.url()})`)
  }
  console.log(`  [assert] ${checkLabel} OK (${expanded.length} 项文案命中, 0 禁用词泄露)`)
}

async function loginRole(browser, base, actor, timezone, locale) {
  const password = process.env[actor.passwordEnv] || actor.defaultPassword || '123456'
  const loginPath = actor.authSide === 'admin' ? '/admin/login' : '/login'
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    timezoneId: timezone,
    locale
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  try {
    await page.goto(`${base}${loginPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.getByPlaceholder('请输入登录账号').fill(actor.username)
    await page.getByPlaceholder('请输入密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 20000 })
    await page.waitForTimeout(300)
    const state = await context.storageState()
    console.log(`[login] ${actor.displayName} (${actor.authSide}) pre-authenticated via storageState`)
    return state
  } finally {
    await context.close()
  }
}

class ClipSession {
  constructor({ clipId, role, viewport, rawDir, timezone, locale, events, gaps }) {
    this.clipId = clipId
    this.role = role
    this.viewport = { width: viewport.width, height: viewport.height, dpr: viewport.dpr }
    this.recordSize = { width: viewport.recordSize.width, height: viewport.recordSize.height }
    this.rawDir = rawDir
    this.tmpDir = join(rawDir, `.tmp-${clipId}`)
    this.timezone = timezone
    this.locale = locale
    this.events = events
    this.gaps = gaps
    this.context = null
    this.page = null
    this.stopErrors = null
    this.syncEpochMs = 0
    this.syncEndEpochMs = 0
    this.meta = null
  }

  async open(browser, { storageState } = {}) {
    mkdirSync(this.tmpDir, { recursive: true })
    this.context = await browser.newContext({
      viewport: { width: this.viewport.width, height: this.viewport.height },
      deviceScaleFactor: this.viewport.dpr,
      timezoneId: this.timezone,
      locale: this.locale,
      storageState,
      recordVideo: { dir: this.tmpDir, size: this.recordSize }
    })
    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(20000)
    return this.page
  }

  attachErrors(assertions) {
    let active = true
    this.page.on('pageerror', (err) => {
      if (active) assertions.pageErrors.push(`[${this.clipId}] ${err.message}`)
    })
    this.page.on('console', (msg) => {
      if (active && msg.type() === 'error') assertions.consoleErrors.push(`[${this.clipId}] ${msg.text()}`)
    })
    this.stopErrors = () => { active = false }
  }

  async runClapperboard() {
    await this.page.setContent(
      '<!doctype html><html style="margin:0;width:100%;height:100%;background:#00ff00;"><body style="margin:0;width:100vw;height:100vh;background:#00ff00;"><div id="t" style="width:2px;height:2px;"></div><script>let n=0;function f(){const el=document.getElementById("t");if(el)el.style.opacity=(n++%2)?1:0.99;requestAnimationFrame(f)}requestAnimationFrame(f)</script></body></html>',
      { waitUntil: 'load' }
    )
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await this.page.waitForTimeout(480)
    this.syncEpochMs = Date.now()
    await this.page.evaluate(() => {
      document.documentElement.style.background = '#0000ff'
      document.body.style.background = '#0000ff'
    })
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await this.page.waitForTimeout(260)
    this.syncEndEpochMs = Date.now()
  }

  async measureTarget(locator, selectorDesc) {
    await locator.scrollIntoViewIfNeeded().catch(() => {})
    await this.page.waitForTimeout(80)
    const box = await locator.boundingBox()
    if (!box) return undefined
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    return {
      selector: selectorDesc,
      x: round3(box.x),
      y: round3(box.y),
      width: round3(box.width),
      height: round3(box.height),
      cx: round3(cx),
      cy: round3(cy),
      nx: round4(cx / this.viewport.width),
      ny: round4(cy / this.viewport.height),
      nw: round4(box.width / this.viewport.width),
      nh: round4(box.height / this.viewport.height)
    }
  }

  addEvent(shotId, type, label, { actionId, epochMs = Date.now(), target } = {}) {
    const eventId = `ev-${String(this.events.length + 1).padStart(3, '0')}`
    const ev = {
      eventId,
      ...(actionId ? { actionId } : {}),
      shotId,
      clipId: this.clipId,
      role: this.role,
      type,
      tSec: 0,
      epochMs,
      label,
      ...(target ? { target } : {})
    }
    this.events.push(ev)
    return ev
  }

  addGap(shotId, reason, startEpochMs, endEpochMs, recommendedKeepSec = 0.25) {
    if (endEpochMs - startEpochMs < 200) return null
    const gapId = `gap-${String(this.gaps.length + 1).padStart(3, '0')}`
    const gap = {
      gapId,
      shotId,
      clipId: this.clipId,
      role: this.role,
      reason,
      startSec: 0,
      endSec: 0,
      startEpochMs,
      endEpochMs,
      recommendedKeepSec
    }
    this.gaps.push(gap)
    this.addEvent(shotId, 'gap_start', `等待开始(${reason})`, { epochMs: startEpochMs })
    this.addEvent(shotId, 'gap_end', `等待结束(${reason})`, { epochMs: endEpochMs })
    return gap
  }

  async clickAndTrack(shotId, locator, selectorDesc, label, { actionId, pauseBeforeMs = 180, pauseAfterMs = 200 } = {}) {
    await locator.waitFor({ state: 'visible', timeout: 20000 })
    const target = await this.measureTarget(locator, selectorDesc)
    if (pauseBeforeMs > 0) await this.page.waitForTimeout(pauseBeforeMs)
    const epochMs = Date.now()
    await locator.click()
    const ev = this.addEvent(shotId, 'click', label, { actionId, epochMs, target })
    if (pauseAfterMs > 0) await this.page.waitForTimeout(pauseAfterMs)
    return ev
  }

  async typeAndTrack(shotId, locator, selectorDesc, value, label, { actionId, delay = 45, pauseBeforeMs = 140, skipClick = false } = {}) {
    await locator.waitFor({ state: 'visible', timeout: 20000 })
    const target = await this.measureTarget(locator, selectorDesc)
    if (pauseBeforeMs > 0) await this.page.waitForTimeout(pauseBeforeMs)
    const epochMs = Date.now()
    if (!skipClick) await locator.click()
    await locator.fill('')
    if (delay > 0) await locator.pressSequentially(value, { delay })
    else await locator.fill(value)
    return this.addEvent(shotId, 'input', label, { actionId, epochMs, target })
  }

  async closeAndFinalize(outDir) {
    if (this.stopErrors) this.stopErrors()
    const video = this.page.video()
    await this.context.close()
    const srcPath = await video.path()
    const destPath = join(this.rawDir, `${this.clipId}.webm`)
    writeFileSync(destPath, readFileSync(srcPath))
    rmSync(this.tmpDir, { recursive: true, force: true })

    const probed = probeVideo(destPath)
    assert.equal(probed.width, this.recordSize.width, `${this.clipId}: 宽 ${probed.width} !== ${this.recordSize.width}`)
    assert.equal(probed.height, this.recordSize.height, `${this.clipId}: 高 ${probed.height} !== ${this.recordSize.height}`)
    assertNoGrayPadding(destPath, probed.durationSec)

    const clap = detectClapperboard(destPath, probed.fps)
    const anchorEpoch = clap.mode === 'blue_end_fallback' ? this.syncEndEpochMs : this.syncEpochMs
    const recordedStartEpochMs = Math.round(anchorEpoch - clap.clapperSec * 1000)

    this.meta = {
      clipId: this.clipId,
      file: relative(outDir, destPath).replace(/\\/g, '/'),
      role: this.role,
      viewport: this.viewport,
      recordSize: this.recordSize,
      fps: probed.fps,
      codec: probed.codec,
      frames: probed.frames,
      durationSec: probed.durationSec,
      recordedStartEpochMs,
      clapperFrame: clap.clapperFrame,
      usableStartSec: clap.firstContentSec
    }
    console.log(
      `[clip] ${this.clipId}: ${probed.width}x${probed.height} @${probed.fps}fps ` +
      `dur=${probed.durationSec}s clapperFrame=${clap.clapperFrame} usableStart=${clap.firstContentSec}s ✓`
    )
    return this.meta
  }
}

function actionById(shot, id) {
  const act = (shot.actions || []).find((a) => a.id === id)
  if (!act) throw new Error(`${shot.shotId}: 找不到动作定义 ${id}`)
  return act
}

function buildLandingCss(landingCapture) {
  const hideSelectors = landingCapture?.hideSelectors || [
    'article#top .stamp-row > p.note',
    '.fold .stamp.is-pending + p.note',
    '.stamp.is-pending .sr-only',
    '.doors .id',
    'p.fine:has(#pw)',
    'article.paper.next'
  ]
  const overrideCss = landingCapture?.overrideCss || '.stamp.is-pending { cursor: pointer !important; opacity: 1 !important; }'
  return `
    ${hideSelectors.join(',\n    ')} { display: none !important; }
    ${overrideCss}
    .stamp.is-pending { background: var(--action, #d92549) !important; border-color: var(--action, #d92549) !important; }
    body { overflow: hidden !important; }
    article#top.paper { margin-top: 106px !important; margin-bottom: 16px !important; }
    article#top .dog { width: 260px !important; left: 40px !important; }
    article#top .slip { padding: 22px 44px 12px !important; }
    article#top h1 { font-size: 34px !important; line-height: 1.24 !important; }
    article#top .stamp-row { margin-top: 18px !important; }
    article#top .doors { margin-top: 16px !important; }
    article#top .doors a { min-height: 36px !important; }
    article#top .fine { padding-top: 8px !important; padding-bottom: 12px !important; font-size: 14px !important; }
    .foot { display: none !important; }
  `
}

async function runRecording(args, storyboard, brand) {
  const tz = storyboard.environment?.timezone || 'Asia/Shanghai'
  const locale = storyboard.environment?.locale || 'zh-CN'
  const cutoff = storyboard.environment?.latestTodayBookingTime || '21:30'
  const now = nowInTimezone(tz)

  if (now.hhmm >= cutoff) {
    throw new Error(
      `当前北京时间 ${now.hhmm} 已晚于当日最晚可约时段 ${cutoff}，` +
      '医生接诊工作台默认过滤当天预约，无法完成当天挂号与接诊闭环录制。请在北京时间 21:30 前运行。'
    )
  }

  const base = (args.base || storyboard.environment?.baseUrl || 'http://127.0.0.1:8088').replace(/\/+$/, '')
  const runDate = args.date || now.date
  const outDir = resolve(args.out || join(ROOT, 'output', 'demo-video', runDate))
  const rawDir = join(outDir, 'raw')
  mkdirSync(rawDir, { recursive: true })

  // 预检前端服务健康
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    const res2 = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) }).catch((e) => {
      throw new Error(`无法连接前端服务 ${base}（请确认 docker compose up -d --wait 已就绪）：${e.message}`)
    })
    if (!res2.ok) throw new Error(`前端服务 ${base}/ 返回 HTTP ${res2.status}`)
  }

  const [s1, s2, s3, s4, s5, s6, s7, s8] = storyboard.shots
  const { owner: ownerActor, doctor: doctorActor, admin: adminActor } = storyboard.actors
  const forbiddenMatchers = buildForbiddenMatchers(storyboard.forbiddenVisibleText)

  const { mod: pw } = loadPlaywright()
  const browser = await launchDpr2Browser(pw.chromium, args.channel)
  const demoServer = await startReadOnlyStaticServer(s8.landingCapture?.staticRoot || 'deploy/demo')

  const events = []
  const gaps = []
  const assertions = {
    pageErrors: [],
    consoleErrors: [],
    usernameLeakCheck: 'passed',
    shotChecks: []
  }
  const shotWindows = []
  const syncPairsRaw = []
  const clipMetas = new Map()

  try {
    // 0. 预登录三角色（独立临时 context，绝不录屏，杜绝登录页与账号名入镜）
    const ownerState = await loginRole(browser, base, ownerActor, tz, locale)
    const doctorState = await loginRole(browser, base, doctorActor, tz, locale)
    const adminState = await loginRole(browser, base, adminActor, tz, locale)

    // =========================================================================
    // Clip 1: owner-main (S01 -> S02 -> S03 left -> S04 left -> S05)
    // =========================================================================
    console.log('\n[phase] Clip 1: owner-main (S01–S05) + Clip 2: doctor-consult (S03–S04)')
    const ownerClip = new ClipSession({
      clipId: 'owner-main',
      role: 'owner',
      viewport: storyboard.viewports[s1.viewportRefs.owner],
      rawDir,
      timezone: tz,
      locale,
      events,
      gaps
    })
    const ownerPage = await ownerClip.open(browser, { storageState: ownerState })
    ownerClip.attachErrors(assertions)
    await ownerClip.runClapperboard()

    // --- S01: 宠主首页搜「耳」 ---
    const s1LoadStart = Date.now()
    await ownerPage.goto(`${base}${s1.routes.owner}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await ownerPage.waitForSelector('h1:has-text("为爱宠，找到合适的医生")', { state: 'visible' })
    await ownerPage.locator('.el-loading-mask').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
    await waitForImagesAndFonts(ownerPage)
    await ownerPage.waitForTimeout(180)
    const s1StartMs = Date.now()
    ownerClip.addGap(s1.shotId, 'page_load', s1LoadStart, s1StartMs, 0)
    ownerClip.addEvent(s1.shotId, 'navigate', '进入宠主首页 /', { actionId: 's01-open', epochMs: s1StartMs })
    await assertPageState(ownerPage, 'S01-owner', s1.assertText.owner, brand, forbiddenMatchers, assertions)
    await ownerPage.waitForTimeout(1850)

    const actFocusSearch = actionById(s1, 's01-focus-search')
    const actTypeEar = actionById(s1, 's01-type-ear')
    const actSubmitSearch = actionById(s1, 's01-submit')
    const searchInput = ownerPage.locator(actFocusSearch.selector).first()
    await ownerClip.clickAndTrack(s1.shotId, searchInput, actFocusSearch.selector, '聚焦顶部搜索框', {
      actionId: actFocusSearch.id,
      pauseBeforeMs: 260,
      pauseAfterMs: 220
    })
    await ownerClip.typeAndTrack(s1.shotId, searchInput, actTypeEar.selector, actTypeEar.value, `输入关键词「${actTypeEar.value}」`, {
      actionId: actTypeEar.id,
      delay: 180,
      pauseBeforeMs: 120,
      skipClick: true
    })
    await ownerPage.waitForTimeout(750)
    await ownerClip.clickAndTrack(s1.shotId, ownerPage.locator(actSubmitSearch.selector).first(), actSubmitSearch.selector, '点击搜索按钮', {
      actionId: actSubmitSearch.id,
      pauseBeforeMs: 220,
      pauseAfterMs: 180
    })
    await ownerPage.waitForURL('**/doctors**', { timeout: 15000 })
    const actPickDoc = actionById(s2, 's02-pick-doctor')
    await ownerPage.locator(actPickDoc.selector).first().waitFor({ state: 'visible', timeout: 15000 })
    await waitForImagesAndFonts(ownerPage)
    await ownerPage.waitForTimeout(350)
    const s1EndMs = Date.now()
    shotWindows.push({
      shotId: s1.shotId,
      layout: s1.layout,
      refs: [{ clipId: 'owner-main', role: 'owner', startEpochMs: s1StartMs, endEpochMs: s1EndMs, playbackRate: 1.0 }]
    })

    // --- S02: 医生列表选苏晚晴 → 医生详情 → 发起图文问诊 ---
    const s2StartMs = s1EndMs
    await assertPageState(ownerPage, 'S02-ownerList', s2.assertText.ownerList, brand, forbiddenMatchers, assertions)
    await ownerPage.waitForTimeout(1250)
    await ownerClip.clickAndTrack(s2.shotId, ownerPage.locator(actPickDoc.selector).first(), actPickDoc.selector, `点击医生卡片「${doctorActor.displayName}」`, {
      actionId: actPickDoc.id
    })
    await ownerPage.waitForURL(`**/doctor/${doctorActor.doctorId}**`, { timeout: 15000 })
    await ownerPage.locator(`h1:has-text("${doctorActor.displayName}")`).waitFor({ state: 'visible' })
    await assertPageState(ownerPage, 'S02-ownerDetail', s2.assertText.ownerDetail, brand, forbiddenMatchers, assertions)
    await ownerPage.waitForTimeout(1550)

    const actOpenConsult = actionById(s2, 's02-open-consult')
    await ownerClip.clickAndTrack(s2.shotId, ownerPage.locator(actOpenConsult.selector).first(), actOpenConsult.selector, '点击「图文问诊 免费」', {
      actionId: actOpenConsult.id
    })
    await ownerPage.waitForURL(`**/consult/new/${doctorActor.doctorId}**`, { timeout: 15000 })
    await ownerPage.locator('label.pet').first().waitFor({ state: 'visible' })
    await assertPageState(ownerPage, 'S02-ownerNewConsult', s2.assertText.ownerNewConsult, brand, forbiddenMatchers, assertions)

    const actPickPetConsult = actionById(s2, 's02-pick-pet')
    const actFillSymptomConsult = actionById(s2, 's02-fill-symptom')
    const actSubmitConsult = actionById(s2, 's02-submit-consult')
    await ownerClip.clickAndTrack(s2.shotId, ownerPage.locator(actPickPetConsult.selector).first(), actPickPetConsult.selector, `选择问诊宠物「${ownerActor.petName}」`, {
      actionId: actPickPetConsult.id,
      pauseBeforeMs: 180,
      pauseAfterMs: 180
    })
    await ownerClip.typeAndTrack(s2.shotId, ownerPage.locator(actFillSymptomConsult.selector).first(), actFillSymptomConsult.selector, actFillSymptomConsult.value, '填写图文问诊症状描述', {
      actionId: actFillSymptomConsult.id,
      delay: 30,
      pauseBeforeMs: 120
    })
    const createSessionPromise = ownerPage.waitForResponse(
      (r) => r.url().includes('/api/client/consult/sessions') && r.request().method() === 'POST',
      { timeout: 20000 }
    )
    await ownerClip.clickAndTrack(s2.shotId, ownerPage.locator(actSubmitConsult.selector).first(), actSubmitConsult.selector, '点击「发起问诊」', {
      actionId: actSubmitConsult.id,
      pauseBeforeMs: 180,
      pauseAfterMs: 0
    })
    const createSessionRes = await (await createSessionPromise).json()
    assert.equal(createSessionRes.code, 200, `发起问诊失败: ${createSessionRes.msg}`)
    const sessionId = createSessionRes.data.id
    await ownerPage.waitForURL(`**/consult/${sessionId}`, { timeout: 15000 })
    await ownerPage.locator('textarea[aria-label="问诊消息"]').waitFor({ state: 'visible' })
    await ownerPage.waitForFunction(() => !document.body.innerText.includes('正在同步会话'), { timeout: 15000 })
    const s2EndMs = Date.now()
    shotWindows.push({
      shotId: s2.shotId,
      layout: s2.layout,
      refs: [{ clipId: 'owner-main', role: 'owner', startEpochMs: s2StartMs, endEpochMs: s2EndMs, playbackRate: 1.0 }]
    })
    console.log(`  [consult] sessionId=${sessionId} created`)

    // =========================================================================
    // Clip 2: doctor-consult (S03 right -> S04 right，与 owner-main 并行录屏)
    // =========================================================================
    const ownerWaitDoctorStart = Date.now()
    const doctorConsultClip = new ClipSession({
      clipId: 'doctor-consult',
      role: 'doctor',
      viewport: storyboard.viewports[s3.viewportRefs.doctor],
      rawDir,
      timezone: tz,
      locale,
      events,
      gaps
    })
    const docConsultPage = await doctorConsultClip.open(browser, { storageState: doctorState })
    doctorConsultClip.attachErrors(assertions)
    await doctorConsultClip.runClapperboard()

    const docLoadStart = Date.now()
    await docConsultPage.goto(`${base}/admin/consult/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await docConsultPage.locator('textarea[aria-label="问诊回复"]').waitFor({ state: 'visible' })
    await docConsultPage.waitForFunction(() => !document.body.innerText.includes('正在同步会话'), { timeout: 15000 })
    await waitForImagesAndFonts(docConsultPage)
    const docReadyMs = Date.now()
    doctorConsultClip.addGap(s3.shotId, 'page_load', docLoadStart, docReadyMs, 0)
    ownerClip.addGap(s3.shotId, 'ws_wait', ownerWaitDoctorStart, docReadyMs, 0.2)

    // --- S03: 双端实时图文问诊 + 已读回执 ---
    const s3StartMs = Date.now()
    ownerClip.addEvent(s3.shotId, 'navigate', '进入双端问诊同步起点（宠主端）', { epochMs: s3StartMs })
    doctorConsultClip.addEvent(s3.shotId, 'navigate', '进入医生问诊会话', { actionId: 's03-doc-open', epochMs: s3StartMs })
    await ownerPage.waitForTimeout(700)

    const actDocAccept = actionById(s3, 's03-doc-accept')
    const acceptBtn = docConsultPage.locator(actDocAccept.selector).first()
    if (await acceptBtn.count()) {
      await doctorConsultClip.clickAndTrack(s3.shotId, acceptBtn, actDocAccept.selector, '医生点击「接诊」', {
        actionId: actDocAccept.id,
        pauseBeforeMs: 220,
        pauseAfterMs: 0
      })
      const wsAcceptStart = Date.now()
      await ownerPage.getByText('医生已接诊，会话开始。').first().waitFor({ state: 'visible', timeout: 15000 })
      await docConsultPage.waitForFunction(() => !document.body.innerText.includes('正在同步会话'), { timeout: 15000 })
      ownerClip.addGap(s3.shotId, 'ws_wait', wsAcceptStart, Date.now(), 0.25)
    }
    await ownerPage.waitForTimeout(850)

    const actOwnerType = actionById(s3, 's03-owner-type')
    const actOwnerSend = actionById(s3, 's03-owner-send')
    await ownerClip.typeAndTrack(s3.shotId, ownerPage.locator(actOwnerType.selector).first(), actOwnerType.selector, actOwnerType.value, '宠主输入问诊消息', {
      actionId: actOwnerType.id,
      delay: 60
    })
    const ownerSendEv = await ownerClip.clickAndTrack(s3.shotId, ownerPage.locator(actOwnerSend.selector).first(), actOwnerSend.selector, '宠主点击发送消息', {
      actionId: actOwnerSend.id,
      pauseBeforeMs: 240,
      pauseAfterMs: 0
    })
    const wsSentAnchor = ownerClip.addEvent(s3.shotId, 'ws_sent', '宠主发出 WS 问诊消息', {
      epochMs: ownerSendEv.epochMs,
      target: ownerSendEv.target
    })

    const wsMsgStart = Date.now()
    await docConsultPage.getByText(actOwnerType.value, { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
    doctorConsultClip.addEvent(s3.shotId, 'ws_received', '医生端实时收到宠主消息', { epochMs: Date.now() })
    await ownerPage.locator('.msg.mine .message-meta:has-text("已读")').last().waitFor({ state: 'visible', timeout: 15000 })
    const readReceiptMs = Date.now()
    ownerClip.addEvent(s3.shotId, 'read_receipt', '宠主消息状态实时变「已读」', { epochMs: readReceiptMs })
    ownerClip.addGap(s3.shotId, 'ws_wait', wsMsgStart, readReceiptMs, 0.35)
    await ownerPage.waitForTimeout(1450)

    const actDocType = actionById(s3, 's03-doc-type')
    const actDocSend = actionById(s3, 's03-doc-send')
    await doctorConsultClip.typeAndTrack(s3.shotId, docConsultPage.locator(actDocType.selector).first(), actDocType.selector, actDocType.value, '医生输入问诊回复', {
      actionId: actDocType.id,
      delay: 48
    })
    const docSendEv = await doctorConsultClip.clickAndTrack(s3.shotId, docConsultPage.locator(actDocSend.selector).first(), actDocSend.selector, '医生点击发送回复', {
      actionId: actDocSend.id,
      pauseBeforeMs: 220,
      pauseAfterMs: 0
    })
    doctorConsultClip.addEvent(s3.shotId, 'ws_sent', '医生发出 WS 回复', { epochMs: docSendEv.epochMs, target: docSendEv.target })

    const wsReplyStart = Date.now()
    await ownerPage.getByText(actDocType.value, { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
    const ownerRecvMs = Date.now()
    ownerClip.addEvent(s3.shotId, 'ws_received', '宠主端实时收到医生回复', { epochMs: ownerRecvMs })
    doctorConsultClip.addGap(s3.shotId, 'ws_wait', wsReplyStart, ownerRecvMs, 0.3)

    await assertPageState(ownerPage, 'S03-owner', s3.assertText.owner, brand, forbiddenMatchers, assertions)
    await assertPageState(docConsultPage, 'S03-doctor', s3.assertText.doctor, brand, forbiddenMatchers, assertions)
    await ownerPage.waitForTimeout(1400)
    const s3EndMs = Date.now()
    shotWindows.push({
      shotId: s3.shotId,
      layout: s3.layout,
      refs: [
        { clipId: 'owner-main', role: 'owner', startEpochMs: s3StartMs, endEpochMs: s3EndMs, playbackRate: 1.0 },
        { clipId: 'doctor-consult', role: 'doctor', startEpochMs: s3StartMs, endEpochMs: s3EndMs, playbackRate: 1.0 }
      ]
    })

    // --- S04: 医生发「建议到院」卡 → 宠主点击「去预约挂号」 ---
    const s4StartMs = s3EndMs
    const actSuggestOpen = actionById(s4, 's04-doc-suggest-open')
    const actSuggestNote = actionById(s4, 's04-doc-suggest-note')
    const actSuggestSend = actionById(s4, 's04-doc-suggest-send')
    const actOwnerGoBook = actionById(s4, 's04-owner-go-book')

    await doctorConsultClip.clickAndTrack(s4.shotId, docConsultPage.locator(actSuggestOpen.selector).first(), actSuggestOpen.selector, '医生点击「建议到院」', {
      actionId: actSuggestOpen.id,
      pauseBeforeMs: 220,
      pauseAfterMs: 320
    })
    const suggestDlg = docConsultPage.getByRole('dialog')
    await suggestDlg.waitFor({ state: 'visible', timeout: 15000 })
    await assertPageState(docConsultPage, 'S04-doctor-dialog', ['建议到院预约'], brand, forbiddenMatchers, assertions)

    await doctorConsultClip.typeAndTrack(s4.shotId, docConsultPage.locator(actSuggestNote.selector).first(), actSuggestNote.selector, actSuggestNote.value, '医生填写到院建议附言', {
      actionId: actSuggestNote.id,
      delay: 42
    })
    await ownerPage.waitForTimeout(380)
    await doctorConsultClip.clickAndTrack(s4.shotId, docConsultPage.locator(actSuggestSend.selector).first(), actSuggestSend.selector, '医生点击「发送建议」', {
      actionId: actSuggestSend.id,
      pauseBeforeMs: 220,
      pauseAfterMs: 0
    })

    const wsCardStart = Date.now()
    await suggestDlg.waitFor({ state: 'hidden', timeout: 15000 })
    const goBookBtn = ownerPage.locator(actOwnerGoBook.selector).last()
    await goBookBtn.waitFor({ state: 'visible', timeout: 15000 })
    const cardShownMs = Date.now()
    const cardTarget = await ownerClip.measureTarget(goBookBtn, actOwnerGoBook.selector)
    ownerClip.addEvent(s4.shotId, 'card_shown', '宠主端收到「医生建议到院就诊」卡片', { epochMs: cardShownMs, target: cardTarget })
    ownerClip.addGap(s4.shotId, 'ws_wait', wsCardStart, cardShownMs, 0.3)

    await assertPageState(docConsultPage, 'S04-doctor-sent', ['已建议患者到院就诊'], brand, forbiddenMatchers, assertions)
    await assertPageState(ownerPage, 'S04-owner', s4.assertText.owner, brand, forbiddenMatchers, assertions)
    await ownerPage.waitForTimeout(1650)

    await ownerClip.clickAndTrack(s4.shotId, goBookBtn, actOwnerGoBook.selector, '宠主点击「去预约挂号」', {
      actionId: actOwnerGoBook.id,
      pauseBeforeMs: 220,
      pauseAfterMs: 250
    })
    await ownerPage.waitForURL(`**/book/${doctorActor.doctorId}**`, { timeout: 15000 })
    const s4EndMs = Date.now()
    shotWindows.push({
      shotId: s4.shotId,
      layout: s4.layout,
      refs: [
        { clipId: 'owner-main', role: 'owner', startEpochMs: s4StartMs, endEpochMs: s4EndMs, playbackRate: 1.0 },
        { clipId: 'doctor-consult', role: 'doctor', startEpochMs: s4StartMs, endEpochMs: s4EndMs, playbackRate: 1.0 }
      ]
    })

    syncPairsRaw.push({
      pairId: 'consult-split',
      shotIds: [s3.shotId, s4.shotId],
      leftClipId: 'owner-main',
      rightClipId: 'doctor-consult',
      anchorEventId: wsSentAnchor.eventId,
      anchorEpochMs: wsSentAnchor.epochMs
    })

    await docConsultPage.waitForTimeout(300)
    clipMetas.set('doctor-consult', await doctorConsultClip.closeAndFinalize(outDir))

    // --- S05: 挂号页选今天时段 + 团团 + 提交 + 模拟支付 + 查看预约 ---
    const s5LoadStart = Date.now()
    await ownerPage.waitForSelector('h1:has-text("确认挂号")', { state: 'visible' })
    await ownerPage.locator('.date-option').first().waitFor({ state: 'visible', timeout: 15000 })
    await waitForImagesAndFonts(ownerPage)
    const s5StartMs = Date.now()
    ownerClip.addGap(s5.shotId, 'page_load', s5LoadStart, s5StartMs, 0.2)
    ownerClip.addEvent(s5.shotId, 'navigate', '进入确认挂号页', { epochMs: s5StartMs })
    await assertPageState(ownerPage, 'S05-ownerBook', s5.assertText.ownerBook, brand, forbiddenMatchers, assertions)

    const actPickToday = actionById(s5, 's05-pick-today')
    const actPickSlot = actionById(s5, 's05-pick-slot')
    const actPickPetBook = actionById(s5, 's05-pick-pet')
    const actFillSymptomBook = actionById(s5, 's05-fill-symptom')
    const actSubmitOrder = actionById(s5, 's05-submit-order')
    const actPayConfirm = actionById(s5, 's05-pay-confirm')
    const actViewOrder = actionById(s5, 's05-view-order')

    const todayBtn = ownerPage.locator(actPickToday.selector).first()
    if (!(await todayBtn.count())) {
      throw new Error(`挂号页未找到今天(${now.date})的排班按钮，请先执行 prepare.sql`)
    }
    await ownerClip.clickAndTrack(s5.shotId, todayBtn, actPickToday.selector, '确认选择今天日期', {
      actionId: actPickToday.id,
      pauseBeforeMs: 120,
      pauseAfterMs: 220
    })

    const enabledSlot = ownerPage.locator(actPickSlot.selector).first()
    if (!(await enabledSlot.count())) {
      throw new Error(`今天(${now.date})北京时间 ${nowInTimezone(tz).hhmm} 已无未结束可约时段（苏晚晴最晚时段 ${cutoff} 结束）`)
    }
    await ownerClip.clickAndTrack(s5.shotId, enabledSlot, actPickSlot.selector, '选择今天可约时段', {
      actionId: actPickSlot.id
    })
    await ownerClip.clickAndTrack(s5.shotId, ownerPage.locator(actPickPetBook.selector).first(), actPickPetBook.selector, `选择就诊宠物「${ownerActor.petName}」`, {
      actionId: actPickPetBook.id
    })
    await ownerClip.typeAndTrack(s5.shotId, ownerPage.locator(actFillSymptomBook.selector).first(), actFillSymptomBook.selector, actFillSymptomBook.value, '填写挂号症状描述', {
      actionId: actFillSymptomBook.id,
      delay: 18
    })

    const createOrderPromise = ownerPage.waitForResponse(
      (r) => r.url().endsWith('/api/client/appointment') && r.request().method() === 'POST',
      { timeout: 20000 }
    )
    await ownerClip.clickAndTrack(s5.shotId, ownerPage.locator(actSubmitOrder.selector).first(), actSubmitOrder.selector, '点击「提交挂号」', {
      actionId: actSubmitOrder.id,
      pauseBeforeMs: 160,
      pauseAfterMs: 0
    })
    const createOrderJson = await (await createOrderPromise).json()
    assert.equal(createOrderJson.code, 200, `提交挂号失败: ${createOrderJson.msg}`)
    const orderId = createOrderJson.data.id
    console.log(`  [booking] orderId=${orderId} created`)

    const payBtn = ownerPage.locator(actPayConfirm.selector).first()
    await payBtn.waitFor({ state: 'visible', timeout: 15000 })
    await ownerPage.waitForTimeout(1200)
    await assertPageState(ownerPage, 'S05-ownerPayTicket-before', ['确认这次就诊'], brand, forbiddenMatchers, assertions)

    await ownerClip.clickAndTrack(s5.shotId, payBtn, actPayConfirm.selector, '点击「确认支付」', {
      actionId: actPayConfirm.id,
      pauseBeforeMs: 220,
      pauseAfterMs: 0
    })
    await ownerPage.getByText('支付成功，请按预约时间到院').first().waitFor({ state: 'visible', timeout: 15000 })
    ownerClip.addEvent(s5.shotId, 'paid', '模拟支付成功，预约已生效', { epochMs: Date.now() })
    await assertPageState(ownerPage, 'S05-ownerPayTicket-after', ['预约已生效', '支付成功，请按预约时间到院'], brand, forbiddenMatchers, assertions)
    await ownerPage.waitForTimeout(1350)

    await ownerClip.clickAndTrack(s5.shotId, ownerPage.locator(actViewOrder.selector).first(), actViewOrder.selector, '点击「查看预约」', {
      actionId: actViewOrder.id
    })
    await ownerPage.waitForURL(`**/order/${orderId}`, { timeout: 15000 })
    await ownerPage.getByText('待接诊').first().waitFor({ state: 'visible', timeout: 15000 })
    await assertPageState(ownerPage, 'S05-ownerOrder', s5.assertText.ownerOrder, brand, forbiddenMatchers, assertions)
    await ownerPage.waitForTimeout(1400)
    const s5EndMs = Date.now()
    shotWindows.push({
      shotId: s5.shotId,
      layout: s5.layout,
      refs: [{ clipId: 'owner-main', role: 'owner', startEpochMs: s5StartMs, endEpochMs: s5EndMs, playbackRate: 1.0 }]
    })

    await ownerPage.waitForTimeout(300)
    clipMetas.set('owner-main', await ownerClip.closeAndFinalize(outDir))

    // =========================================================================
    // Clip 3: doctor-workbench (S06: 今日接诊清单 -> 接诊 -> 写病历 -> 结束就诊)
    // =========================================================================
    console.log('\n[phase] Clip 3: doctor-workbench (S06)')
    const docWorkClip = new ClipSession({
      clipId: 'doctor-workbench',
      role: 'doctor',
      viewport: storyboard.viewports[s6.viewportRefs.doctor],
      rawDir,
      timezone: tz,
      locale,
      events,
      gaps
    })
    const docWorkPage = await docWorkClip.open(browser, { storageState: doctorState })
    docWorkClip.attachErrors(assertions)
    await docWorkClip.runClapperboard()

    const actOpenList = actionById(s6, 's06-open-list')
    const actAcceptRow = actionById(s6, 's06-accept-row')
    const actEnterWorkbench = actionById(s6, 's06-enter-workbench')
    const actSaveRecord = actionById(s6, 's06-save-record')
    const actFinishOpen = actionById(s6, 's06-finish-open')
    const actFinishConfirm = actionById(s6, 's06-finish-confirm')

    const s6LoadStart = Date.now()
    await docWorkPage.goto(`${base}${actOpenList.target}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await docWorkPage.locator(actAcceptRow.selector).first().waitFor({ state: 'visible', timeout: 20000 })
    await waitForImagesAndFonts(docWorkPage)
    const s6StartMs = Date.now()
    docWorkClip.addGap(s6.shotId, 'page_load', s6LoadStart, s6StartMs, 0)
    docWorkClip.addEvent(s6.shotId, 'navigate', '进入医生今日接诊清单', { actionId: actOpenList.id, epochMs: s6StartMs })
    await assertPageState(docWorkPage, 'S06-doctorList', s6.assertText.doctorList, brand, forbiddenMatchers, assertions)
    await docWorkPage.waitForTimeout(700)

    await docWorkClip.clickAndTrack(s6.shotId, docWorkPage.locator(actAcceptRow.selector).first(), actAcceptRow.selector, '点击今日预约行「接诊」', {
      actionId: actAcceptRow.id
    })
    const continueBtn = docWorkPage.locator(actEnterWorkbench.selector).first()
    await continueBtn.waitFor({ state: 'visible', timeout: 15000 })
    await docWorkPage.waitForTimeout(300)
    await docWorkClip.clickAndTrack(s6.shotId, continueBtn, actEnterWorkbench.selector, '点击「继续接诊」进入工作台', {
      actionId: actEnterWorkbench.id
    })
    await docWorkPage.waitForURL(`**/admin/workbench/${orderId}`, { timeout: 15000 })
    await docWorkPage.locator('h1:has-text("门诊病历")').waitFor({ state: 'visible' })
    await assertPageState(docWorkPage, 'S06-doctorWorkbench-active', ['门诊病历', `${doctorActor.displayName}医生`, ownerActor.petName, '就诊中'], brand, forbiddenMatchers, assertions)
    await docWorkPage.waitForTimeout(350)

    for (const fieldActionId of ['s06-fill-chief', 's06-fill-exam', 's06-fill-diagnosis', 's06-fill-rx', 's06-fill-treatment', 's06-fill-advice']) {
      const act = actionById(s6, fieldActionId)
      await docWorkClip.typeAndTrack(s6.shotId, docWorkPage.locator(act.selector).first(), act.selector, act.value, act.note, {
        actionId: act.id,
        delay: fieldActionId === 's06-fill-diagnosis' ? 20 : 10,
        pauseBeforeMs: 70
      })
    }

    await docWorkClip.clickAndTrack(s6.shotId, docWorkPage.locator(actSaveRecord.selector).first(), actSaveRecord.selector, '点击「保存病历」', {
      actionId: actSaveRecord.id
    })
    await docWorkPage.locator('.save-state:has-text("病历已保存")').waitFor({ state: 'visible', timeout: 15000 })
    await assertPageState(docWorkPage, 'S06-doctorWorkbench-saved', ['病历已保存'], brand, forbiddenMatchers, assertions)
    await docWorkPage.waitForTimeout(500)

    await docWorkClip.clickAndTrack(s6.shotId, docWorkPage.locator(actFinishOpen.selector).first(), actFinishOpen.selector, '点击「结束就诊」', {
      actionId: actFinishOpen.id
    })
    const confirmEndBtn = docWorkPage.locator(actFinishConfirm.selector).first()
    await confirmEndBtn.waitFor({ state: 'visible', timeout: 15000 })
    await docWorkPage.waitForTimeout(320)
    await docWorkClip.clickAndTrack(s6.shotId, confirmEndBtn, actFinishConfirm.selector, '点击「确认结束」', {
      actionId: actFinishConfirm.id
    })
    await docWorkPage.getByRole('dialog').waitFor({ state: 'hidden', timeout: 15000 })
    await docWorkPage.locator('.visit-meta:has-text("已完成")').waitFor({ state: 'visible', timeout: 15000 })
    await docWorkPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
    docWorkClip.addEvent(s6.shotId, 'ended', '本次门诊接诊已完成', { epochMs: Date.now() })
    await assertPageState(docWorkPage, 'S06-doctorWorkbench-done', ['门诊病历', `${doctorActor.displayName}医生`, ownerActor.petName, '已完成'], brand, forbiddenMatchers, assertions)
    await docWorkPage.waitForTimeout(1050)
    const s6EndMs = Date.now()
    shotWindows.push({
      shotId: s6.shotId,
      layout: s6.layout,
      refs: [{ clipId: 'doctor-workbench', role: 'doctor', startEpochMs: s6StartMs, endEpochMs: s6EndMs, playbackRate: 1.0 }]
    })
    clipMetas.set('doctor-workbench', await docWorkClip.closeAndFinalize(outDir))

    // =========================================================================
    // Clip 4: admin-dashboard (S07: 管理端全院看板 16:9)
    // =========================================================================
    console.log('\n[phase] Clip 4: admin-dashboard (S07)')
    const adminClip = new ClipSession({
      clipId: 'admin-dashboard',
      role: 'admin',
      viewport: storyboard.viewports[s7.viewportRefs.admin],
      rawDir,
      timezone: tz,
      locale,
      events,
      gaps
    })
    const adminPage = await adminClip.open(browser, { storageState: adminState })
    adminClip.attachErrors(assertions)
    await adminClip.runClapperboard()

    const actOpenDash = actionById(s7, 's07-open-dashboard')
    const actScrollDash = actionById(s7, 's07-scroll-charts')
    const s7LoadStart = Date.now()
    await adminPage.goto(`${base}${actOpenDash.target}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await adminPage.waitForFunction(() => document.querySelectorAll('div.cv canvas').length >= 4, { timeout: 20000 })
    await adminPage.locator('.el-loading-mask').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
    await waitForImagesAndFonts(adminPage)
    await adminPage.waitForTimeout(350) // 等待 v-loading 淡出与 ECharts 初帧完全稳定
    const s7StartMs = Date.now()
    adminClip.addGap(s7.shotId, 'page_load', s7LoadStart, s7StartMs, 0)
    const kpiTarget = await adminClip.measureTarget(adminPage.locator('.kpi, .overview, h2:has-text("今日概览")').first(), 'h2:has-text("今日概览")')
    adminClip.addEvent(s7.shotId, 'navigate', '进入管理端全院看板', { actionId: actOpenDash.id, epochMs: s7StartMs, target: kpiTarget })

    await adminPage.waitForTimeout(2300)
    await assertPageState(adminPage, 'S07-admin', s7.assertText.admin, brand, forbiddenMatchers, assertions)

    const scrollTargetY = Math.max(300, Number(actScrollDash.value) || 300)
    adminClip.addEvent(s7.shotId, 'card_shown', '平滑下滚展示 4 张业务统计图', { actionId: actScrollDash.id, epochMs: Date.now() })
    await adminPage.evaluate(async (y) => {
      const target = Math.min(y, Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
      const steps = 36
      for (let i = 1; i <= steps; i += 1) {
        window.scrollTo(0, Math.round((target * i) / steps))
        await new Promise((r) => setTimeout(r, 30))
      }
    }, scrollTargetY)
    await adminPage.waitForTimeout(2650)
    const s7EndMs = Date.now()
    shotWindows.push({
      shotId: s7.shotId,
      layout: s7.layout,
      refs: [{ clipId: 'admin-dashboard', role: 'admin', startEpochMs: s7StartMs, endEpochMs: s7EndMs, playbackRate: 1.0 }]
    })
    clipMetas.set('admin-dashboard', await adminClip.closeAndFinalize(outDir))

    // =========================================================================
    // Clip 5: landing-demo (S08: 本地只读静态服 + 首帧前样式净化 deploy/demo/agent-draft.html)
    // =========================================================================
    console.log('\n[phase] Clip 5: landing-demo (S08)')
    const landingClip = new ClipSession({
      clipId: 'landing-demo',
      role: 'landing',
      viewport: storyboard.viewports[s8.viewportRefs.landing],
      rawDir,
      timezone: tz,
      locale,
      events,
      gaps
    })
    const landingPage = await landingClip.open(browser)
    const landingCss = buildLandingCss(s8.landingCapture)
    // 通过 addInitScript 在首帧绘制前注入净化样式，确保零帧闪烁账号密码或待上线提示
    await landingClip.context.addInitScript((cssText) => {
      const inject = () => {
        if (document.getElementById('yuzhua-demo-sanitize')) return
        const style = document.createElement('style')
        style.id = 'yuzhua-demo-sanitize'
        style.textContent = cssText
        ;(document.head || document.documentElement).appendChild(style)
      }
      if (document.documentElement) inject()
      document.addEventListener('DOMContentLoaded', inject, { once: true })
    }, landingCss)
    landingClip.attachErrors(assertions)
    await landingClip.runClapperboard()

    const actOpenLanding = actionById(s8, 's08-open-landing')
    const s8LoadStart = Date.now()
    await landingPage.goto(`${demoServer.url}${actOpenLanding.target}`, { waitUntil: 'load', timeout: 30000 })
    await landingPage.addStyleTag({ content: landingCss })
    await waitForImagesAndFonts(landingPage)
    await landingPage.waitForTimeout(300)
    const s8StartMs = Date.now()
    landingClip.addGap(s8.shotId, 'page_load', s8LoadStart, s8StartMs, 0)

    const stampSel = s8.landingCapture?.stampSelector || 'article#top .stamp-row > span.stamp.is-pending'
    const stampTarget = await landingClip.measureTarget(landingPage.locator(stampSel).first(), stampSel)
    landingClip.addEvent(s8.shotId, 'navigate', '展示净化后的 /demo 落地页首纸', {
      actionId: actOpenLanding.id,
      epochMs: s8StartMs,
      target: stampTarget
    })
    landingClip.addEvent(s8.shotId, 'card_shown', '红章「看演示」坐标定位', {
      epochMs: Date.now(),
      target: stampTarget
    })
    await assertPageState(landingPage, 'S08-landing', s8.assertText.landing, brand, forbiddenMatchers, assertions)
    await landingPage.waitForTimeout(3800)
    const s8EndMs = Date.now()
    shotWindows.push({
      shotId: s8.shotId,
      layout: s8.layout,
      refs: [{ clipId: 'landing-demo', role: 'landing', startEpochMs: s8StartMs, endEpochMs: s8EndMs, playbackRate: 1.0 }]
    })
    clipMetas.set('landing-demo', await landingClip.closeAndFinalize(outDir))

    // =========================================================================
    // 门禁复核 + 生成 timeline.json v1（全部秒数以原始 WebM 第 0 帧为原点）
    // =========================================================================
    if (assertions.pageErrors.length || assertions.consoleErrors.length) {
      throw new Error(
        `录制过程检测到前端报错：\n` +
        `  pageErrors(${assertions.pageErrors.length}): ${assertions.pageErrors.join(' | ')}\n` +
        `  consoleErrors(${assertions.consoleErrors.length}): ${assertions.consoleErrors.join(' | ')}`
      )
    }

    const toClipSec = (clipId, epochMs) => {
      const meta = clipMetas.get(clipId)
      if (!meta) throw new Error(`未知 clipId: ${clipId}`)
      return round3(Math.max(0, (epochMs - meta.recordedStartEpochMs) / 1000))
    }

    for (const ev of events) {
      ev.tSec = toClipSec(ev.clipId, ev.epochMs)
    }
    for (const gap of gaps) {
      gap.startSec = toClipSec(gap.clipId, gap.startEpochMs)
      gap.endSec = toClipSec(gap.clipId, gap.endEpochMs)
    }

    const shotsOut = shotWindows.map((sw) => ({
      shotId: sw.shotId,
      layout: sw.layout,
      clipRefs: sw.refs.map((r) => {
        const meta = clipMetas.get(r.clipId)
        const trimStartSec = Math.max(meta.usableStartSec, toClipSec(r.clipId, r.startEpochMs))
        const trimEndSec = Math.min(meta.durationSec, toClipSec(r.clipId, r.endEpochMs))
        return {
          clipId: r.clipId,
          role: r.role,
          trimStartSec: round3(trimStartSec),
          trimEndSec: round3(trimEndSec),
          playbackRate: r.playbackRate
        }
      })
    }))

    const syncPairs = syncPairsRaw.map((sp) => {
      const leftAnchorSec = toClipSec(sp.leftClipId, sp.anchorEpochMs)
      const rightAnchorSec = toClipSec(sp.rightClipId, sp.anchorEpochMs)
      return {
        pairId: sp.pairId,
        shotIds: sp.shotIds,
        leftClipId: sp.leftClipId,
        rightClipId: sp.rightClipId,
        anchorEventId: sp.anchorEventId,
        anchorEpochMs: sp.anchorEpochMs,
        leftAnchorSec,
        rightAnchorSec,
        leftMinusRightSec: round3(leftAnchorSec - rightAnchorSec)
      }
    })

    const timeline = {
      schemaVersion: 1,
      generatedAt: nowInTimezone(tz).iso,
      date: runDate,
      baseUrl: base,
      timezone: tz,
      brand: {
        name: brand.name,
        fullName: brand.fullName,
        title: brand.title,
        tagline: brand.tagline
      },
      sessionId,
      orderId,
      clips: [...clipMetas.values()],
      shots: shotsOut,
      events,
      gaps,
      syncPairs,
      assertions
    }

    const timelinePath = join(outDir, 'timeline.json')
    writeFileSync(timelinePath, JSON.stringify(timeline, null, 2) + '\n', 'utf8')
    console.log('\n[done] P2 全量录制与断言全部通过！')
    console.log(`  timeline : ${timelinePath}`)
    console.log(`  clips    : ${timeline.clips.map((c) => `${c.clipId}(${c.recordSize.width}x${c.recordSize.height},${c.durationSec}s)`).join(', ')}`)
    console.log(`  sync     : ${syncPairs.map((p) => `${p.pairId}: left=${p.leftAnchorSec}s right=${p.rightAnchorSec}s leftMinusRight=${p.leftMinusRightSec}s`).join('; ')}`)
    console.log(`  checks   : ${assertions.shotChecks.length} 项断言全过, pageErrors=0, consoleErrors=0, leakCheck=${assertions.usernameLeakCheck}`)
  } finally {
    await demoServer.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.storyboard)) throw new Error(`找不到分镜文件: ${args.storyboard}`)
  const storyboard = JSON.parse(readFileSync(args.storyboard, 'utf8'))
  const brand = await loadBrand(storyboard.brandSource || 'frontend/src/brand.js')
  const check = validateStoryboard(storyboard, brand)

  if (args.dryRun) {
    console.log(`[dry-run] storyboard: ${args.storyboard}`)
    console.log(`[dry-run] brand source: ${storyboard.brandSource} (${brand.name})`)
    console.log(`[dry-run] shots: ${check.shotSummaries.length} | totalBudget: ${check.totalSec}s / ${check.maxTargetBudget}s`)
    console.log('\n| Shot | Roles | Layout | Budget | Tag | Subtitle | Len | Asserts |')
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const s of check.shotSummaries) {
      console.log(`| ${s.shotId} | ${s.roles} | ${s.layout} | ${s.durationSec}s | ${s.featureTag} | ${s.subtitle} | ${s.subtitleLen}/${check.maxSubtitleChars} | ${s.assertCount} |`)
    }
    if (!check.ok) {
      console.error(`\n[dry-run] 校验失败（${check.issues.length} 项）：`)
      for (const issue of check.issues) console.error(`  - ${issue}`)
      process.exit(1)
    }
    console.log('\n[dry-run] 全部校验通过（未启动浏览器、未修改数据库）。')
    return
  }

  if (!check.ok) {
    throw new Error(`storyboard.json 预检失败（${check.issues.length} 项）：\n  - ${check.issues.join('\n  - ')}`)
  }

  await runRecording(args, storyboard, brand)
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  process.exit(1)
})
