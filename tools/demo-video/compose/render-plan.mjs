/**
 * 将 brand.js + storyboard.json + timeline.json 编译为确定性的合成计划（renderPlan）。
 *
 * 关键不变量：
 * 1. 所有品牌文案仅从 frontend/src/brand.js 注入，绝不硬编码。
 * 2. 所有原始秒数均以原始 WebM 第 0 帧为原点，由 gaps[] 唯一事实源计算裁切段与时间映射。
 * 3. 分屏镜头（split）依据 syncPairs[].leftMinusRightSec 锁死左右两路的时间轴与空档裁切，
 *    确保左右画面的实时交互与已读回执误差 ≤ 1 帧。
 * 4. 全片总时长硬上限 ≤ 60.0s（默认预算 ≤ 58.0s），每条字幕 ≤ 14 字。
 */
import { BRAND } from '../../../frontend/src/brand.js'

export const MAX_TOTAL_DURATION_SEC = 60.0
export const DEFAULT_BUDGET_SEC = 58.0
export const MAX_SUBTITLE_CHARS = 14
export const DEFAULT_FPS = 30

const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
const round3 = (v) => Math.round(v * 1000) / 1000

/**
 * 将字符串中的 {{brand.*}} 占位符替换为 frontend/src/brand.js 的正式文案。
 */
export function interpolateBrand(value) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*brand\.([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      if (!(key in BRAND)) {
        throw new Error(`storyboard 引用了未定义的 brand 字段: brand.${key}`)
      }
      return String(BRAND[key])
    })
  }
  if (Array.isArray(value)) return value.map(interpolateBrand)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateBrand(v)]))
  }
  return value
}

/**
 * 统计字幕可见字符数（去掉首尾空白；中英文及标点均按视觉字数计，避免超 14 字）。
 */
export function countSubtitleChars(text) {
  return [...String(text || '').trim()].length
}

/**
 * 校验 storyboard.json 基础结构、预算与品牌规矩一合规性。
 */
export function validateStoryboard(rawStoryboard) {
  const errors = []
  const warnings = []

  if (!rawStoryboard || !Array.isArray(rawStoryboard.shots) || rawStoryboard.shots.length === 0) {
    errors.push('storyboard.json 缺少非空 shots 数组')
    return { ok: false, errors, warnings, totalBudgetSec: 0 }
  }

  // 规矩一：检查原始 JSON 文本中是否硬编码了品牌名（允许使用 {{brand.name}}）
  const rawText = JSON.stringify(rawStoryboard)
  if (rawText.includes(BRAND.name)) {
    errors.push(`storyboard.json 含硬编码品牌名（应使用 {{brand.name}} 占位符从 frontend/src/brand.js 注入）`)
  }

  let totalBudgetSec = 0
  const seenIds = new Set()

  for (const shot of rawStoryboard.shots) {
    const id = shot.shotId || shot.id
    if (!id) {
      errors.push(`存在缺少 shotId/id 的镜头定义: ${JSON.stringify(shot).slice(0, 80)}`)
      continue
    }
    if (seenIds.has(id)) errors.push(`镜头 ID 重复: ${id}`)
    seenIds.add(id)

    const dur = Number(shot.durationSec ?? shot.budgetSec ?? shot.duration ?? 0)
    if (!(dur > 0)) {
      errors.push(`镜头 ${id} 缺少合法时长（durationSec/budgetSec）`)
    } else {
      totalBudgetSec += dur
    }

    const subtitle = interpolateBrand(shot.subtitle ?? '')
    if (subtitle) {
      const len = countSubtitleChars(subtitle)
      if (len > MAX_SUBTITLE_CHARS) {
        errors.push(`镜头 ${id} 字幕超长（${len} > ${MAX_SUBTITLE_CHARS} 字）：「${subtitle}」`)
      }
    }
    if (Array.isArray(shot.subtitles)) {
      for (let si = 0; si < shot.subtitles.length; si++) {
        const segText = interpolateBrand(shot.subtitles[si]?.text ?? '')
        const segLen = countSubtitleChars(segText)
        if (segLen > MAX_SUBTITLE_CHARS) {
          errors.push(
            `镜头 ${id} 分段字幕[${si}]超长（${segLen} > ${MAX_SUBTITLE_CHARS} 字）：「${segText}」`,
          )
        }
      }
    }
  }

  if (totalBudgetSec > MAX_TOTAL_DURATION_SEC) {
    errors.push(`分镜总预算 ${round3(totalBudgetSec)}s 超过硬上限 ${MAX_TOTAL_DURATION_SEC}s`)
  } else if (totalBudgetSec > DEFAULT_BUDGET_SEC) {
    warnings.push(`分镜总预算 ${round3(totalBudgetSec)}s 高于推荐目标 ${DEFAULT_BUDGET_SEC}s`)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    totalBudgetSec: round3(totalBudgetSec),
  }
}

