/**
 * 常驻左侧进度轨子合成（宠主 → 医生 → 管理）：
 * - 位于 x = 112px（严格在 90% 动作安全区 x ≥ 96 内，不贴边）；
 * - 字号 28px（满足 HyperFrames 28px 文本下限 + 640×360 清晰可见）；
 * - 100% 纯 GSAP 属性补间（零 tl.call 副作用，支持任意前后随机 seek）；
 * - 支持双端分屏镜头（S03/S04）同时高亮「宠主」与「医生」并点亮连接脊线；
 * - 进入片尾（S08）时干净淡出，不抢占片尾视觉。
 */
import { escHtml, FONT_FACE_CSS } from './motion-helpers.mjs'

const NODES = [
  { key: 'owner', label: '宠主' },
  { key: 'doctor', label: '医生' },
  { key: 'admin', label: '管理' },
]

export function renderOverlayRailHtml(renderPlan) {
  const { width, height, shots } = renderPlan

  const transitions = []
  for (const shot of shots) {
    const t = shot.startSec
    const isEnding = shot.layout === 'ending' || shot.railStages.length === 0
    if (isEnding) {
      transitions.push(
        `tl.to("#rail-panel", { opacity: 0, x: -16, duration: 0.25, ease: "power2.in" }, ${Math.max(0, Math.round((t - 0.12) * 1000) / 1000)});`,
      )
      continue
    }

    const activeSet = new Set(shot.railStages)
    const isFirst = shot.index === 1
    const dur = isFirst ? 0 : 0.22

    // 进度脊线高度：仅 owner=4%, 含 doctor=50%, 含 admin=100%
    const spineScaleY = activeSet.has('admin') ? 1 : activeSet.has('doctor') ? 0.5 : 0.04

    if (isFirst) {
      transitions.push(`tl.set("#rail-panel", { opacity: 1, x: 0 }, 0);`)
      transitions.push(`tl.set("#rail-spine-fill", { scaleY: ${spineScaleY} }, 0);`)
    } else {
      transitions.push(
        `tl.to("#rail-spine-fill", { scaleY: ${spineScaleY}, duration: ${dur}, ease: "power2.out" }, ${t});`,
      )
    }

    for (const node of NODES) {
      const isActive = activeSet.has(node.key)
      const isDone =
        !isActive &&
        ((node.key === 'owner' && (activeSet.has('doctor') || activeSet.has('admin'))) ||
          (node.key === 'doctor' && activeSet.has('admin')))

      const dotBg = isActive ? '#d92549' : isDone ? '#222222' : '#c8c8c8'
      const dotScale = isActive ? 1.28 : 1
      const labelColor = isActive ? '#222222' : isDone ? '#3f3f3f' : '#595959'
      const labelOpacity = isActive ? 1 : isDone ? 0.92 : 0.72

      if (isFirst) {
        transitions.push(
          `tl.set("#rail-dot-${node.key}", { backgroundColor: "${dotBg}", scale: ${dotScale} }, 0);`,
        )
        transitions.push(
          `tl.set("#rail-lbl-${node.key}", { color: "${labelColor}", opacity: ${labelOpacity} }, 0);`,
        )
      } else {
        transitions.push(
          `tl.to("#rail-dot-${node.key}", { backgroundColor: "${dotBg}", scale: ${dotScale}, duration: ${dur}, ease: "power2.out" }, ${t});`,
        )
        transitions.push(
          `tl.to("#rail-lbl-${node.key}", { color: "${labelColor}", opacity: ${labelOpacity}, duration: ${dur}, ease: "power2.out" }, ${t});`,
        )
      }
    }
  }

  return `<template>
  <style>${FONT_FACE_CSS}
    #root {
      position: absolute;
      inset: 0;
      background: transparent;
      pointer-events: none;
      font-family: "YuzhuaSC", sans-serif;
    }

    /* 左侧常驻进度轨：x = 112..232（严格位于 90% 动作安全区 x >= 96 内，不贴边） */
    .rail-panel {
      position: absolute;
      left: 112px;
      top: 296px;
      width: 120px;
      padding: 24px 0;
      border-top: 2px solid #222222;
      border-bottom: 1px solid #d4d4d4;
    }

    .rail-track {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 64px;
      padding-left: 2px;
    }

    .rail-spine {
      position: absolute;
      left: 9px;
      top: 16px;
      width: 2px;
      height: 196px;
      background: #d4d4d4;
    }
    .rail-spine-fill {
      position: absolute;
      left: 0;
      top: 0;
      width: 2px;
      height: 100%;
      background: #d92549;
      transform-origin: top center;
    }

    .rail-node {
      position: relative;
      display: flex;
      align-items: center;
      gap: 16px;
      z-index: 2;
    }

    .rail-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #c8c8c8;
      border: 2px solid #f7f7f7;
      flex: none;
    }

    .rail-label {
      font-size: 32px;
      font-weight: 700;
      line-height: 1.2;
      color: #595959;
      white-space: nowrap;
    }
  </style>

  <div id="root" data-composition-id="overlay-rail" data-width="${width}" data-height="${height}">
    <aside class="rail-panel" id="rail-panel">
      <div class="rail-track">
        <div class="rail-spine" data-layout-ignore>
          <div class="rail-spine-fill" id="rail-spine-fill" data-layout-ignore></div>
        </div>
        ${NODES.map(
          (n) => `<div class="rail-node" id="rail-node-${n.key}">
          <span class="rail-dot" id="rail-dot-${n.key}" data-layout-ignore></span>
          <span class="rail-label" id="rail-lbl-${n.key}">${escHtml(n.label)}</span>
        </div>`,
        ).join('\n        ')}
      </div>
    </aside>
  </div>

  <script>
    const tl = gsap.timeline({ paused: true });
    ${transitions.join('\n    ')}
    window.__timelines = window.__timelines || {};
    window.__timelines["overlay-rail"] = tl;
  </script>
</template>
`
}
