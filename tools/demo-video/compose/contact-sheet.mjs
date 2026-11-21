/**
 * 关键帧采样与验收拼图生成器：
 * - 单次调用 hyperframes snapshot --at 批量截取首帧（t=0）+ 每镜头 2 张关键帧；
 * - 使用 FFmpeg 生成：
 *   1) keyframes/contact-sheet.png        （4×2 每镜头代表帧拼图，带镜号/时间标签）
 *   2) keyframes/contact-sheet-detail.png （4×4 全 16 张关键帧明细拼图）
 *   3) keyframes/preview-640x360.png      （2×4 精确 640×360 1:1 缩略拼图，直验 B 站小窗可读性）
 *   4) keyframes/manifest.json            （全部帧时间与文件索引）
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const r3 = (v) => Math.round(v * 1000) / 1000

/**
 * 为每个镜头规划 2 个代表性采样时间点：
 * - hero 帧：优先锁定该镜头最具信息量的交付/高光时刻（如已读回执、到院卡、支付生效、门诊病历、看板 KPI、片尾 CTA）；
 * - secondary 帧：补充展示该镜头的另一关键动作（如列表页、弹窗、滚动后 4 图、脱敏落地页）。
 */
export function planKeyframeSamples(renderPlan) {
  const samples = []
  const clampLocal = (shot, t) => r3(Math.max(0.35, Math.min(shot.durationSec - 0.25, t)))

  // 第 0 帧：专门核验「第一帧即产品界面，零黑屏」
  samples.push({
    key: 'frame-00-first',
    shotId: renderPlan.shots[0]?.shotId || 'S01',
    role: 'first_frame',
    timeSec: 0,
    label: '0.0s 首帧（产品界面）',
    isHero: false,
  })

  for (const shot of renderPlan.shots) {
    const evs = shot.events || []
    const findEv = (pred) => evs.find(pred)

    if (shot.layout === 'ending') {
      const flashSec = Number.isFinite(shot.ending?.flashSec) ? shot.ending.flashSec : 2.2
      // 落地页采样取缩放前（0.55s），完整展示团团全头、品牌与红章
      const landingT = r3(shot.startSec + Math.min(0.6, flashSec * 0.3))
      const ctaT = r3(Math.min(renderPlan.totalDurationSec - 0.15, shot.startSec + flashSec + 1.0))
      samples.push({
        key: `${shot.shotId}-01-landing`,
        shotId: shot.shotId,
        role: 'landing',
        timeSec: landingT,
        label: `${shot.shotId} ${landingT}s 落地页`,
        isHero: false,
      })
      samples.push({
        key: `${shot.shotId}-02-cta`,
        shotId: shot.shotId,
        role: 'cta',
        timeSec: ctaT,
        label: `${shot.shotId} ${ctaT}s 片尾CTA`,
        isHero: true,
      })
      continue
    }

    let heroLocal = shot.durationSec * 0.55
    let actionLocal = shot.durationSec * 0.28

    if (shot.shotId === 'S01') {
      const typeEv = findEv((e) => e.type === 'input')
      const subEv = findEv((e) => e.actionId === 's01-submit')
      heroLocal = clampLocal(shot, typeEv ? typeEv.sceneSec + 0.45 : shot.durationSec * 0.62)
      actionLocal = clampLocal(shot, subEv ? subEv.sceneSec + 0.18 : shot.durationSec * 0.82)
    } else if (shot.shotId === 'S02') {
      // hero 帧取进入苏晚晴详情页且镜头已拉回 1.0x 的时刻，完整展示头像、皮肤科与外耳炎
      const pickEv = findEv((e) => e.actionId === 's02-pick-doctor')
      const openEv = findEv((e) => e.actionId === 's02-open-consult')
      heroLocal = clampLocal(
        shot,
        pickEv && openEv ? (pickEv.sceneSec + openEv.sceneSec) * 0.5 + 0.35 : shot.durationSec * 0.48,
      )
      actionLocal = clampLocal(shot, pickEv ? pickEv.sceneSec - 0.1 : shot.durationSec * 0.22)
    } else if (shot.shotId === 'S03') {
      // S03 支持两段字幕切换：明细拼图同时展示前半句（「等不及？先在线问问」）与后半句（「医生这边实时收到」）
      const segs = shot.captionSegments || []
      const replyEv = [...evs].reverse().find((e) => e.type === 'ws_received')
      const seg1End = segs[0]?.localEndSec ?? shot.durationSec * 0.45
      const seg2Start = segs[1]?.localStartSec ?? seg1End
      // hero 帧取后半段（双端完整对话 + 已读回执 + 第 2 句字幕）
      heroLocal = clampLocal(
        shot,
        Math.max(seg2Start + 0.65, replyEv ? replyEv.sceneSec + 0.55 : shot.durationSec * 0.8),
      )
      // detail 帧取前半段（第 1 句字幕 + 宠主发问诊消息）
      actionLocal = clampLocal(shot, Math.min(seg1End - 0.55, Math.max(1.4, seg1End * 0.58)))
    } else if (shot.shotId === 'S04') {
      // hero 帧取宠主端收到「医生建议到院就诊 / 去预约挂号」卡片后的双端同步帧
      const cardEv = findEv((e) => e.type === 'card_shown')
      const sendEv = findEv((e) => e.actionId === 's04-doc-suggest-send')
      heroLocal = clampLocal(shot, cardEv ? cardEv.sceneSec + 0.85 : shot.durationSec * 0.72)
      actionLocal = clampLocal(shot, sendEv ? sendEv.sceneSec - 0.3 : shot.durationSec * 0.38)
    } else if (shot.shotId === 'S05') {
      // hero 帧取支付生效（预约已生效/支付成功）或确认支付票据弹窗
      const paidEv = findEv((e) => e.type === 'paid')
      const payBtnEv = findEv((e) => e.actionId === 's05-pay-confirm')
      heroLocal = clampLocal(shot, paidEv ? paidEv.sceneSec + 0.55 : shot.durationSec * 0.6)
      actionLocal = clampLocal(shot, payBtnEv ? payBtnEv.sceneSec - 0.35 : shot.durationSec * 0.32)
    } else if (shot.shotId === 'S06') {
      // hero 帧取病历填写完毕/病历已保存的工作台主画面，副帧取已完成态
      const saveEv = findEv((e) => e.actionId === 's06-save-record')
      const endEv = findEv((e) => e.type === 'ended')
      heroLocal = clampLocal(shot, saveEv ? saveEv.sceneSec + 0.45 : shot.durationSec * 0.68)
      actionLocal = clampLocal(shot, endEv ? endEv.sceneSec + 0.35 : shot.durationSec * 0.9)
    } else if (shot.shotId === 'S07') {
      // hero 帧取今日概览 KPI（含模拟支付口径）+ 图表，副帧取下滚展示 4 图完整态
      const scrollEv = findEv((e) => e.actionId === 's07-scroll-charts')
      heroLocal = clampLocal(shot, 1.15)
      actionLocal = clampLocal(shot, scrollEv ? scrollEv.sceneSec + 1.8 : shot.durationSec * 0.78)
    }

    const heroAbs = r3(shot.startSec + heroLocal)
    const actionAbs = r3(shot.startSec + actionLocal)
    const hasMultiSub = (shot.captionSegments || []).length > 1

    samples.push({
      key: `${shot.shotId}-01-hero`,
      shotId: shot.shotId,
      role: 'hero',
      timeSec: heroAbs,
      label: `${shot.shotId} ${heroAbs}s ${hasMultiSub ? '后段字幕' : shot.featureTag || shot.subtitle || shot.title}`.slice(0, 26),
      isHero: true,
    })
    samples.push({
      key: `${shot.shotId}-02-detail`,
      shotId: shot.shotId,
      role: 'detail',
      timeSec: actionAbs,
      label: `${shot.shotId} ${actionAbs}s ${hasMultiSub ? '前段字幕' : '细节帧'}`,
      isHero: false,
    })
  }

  return samples
}