/**
 * 合并并规整一段区间内的待裁空档（保留 recommendedKeepSec，避免跳剪突兀）。
 * 输入与输出均为同一原始视频时间轴秒数。
 */
export function computeKeptSegments(trimStart, trimEnd, rawGaps) {
  const start = Math.max(0, Number(trimStart) || 0)
  const end = Math.max(start + 0.05, Number(trimEnd) || start + 0.05)

  // 计算真正需要切掉的内部区间
  const cuts = []
  for (const g of rawGaps || []) {
    const gs = clamp(Number(g.startSec), start, end)
    const ge = clamp(Number(g.endSec), start, end)
    const keep = Math.max(0, Number(g.recommendedKeepSec ?? 0.35))
    const gapLen = ge - gs
    if (gapLen <= keep + 0.12) continue // 空档已经够短，保留自然停顿
    const cutStart = gs + keep * 0.5
    const cutEnd = ge - keep * 0.5
    if (cutEnd - cutStart > 0.08) {
      cuts.push([round3(cutStart), round3(cutEnd)])
    }
  }

  cuts.sort((a, b) => a[0] - b[0])
  const mergedCuts = []
  for (const [cs, ce] of cuts) {
    if (!mergedCuts.length || cs > mergedCuts[mergedCuts.length - 1][1]) {
      mergedCuts.push([cs, ce])
    } else {
      mergedCuts[mergedCuts.length - 1][1] = Math.max(mergedCuts[mergedCuts.length - 1][1], ce)
    }
  }

  const segments = []
  let cursor = start
  for (const [cs, ce] of mergedCuts) {
    if (cs > cursor + 0.04) {
      segments.push({ startSec: round3(cursor), endSec: round3(cs) })
    }
    cursor = Math.max(cursor, ce)
  }
  if (end > cursor + 0.04) {
    segments.push({ startSec: round3(cursor), endSec: round3(end) })
  }

  if (!segments.length) {
    segments.push({ startSec: round3(start), endSec: round3(end) })
  }

  let acc = 0
  const mappedSegments = segments.map((seg) => {
    const dur = round3(seg.endSec - seg.startSec)
    const out = {
      rawStartSec: seg.startSec,
      rawEndSec: seg.endSec,
      outStartSec: round3(acc),
      outEndSec: round3(acc + dur),
      durationSec: dur,
    }
    acc += dur
    return out
  })

  return {
    segments: mappedSegments,
    processedDurationSec: round3(acc),
    removedSec: round3((end - start) - acc),
  }
}

/**
 * 将原始 WebM 时间戳映射到经 gaps 裁切后的 MP4 秒数。
 * 若时间戳落在被切掉的空档内，吸附到对应切点。
 */
