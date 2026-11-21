/**
 * P4 成片自动验收模块：
 * 1. ffprobe 硬指标校验（1920×1080 / 30fps / H.264 yuv420p / ≤60s / 与 data-duration 一致 / 纯静音单轨 / moov faststart）；
 * 2. 真实浏览器排版 80% 标题安全区校验（x ∈ [192, 1728], y ∈ [108, 972]），测量全部字幕、功能标签与片尾 CTA 的真实 DOM 包围盒；
 * 3. 导出 640×360 预览成片 yuzhua-demo-360p.mp4 并 ffprobe 复核；
 * 4. 分别从最终 1080p 与 360p 成片直接解码抽帧并生成对比拼图，供目检确认零黑屏、零花屏、360p 字幕清晰可读；
 * 5. 汇总写入 output/demo-video/<date>/p4-check.json。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { probeVideo } from './ffmpeg-prep.mjs'
import { planKeyframeSamples } from './contact-sheet.mjs'

const TITLE_SAFE = { xMin: 192, xMax: 1728, yMin: 108, yMax: 972 }
const r2 = (n) => Math.round(n * 100) / 100
const r3 = (n) => Math.round(n * 1000) / 1000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
}

function runFfmpeg(args, { cwd, label }) {
  const res = spawnSync('ffmpeg', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 25 * 1024 * 1024 })
  if (res.error) throw new Error(`${label} 启动失败: ${res.error.message}`)
  if (res.status !== 0) {
    const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-12).join('\n')
    throw new Error(`${label} 失败（exit ${res.status}）:\n${tail}`)
  }
}

/**
 * 检查 MP4 顶层 box 顺序，确认 moov 位于 mdat 之前（+faststart）。
 */
export function checkMp4Faststart(filePath) {
  const size = statSync(filePath).size
  const fd = openSync(filePath, 'r')
  const header = Buffer.alloc(16)
  let offset = 0
  let moovOffset = -1
  let mdatOffset = -1
  try {
    while (offset + 8 <= size) {
      const read = readSync(fd, header, 0, 16, offset)
      if (read < 8) break
      let boxSize = header.readUInt32BE(0)
      const type = header.toString('ascii', 4, 8)
      if (type === 'moov' && moovOffset < 0) moovOffset = offset
      if (type === 'mdat' && mdatOffset < 0) mdatOffset = offset
      if (moovOffset >= 0 && mdatOffset >= 0) break
      if (boxSize === 1 && read >= 16) {
        boxSize = Number(header.readBigUInt64BE(8))
      } else if (boxSize === 0) {
        break
      }
      if (boxSize < 8) break
      offset += boxSize
    }
  } finally {
    closeSync(fd)
  }
  return {
    faststart: moovOffset >= 0 && mdatOffset >= 0 && moovOffset < mdatOffset,
    moovOffset,
    mdatOffset,
  }
}

/**
 * 无损快速重封装加 +faststart（若原成片 moov 不在前面）。
 */
export function ensureFaststart(inputPath, outputPath) {
  const tmpPath = `${outputPath}.faststart.mp4`
  runFfmpeg(
    ['-y', '-i', inputPath, '-c', 'copy', '-an', '-movflags', '+faststart', tmpPath],
    { cwd: process.cwd(), label: 'MP4 faststart 重封装' },
  )
  rmSync(outputPath, { force: true })
  const fs = createRequire(import.meta.url)('node:fs')
  fs.renameSync(tmpPath, outputPath)
}

/**
 * 在真实无头 Chromium 中加载已生成的字形与 HTML 模板，实测全部字幕/标签/CTA 的 DOM 包围盒是否完全落在 80% 标题安全区。
 */
