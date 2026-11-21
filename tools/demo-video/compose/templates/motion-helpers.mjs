/**
 * HyperFrames 模板共享工具：转义、镜头推近坐标换算、合成光标与 #d92549 点击波纹脚本生成。
 */

export const FONT_FACE_CSS = `
@font-face {
  font-family: "YuzhuaSC";
  src: url("assets/fonts/NotoSansSC-VF.ttf") format("truetype");
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
`

export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
const r3 = (v) => Math.round(v * 1000) / 1000

/**
 * 计算将归一化点击点 (nx, ny) 推近至 scale 倍时，既柔和偏向目标又保留四周完整文字的安全平移量 (tx, ty)。
 * 通过水平/垂直平移阻尼避免贴边硬裁（如宽票据弹窗、表单左侧标签、聊天气泡右沿），基于 GSAP 默认 50% 50% 原点。
 */
export function computeSafeZoomTransform(
  vpW,
  vpH,
  nx,
  ny,
  scale,
  { panDampX = 0.3, panDampY = 0.45 } = {},
) {
  const maxTx = ((scale - 1) * vpW) / 2
  const maxTy = ((scale - 1) * vpH) / 2
  const rawTx = -scale * (nx - 0.5) * vpW * panDampX
  const rawTy = -scale * (ny - 0.5) * vpH * panDampY
  return {
    scale: r3(scale),
    x: r3(clamp(rawTx, -maxTx * 0.72, maxTx * 0.72)),
    y: r3(clamp(rawTy, -maxTy * 0.78, maxTy * 0.78)),
  }
}

/**
 * 从某一路（slot）的映射事件中筛选适合做光标+推近的高光点击事件，
 * 强制保持事件间隔 ≥ minGapSec，避免镜头频繁抖动。
 */
export function pickHighlightClicks(
  events,
  slot,
  durationSec,
  { maxCount = 2, minGapSec = 1.9, zoomTargets = null } = {},
) {
  const eligible = (events || []).filter(
    (e) =>
      (!slot || e.slot === slot) &&
      e.target &&
      (e.type === 'click' || e.type === 'input' || e.type === 'card_shown' || e.type === 'paid') &&
      e.sceneSec >= 0.35 &&
      e.sceneSec <= durationSec - 0.55,
  )

  // 若 storyboard 显式指定了 zoomTargets（含 actionId 与专属 scale），优先按 actionId 精准匹配
  const ztMap = new Map()
  if (Array.isArray(zoomTargets)) {
    for (const zt of zoomTargets) {
      if (zt.actionId) ztMap.set(zt.actionId, zt)
    }
  }

  const prioritized = [
    ...eligible.filter((e) => e.actionId && ztMap.has(e.actionId)),
    ...eligible.filter((e) => !(e.actionId && ztMap.has(e.actionId)) && e.type === 'click'),
    ...eligible.filter((e) => !(e.actionId && ztMap.has(e.actionId)) && e.type !== 'click'),
  ]

  const picked = []
  for (const ev of prioritized) {
    if (picked.length >= maxCount) break
    if (picked.some((p) => Math.abs(p.sceneSec - ev.sceneSec) < minGapSec)) continue
    const zt = ev.actionId ? ztMap.get(ev.actionId) : null
    picked.push(zt?.scale ? { ...ev, zoomScale: Number(zt.scale) } : ev)
  }
  return picked.sort((a, b) => a.sceneSec - b.sceneSec)
}

/**
 * 合成光标 + 点击波纹所需公共 CSS（配合 data-layout-ignore）。
 */
export const CURSOR_AND_RIPPLE_CSS = `
.camera-ripple {
  position: absolute;
  width: 56px;
  height: 56px;
  margin-left: -28px;
  margin-top: -28px;
  border-radius: 50%;
  border: 4px solid #d92549;
  background: rgba(217, 37, 73, 0.14);
  pointer-events: none;
  opacity: 0;
  z-index: 12;
}
.camera-ripple-outer {
  position: absolute;
  width: 56px;
  height: 56px;
  margin-left: -28px;
  margin-top: -28px;
  border-radius: 50%;
  border: 2px solid #d92549;
  pointer-events: none;
  opacity: 0;
  z-index: 11;
}
.viewport-cursor-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 18;
}
.synth-cursor {
  position: absolute;
  left: 0;
  top: 0;
  width: 34px;
  height: 34px;
  opacity: 0;
  filter: drop-shadow(0 3px 6px rgba(34, 34, 34, 0.35));
}
`

export function cursorSvgMarkup(id) {
  return `<svg class="synth-cursor" id="${escHtml(id)}" viewBox="0 0 36 36" fill="none" data-layout-ignore>
  <path d="M5 3L30 16L18.5 20L13.5 32L5 3Z" fill="#222222" stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round" />
</svg>`
}

/**
 * 生成针对单个视口（camera + cursor + ripple）的单调无冲突 GSAP 脚本片段。
 */
