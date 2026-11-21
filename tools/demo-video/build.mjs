#!/usr/bin/env node
/**
 * 演示视频一键可再生构建入口（遵守仓库 AGENTS.md 三条规矩）：
 *   规矩一：品牌文案唯一事实源 frontend/src/brand.js，严禁硬编码；
 *   规矩二：一条命令可再生（默认全流程，中间产物与成片落 output/demo-video/<日期>/ 不入库）；
 *   规矩三：前置健康检查、幂等准备、HyperFrames check 零错误门禁、ffprobe 硬指标核验。
 *
 * 常用命令：
 *   node tools/demo-video/build.mjs --dry-run
 *   node tools/demo-video/build.mjs --skip-record --stage=keyframes --date 2026-11-21
 *   node tools/demo-video/build.mjs --stage=render --quality delivery
 *   node tools/demo-video/build.mjs --synth-test --stage=keyframes   # 合成端独立自检（不触碰业务栈）
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRAND } from '../../frontend/src/brand.js'
import { buildRenderPlan, MAX_TOTAL_DURATION_SEC, validateStoryboard } from './compose/render-plan.mjs'
import { preprocessAllClips } from './compose/ffmpeg-prep.mjs'
import { generateHyperFramesProject } from './compose/generate-project.mjs'
import { captureKeyframesAndSheets } from './compose/contact-sheet.mjs'
import { runP4Verification } from './compose/p4-verify.mjs'
import { generateBilibiliCover } from './compose/render-cover.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const STORYBOARD_PATH = join(__dirname, 'storyboard.json')
const PREPARE_SQL_PATH = join(__dirname, 'prepare.sql')
const RECORD_SCRIPT_PATH = join(__dirname, 'record.mjs')

const argv = process.argv.slice(2)
function flagValue(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1)
  const idx = argv.indexOf(name)
  if (idx >= 0 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) return argv[idx + 1]
  return fallback
}
const hasFlag = (name) => argv.includes(name)

function todayBeijingDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  return `${map.year}-${map.month}-${map.day}`
}

function fail(msg) {
  console.error(`\n[build] ERROR: ${msg}`)
  process.exit(1)
}

function log(msg) {
  console.log(`[build] ${msg}`)
}

function readEnvFile(filePath) {
  const map = {}
  if (!existsSync(filePath)) return map
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    map[key] = val
  }
  return map
}

function resolveHyperFramesCli() {
  const candidates = [
    process.env.HYPERFRAMES_PLUGIN_CLI,
    join(homedir(), '.agents', 'skills', 'hyperframes', 'scripts', 'plugin-cli.mjs'),
  ].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    fail(
      `找不到 HyperFrames CLI 启动器（已查：${candidates.join(', ')}）。请设置 HYPERFRAMES_PLUGIN_CLI。`,
    )
  }
  return found
}

function resolveChineseFont(storyboard) {
  const candidates = [
    process.env.YUZHUA_FONT_PATH,
    storyboard?.visualTheme?.localFontFallback,
    'C:\\Windows\\Fonts\\NotoSansSC-VF.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/PingFang.ttc',
  ].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    fail(
      `找不到可用的本地中文字体（推荐 SIL OFL NotoSansSC-VF.ttf，可通过 YUZHUA_FONT_PATH 指定）。`,
    )
  }
  return found
}

function hfEnv() {
  return {
    ...process.env,
    HYPERFRAMES_NO_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
  }
}

function runSync(cmd, args, { cwd = REPO_ROOT, env = process.env, input, label, capture = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : [input !== undefined ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.error) fail(`${label || cmd} 启动失败: ${res.error.message}`)
  if (res.status !== 0) {
    const extra = capture ? `\n${(res.stderr || res.stdout || '').trim().slice(-1500)}` : ''
    fail(`${label || cmd} 失败（exit ${res.status}）${extra}`)
  }
  return res
}

function checkPreflight(storyboard) {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 22) fail(`需要 Node.js 22+，当前 ${process.version}`)

  for (const bin of ['ffmpeg', 'ffprobe']) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true })
    if (r.error || r.status !== 0) fail(`未找到可用 ${bin}，请安装并加入 PATH`)
  }

  const hfCliPath = resolveHyperFramesCli()
  const fontPath = resolveChineseFont(storyboard)

  const logoPath = resolve(REPO_ROOT, storyboard?.visualTheme?.assets?.logo || 'deploy/demo/agent-assets/logo.svg')
  const mascotPath = resolve(REPO_ROOT, storyboard?.visualTheme?.assets?.mascot || 'deploy/demo/agent-assets/tuantuan.webp')
  if (!existsSync(logoPath)) fail(`缺少品牌图标: ${logoPath}`)
  if (!existsSync(mascotPath)) fail(`缺少吉祥物图: ${mascotPath}`)

  return { hfCliPath, fontPath, logoPath, mascotPath }
}

/**
 * 同步镜像内最新种子图（含 doctor-13.jpg / pet-11.jpg）到 Compose 上传卷，
 * 避免存量卷里保留旧头像（docs/部署步骤.md#L168）。
 */