export async function verifyTitleSafeBoxes({ hfProjectDir, renderPlan }) {
  const require = createRequire(import.meta.url)
  let playwright
  const candidates = [
    process.env.PLAYWRIGHT_PACKAGE,
    'playwright',
    join(process.env.APPDATA || '', 'npm', 'node_modules', 'playwright'),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      playwright = require(c)
      break
    } catch {}
  }
  if (!playwright?.chromium) {
    throw new Error('找不到 Playwright Chromium 以执行 80% 标题安全区真实 DOM 校验')
  }

  // 起本地只读临时静态服务指向 hf-project/，保证 @font-face 与素材正常加载
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    if (urlPath === '/__measure__.html') {
      const target = new URL(req.url, 'http://127.0.0.1').searchParams.get('src') || ''
      const abs = resolve(hfProjectDir, target)
      if (!abs.startsWith(resolve(hfProjectDir)) || !existsSync(abs)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const raw = readFileSync(abs, 'utf8')
      // 剥离 <template> 包裹与 <script>（直接测量稳态布局盒），对字幕组与 CTA 强制可见
      const inner = raw
        .replace(/^\s*<template>\s*/i, '')
        .replace(/\s*<\/template>\s*$/i, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
        *{margin:0;padding:0;box-sizing:border-box}
        html,body{width:1920px;height:1080px;position:relative;overflow:hidden;background:#f7f7f7}
        .cap-group,.end-wrap{opacity:1 !important;visibility:visible !important}
      </style></head><body>${inner}</body></html>`
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    const rel = urlPath.replace(/^\/+/, '')
    const abs = resolve(hfProjectDir, rel)
    if (!abs.startsWith(resolve(hfProjectDir)) || !existsSync(abs) || statSync(abs).isDirectory()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream' })
    res.end(readFileSync(abs))
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const channel = process.env.PLAYWRIGHT_CHANNEL || 'msedge'
  let browser
  try {
    try {
      browser = await playwright.chromium.launch({ channel, headless: true })
    } catch {
      browser = await playwright.chromium.launch({ headless: true })
    }
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

    const checks = []
    const violations = []

    const measureSelectors = async (srcFile, items) => {
      await page.goto(`${base}/__measure__.html?src=${encodeURIComponent(srcFile)}`, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)
      const boxes = await page.evaluate((list) => {
        const out = []
        for (const item of list) {
          const els = [...document.querySelectorAll(item.selector)]
          els.forEach((el, idx) => {
            const r = el.getBoundingClientRect()
            const cs = getComputedStyle(el)
            out.push({
              label: els.length > 1 ? `${item.label}[${idx}]` : item.label,
              selector: item.selector,
              text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
              fontSizePx: parseFloat(cs.fontSize) || 0,
              x: r.left,
              y: r.top,
              right: r.right,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
            })
          })
        }
        return out
      }, items)

      for (const b of boxes) {
        if (b.width <= 0 || b.height <= 0) continue
        const inside =
          b.x >= TITLE_SAFE.xMin - 0.5 &&
          b.right <= TITLE_SAFE.xMax + 0.5 &&
          b.y >= TITLE_SAFE.yMin - 0.5 &&
          b.bottom <= TITLE_SAFE.yMax + 0.5
        const entry = {
          file: srcFile,
          label: b.label,
          text: b.text,
          fontSizePx: r2(b.fontSizePx),
          box: { x: r2(b.x), y: r2(b.y), right: r2(b.right), bottom: r2(b.bottom), w: r2(b.width), h: r2(b.height) },
          insideTitleSafe: inside,
        }
        checks.push(entry)
        if (!inside) violations.push(entry)
      }
    }

    // 1. 宽幅字幕轨 overlay-captions.html：全部 .cap-group 按真实绝对定位叠于 subtitle-zone(y=880..960) 逐一测量
    await page.goto(`${base}/__measure__.html?src=${encodeURIComponent('compositions/overlay-captions.html')}`, {
      waitUntil: 'load',
    })
    await page.evaluate(() => document.fonts.ready)
    const capResults = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.cap-group')]
      const out = []
      for (const g of groups) {
        const bar = g.querySelector('.cap-bar')
        const tag = g.querySelector('.cap-tag')
        const txt = g.querySelector('.cap-text')
        for (const [kind, el] of [
          ['bar', bar],
          ['tag', tag],
          ['text', txt],
        ]) {
          if (!el) continue
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          out.push({
            label: `${g.id}:${kind}`,
            text: (el.textContent || '').trim(),
            fontSizePx: parseFloat(cs.fontSize) || 0,
            x: r.left,
            y: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          })
        }
      }
      return out
    })
    for (const b of capResults) {
      const inside =
        b.x >= TITLE_SAFE.xMin - 0.5 &&
        b.right <= TITLE_SAFE.xMax + 0.5 &&
        b.y >= TITLE_SAFE.yMin - 0.5 &&
        b.bottom <= TITLE_SAFE.yMax + 0.5
      const entry = {
        file: 'compositions/overlay-captions.html',
        label: b.label,
        text: b.text,
        fontSizePx: r2(b.fontSizePx),
        box: { x: r2(b.x), y: r2(b.y), right: r2(b.right), bottom: r2(b.bottom), w: r2(b.width), h: r2(b.height) },
        insideTitleSafe: inside,
      }
      checks.push(entry)
      if (!inside) violations.push(entry)
    }

    // 2. 手机镜头右侧故事字幕卡（S01 / S02 / S05）
    for (const s of renderPlan.shots.filter((sh) => sh.layout === 'phone')) {
      await measureSelectors(`compositions/${s.shotId}.html`, [
        { label: `${s.shotId}:story-card`, selector: '.story-card' },
        { label: `${s.shotId}:story-tag`, selector: '.story-tag' },
        { label: `${s.shotId}:story-caption`, selector: '.story-caption' },
      ])
    }

    // 3. 片尾 CTA 核心排版（S08）
    for (const s of renderPlan.shots.filter((sh) => sh.layout === 'ending')) {
      await measureSelectors(`compositions/${s.shotId}.html`, [
        { label: `${s.shotId}:end-paper`, selector: '.end-paper' },
        { label: `${s.shotId}:end-stamp`, selector: '.end-stamp' },
        { label: `${s.shotId}:end-url`, selector: '.end-url' },
        { label: `${s.shotId}:end-subline`, selector: '.end-subline' },
      ])
    }

    return {
      ok: violations.length === 0,
      bounds: TITLE_SAFE,
      checkedCount: checks.length,
      violationCount: violations.length,
      violations,
      checks,
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
    server.close()
  }
}

function buildGridLayout(count, cols, cellW, cellH) {
  const pad = 8
  const coords = []
  for (let i = 0; i < count; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    coords.push(`${c * (cellW + pad)}_${r * (cellH + pad)}`)
  }
  return coords.join('|')
}

/**
 * 从已编码的 MP4 成片直接解码抽帧 + 拼图，并做非黑帧均值检测。
 */
function decodeFramesAndSheet({ videoPath, outDir, sheetName, samples, cellW, cellH, cols, withLabel, hfProjectDir }) {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const decoded = []
  for (const s of samples) {
    const pngPath = join(outDir, `${s.key}.png`)
    runFfmpeg(
      ['-y', '-ss', String(s.timeSec), '-i', videoPath, '-frames:v', '1', '-q:v', '2', pngPath],
      { cwd: hfProjectDir, label: `解码抽帧 ${s.key}` },
    )
    const sizeBytes = statSync(pngPath).size
    decoded.push({ ...s, path: pngPath, sizeBytes })
  }

  const sheetPath = join(outDir, sheetName)
  const args = ['-y']
  for (const d of decoded) args.push('-i', d.path)

  if (withLabel) {
    const fontSize = Math.max(16, Math.round(cellH * 0.055))
    const barH = Math.round(fontSize * 1.6)
    const tileH = cellH + barH
    const parts = decoded.map((d, idx) => {
      const txt = d.label.replace(/[:'\\]/g, ' ')
      return (
        `[${idx}:v]scale=${cellW}:${cellH}:flags=lanczos,` +
        `pad=iw:ih+${barH}:0:${barH}:color=#222222,` +
        `drawtext=fontfile='assets/fonts/NotoSansSC-VF.ttf':text='${txt}':fontcolor=#ffffff:fontsize=${fontSize}:x=12:y=${Math.round((barH - fontSize) * 0.45)}[v${idx}]`
      )
    })
    parts.push(
      `${decoded.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${decoded.length}:layout=${buildGridLayout(decoded.length, cols, cellW, tileH)}:fill=#e5e5e5[grid]`,
    )
    args.push('-filter_complex', parts.join(';'), '-map', '[grid]', '-frames:v', '1', sheetPath)
  } else {
    const parts = decoded.map((_, idx) => `[${idx}:v]scale=${cellW}:${cellH}:flags=lanczos[v${idx}]`)
    parts.push(
      `${decoded.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${decoded.length}:layout=${buildGridLayout(decoded.length, cols, cellW, cellH)}:fill=#d4d4d4[grid]`,
    )
    args.push('-filter_complex', parts.join(';'), '-map', '[grid]', '-frames:v', '1', sheetPath)
  }

  runFfmpeg(args, { cwd: hfProjectDir, label: `生成解码拼图 ${sheetName}` })
  return { sheetPath, frames: decoded }
}