function runFfmpegTile({ cwd, inputs, cols, rows, cellW, cellH, outputPath, labels }) {
  const args = ['-y']
  for (const inp of inputs) {
    args.push('-i', inp)
  }

  // 每个输入缩放到 cellW×cellH，并在上方 pad 出独立墨底白字镜号条（不遮挡画面任何像素）
  const fontSize = Math.max(18, Math.round(cellH * 0.055))
  const barH = Math.round(fontSize * 1.6)
  const tileH = cellH + barH
  const filterParts = inputs.map((_, idx) => {
    const rawLabel = (labels?.[idx] || `#${idx + 1}`).replace(/[:'\\]/g, ' ')
    return (
      `[${idx}:v]scale=${cellW}:${cellH}:flags=lanczos,` +
      `pad=iw:ih+${barH}:0:${barH}:color=#222222,` +
      `drawtext=fontfile='assets/fonts/NotoSansSC-VF.ttf':text='${rawLabel}':fontcolor=#ffffff:fontsize=${fontSize}:x=14:y=${Math.round((barH - fontSize) * 0.45)}[v${idx}]`
    )
  })
  const stackInputs = inputs.map((_, idx) => `[v${idx}]`).join('')
  filterParts.push(
    `${stackInputs}xstack=inputs=${inputs.length}:layout=${buildGridLayout(inputs.length, cols, cellW, tileH)}:fill=#e5e5e5[grid]`,
  )

  args.push('-filter_complex', filterParts.join(';'), '-map', '[grid]', '-frames:v', '1', outputPath)

  const res = spawnSync('ffmpeg', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (res.error) throw new Error(`FFmpeg 拼图启动失败: ${res.error.message}`)
  if (res.status !== 0) {
    const tail = (res.stderr || '').trim().split(/\r?\n/).slice(-10).join('\n')
    throw new Error(`FFmpeg 拼图失败（exit ${res.status}）:\n${tail}`)
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

export function captureKeyframesAndSheets({
  hfCliPath,
  hfProjectDir,
  keyframesDir,
  renderPlan,
  env,
}) {
  if (existsSync(keyframesDir)) rmSync(keyframesDir, { recursive: true, force: true })
  mkdirSync(keyframesDir, { recursive: true })
  const rawSnapDir = join(keyframesDir, '_raw')
  mkdirSync(rawSnapDir, { recursive: true })

  const samples = planKeyframeSamples(renderPlan)
  // 去重时间点，保证传给 --at 的时间戳单调且唯一
  const uniqueTimes = [...new Set(samples.map((s) => s.timeSec))].sort((a, b) => a - b)

  const snapArgs = [
    hfCliPath,
    'snapshot',
    '--at',
    uniqueTimes.join(','),
    '--no-end',
    '--output',
    rawSnapDir,
    '--json',
  ]
  const res = spawnSync(process.execPath, snapArgs, {
    cwd: hfProjectDir,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (res.error) throw new Error(`hyperframes snapshot 启动失败: ${res.error.message}`)
  if (res.status !== 0) {
    throw new Error(`hyperframes snapshot 失败（exit ${res.status}）:\n${res.stderr || res.stdout}`)
  }

  // 从 stdout 提取末尾 JSON 结果
  const jsonMatch = res.stdout.match(/\{[\s\S]*\}\s*$/)
  if (!jsonMatch) {
    throw new Error(`无法解析 hyperframes snapshot JSON 输出:\n${res.stdout.slice(-600)}`)
  }
  const snapJson = JSON.parse(jsonMatch[0])
  const frameByTime = new Map()
  for (const f of snapJson.frames || []) {
    frameByTime.set(r3(Number(f.time)), f.path)
  }

  const captured = []
  for (const s of samples) {
    // 找最接近时间戳（容差 0.02s）
    let srcPath = frameByTime.get(s.timeSec)
    if (!srcPath) {
      let bestDist = Infinity
      for (const [t, p] of frameByTime.entries()) {
        const d = Math.abs(t - s.timeSec)
        if (d < bestDist) {
          bestDist = d
          srcPath = p
        }
      }
    }
    if (!srcPath || !existsSync(srcPath)) {
      throw new Error(`缺少采样帧: ${s.key} (${s.timeSec}s)`)
    }
    const destPath = join(keyframesDir, `${s.key}.png`)
    copyFileSync(srcPath, destPath)
    captured.push({
      ...s,
      path: destPath,
      fileName: `${s.key}.png`,
    })
  }

  // 1. 4×2 每镜头代表帧主拼图（contact-sheet.png，每格 640×360，含镜号/字幕标签）
  const heroFrames = captured.filter((c) => c.isHero)
  const contactSheetPath = join(keyframesDir, 'contact-sheet.png')
  runFfmpegTile({
    cwd: hfProjectDir,
    inputs: heroFrames.map((f) => f.path),
    cols: 4,
    rows: 2,
    cellW: 640,
    cellH: 360,
    outputPath: contactSheetPath,
    labels: heroFrames.map((f) => f.label),
  })

  // 2. 4×4 明细拼图（contact-sheet-detail.png，全部 8 镜头 × 2 帧）
  const detailFrames = captured.filter((c) => c.role !== 'first_frame').slice(0, 16)
  const detailSheetPath = join(keyframesDir, 'contact-sheet-detail.png')
  runFfmpegTile({
    cwd: hfProjectDir,
    inputs: detailFrames.map((f) => f.path),
    cols: 4,
    rows: Math.ceil(detailFrames.length / 4),
    cellW: 480,
    cellH: 270,
    outputPath: detailSheetPath,
    labels: detailFrames.map((f) => f.label),
  })

  // 3. 2×4 精确 640×360 1:1 像素缩略预览（不叠加额外遮挡条，真实模拟 B 站小窗清晰度）
  const preview640Path = join(keyframesDir, 'preview-640x360.png')
  const previewArgs = ['-y']
  for (const f of heroFrames) previewArgs.push('-i', f.path)
  const previewFilters = heroFrames.map(
    (_, idx) => `[${idx}:v]scale=640:360:flags=lanczos[p${idx}]`,
  )
  previewFilters.push(
    `${heroFrames.map((_, idx) => `[p${idx}]`).join('')}xstack=inputs=${heroFrames.length}:layout=${buildGridLayout(heroFrames.length, 2, 640, 360)}:fill=#d4d4d4[out]`,
  )
  previewArgs.push('-filter_complex', previewFilters.join(';'), '-map', '[out]', '-frames:v', '1', preview640Path)
  const pRes = spawnSync('ffmpeg', previewArgs, { cwd: hfProjectDir, encoding: 'utf8', windowsHide: true })
  if (pRes.status !== 0) {
    throw new Error(`生成 640×360 预览拼图失败: ${pRes.stderr}`)
  }

  // 清理 _raw 临时目录
  rmSync(rawSnapDir, { recursive: true, force: true })

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalDurationSec: renderPlan.totalDurationSec,
    contactSheet: resolve(contactSheetPath),
    contactSheetDetail: resolve(detailSheetPath),
    preview640x360: resolve(preview640Path),
    firstFrame: resolve(join(keyframesDir, 'frame-00-first.png')),
    frames: captured,
  }
  writeFileSync(join(keyframesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return manifest
}