export function buildViewportActionScript({
  cameraSelector,
  cursorSelector,
  rippleInnerSelector,
  rippleOuterSelector,
  vpW,
  vpH,
  durationSec,
  clicks,
  zoomScale = 1.1,
  maxScale = 1.12,
  panDampX = 0.3,
  panDampY = 0.45,
  holdSec = 0.58,
}) {
  const lines = []
  lines.push(`tl.set(${JSON.stringify(cameraSelector)}, { scale: 1, x: 0, y: 0 }, 0);`)
  lines.push(`tl.set(${JSON.stringify(cursorSelector)}, { opacity: 0, x: ${Math.round(vpW * 0.72)}, y: ${Math.round(vpH * 0.82)}, scale: 1 }, 0);`)
  lines.push(`tl.set(${JSON.stringify(rippleInnerSelector)}, { opacity: 0, scale: 0.25 }, 0);`)
  lines.push(`tl.set(${JSON.stringify(rippleOuterSelector)}, { opacity: 0, scale: 0.25 }, 0);`)

  if (!clicks || clicks.length === 0) {
    // 即使没有显式 click 目标，也给轻微的平稳呼吸推进（0.025x）保证画面有呼吸感且不触发 static
    return lines.join('\n    ')
  }

  let camFreeAt = 0
  for (let i = 0; i < clicks.length; i++) {
    const ev = clicks[i]
    const px = r3(ev.target.nx * vpW)
    const py = r3(ev.target.ny * vpH)
    const entryX = r3(clamp(px + (px > vpW * 0.5 ? -90 : 90), 20, vpW - 20))
    const entryY = r3(clamp(py + 96, 20, vpH - 20))

    const clickT = r3(ev.sceneSec)
    const approachStart = r3(Math.max(camFreeAt, clickT - 0.42))
    const approachDur = r3(Math.max(0.18, clickT - approachStart))

    // 1. 光标滑入目标中心
    lines.push(
      `tl.fromTo(${JSON.stringify(cursorSelector)}, { x: ${entryX}, y: ${entryY}, opacity: 0, scale: 1 }, { x: ${px}, y: ${py}, opacity: 1, scale: 1, duration: ${approachDur}, ease: "power3.out" }, ${approachStart});`,
    )
    // 2. 点击按压反馈
    lines.push(
      `tl.to(${JSON.stringify(cursorSelector)}, { scale: 0.84, duration: 0.08, ease: "power2.in" }, ${clickT});`,
    )
    lines.push(
      `tl.to(${JSON.stringify(cursorSelector)}, { scale: 1, duration: 0.1, ease: "power2.out" }, ${r3(clickT + 0.08)});`,
    )
    // 3. 点击后轻淡出光标，不遮挡后续推近可读性
    lines.push(
      `tl.to(${JSON.stringify(cursorSelector)}, { opacity: 0, duration: 0.22, ease: "power2.in" }, ${r3(clickT + 0.28)});`,
    )

    // 4. 红色点击双波纹（在 .camera 内部，推近时与点击点严格锁死）
    lines.push(
      `tl.set([${JSON.stringify(rippleInnerSelector)}, ${JSON.stringify(rippleOuterSelector)}], { left: ${px}, top: ${py} }, ${r3(Math.max(0, clickT - 0.02))});`,
    )
    lines.push(
      `tl.fromTo(${JSON.stringify(rippleInnerSelector)}, { scale: 0.25, opacity: 0.95 }, { scale: 1.9, opacity: 0, duration: 0.42, ease: "power2.out" }, ${clickT});`,
    )
    lines.push(
      `tl.fromTo(${JSON.stringify(rippleOuterSelector)}, { scale: 0.35, opacity: 0.65 }, { scale: 2.55, opacity: 0, duration: 0.56, ease: "power2.out" }, ${r3(clickT + 0.06)});`,
    )

    // 5. 跟随点击推近镜头（利落推入、短停顿即拉回 1.0x，不裁切跳转后的新页面）
    const zoomStart = r3(Math.max(camFreeAt, clickT + 0.04))
    const zoomInDur = 0.36
    const nextEventT = clicks[i + 1] ? clicks[i + 1].sceneSec - 0.45 : durationSec - 0.12
    const maxHoldEnd = r3(Math.min(nextEventT - 0.36, zoomStart + zoomInDur + holdSec))
    if (zoomStart + zoomInDur + 0.25 < durationSec) {
      const requestedScale = Number.isFinite(ev.zoomScale) ? ev.zoomScale : zoomScale
      const targetScale = r3(clamp(Math.min(requestedScale, maxScale), 1.0, maxScale))
      if (targetScale > 1.001) {
        const z = computeSafeZoomTransform(vpW, vpH, ev.target.nx, ev.target.ny, targetScale, {
          panDampX,
          panDampY,
        })
        lines.push(
          `tl.to(${JSON.stringify(cameraSelector)}, { scale: ${z.scale}, x: ${z.x}, y: ${z.y}, duration: ${zoomInDur}, ease: "power2.inOut" }, ${zoomStart});`,
        )
        const zoomOutStart = r3(Math.max(zoomStart + zoomInDur + 0.22, maxHoldEnd))
        const zoomOutDur = r3(Math.min(0.36, Math.max(0.22, durationSec - zoomOutStart - 0.08)))
        if (zoomOutStart + zoomOutDur < durationSec) {
          lines.push(
            `tl.to(${JSON.stringify(cameraSelector)}, { scale: 1, x: 0, y: 0, duration: ${zoomOutDur}, ease: "power2.inOut" }, ${zoomOutStart});`,
          )
          camFreeAt = r3(zoomOutStart + zoomOutDur + 0.04)
        } else {
          camFreeAt = durationSec
        }
      }
    }
  }

  return lines.join('\n    ')
}