function syncSeedUploadsVolume() {
  const dotEnv = readEnvFile(join(REPO_ROOT, '.env'))
  const volumeName = process.env.YUZHUA_UPLOADS_VOLUME || dotEnv.YUZHUA_UPLOADS_VOLUME || 'yuzhua_uploads_data'
  log(`同步种子图至 Docker 卷 ${volumeName} ...`)
  runSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${volumeName}:/seed-target`,
      '--entrypoint',
      'sh',
      'yuzhua-backend:local',
      '-c',
      'mkdir -p /seed-target/seed && cp -f /app/uploads/seed/*.jpg /seed-target/seed/',
    ],
    { label: '同步 Docker 上传卷种子图' },
  )
}

function runPrepareSql() {
  if (!existsSync(PREPARE_SQL_PATH)) fail(`找不到数据准备脚本: ${PREPARE_SQL_PATH}`)
  log('执行幂等数据准备 prepare.sql ...')
  const sqlContent = readFileSync(PREPARE_SQL_PATH, 'utf8')
  runSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -u petapp --default-character-set=utf8mb4 yuzhua',
    ],
    { input: sqlContent, label: '执行 prepare.sql' },
  )
}

function runHyperFramesCheck(hfCliPath, hfProjectDir, dateOutputDir) {
  log('运行 hyperframes check --json ...')
  const res = spawnSync(process.execPath, [hfCliPath, 'check', '--json'], {
    cwd: hfProjectDir,
    env: hfEnv(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 25 * 1024 * 1024,
  })
  if (res.error) fail(`hyperframes check 启动失败: ${res.error.message}`)
  const jsonMatch = res.stdout.match(/\{[\s\S]*\}\s*$/)
  if (!jsonMatch) {
    fail(`无法解析 hyperframes check JSON 输出（exit ${res.status}）:\n${res.stderr || res.stdout}`)
  }
  const report = JSON.parse(jsonMatch[0])
  const reportPath = join(dateOutputDir, 'hyperframes-check.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')

  const lintErr = report.lint?.errorCount ?? -1
  const rtErr = report.runtime?.errorCount ?? -1
  const layoutErr = report.layout?.errorCount ?? -1
  const contrastErr = report.contrast?.errorCount ?? -1
  const craftWarn = report.craft?.warningCount ?? 0

  log(
    `check 结果: ok=${report.ok} | lint=${lintErr} err | runtime=${rtErr} err | layout=${layoutErr} err | contrast=${contrastErr} err (${report.contrast?.passed ?? 0}/${report.contrast?.checked ?? 0}) | craft=${craftWarn} warn`,
  )
  if (!report.ok || lintErr > 0 || rtErr > 0 || layoutErr > 0 || contrastErr > 0) {
    const details = [
      ...(report.lint?.findings || []),
      ...(report.runtime?.findings || []),
      ...(report.layout?.findings || []),
      ...(report.contrast?.findings || []),
    ]
      .filter((f) => f.severity === 'error' || !f.severity)
      .slice(0, 12)
      .map((f) => `  - [${f.code || 'err'}] ${f.sourceFile || ''} ${f.selector || ''}: ${f.message}`)
      .join('\n')
    fail(`hyperframes check 未通过（详见 ${reportPath}）：\n${details}`)
  }
  return { report, reportPath }
}

/**
 * 独立自测模式（--synth-test）：生成模拟录屏与 timeline.json，验证全套合成与 check/snapshot 闭环。
 */
function createSyntheticFixture(storyboard, dateOutputDir) {
  const rawDir = join(dateOutputDir, 'raw')
  if (existsSync(rawDir)) rmSync(rawDir, { recursive: true, force: true })
  mkdirSync(rawDir, { recursive: true })

  log('生成 --synth-test 合成自测素材（4 路 FFmpeg 测试源）...')
  const makeClip = (name, size, duration, hue) => {
    const out = join(rawDir, name)
    runSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=25:duration=${duration}`,
        '-vf',
        `hue=h=${hue}`,
        '-c:v',
        'libvpx',
        '-b:v',
        '1500k',
        '-an',
        out,
      ],
      { label: `生成自测素材 ${name}`, capture: true },
    )
    return out
  }

  makeClip('owner-main.webm', '780x1688', 24, 0)
  makeClip('doctor-consult.webm', '2560x1600', 18, 80)
  makeClip('doctor-workbench.webm', '2560x1600', 10, 160)
  makeClip('admin-dashboard.webm', '2560x1440', 8, 220)
  makeClip('landing-demo.webm', '2560x1440', 4, 300)

  const baseEpoch = 1795200000000
  const synthTimeline = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://127.0.0.1:8088',
    timezone: 'Asia/Shanghai',
    brand: { name: BRAND.name },
    clips: [
      { clipId: 'owner-main', file: 'raw/owner-main.webm', role: 'owner', viewport: { width: 390, height: 844, dpr: 2 }, recordSize: { width: 780, height: 1688 }, fps: 25, durationSec: 24, recordedStartEpochMs: baseEpoch, clapperFrame: 5, usableStartSec: 0.4 },
      { clipId: 'doctor-consult', file: 'raw/doctor-consult.webm', role: 'doctor', viewport: { width: 1280, height: 800, dpr: 2 }, recordSize: { width: 2560, height: 1600 }, fps: 25, durationSec: 18, recordedStartEpochMs: baseEpoch + 6000, clapperFrame: 5, usableStartSec: 0.4 },
      { clipId: 'doctor-workbench', file: 'raw/doctor-workbench.webm', role: 'doctor', viewport: { width: 1280, height: 800, dpr: 2 }, recordSize: { width: 2560, height: 1600 }, fps: 25, durationSec: 10, recordedStartEpochMs: baseEpoch + 26000, clapperFrame: 5, usableStartSec: 0.4 },
      { clipId: 'admin-dashboard', file: 'raw/admin-dashboard.webm', role: 'admin', viewport: { width: 1280, height: 720, dpr: 2 }, recordSize: { width: 2560, height: 1440 }, fps: 25, durationSec: 8, recordedStartEpochMs: baseEpoch + 38000, clapperFrame: 5, usableStartSec: 0.4 },
      { clipId: 'landing-demo', file: 'raw/landing-demo.webm', role: 'landing', viewport: { width: 1280, height: 720, dpr: 2 }, recordSize: { width: 2560, height: 1440 }, fps: 25, durationSec: 4, recordedStartEpochMs: baseEpoch + 48000, clapperFrame: 5, usableStartSec: 0.4 },
    ],
    shots: [
      { shotId: 'S01', layout: 'phone', clipRefs: [{ clipId: 'owner-main', role: 'owner', trimStartSec: 0.5, trimEndSec: 5.5, playbackRate: 1.0 }] },
      { shotId: 'S02', layout: 'phone', clipRefs: [{ clipId: 'owner-main', role: 'owner', trimStartSec: 5.5, trimEndSec: 11.5, playbackRate: 1.0 }] },
      {
        shotId: 'S03',
        layout: 'split',
        clipRefs: [
          { clipId: 'owner-main', role: 'owner', trimStartSec: 11.5, trimEndSec: 17.5, playbackRate: 1.0 },
          { clipId: 'doctor-consult', role: 'doctor', trimStartSec: 5.5, trimEndSec: 11.5, playbackRate: 1.0 },
        ],
      },
      {
        shotId: 'S04',
        layout: 'split',
        clipRefs: [
          { clipId: 'owner-main', role: 'owner', trimStartSec: 17.5, trimEndSec: 22.0, playbackRate: 1.0 },
          { clipId: 'doctor-consult', role: 'doctor', trimStartSec: 11.5, trimEndSec: 16.0, playbackRate: 1.0 },
        ],
      },
      { shotId: 'S05', layout: 'phone', clipRefs: [{ clipId: 'owner-main', role: 'owner', trimStartSec: 15.0, trimEndSec: 23.5, playbackRate: 1.0 }] },
      { shotId: 'S06', layout: 'desktop', clipRefs: [{ clipId: 'doctor-workbench', role: 'doctor', trimStartSec: 0.5, trimEndSec: 9.5, playbackRate: 1.0 }] },
      { shotId: 'S07', layout: 'fullscreen', clipRefs: [{ clipId: 'admin-dashboard', role: 'admin', trimStartSec: 0.5, trimEndSec: 6.5, playbackRate: 1.0 }] },
      { shotId: 'S08', layout: 'landing_outro', clipRefs: [{ clipId: 'landing-demo', role: 'landing', trimStartSec: 0.5, trimEndSec: 3.0, playbackRate: 1.0 }] },
    ],
    events: [
      { eventId: 'ev-s01', actionId: 's01-submit', shotId: 'S01', clipId: 'owner-main', role: 'owner', type: 'click', tSec: 2.3, epochMs: baseEpoch + 2300, label: '搜索「耳」', target: { x: 260, y: 240, width: 84, height: 42, cx: 302, cy: 261, nx: 0.774, ny: 0.309 } },
      { eventId: 'ev-s02', actionId: 's02-open-consult', shotId: 'S02', clipId: 'owner-main', role: 'owner', type: 'click', tSec: 8.1, epochMs: baseEpoch + 8100, label: '点免费图文问诊', target: { x: 40, y: 760, width: 150, height: 48, cx: 115, cy: 784, nx: 0.295, ny: 0.929 } },
      { eventId: 'ev-s03-d', actionId: 's03-doc-accept', shotId: 'S03', clipId: 'doctor-consult', role: 'doctor', type: 'click', tSec: 7.1, epochMs: baseEpoch + 13100, label: '医生接诊', target: { x: 1080, y: 92, width: 110, height: 38, cx: 1135, cy: 111, nx: 0.887, ny: 0.139 } },
      { eventId: 'ev-s03-o', actionId: 's03-owner-send', shotId: 'S03', clipId: 'owner-main', role: 'owner', type: 'click', tSec: 15.2, epochMs: baseEpoch + 15200, label: '发送并已读', target: { x: 300, y: 780, width: 70, height: 36, cx: 335, cy: 798, nx: 0.859, ny: 0.945 } },
      { eventId: 'ev-s04-d', actionId: 's04-doc-suggest-send', shotId: 'S04', clipId: 'doctor-consult', role: 'doctor', type: 'click', tSec: 12.6, epochMs: baseEpoch + 18600, label: '发建议到院卡', target: { x: 640, y: 520, width: 120, height: 40, cx: 700, cy: 540, nx: 0.547, ny: 0.675 } },
      { eventId: 'ev-s04-o', actionId: 's04-owner-go-book', shotId: 'S04', clipId: 'owner-main', role: 'owner', type: 'click', tSec: 20.1, epochMs: baseEpoch + 20100, label: '去预约挂号', target: { x: 96, y: 540, width: 140, height: 38, cx: 166, cy: 559, nx: 0.426, ny: 0.662 } },
      { eventId: 'ev-s05', actionId: 's05-pay-confirm', shotId: 'S05', clipId: 'owner-main', role: 'owner', type: 'click', tSec: 19.2, epochMs: baseEpoch + 19200, label: '确认支付', target: { x: 60, y: 610, width: 270, height: 48, cx: 195, cy: 634, nx: 0.5, ny: 0.751 } },
      { eventId: 'ev-s06', actionId: 's06-finish-confirm', shotId: 'S06', clipId: 'doctor-workbench', role: 'doctor', type: 'click', tSec: 5.2, epochMs: baseEpoch + 31200, label: '确认结束', target: { x: 740, y: 470, width: 110, height: 38, cx: 795, cy: 489, nx: 0.621, ny: 0.611 } },
      { eventId: 'ev-s08', actionId: 's08-open-landing', shotId: 'S08', clipId: 'landing-demo', role: 'landing', type: 'click', tSec: 1.4, epochMs: baseEpoch + 49400, label: '红章位置', target: { x: 260, y: 420, width: 120, height: 48, cx: 320, cy: 444, nx: 0.25, ny: 0.617 } },
    ],
    gaps: [
      { gapId: 'gap-synth-1', shotId: 'S03', clipId: 'owner-main', reason: 'ws_wait', startSec: 13.0, endSec: 14.5, recommendedKeepSec: 0.35 },
    ],
    syncPairs: [
      { pairId: 'consult-split', shotIds: ['S03', 'S04'], leftClipId: 'owner-main', rightClipId: 'doctor-consult', anchorEventId: 'ev-s03-d', leftAnchorSec: 13.1, rightAnchorSec: 7.1, leftMinusRightSec: 6.0 },
    ],
    assertions: { pageErrors: [], consoleErrors: [], usernameLeakCheck: 'passed', shotChecks: [] },
  }

  const timelinePath = join(dateOutputDir, 'timeline.json')
  writeFileSync(timelinePath, JSON.stringify(synthTimeline, null, 2) + '\n', 'utf8')
  return timelinePath
}