export function mapRawTimeToProcessed(rawSec, segments) {
  if (!segments?.length) return 0
  if (rawSec <= segments[0].rawStartSec) return 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (rawSec <= seg.rawEndSec) {
      return round3(seg.outStartSec + Math.max(0, rawSec - seg.rawStartSec))
    }
    const next = segments[i + 1]
    if (next && rawSec < next.rawStartSec) {
      return seg.outEndSec
    }
  }
  return segments[segments.length - 1].outEndSec
}

/**
 * 归一化镜头角色到常驻左侧进度轨的 3 个阶段：owner / doctor / admin（支持 split 双亮，ending 隐藏）。
 */
function resolveRailStages(shotSpec, layout) {
  if (layout === 'ending') return []
  const explicit = shotSpec.activeStages || shotSpec.railStages || shotSpec.railStage || shotSpec.progressStage
  if (Array.isArray(explicit)) return explicit
  if (typeof explicit === 'string') {
    const s = explicit.toLowerCase()
    if (s.includes('split') || s.includes('both') || (s.includes('宠主') && s.includes('医生'))) {
      return ['owner', 'doctor']
    }
    if (s.includes('admin') || s.includes('管理')) return ['admin']
    if (s.includes('doctor') || s.includes('医生')) return ['doctor']
    if (s.includes('owner') || s.includes('client') || s.includes('宠主')) return ['owner']
  }
  if (layout === 'split') return ['owner', 'doctor']
  const role = String(shotSpec.role || shotSpec.stage || '').toLowerCase()
  if (role.includes('admin') || role.includes('管理')) return ['admin']
  if (role.includes('doctor') || role.includes('医生')) return ['doctor']
  if (role.includes('ending') || role.includes('landing') || role.includes('outro') || role.includes('片尾')) return []
  return ['owner']
}

function resolveLayout(shotSpec, timelineShot) {
  const raw = String(timelineShot?.layout || shotSpec.layout || '').toLowerCase()
  if (raw.includes('end') || raw.includes('outro') || raw.includes('landing') || raw.includes('cta')) return 'ending'
  if (raw.includes('split')) return 'split'
  if (raw.includes('full') || raw.includes('admin')) return 'fullscreen'
  if (raw.includes('desk') || raw.includes('work')) return 'desktop'
  if (raw.includes('phone') || raw.includes('mobile')) return 'phone'
  const role = String(shotSpec.role || shotSpec.stage || '').toLowerCase()
  if (role.includes('admin')) return 'fullscreen'
  if (role.includes('doctor')) return 'desktop'
  if (role.includes('ending') || role.includes('outro') || role.includes('landing')) return 'ending'
  return 'phone'
}

/**
 * 从 syncPairs 中查找给定 shotId 的双路同步关系。
 * 统一口径（#9/#10）：leftMinusRightSec = leftAnchorSec - rightAnchorSec
 * 即 rightSec = leftSec - leftMinusRightSec。
 */
function findSyncPair(timeline, shotId, leftClipId, rightClipId) {
  const pairs = timeline.syncPairs || []
  for (const p of pairs) {
    const shotMatch = Array.isArray(p.shotIds) ? p.shotIds.includes(shotId) : true
    const clipMatch = p.leftClipId === leftClipId && p.rightClipId === rightClipId
    if (shotMatch && clipMatch) {
      let leftMinusRightSec = Number(p.leftMinusRightSec)
      if (!Number.isFinite(leftMinusRightSec)) {
        if (Number.isFinite(Number(p.leftAnchorSec)) && Number.isFinite(Number(p.rightAnchorSec))) {
          leftMinusRightSec = Number(p.leftAnchorSec) - Number(p.rightAnchorSec)
        } else {
          leftMinusRightSec = 0
        }
      }
      return { ...p, leftMinusRightSec: round3(leftMinusRightSec) }
    }
  }
  return null
}

/**
 * 构建完整 renderPlan。
 */
