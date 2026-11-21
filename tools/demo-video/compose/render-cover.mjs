/**
 * P5 可再生 B 站封面生成器（1920×1080 16:9 + 居中 1440×1080 4:3 裁切安全区）：
 * - 遵守规矩一：品牌文案全部从 frontend/src/brand.js 动态读取，严禁硬编码；
 * - 遵守规矩二：由 node tools/demo-video/build.mjs --stage=cover（或 --stage=render）一键生成；
 * - 视觉规范：沿用 deploy/demo/agent-draft.html 墨色 #222222 + #f7f7f7/#ffffff + #d92549 体系，
 *   结合本轮实录高分真机画面（宠主手机端建议到院卡 + 医生门诊病历 + 管理端全院看板）、
 *   logo.svg 与 tuantuan.webp；
 * - 安全区硬校验：在真实无头 Chromium 中测量全部核心元素的 DOM 包围盒，确保 100% 落在
 *   居中 4:3 安全区 x ∈ [240, 1680], y ∈ [0, 1080] 内，并同步导出 1440×1080 4:3 裁切预览图。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { escHtml, FONT_FACE_CSS } from './templates/motion-helpers.mjs'

const SAFE_4X3 = { xMin: 240, xMax: 1680, yMin: 36, yMax: 1044 }
const r2 = (n) => Math.round(n * 100) / 100

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
}

function runFfmpeg(args, label) {
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8', windowsHide: true })
  if (res.error) throw new Error(`${label} 启动失败: ${res.error.message}`)
  if (res.status !== 0) {
    const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-10).join('\n')
    throw new Error(`${label} 失败（exit ${res.status}）:\n${tail}`)
  }
}

function pngDimensions(filePath) {
  const buf = readFileSync(filePath)
  if (buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`不是有效 PNG 文件: ${filePath}`)
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    sizeBytes: buf.length,
  }
}

/**
 * 从预处理后的无水印高分实录 MP4 中抽取封面所需的 3 张代表性真机画面。
 */
function prepareCoverScreenAssets({ hfProjectDir, dateOutputDir }) {
  const coverAssetsDir = join(hfProjectDir, 'assets', 'cover')
  mkdirSync(coverAssetsDir, { recursive: true })

  const clipsDir = join(hfProjectDir, 'assets', 'clips')
  const rawDir = join(dateOutputDir, 'raw')

  // 1. 宠主手机端：S04 医生建议到院就诊 + 去预约挂号卡片（若不存在则回退 raw/owner-main.webm）
  const phoneOut = join(coverAssetsDir, 'screen-phone.png')
  const s04Left = join(clipsDir, 'S04_left_owner.mp4')
  if (existsSync(s04Left)) {
    runFfmpeg(['-y', '-ss', '4.1', '-i', s04Left, '-frames:v', '1', phoneOut], '抽取封面手机真机图')
  } else {
    runFfmpeg(['-y', '-ss', '26.2', '-i', join(rawDir, 'owner-main.webm'), '-frames:v', '1', phoneOut], '抽取封面手机真机图(raw)')
  }

  // 2. 管理端全院看板：S07 今日概览 6 / ¥350.00 + 趋势与状态图
  const adminOut = join(coverAssetsDir, 'screen-admin.png')
  const s07Main = join(clipsDir, 'S07_admin.mp4')
  if (existsSync(s07Main)) {
    runFfmpeg(['-y', '-ss', '1.2', '-i', s07Main, '-frames:v', '1', adminOut], '抽取封面看板真机图')
  } else {
    runFfmpeg(['-y', '-ss', '3.0', '-i', join(rawDir, 'admin-dashboard.webm'), '-frames:v', '1', adminOut], '抽取封面看板真机图(raw)')
  }

  // 3. 医生端门诊病历工作台：S06 填写完整 + 病历已保存
  const doctorOut = join(coverAssetsDir, 'screen-doctor.png')
  const s06Main = join(clipsDir, 'S06_doctor.mp4')
  if (existsSync(s06Main)) {
    runFfmpeg(['-y', '-ss', '7.2', '-i', s06Main, '-frames:v', '1', doctorOut], '抽取封面医生工作台真机图')
  } else {
    runFfmpeg(['-y', '-ss', '8.2', '-i', join(rawDir, 'doctor-workbench.webm'), '-frames:v', '1', doctorOut], '抽取封面医生工作台真机图(raw)')
  }

  return { phoneOut, adminOut, doctorOut }
}