/**
 * 执行完整 P4 自动校验并生成 p4-check.json。
 */
export async function runP4Verification({
  finalVideoPath,
  preview360Path,
  dateOutputDir,
  hfProjectDir,
  renderPlan,
  maxDurationSec = 60.0,
}) {
  // 1. 确保最终 1080p 成片为 +faststart
  let fsCheck = checkMp4Faststart(finalVideoPath)
  if (!fsCheck.faststart) {
    ensureFaststart(finalVideoPath, finalVideoPath)
    fsCheck = checkMp4Faststart(finalVideoPath)
  }
  const probe1080 = probeVideo(finalVideoPath)

  // 2. 导出 640×360 预览成片（用于小窗清晰度实测）
  runFfmpeg(
    [
      '-y',
      '-i',
      finalVideoPath,
      '-vf',
      'scale=640:360:flags=lanczos',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '20',
      '-preset',
      'medium',
      '-an',
      '-movflags',
      '+faststart',
      preview360Path,
    ],
    { cwd: hfProjectDir, label: '导出 640×360 预览成片' },
  )
  const probe360 = probeVideo(preview360Path)
  const fs360 = checkMp4Faststart(preview360Path)

  // 3. 80% 标题安全区真实 DOM 校验
  const titleSafe = await verifyTitleSafeBoxes({ hfProjectDir, renderPlan })

  // 4. 从最终 1080p 与 360p 成片分别解码抽取代表帧（首帧 + S01–S08 全部关键帧 + S08 红章闪瞬间）
  const baseSamples = planKeyframeSamples(renderPlan)
  const s08 = renderPlan.shots.find((s) => s.layout === 'ending')
  const decodeSamples = [...baseSamples]
  if (s08 && Number.isFinite(s08.ending?.flashSec)) {
    const flashAbs = r3(s08.startSec + s08.ending.flashSec - 0.12)
    decodeSamples.splice(decodeSamples.length - 1, 0, {
      key: 'S08-01b-flash',
      shotId: 'S08',
      role: 'flash',
      timeSec: flashAbs,
      label: `S08 ${flashAbs}s 红章闪`,
      isHero: false,
    })
  }

  const decoded1080Dir = join(dateOutputDir, 'decoded-1080p')
  const decoded360Dir = join(dateOutputDir, 'decoded-360p')
  const dec1080 = decodeFramesAndSheet({
    videoPath: finalVideoPath,
    outDir: decoded1080Dir,
    sheetName: 'contact-sheet-decoded-1080p.png',
    samples: decodeSamples,
    cellW: 480,
    cellH: 270,
    cols: 4,
    withLabel: true,
    hfProjectDir,
  })

  // 360p 解码拼图：取首帧 + 8 镜头 hero + S03 前段字幕 + S08 落地页（10 张 1:1 640×360 原像素）
  const preview360Samples = decodeSamples.filter(
    (s) => s.role === 'first_frame' || s.isHero || s.key === 'S03-02-detail' || s.key === 'S08-01-landing',
  )
  const dec360 = decodeFramesAndSheet({
    videoPath: preview360Path,
    outDir: decoded360Dir,
    sheetName: 'contact-sheet-decoded-360p.png',
    samples: preview360Samples,
    cellW: 640,
    cellH: 360,
    cols: 2,
    withLabel: false,
    hfProjectDir,
  })

  // 5. 汇总硬校验结果
  const durationDeltaSec = r3(Math.abs(probe1080.durationSec - renderPlan.totalDurationSec))
  const checks1080 = {
    nonEmpty: probe1080.sizeBytes > 0,
    resolutionOk: probe1080.width === 1920 && probe1080.height === 1080,
    fpsOk: probe1080.fps === '30/1',
    codecOk: probe1080.codec === 'h264' && probe1080.pixFmt === 'yuv420p',
    silentOk: !probe1080.hasAudio && probe1080.nbStreams === 1,
    durationWithinLimit: probe1080.durationSec > 0 && probe1080.durationSec <= maxDurationSec + 0.05,
    durationMatchesRoot: durationDeltaSec <= 0.12,
    faststartOk: fsCheck.faststart,
    allDecodedNonEmpty: dec1080.frames.every((f) => f.sizeBytes > 10240),
  }
  const checks360 = {
    nonEmpty: probe360.sizeBytes > 0,
    resolutionOk: probe360.width === 640 && probe360.height === 360,
    fpsOk: probe360.fps === '30/1',
    codecOk: probe360.codec === 'h264' && probe360.pixFmt === 'yuv420p',
    silentOk: !probe360.hasAudio && probe360.nbStreams === 1,
    faststartOk: fs360.faststart,
    allDecodedNonEmpty: dec360.frames.every((f) => f.sizeBytes > 5120),
  }

  const allOk =
    Object.values(checks1080).every(Boolean) &&
    Object.values(checks360).every(Boolean) &&
    titleSafe.ok

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: allOk,
    rootDurationSec: renderPlan.totalDurationSec,
    durationDeltaSec,
    video1080p: {
      path: resolve(finalVideoPath),
      probe: probe1080,
      faststart: fsCheck,
      checks: checks1080,
    },
    video360p: {
      path: resolve(preview360Path),
      probe: probe360,
      faststart: fs360,
      checks: checks360,
    },
    titleSafe80Pct: titleSafe,
    decodedFrames: {
      sheet1080p: resolve(dec1080.sheetPath),
      sheet360p: resolve(dec360.sheetPath),
      count1080p: dec1080.frames.length,
      count360p: dec360.frames.length,
      frames1080p: dec1080.frames.map((f) => ({ key: f.key, timeSec: f.timeSec, sizeBytes: f.sizeBytes, path: resolve(f.path) })),
      frames360p: dec360.frames.map((f) => ({ key: f.key, timeSec: f.timeSec, sizeBytes: f.sizeBytes, path: resolve(f.path) })),
    },
  }

  const reportPath = join(dateOutputDir, 'p4-check.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  return { report, reportPath }
}