export function buildRenderPlan({ storyboard: rawStoryboard, timeline }) {
  const validation = validateStoryboard(rawStoryboard)
  if (!validation.ok) {
    throw new Error(`storyboard.json 校验失败:\n- ${validation.errors.join('\n- ')}`)
  }
  if (!timeline || !Array.isArray(timeline.clips)) {
    throw new Error('timeline.json 缺少 clips 数组')
  }

  const storyboard = interpolateBrand(rawStoryboard)
  const clipMap = new Map(timeline.clips.map((c) => [c.clipId, c]))
  const timelineShotMap = new Map((timeline.shots || []).map((s) => [s.shotId, s]))
  const allEvents = timeline.events || []
  const allGaps = timeline.gaps || []

  const plannedShots = []
  let timelineCursor = 0

  for (let idx = 0; idx < storyboard.shots.length; idx++) {
    const spec = storyboard.shots[idx]
    const shotId = spec.shotId || spec.id
    const tlShot = timelineShotMap.get(shotId)
    const layout = resolveLayout(spec, tlShot)
    const railStages = resolveRailStages(spec, layout)
    const budgetSec = Number(spec.durationSec ?? spec.budgetSec ?? spec.duration ?? 6)
    const clipRefs = tlShot?.clipRefs || []

    // 针对 split 镜头与单路镜头分别构建 FFmpeg 裁切任务与事件映射
    const prepClips = []
    let primaryProcessedDur = 0
    let primaryRate = 1.0

    if (layout === 'split' && clipRefs.length >= 2) {
      const leftRef = clipRefs.find((r) => r.role === 'owner') || clipRefs[0]
      const rightRef = clipRefs.find((r) => r.role === 'doctor') || clipRefs[1]
      const leftMeta = clipMap.get(leftRef.clipId)
      const rightMeta = clipMap.get(rightRef.clipId)
      if (!leftMeta || !rightMeta) {
        throw new Error(`镜头 ${shotId} 引用的 clip 不存在: ${leftRef.clipId} / ${rightRef.clipId}`)
      }

      const syncPair = findSyncPair(timeline, shotId, leftRef.clipId, rightRef.clipId)
      let leftMinusRightSec = syncPair?.leftMinusRightSec
      if (!Number.isFinite(leftMinusRightSec)) {
        // 兜底：若 syncPairs 未显式声明，优先用双路录制起始墙钟差推算
        if (Number.isFinite(leftMeta.recordedStartEpochMs) && Number.isFinite(rightMeta.recordedStartEpochMs)) {
          leftMinusRightSec = round3((rightMeta.recordedStartEpochMs - leftMeta.recordedStartEpochMs) / 1000)
        } else {
          leftMinusRightSec = round3((leftRef.trimStartSec ?? 0) - (rightRef.trimStartSec ?? 0))
        }
      }

      // 将两路的时间窗口交集映射到左路轴，保证两路等长、零漂移
      const lMin = Math.max(leftMeta.usableStartSec ?? 0, leftRef.trimStartSec ?? 0)
      const lMax = Math.min(leftMeta.durationSec, leftRef.trimEndSec ?? leftMeta.durationSec)
      const rAsLMin = Math.max(rightMeta.usableStartSec ?? 0, rightRef.trimStartSec ?? 0) + leftMinusRightSec
      const rAsLMax = Math.min(rightMeta.durationSec, rightRef.trimEndSec ?? rightMeta.durationSec) + leftMinusRightSec

      const commonLStart = round3(Math.max(lMin, rAsLMin))
      const commonLEnd = round3(Math.max(commonLStart + 0.5, Math.min(lMax, rAsLMax)))

      // 收集两路属于该镜头的 gaps，全部折算到左路坐标轴
      const shotGapsOnLeft = []
      for (const g of allGaps) {
        if (g.shotId && g.shotId !== shotId) continue
        if (g.clipId === leftRef.clipId) {
          shotGapsOnLeft.push({
            startSec: g.startSec,
            endSec: g.endSec,
            recommendedKeepSec: g.recommendedKeepSec,
          })
        } else if (g.clipId === rightRef.clipId) {
          shotGapsOnLeft.push({
            startSec: g.startSec + leftMinusRightSec,
            endSec: g.endSec + leftMinusRightSec,
            recommendedKeepSec: g.recommendedKeepSec,
          })
        }
      }

      const leftPlan = computeKeptSegments(commonLStart, commonLEnd, shotGapsOnLeft)
      const rightSegments = leftPlan.segments.map((seg) => ({
        rawStartSec: round3(Math.max(0, seg.rawStartSec - leftMinusRightSec)),
        rawEndSec: round3(Math.max(0.05, seg.rawEndSec - leftMinusRightSec)),
        outStartSec: seg.outStartSec,
        outEndSec: seg.outEndSec,
        durationSec: seg.durationSec,
      }))

      primaryProcessedDur = leftPlan.processedDurationSec
      primaryRate = Number(leftRef.playbackRate || 1.0)

      prepClips.push({
        slot: 'left',
        role: leftRef.role || 'owner',
        clipId: leftRef.clipId,
        sourceFile: leftMeta.file,
        outputRelPath: `assets/clips/${shotId}_left_${leftRef.role || 'owner'}.mp4`,
        viewport: leftMeta.viewport,
        recordSize: leftMeta.recordSize,
        segments: leftPlan.segments,
        processedDurationSec: leftPlan.processedDurationSec,
        removedSec: leftPlan.removedSec,
      })
      prepClips.push({
        slot: 'right',
        role: rightRef.role || 'doctor',
        clipId: rightRef.clipId,
        sourceFile: rightMeta.file,
        outputRelPath: `assets/clips/${shotId}_right_${rightRef.role || 'doctor'}.mp4`,
        viewport: rightMeta.viewport,
        recordSize: rightMeta.recordSize,
        segments: rightSegments,
        processedDurationSec: leftPlan.processedDurationSec,
        removedSec: leftPlan.removedSec,
        leftMinusRightSec,
      })
    } else if (clipRefs.length >= 1) {
      const ref = clipRefs[0]
      const meta = clipMap.get(ref.clipId)
      if (!meta) {
        throw new Error(`镜头 ${shotId} 引用的 clip 不存在: ${ref.clipId}`)
      }
      const trimStart = Math.max(meta.usableStartSec ?? 0, ref.trimStartSec ?? 0)
      const trimEnd = Math.min(meta.durationSec, ref.trimEndSec ?? meta.durationSec)
      const shotGaps = allGaps.filter(
        (g) => g.clipId === ref.clipId && (!g.shotId || g.shotId === shotId),
      )
      const segPlan = computeKeptSegments(trimStart, trimEnd, shotGaps)
      primaryProcessedDur = segPlan.processedDurationSec
      primaryRate = Number(ref.playbackRate || 1.0)

      prepClips.push({
        slot: 'primary',
        role: ref.role || meta.role || 'owner',
        clipId: ref.clipId,
        sourceFile: meta.file,
        outputRelPath: `assets/clips/${shotId}_${ref.role || meta.role || 'main'}.mp4`,
        viewport: meta.viewport,
        recordSize: meta.recordSize,
        segments: segPlan.segments,
        processedDurationSec: segPlan.processedDurationSec,
        removedSec: segPlan.removedSec,
      })
    }

    // 计算最终镜头时长与有效倍速（保证总时长贴合预算且绝不拖沓）
    let effectiveRate = primaryRate
    let sceneDurationSec = budgetSec
    if (layout === 'ending') {
      // 片尾：前段展示实录 /demo 落地页 + 红章闪，后段保持 ≥2.6s 大字 CTA（满足 line_unread ≥2s）
      sceneDurationSec = Math.max(4.6, budgetSec)
      const landingSlot = round3(Math.min(2.4, sceneDurationSec * 0.44))
      if (primaryProcessedDur > 0 && primaryProcessedDur / effectiveRate > landingSlot) {
        effectiveRate = round3(clamp(primaryProcessedDur / landingSlot, 1.0, 2.0))
      }
    } else if (primaryProcessedDur > 0) {
      const naturalDur = primaryProcessedDur / effectiveRate
      if (naturalDur > budgetSec) {
        // 轻微加速贴合镜头预算，最高不超过 2.2x 保持可读
        effectiveRate = round3(clamp(primaryProcessedDur / budgetSec, 1.0, 2.2))
        sceneDurationSec = round3(Math.max(budgetSec, primaryProcessedDur / effectiveRate))
      } else if (naturalDur < budgetSec - 0.8) {
        // 避免末尾超过 0.8s 静止死等（防 dead_stretch）
        sceneDurationSec = round3(Math.max(2.6, naturalDur + 0.45))
      } else {
        sceneDurationSec = round3(budgetSec)
      }
    }

    // 将属于该镜头的原始事件映射到场景本地时间（sceneSec）
    const mappedEvents = []
    for (const ev of allEvents) {
      if (ev.shotId && ev.shotId !== shotId) continue
      const clipEntry = prepClips.find((c) => c.clipId === ev.clipId)
      if (!clipEntry) continue
      const firstSeg = clipEntry.segments[0]
      const lastSeg = clipEntry.segments[clipEntry.segments.length - 1]
      if (!firstSeg || !lastSeg) continue
      if (ev.tSec < firstSeg.rawStartSec - 0.15 || ev.tSec > lastSeg.rawEndSec + 0.15) continue

      const processedSec = mapRawTimeToProcessed(ev.tSec, clipEntry.segments)
      const sceneSec = round3(clamp(processedSec / effectiveRate, 0.05, Math.max(0.1, sceneDurationSec - 0.15)))
      const vp = clipEntry.viewport || { width: 390, height: 844 }
      let target = null
      if (ev.target) {
        const cx = Number.isFinite(ev.target.cx)
          ? ev.target.cx
          : Number.isFinite(ev.target.x)
            ? ev.target.x + (ev.target.width || 0) / 2
            : vp.width / 2
        const cy = Number.isFinite(ev.target.cy)
          ? ev.target.cy
          : Number.isFinite(ev.target.y)
            ? ev.target.y + (ev.target.height || 0) / 2
            : vp.height / 2
        const nx = Number.isFinite(ev.target.nx) ? ev.target.nx : cx / vp.width
        const ny = Number.isFinite(ev.target.ny) ? ev.target.ny : cy / vp.height
        target = {
          selector: ev.target.selector || '',
          cx: round3(cx),
          cy: round3(cy),
          nx: round3(clamp(nx, 0.04, 0.96)),
          ny: round3(clamp(ny, 0.04, 0.96)),
          nw: Number.isFinite(ev.target.nw) ? round3(ev.target.nw) : null,
          nh: Number.isFinite(ev.target.nh) ? round3(ev.target.nh) : null,
        }
      }

      mappedEvents.push({
        eventId: ev.eventId || `${shotId}-ev-${mappedEvents.length + 1}`,
        actionId: ev.actionId || null,
        slot: clipEntry.slot,
        role: ev.role || clipEntry.role,
        type: ev.type,
        rawSec: round3(ev.tSec),
        processedSec,
        sceneSec,
        label: interpolateBrand(ev.label || ''),
        target,
      })
    }
    mappedEvents.sort((a, b) => a.sceneSec - b.sceneSec)

    const startSec = round3(timelineCursor)
    const endSec = round3(startSec + sceneDurationSec)
    timelineCursor = endSec

    const endingSpec = spec.cta || storyboard.ending || spec.ending || {}
    const zoomTargets = Array.isArray(spec.zoomTargets) ? spec.zoomTargets : []
    const derivedBullets = Array.isArray(spec.bullets)
      ? spec.bullets
      : zoomTargets.length
        ? zoomTargets.map((z) => z.label).filter(Boolean)
        : Array.isArray(spec.steps)
          ? spec.steps.map((s) => (typeof s === 'string' ? s : s.label || s.text || '')).filter(Boolean)
          : []

    const outroMinHold = Number(storyboard.videoSpec?.minOutroHoldSec || 2.5)
    const endingFlashSec =
      layout === 'ending'
        ? round3(
            prepClips.length > 0
              ? Math.max(1.6, Math.min(2.4, sceneDurationSec - outroMinHold - 0.15))
              : 0.25,
          )
        : null

    // 解析单句或多段字幕（如 S03 支持 subtitles: [{ atRatio, text }, ...]）
    let captionSegments = []
    if (Array.isArray(spec.subtitles) && spec.subtitles.length > 0) {
      const sorted = spec.subtitles
        .filter((item) => String(item?.text || '').trim())
        .map((item) => ({
          atRatio: Number.isFinite(Number(item.atRatio)) ? clamp(Number(item.atRatio), 0, 0.95) : 0,
          text: String(item.text).trim(),
        }))
        .sort((a, b) => a.atRatio - b.atRatio)
      captionSegments = sorted.map((item, sIdx) => {
        const segStart = round3(sceneDurationSec * item.atRatio)
        const nextRatio = sorted[sIdx + 1]?.atRatio ?? 1
        const segEnd = round3(sceneDurationSec * nextRatio)
        return {
          index: sIdx,
          localStartSec: segStart,
          localEndSec: segEnd,
          absStartSec: round3(startSec + segStart),
          absEndSec: round3(startSec + segEnd),
          text: item.text,
        }
      })
    } else if (String(spec.subtitle || '').trim()) {
      captionSegments = [
        {
          index: 0,
          localStartSec: 0,
          localEndSec: round3(sceneDurationSec),
          absStartSec: startSec,
          absEndSec: endSec,
          text: String(spec.subtitle).trim(),
        },
      ]
    }

    plannedShots.push({
      index: idx + 1,
      totalShots: storyboard.shots.length,
      shotId,
      title: spec.title || spec.name || shotId,
      layout,
      railStages,
      startSec,
      durationSec: round3(sceneDurationSec),
      endSec,
      budgetSec: round3(budgetSec),
      effectiveRate,
      subtitle: String(spec.subtitle || '').trim(),
      captionSegments,
      featureTag: String(spec.featureTag ?? spec.tag ?? spec.badge ?? '').trim(),
      panelBullets: derivedBullets,
      zoomTargets,
      zoomConfig: spec.zoom || spec.focus || null,
      ending:
        layout === 'ending'
          ? {
              ctaUrl: spec.ctaUrl || endingSpec.url || endingSpec.ctaUrl || 'yuzhua-petclinic.top/demo',
              ctaSubline:
                spec.ctaSubline ||
                endingSpec.subline ||
                endingSpec.ctaSubline ||
                '免注册 · 三端直接进入 · 链接在简介',
              stampLabel:
                spec.stampLabel || endingSpec.stampText || endingSpec.stampLabel || '看演示',
              minOutroHoldSec: outroMinHold,
              flashSec: endingFlashSec,
            }
          : null,
      clips: prepClips,
      events: mappedEvents,
    })
  }

  const totalDurationSec = round3(timelineCursor)
  if (totalDurationSec > MAX_TOTAL_DURATION_SEC) {
    throw new Error(
      `合成总时长 ${totalDurationSec}s 超过 60s 红线！请收紧 storyboard 预算或检查 timeline.json 裁剪区间。`,
    )
  }

  return {
    schemaVersion: 1,
    fps: DEFAULT_FPS,
    width: 1920,
    height: 1080,
    totalDurationSec,
    brand: BRAND,
    shots: plannedShots,
  }
}