/**
 * 构建 B 站封面 HTML（1920×1080，所有核心信息严格收敛在中心 1440×1080 [x: 276..1644] 内）。
 */
function buildCoverHtml({ brand, ctaUrl = 'yuzhua-petclinic.top/demo' }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <style>${FONT_FACE_CSS}
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      html,
      body {
        width: 1920px;
        height: 1080px;
        overflow: hidden;
        background: #f7f7f7;
        color: #222222;
        font-family: "YuzhuaSC", sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      /* 左右 240px 安全留白区仅作纸面底纹，全部主体严格在 x ∈ [276, 1644]（中心 1368px < 1440px） */
      .cover-root {
        position: relative;
        width: 1920px;
        height: 1080px;
        background:
          radial-gradient(circle at 50% 48%, rgba(217, 37, 73, 0.045) 0%, rgba(247, 247, 247, 0) 68%),
          #f7f7f7;
      }

      /* 主诊单纸卡：x = 276..1644 (宽 1368px，距 4:3 裁切线 [240, 1680] 各留 36px 余量)，y = 142..982 */
      .cover-paper {
        position: absolute;
        left: 276px;
        top: 142px;
        width: 1368px;
        height: 840px;
        background: #ffffff;
        border: 2.5px solid #222222;
        border-top: 8px solid #d92549;
        box-shadow: 16px 16px 0 rgba(34, 34, 34, 0.08);
        display: flex;
        align-items: stretch;
        justify-content: space-between;
        padding: 54px 56px;
      }

      /* 团团吉祥物趴在纸沿上方：x = 332..572, y = 52..172（完全在 4:3 安全区内） */
      .cover-dog {
        position: absolute;
        left: 332px;
        top: 52px;
        width: 236px;
        height: auto;
        z-index: 15;
        pointer-events: none;
      }

      /* 左栏：大字标题与三端卖点（宽 544px，与右侧手机框留足 50px+ 纸面呼吸间距） */
      .cover-left {
        width: 544px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding-top: 18px;
        padding-bottom: 6px;
        z-index: 5;
      }

      .brand-row {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .brand-row img {
        width: 46px;
        height: 46px;
        display: block;
      }
      .brand-name {
        font-size: 40px;
        font-weight: 800;
        color: #222222;
        letter-spacing: -0.01em;
      }
      .brand-pill {
        margin-left: 6px;
        padding: 6px 16px;
        background: #222222;
        color: #ffffff;
        font-size: 24px;
        font-weight: 700;
        letter-spacing: 0.04em;
      }

      .hero-copy {
        margin-top: 16px;
      }

      .hero-kicker {
        display: inline-block;
        font-size: 28px;
        font-weight: 700;
        color: #d92549;
        letter-spacing: 0.04em;
        margin-bottom: 14px;
      }

      .hero-title {
        font-size: 76px;
        font-weight: 900;
        line-height: 1.16;
        color: #222222;
        letter-spacing: -0.025em;
      }
      .hero-title span {
        display: block;
      }
      .hero-title .accent {
        color: #d92549;
      }

      .role-flow {
        margin-top: 28px;
        padding: 18px 22px;
        width: fit-content;
        max-width: 100%;
        background: #f7f7f7;
        border: 1.5px solid #222222;
        border-left: 7px solid #d92549;
        display: inline-flex;
        align-items: center;
        gap: 14px;
        font-size: 30px;
        font-weight: 800;
        color: #222222;
        white-space: nowrap;
      }
      .role-arrow {
        color: #d92549;
        font-weight: 900;
      }

      .cta-footer {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding-top: 22px;
        border-top: 1.5px solid #ebebeb;
      }

      .stamp-line {
        display: flex;
        align-items: center;
        gap: 18px;
      }

      .red-stamp {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 12px 26px;
        background: #d92549;
        color: #ffffff;
        font-size: 32px;
        font-weight: 800;
        letter-spacing: 0.04em;
        border: 2px solid #d92549;
      }

      .stamp-note {
        font-size: 28px;
        font-weight: 700;
        color: #3f3f3f;
      }

      .cta-domain {
        font-size: 28px;
        font-weight: 700;
        color: #222222;
        letter-spacing: 0.01em;
      }

      /* 右栏：三端真实产品界面叠层舞台（宽 664px，完全在纸卡内） */
      .cover-right {
        position: relative;
        width: 664px;
        height: 724px;
        flex: none;
      }

      /* 顶右：管理端全院经营看板真机窗 */
      .shot-admin {
        position: absolute;
        right: 0;
        top: 6px;
        width: 536px;
        height: 334px;
        border: 2px solid #222222;
        border-radius: 10px;
        background: #ffffff;
        overflow: hidden;
        box-shadow: 0 16px 36px rgba(34, 34, 34, 0.14);
        z-index: 2;
      }
      .window-bar {
        height: 32px;
        background: #222222;
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 14px;
        font-size: 18px;
        font-weight: 700;
      }
      .window-dots {
        display: inline-flex;
        gap: 6px;
      }
      .window-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #595959;
      }
      .window-dot.red {
        background: #d92549;
      }
      .shot-admin img {
        width: 100%;
        height: calc(100% - 32px);
        object-fit: cover;
        object-position: top center;
        display: block;
      }

      /* 底右：医生端门诊病历工作台真机窗（标题左移避开前景手机框右沿） */
      .shot-doctor {
        position: absolute;
        right: 0;
        bottom: 10px;
        width: 504px;
        height: 340px;
        border: 2px solid #222222;
        border-radius: 10px;
        background: #ffffff;
        overflow: hidden;
        box-shadow: 0 18px 40px rgba(34, 34, 34, 0.16);
        z-index: 3;
      }
      .shot-doctor .window-bar {
        padding-left: 112px;
      }
      .shot-doctor img {
        width: 100%;
        height: calc(100% - 32px);
        object-fit: cover;
        object-position: top left;
        display: block;
      }

      /* 左前前景：宠主手机端问诊转挂号真机框 */
      .shot-phone {
        position: absolute;
        left: 0;
        top: 124px;
        width: 248px;
        height: 536px;
        padding: 6px;
        border-radius: 34px;
        background: #222222;
        border: 2.5px solid #d92549;
        box-shadow: 0 22px 48px rgba(34, 34, 34, 0.24);
        z-index: 6;
      }
      .shot-phone-inner {
        width: 100%;
        height: 100%;
        border-radius: 27px;
        overflow: hidden;
        background: #ffffff;
      }
      .shot-phone-inner img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top center;
        display: block;
      }
    </style>
  </head>
  <body>
    <main class="cover-root">
      <img class="cover-dog" src="assets/brand/tuantuan.webp" alt="" />
      <article class="cover-paper" id="cover-paper">
        <div class="cover-left" id="cover-left">
          <div>
            <div class="brand-row" id="cover-brand">
              <img src="assets/brand/logo.svg" alt="${escHtml(brand.name)}" />
              <span class="brand-name">${escHtml(brand.name)}</span>
              <span class="brand-pill">三端实录</span>
            </div>

            <div class="hero-copy">
              <span class="hero-kicker">60 秒全流程演示 · 已上线可试用</span>
              <h1 class="hero-title" id="cover-title">
                <span>宠物医院预约</span>
                <span class="accent">+ 在线图文问诊</span>
              </h1>
            </div>

            <div class="role-flow" id="cover-flow">
              <span>宠主问诊</span>
              <span class="role-arrow">→</span>
              <span>医生病历</span>
              <span class="role-arrow">→</span>
              <span>全院看板</span>
            </div>
          </div>

          <div class="cta-footer" id="cover-cta">
            <div class="stamp-line">
              <span class="red-stamp">免注册直接体验</span>
              <span class="stamp-note">三端同一套数据</span>
            </div>
            <div class="cta-domain">${escHtml(ctaUrl)}</div>
          </div>
        </div>

        <div class="cover-right" id="cover-screens">
          <div class="shot-admin" id="cover-shot-admin">
            <div class="window-bar">
              <span>管理端 · 全院经营看板</span>
              <span class="window-dots"><span class="window-dot red"></span><span class="window-dot"></span><span class="window-dot"></span></span>
            </div>
            <img src="assets/cover/screen-admin.png" alt="" />
          </div>

          <div class="shot-doctor" id="cover-shot-doctor">
            <div class="window-bar">
              <span id="cover-doctor-title">医生端 · 门诊电子病历</span>
              <span class="window-dots"><span class="window-dot red"></span><span class="window-dot"></span><span class="window-dot"></span></span>
            </div>
            <img src="assets/cover/screen-doctor.png" alt="" />
          </div>

          <div class="shot-phone" id="cover-shot-phone">
            <div class="shot-phone-inner">
              <img src="assets/cover/screen-phone.png" alt="" />
            </div>
          </div>
        </div>
      </article>
    </main>
  </body>
</html>
`
}

/**
 * 渲染 B 站封面 PNG（1920×1080）+ 4:3 裁切预览（1440×1080）+ 信息流小图预览（480×270），
 * 并校验所有核心元素的真实 DOM 包围盒严格位于 4:3 安全区 x ∈ [240, 1680]。
 */
export async function generateBilibiliCover({
  hfProjectDir,
  dateOutputDir,
  coverOutputPath,
  brand,
  storyboard,
}) {
  prepareCoverScreenAssets({ hfProjectDir, dateOutputDir })

  const ctaUrl = storyboard?.shots?.find((s) => s.cta?.url)?.cta?.url || 'yuzhua-petclinic.top/demo'
  const coverHtml = buildCoverHtml({ brand, ctaUrl })

  // 敏感词静态审计
  const forbidden = storyboard?.forbiddenVisibleText || [
    'doctor13',
    'zhangsan',
    'admin',
    'doctor01',
    'Yuzhua@2026',
    '演示视频即将上线',
  ]
  for (const term of forbidden) {
    if (term === 'admin') {
      const visibleText = coverHtml
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
      if (/\badmin\b/i.test(visibleText)) {
        throw new Error(`封面 HTML 可见文本命中禁用词: ${term}`)
      }
    } else if (coverHtml.includes(term)) {
      throw new Error(`封面 HTML 命中禁用词: ${term}`)
    }
  }

  const coverHtmlPath = join(hfProjectDir, 'cover.html')
  writeFileSync(coverHtmlPath, coverHtml, 'utf8')

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
    throw new Error('找不到 Playwright Chromium 用于渲染 B 站封面')
  }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'cover.html'
    const abs = resolve(hfProjectDir, urlPath)
    if (!abs.startsWith(resolve(hfProjectDir)) || !existsSync(abs) || statSync(abs).isDirectory()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream' })
    res.end(readFileSync(abs))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const channel = process.env.PLAYWRIGHT_CHANNEL || 'msedge'
  let browser
  try {
    try {
      browser = await playwright.chromium.launch({ channel, headless: true })
    } catch {
      browser = await playwright.chromium.launch({ headless: true })
    }
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}/cover.html`, { waitUntil: 'load' })
    await page.evaluate(async () => {
      await document.fonts.ready
      const imgs = [...document.querySelectorAll('img')]
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((res, rej) => {
                img.onload = res
                img.onerror = rej
              }),
        ),
      )
    })

    // 测量所有核心元素包围盒，校验 100% 落在中心 4:3 安全区 x ∈ [240, 1680] 且文案与手机框零遮挡
    const selectors = [
      '#cover-paper',
      '.cover-dog',
      '#cover-brand',
      '#cover-title',
      '#cover-flow',
      '#cover-cta',
      '#cover-screens',
      '#cover-shot-admin',
      '#cover-shot-doctor',
      '#cover-doctor-title',
      '#cover-shot-phone',
    ]
    const boxes = await page.evaluate((sels) => {
      return sels.map((sel) => {
        const el = document.querySelector(sel)
        if (!el) return { selector: sel, missing: true }
        const r = el.getBoundingClientRect()
        return {
          selector: sel,
          x: r.left,
          y: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        }
      })
    }, selectors)

    const violations = []
    const checkedBoxes = boxes.map((b) => {
      if (b.missing) {
        violations.push(b)
        return b
      }
      const inside4x3 =
        b.x >= SAFE_4X3.xMin &&
        b.right <= SAFE_4X3.xMax &&
        b.y >= SAFE_4X3.yMin &&
        b.bottom <= SAFE_4X3.yMax
      const item = {
        selector: b.selector,
        box: { x: r2(b.x), y: r2(b.y), right: r2(b.right), bottom: r2(b.bottom), w: r2(b.width), h: r2(b.height) },
        inside4x3SafeZone: inside4x3,
      }
      if (!inside4x3) violations.push(item)
      return item
    })

    if (violations.length > 0) {
      throw new Error(`封面元素越出 4:3 安全区 [240..1680]: ${JSON.stringify(violations)}`)
    }

    const boxMap = Object.fromEntries(checkedBoxes.map((b) => [b.selector, b.box]))
    if (boxMap['#cover-flow'].right + 16 > boxMap['#cover-shot-phone'].x) {
      throw new Error(`封面左栏流程条与手机框间距不足: flow.right=${boxMap['#cover-flow'].right}, phone.x=${boxMap['#cover-shot-phone'].x}`)
    }
    if (boxMap['#cover-doctor-title'].x < boxMap['#cover-shot-phone'].right + 10) {
      throw new Error(`医生端窗口标题被手机框遮挡: title.x=${boxMap['#cover-doctor-title'].x}, phone.right=${boxMap['#cover-shot-phone'].right}`)
    }

    mkdirSync(dirname(coverOutputPath), { recursive: true })
    await page.screenshot({ path: coverOutputPath, type: 'png' })
    const localCopyPath = join(dateOutputDir, 'cover-16x9.png')
    copyFileSync(coverOutputPath, localCopyPath)

    // 导出居中 4:3 (1440×1080) 裁切预览图与信息流小图 (480×270)
    const preview4x3Path = join(dateOutputDir, 'cover-4x3-preview.png')
    const previewSmallPath = join(dateOutputDir, 'cover-small-preview.png')
    runFfmpeg(
      ['-y', '-i', coverOutputPath, '-vf', 'crop=1440:1080:240:0', '-frames:v', '1', preview4x3Path],
      '生成 1440×1080 4:3 裁切预览图',
    )
    runFfmpeg(
      ['-y', '-i', coverOutputPath, '-vf', 'scale=480:270:flags=lanczos', '-frames:v', '1', previewSmallPath],
      '生成 480×270 信息流小图预览',
    )

    const dim16x9 = pngDimensions(coverOutputPath)
    const dim4x3 = pngDimensions(preview4x3Path)
    if (dim16x9.width !== 1920 || dim16x9.height !== 1080) {
      throw new Error(`cover.png 尺寸错误: ${dim16x9.width}x${dim16x9.height}`)
    }
    if (dim4x3.width !== 1440 || dim4x3.height !== 1080) {
      throw new Error(`cover-4x3-preview.png 尺寸错误: ${dim4x3.width}x${dim4x3.height}`)
    }

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      coverPath: resolve(coverOutputPath),
      preview4x3Path: resolve(preview4x3Path),
      previewSmallPath: resolve(previewSmallPath),
      dimensions16x9: dim16x9,
      dimensions4x3: dim4x3,
      safeZone4x3: SAFE_4X3,
      checkedCount: checkedBoxes.length,
      violationCount: 0,
      boxes: checkedBoxes,
    }
    const reportPath = join(dateOutputDir, 'cover-check.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    return { report, reportPath }
  } finally {
    if (browser) await browser.close().catch(() => {})
    server.close()
  }
}