async function main() {
  const dryRun = hasFlag('--dry-run')
  const synthTest = hasFlag('--synth-test')
  const skipRecord = hasFlag('--skip-record') || synthTest
  const skipPrepare = hasFlag('--skip-prepare') || skipRecord
  const stage = flagValue('--stage', 'render')
  const quality = flagValue('--quality', 'delivery')
  const workers = flagValue('--workers', '2')
  const dateStr = synthTest ? 'p3-synth-test' : flagValue('--date', todayBeijingDate())

  if (!['check', 'keyframes', 'render', 'verify', 'cover'].includes(stage)) {
    fail(`不支持的 --stage=${stage}，可选：check | keyframes | render | verify | cover`)
  }

  if (!existsSync(STORYBOARD_PATH)) fail(`找不到分镜文件: ${STORYBOARD_PATH}`)
  const storyboard = JSON.parse(readFileSync(STORYBOARD_PATH, 'utf8'))
  const sbCheck = validateStoryboard(storyboard)
  if (!sbCheck.ok) {
    fail(`storyboard.json 校验失败:\n- ${sbCheck.errors.join('\n- ')}`)
  }
  for (const w of sbCheck.warnings) log(`WARN: ${w}`)

  const baseUrl = flagValue('--base', storyboard.environment?.baseUrl || 'http://127.0.0.1:8088')
  const { hfCliPath, fontPath } = checkPreflight(storyboard)

  const dateOutputDir = join(REPO_ROOT, 'output', 'demo-video', dateStr)
  const hfProjectDir = join(dateOutputDir, 'hf-project')
  const keyframesDir = join(dateOutputDir, 'keyframes')
  const finalVideoPath = join(dateOutputDir, 'yuzhua-demo-60s.mp4')
  const preview360Path = join(dateOutputDir, 'yuzhua-demo-360p.mp4')
  const coverOutputPath = join(REPO_ROOT, 'docs', 'demo-video', 'cover.png')

  log(`品牌来源: frontend/src/brand.js -> "${BRAND.name}"（${BRAND.tagline}）`)
  log(`分镜校验通过: ${storyboard.shots.length} 镜头，总预算 ${sbCheck.totalBudgetSec}s（上限 ${MAX_TOTAL_DURATION_SEC}s）`)
  log(`输出目录: ${dateOutputDir} | stage=${stage} | date=${dateStr}`)

  if (dryRun) {
    log(`字体就绪: ${fontPath}`)
    log(`HyperFrames CLI: ${hfCliPath}`)
    if (existsSync(RECORD_SCRIPT_PATH)) {
      log('联检 record.mjs --dry-run ...')
      runSync(process.execPath, [RECORD_SCRIPT_PATH, '--dry-run'], { label: 'record.mjs --dry-run' })
    } else {
      log('提示: tools/demo-video/record.mjs 尚未落盘，跳过录屏脚本 dry-run。')
    }
    log('dry-run 全部校验通过（未修改数据库、未启动浏览器、未渲染）。')
    return
  }

  // 仅生成 B 站封面模式（--stage=cover）：复用既有 hf-project 或自动初始化素材后渲染 docs/demo-video/cover.png
  if (stage === 'cover') {
    if (!existsSync(join(hfProjectDir, 'assets', 'fonts', 'NotoSansSC-VF.ttf'))) {
      if (!existsSync(timelinePath)) fail(`缺少 timeline.json: ${timelinePath}`)
      const tl = JSON.parse(readFileSync(timelinePath, 'utf8'))
      const rp = buildRenderPlan({ storyboard, timeline: tl })
      mkdirSync(hfProjectDir, { recursive: true })
      preprocessAllClips({ renderPlan: rp, dateOutputDir, hfProjectDir })
      generateHyperFramesProject({ repoRoot: REPO_ROOT, hfProjectDir, renderPlan: rp, fontPath, storyboard })
    }
    log('运行 --stage=cover：渲染 B 站 16:9 封面与 4:3 安全区裁切预览...')
    const { report: cov, reportPath: covPath } = await generateBilibiliCover({
      hfProjectDir,
      dateOutputDir,
      coverOutputPath,
      brand: BRAND,
      storyboard,
    })
    log(
      `B 站封面已生成: ${cov.coverPath} (${cov.dimensions16x9.width}x${cov.dimensions16x9.height}, ${(cov.dimensions16x9.sizeBytes / 1024).toFixed(1)}KB)`,
    )
    log(
      `4:3 裁切预览: ${cov.preview4x3Path} (${cov.dimensions4x3.width}x${cov.dimensions4x3.height}, 安全区校验 ${cov.checkedCount}/${cov.checkedCount} 通过)`,
    )
    log(`封面校验报告: ${covPath}`)
    return
  }

  // 仅校验已有成片模式（--stage=verify）：直接复核已渲染的 yuzhua-demo-60s.mp4
  if (stage === 'verify') {
    const planPath = join(dateOutputDir, 'render-plan.json')
    if (!existsSync(finalVideoPath)) fail(`找不到待校验成片: ${finalVideoPath}`)
    if (!existsSync(planPath)) fail(`找不到 render-plan.json: ${planPath}`)
    const existingPlan = JSON.parse(readFileSync(planPath, 'utf8'))
    log('运行 --stage=verify：复核已有 1080p 成片、360p 预览与 80% 安全区...')
    const { report: p4, reportPath: p4Path } = await runP4Verification({
      finalVideoPath,
      preview360Path,
      dateOutputDir,
      hfProjectDir,
      renderPlan: existingPlan,
      maxDurationSec: MAX_TOTAL_DURATION_SEC,
    })
    log(
      `1080p 成片: ${p4.video1080p.probe.width}x${p4.video1080p.probe.height} ${p4.video1080p.probe.fps}fps ${p4.video1080p.probe.durationSec.toFixed(3)}s codec=${p4.video1080p.probe.codec}/${p4.video1080p.probe.pixFmt} streams=${p4.video1080p.probe.nbStreams} audio=${p4.video1080p.probe.hasAudio} faststart=${p4.video1080p.faststart.faststart} size=${(p4.video1080p.probe.sizeBytes / 1024 / 1024).toFixed(2)}MB`,
    )
    log(
      `360p  预览: ${p4.video360p.probe.width}x${p4.video360p.probe.height} ${p4.video360p.probe.fps}fps ${p4.video360p.probe.durationSec.toFixed(3)}s faststart=${p4.video360p.faststart.faststart} size=${(p4.video360p.probe.sizeBytes / 1024 / 1024).toFixed(2)}MB`,
    )
    log(
      `80% 安全区: ok=${p4.titleSafe80Pct.ok} (${p4.titleSafe80Pct.checkedCount} 个字幕/标签/CTA 盒，越界 ${p4.titleSafe80Pct.violationCount})`,
    )
    log(`P4 报告: ${p4Path}`)
    if (!p4.ok) fail(`P4 自动验收未通过，请查看报告: ${p4Path}`)
    log('stage=verify 全部通过！')
    return
  }

  mkdirSync(dateOutputDir, { recursive: true })

  // 步骤 1 & 2：数据准备（卷内种子图同步 + prepare.sql）
  if (!skipPrepare) {
    syncSeedUploadsVolume()
    runPrepareSql()
  } else {
    log('已跳过数据准备（--skip-prepare / --skip-record）。')
  }

  // 步骤 3：录制或自测夹具
  let timelinePath = join(dateOutputDir, 'timeline.json')
  if (synthTest) {
    timelinePath = createSyntheticFixture(storyboard, dateOutputDir)
  } else if (!skipRecord) {
    if (!existsSync(RECORD_SCRIPT_PATH)) fail(`找不到录屏脚本: ${RECORD_SCRIPT_PATH}`)
    log(`执行录屏 record.mjs（base=${baseUrl}, date=${dateStr}）...`)
    runSync(
      process.execPath,
      [RECORD_SCRIPT_PATH, '--date', dateStr, '--base', baseUrl],
      { label: '执行 record.mjs' },
    )
  } else {
    log(`复用既有录屏与 timeline.json: ${timelinePath}`)
  }

  if (!existsSync(timelinePath)) {
    fail(`缺少 timeline.json: ${timelinePath}（请先执行录屏或去掉 --skip-record）`)
  }
  const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'))

  // 步骤 4：生成确定性合成计划 renderPlan
  const renderPlan = buildRenderPlan({ storyboard, timeline })
  writeFileSync(join(dateOutputDir, 'render-plan.json'), JSON.stringify(renderPlan, null, 2) + '\n', 'utf8')
  log(
    `合成计划就绪: ${renderPlan.shots.length} 镜头，总时长 ${renderPlan.totalDurationSec}s @ ${renderPlan.fps}fps`,
  )

  // 步骤 5：FFmpeg 预处理（定帧 30fps, GOP=30, 按 gaps[] 裁空档并锁死双路同步）
  if (existsSync(hfProjectDir)) rmSync(hfProjectDir, { recursive: true, force: true })
  mkdirSync(hfProjectDir, { recursive: true })
  log('FFmpeg 预处理录屏片段（30fps CFR / -g 30 / 裁空档 / 纯静音）...')
  const prepSummary = preprocessAllClips({ renderPlan, dateOutputDir, hfProjectDir })
  for (const item of prepSummary) {
    log(
      `  - ${item.shotId}[${item.slot}]: ${item.resolution} ${item.durationSec.toFixed(2)}s (segs=${item.segmentsCount}, cut=${item.removedSec.toFixed(2)}s)`,
    )
  }

  // 步骤 6：生成 HyperFrames 工程 + 敏感词静态审计
  const gen = generateHyperFramesProject({
    repoRoot: REPO_ROOT,
    hfProjectDir,
    renderPlan,
    fontPath,
    storyboard,
  })
  log(`已生成 HyperFrames 工程（${gen.fileCount} 个 HTML 文件，敏感词审计 0 命中）: ${hfProjectDir}`)

  // 步骤 7：HyperFrames check --json 零错误门禁
  runHyperFramesCheck(hfCliPath, hfProjectDir, dateOutputDir)

  if (stage === 'check') {
    log('stage=check 完成，已按要求停止（未截拼图、未渲染成片）。')
    return
  }

  // 步骤 8：按镜头截取关键帧 + 生成拼图 & 640×360 可读性预览
  log('截取分镜头关键帧并生成验收拼图...')
  const sheetManifest = captureKeyframesAndSheets({
    hfCliPath,
    hfProjectDir,
    keyframesDir,
    renderPlan,
    env: hfEnv(),
  })
  log(`关键帧拼图已输出:\n  - 主拼图: ${sheetManifest.contactSheet}\n  - 明细拼图: ${sheetManifest.contactSheetDetail}\n  - 640×360 预览: ${sheetManifest.preview640x360}\n  - 首帧: ${sheetManifest.firstFrame}`)

  if (stage === 'keyframes') {
    log('stage=keyframes 完成（验收 1 门禁：尚未渲染最终 mp4）。')
    return
  }

  // 步骤 9：最终成片渲染（仅在 --stage=render 时执行）
  log(`开始渲染最终成片（quality=${quality}, workers=${workers}）-> ${finalVideoPath}`)
  runSync(
    process.execPath,
    [
      hfCliPath,
      'render',
      '--quality',
      quality,
      '--workers',
      String(workers),
      '--strict',
      '-o',
      finalVideoPath,
    ],
    { cwd: hfProjectDir, env: hfEnv(), label: 'hyperframes render' },
  )

  // 步骤 10：P4 自动验收（faststart + ffprobe 硬指标 + 80% 标题安全区真实 DOM 校验 + 360p 预览导出 + 双码率解码抽帧拼图）
  log('执行 P4 成片自动验收（ffprobe / faststart / 80% 安全区 / 360p 预览 / 解码抽帧）...')
  const { report: p4, reportPath: p4Path } = await runP4Verification({
    finalVideoPath,
    preview360Path,
    dateOutputDir,
    hfProjectDir,
    renderPlan,
    maxDurationSec: MAX_TOTAL_DURATION_SEC,
  })
  log(
    `1080p 成片: ${p4.video1080p.probe.width}x${p4.video1080p.probe.height} ${p4.video1080p.probe.fps}fps ${p4.video1080p.probe.durationSec.toFixed(3)}s codec=${p4.video1080p.probe.codec}/${p4.video1080p.probe.pixFmt} streams=${p4.video1080p.probe.nbStreams} audio=${p4.video1080p.probe.hasAudio} faststart=${p4.video1080p.faststart.faststart} size=${(p4.video1080p.probe.sizeBytes / 1024 / 1024).toFixed(2)}MB`,
  )
  log(
    `360p  预览: ${p4.video360p.probe.width}x${p4.video360p.probe.height} ${p4.video360p.probe.fps}fps ${p4.video360p.probe.durationSec.toFixed(3)}s faststart=${p4.video360p.faststart.faststart} size=${(p4.video360p.probe.sizeBytes / 1024 / 1024).toFixed(2)}MB`,
  )
  log(
    `80% 安全区: ok=${p4.titleSafe80Pct.ok} (${p4.titleSafe80Pct.checkedCount} 个字幕/标签/CTA 盒，越界 ${p4.titleSafe80Pct.violationCount})`,
  )
  log(`P4 报告: ${p4Path}`)
  log(`解码拼图:\n  - 1080p 解码拼图: ${p4.decodedFrames.sheet1080p}\n  - 360p  解码拼图: ${p4.decodedFrames.sheet360p}`)

  if (!p4.ok) {
    fail(`P4 自动验收未通过，请查看报告: ${p4Path}`)
  }

  // 步骤 11：生成可再生 B 站封面 docs/demo-video/cover.png（含 4:3 安全区 DOM 校验与裁切预览）
  if (!synthTest) {
    log('渲染 B 站 16:9 封面 docs/demo-video/cover.png 与 4:3 裁切预览...')
    const { report: cov } = await generateBilibiliCover({
      hfProjectDir,
      dateOutputDir,
      coverOutputPath,
      brand: BRAND,
      storyboard,
    })
    log(
      `已导出封面图: ${cov.coverPath} (${cov.dimensions16x9.width}x${cov.dimensions16x9.height}) | 4:3 预览: ${cov.preview4x3Path}`,
    )
  }

  log(`构建全部完成！成片路径: ${finalVideoPath}`)
}

main().catch((err) => fail(err?.stack || String(err)))
