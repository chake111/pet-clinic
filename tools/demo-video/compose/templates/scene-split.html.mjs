/**
 * 左右分屏双路同步模板（S03 双端实时图文问诊 + 已读回执、S04 医生发「建议到院」卡 → 宠主点「去预约挂号」）：
 * - 左：宠主端手机框（352×758 精确匹配 390×844 DPR 2）；
 * - 右：医生端桌面浏览器框（1128×705 精确匹配 1280×800 DPR 2 + 42px 墨色标题栏）；
 * - 左右两路经 FFmpeg 按 syncPairs[].leftMinusRightSec 锁死对齐并等长裁切，HyperFrames 原生播放零漂移；
 * - 左右两路独立支持点击光标、#d92549 波纹与局部推近，且操作侧自动点亮红框焦点。
 */
import {
  buildViewportActionScript,
  CURSOR_AND_RIPPLE_CSS,
  cursorSvgMarkup,
  escHtml,
  FONT_FACE_CSS,
  pickHighlightClicks,
} from './motion-helpers.mjs'

const LEFT_VP_W = 352
const LEFT_VP_H = 758
const RIGHT_VP_W = 1128
const RIGHT_VP_H = 705

export function renderSplitSceneHtml(shot, renderPlan) {
  const { width, height } = renderPlan
  const id = shot.shotId
  const leftClip = shot.clips.find((c) => c.slot === 'left') || shot.clips[0]
  const rightClip = shot.clips.find((c) => c.slot === 'right') || shot.clips[1] || shot.clips[0]

  const leftClicks = pickHighlightClicks(shot.events, 'left', shot.durationSec, {
    maxCount: 2,
    minGapSec: 1.9,
    zoomTargets: shot.zoomTargets,
  })
  const rightClicks = pickHighlightClicks(shot.events, 'right', shot.durationSec, {
    maxCount: 2,
    minGapSec: 1.9,
    zoomTargets: shot.zoomTargets,
  })

  const leftScript = buildViewportActionScript({
    cameraSelector: `#${id}-left-cam`,
    cursorSelector: `#${id}-left-cursor`,
    rippleInnerSelector: `#${id}-left-rip-in`,
    rippleOuterSelector: `#${id}-left-rip-out`,
    vpW: LEFT_VP_W,
    vpH: LEFT_VP_H,
    durationSec: shot.durationSec,
    clicks: leftClicks,
    zoomScale: Math.min(Number(shot.zoomConfig?.leftScale || 1.08), 1.08),
    maxScale: 1.08,
    panDampX: 0.16,
    panDampY: 0.4,
    holdSec: 0.55,
  })

  // 右侧医生桌面自带 200px 左侧栏：保持 1.0x 满幅展示 + 光标/#d92549 双波纹 + 红框焦点高亮，
  // 杜绝推近时左缘切出半个侧栏字（如「台/会话」）
  const rightScript = buildViewportActionScript({
    cameraSelector: `#${id}-right-cam`,
    cursorSelector: `#${id}-right-cursor`,
    rippleInnerSelector: `#${id}-right-rip-in`,
    rippleOuterSelector: `#${id}-right-rip-out`,
    vpW: RIGHT_VP_W,
    vpH: RIGHT_VP_H,
    durationSec: shot.durationSec,
    clicks: rightClicks,
    zoomScale: 1.0,
    maxScale: 1.0,
    panDampX: 0,
    panDampY: 0,
    holdSec: 0.5,
  })

  // 按左右交互时间点动态高亮当前活跃端边框（墨色 ↔ #d92549）
  const focusTimeline = []
  const allHighlights = [
    ...leftClicks.map((c) => ({ side: 'left', t: Math.max(0, c.sceneSec - 0.2) })),
    ...rightClicks.map((c) => ({ side: 'right', t: Math.max(0, c.sceneSec - 0.2) })),
  ].sort((a, b) => a.t - b.t)

  focusTimeline.push(`tl.set("#${id}-phone-shell", { borderColor: "#222222" }, 0);`)
  focusTimeline.push(`tl.set("#${id}-desktop-shell", { borderColor: "#222222" }, 0);`)
  for (const h of allHighlights) {
    const t = Math.round(h.t * 1000) / 1000
    if (h.side === 'left') {
      focusTimeline.push(`tl.to("#${id}-phone-shell", { borderColor: "#d92549", duration: 0.18 }, ${t});`)
      focusTimeline.push(`tl.to("#${id}-desktop-shell", { borderColor: "#222222", duration: 0.18 }, ${t});`)
    } else {
      focusTimeline.push(`tl.to("#${id}-desktop-shell", { borderColor: "#d92549", duration: 0.18 }, ${t});`)
      focusTimeline.push(`tl.to("#${id}-phone-shell", { borderColor: "#222222", duration: 0.18 }, ${t});`)
    }
  }

  return `<template>
  <style>${FONT_FACE_CSS}
    #root {
      position: absolute;
      inset: 0;
      background: #f7f7f7;
      color: #222222;
      font-family: "YuzhuaSC", sans-serif;
    }

    /* 左侧手机框：x = 264..632, y = 76..850 */
    .split-phone-shell {
      position: absolute;
      left: 264px;
      top: 76px;
      width: 368px;
      height: 774px;
      padding: 6px;
      border: 3px solid #222222;
      border-radius: 44px;
      background: #222222;
      box-shadow: 0 20px 44px rgba(34, 34, 34, 0.15);
    }

    .split-phone-viewport {
      position: relative;
      width: ${LEFT_VP_W}px;
      height: ${LEFT_VP_H}px;
      border-radius: 34px;
      overflow: hidden;
      background: #ffffff;
    }

    /* 双端实时同步连接标：x = 640..666 */
    .split-bridge {
      position: absolute;
      left: 638px;
      top: 416px;
      width: 28px;
      height: 72px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      pointer-events: none;
    }
    .bridge-line {
      width: 2px;
      height: 18px;
      background: #d4d4d4;
    }
    .bridge-badge {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #d92549;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* 右侧桌面浏览器框：x = 672..1806, y = 94..851（90% 安全区 x <= 1824） */
    .split-desktop-shell {
      position: absolute;
      left: 672px;
      top: 94px;
      width: 1134px;
      height: 757px;
      border: 3px solid #222222;
      border-radius: 14px;
      background: #ffffff;
      overflow: hidden;
      box-shadow: 0 20px 44px rgba(34, 34, 34, 0.14);
    }

    .split-desktop-bar {
      height: 46px;
      background: #222222;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      font-size: 32px;
      font-weight: 600;
      line-height: 1;
    }

    .bar-dots {
      display: inline-flex;
      gap: 8px;
    }
    .bar-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #595959;
    }
    .bar-dot.is-red {
      background: #d92549;
    }

    .split-desktop-viewport {
      position: relative;
      width: ${RIGHT_VP_W}px;
      height: ${RIGHT_VP_H}px;
      overflow: hidden;
      background: #ffffff;
    }

    .camera-box {
      position: relative;
      width: 100%;
      height: 100%;
      transform-origin: 50% 50%;
    }

    .media-fill {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
${CURSOR_AND_RIPPLE_CSS}
  </style>

  <div id="root" data-composition-id="${escHtml(id)}" data-width="${width}" data-height="${height}">
    <div class="split-phone-shell" id="${escHtml(id)}-phone-shell" data-layout-allow-overflow>
      <div class="split-phone-viewport" data-layout-allow-overflow>
        <div class="camera-box" id="${escHtml(id)}-left-cam" data-layout-allow-overflow>
          <video
            id="${escHtml(id)}-video-left"
            class="clip media-fill"
            src="${escHtml(leftClip?.outputRelPath || '')}"
            muted
            playsinline
            data-start="0"
            data-duration="${shot.durationSec}"
            data-media-start="0"
            data-playback-rate="${shot.effectiveRate}"
            data-track-index="0"
          ></video>
          <div class="camera-ripple" id="${escHtml(id)}-left-rip-in" data-layout-ignore></div>
          <div class="camera-ripple-outer" id="${escHtml(id)}-left-rip-out" data-layout-ignore></div>
        </div>
        <div class="viewport-cursor-layer" data-layout-ignore>
          ${cursorSvgMarkup(`${id}-left-cursor`)}
        </div>
      </div>
    </div>

    <div class="split-bridge" data-layout-ignore>
      <div class="bridge-line"></div>
      <div class="bridge-badge">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 5.5H13.5M10.5 2.5L13.5 5.5L10.5 8.5M14 10.5H2.5M5.5 7.5L2.5 10.5L5.5 13.5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="bridge-line"></div>
    </div>

    <div class="split-desktop-shell" id="${escHtml(id)}-desktop-shell" data-layout-allow-overflow>
      <div class="split-desktop-bar">
        <span>医生端 · 实时问诊工作台</span>
        <span class="bar-dots" data-layout-ignore>
          <span class="bar-dot is-red"></span>
          <span class="bar-dot"></span>
          <span class="bar-dot"></span>
        </span>
      </div>
      <div class="split-desktop-viewport" data-layout-allow-overflow>
        <div class="camera-box" id="${escHtml(id)}-right-cam" data-layout-allow-overflow>
          <video
            id="${escHtml(id)}-video-right"
            class="clip media-fill"
            src="${escHtml(rightClip?.outputRelPath || '')}"
            muted
            playsinline
            data-start="0"
            data-duration="${shot.durationSec}"
            data-media-start="0"
            data-playback-rate="${shot.effectiveRate}"
            data-track-index="1"
          ></video>
          <div class="camera-ripple" id="${escHtml(id)}-right-rip-in" data-layout-ignore></div>
          <div class="camera-ripple-outer" id="${escHtml(id)}-right-rip-out" data-layout-ignore></div>
        </div>
        <div class="viewport-cursor-layer" data-layout-ignore>
          ${cursorSvgMarkup(`${id}-right-cursor`)}
        </div>
      </div>
    </div>
  </div>

  <script>
    const tl = gsap.timeline({ paused: true });
    ${focusTimeline.join('\n    ')}
    ${leftScript}
    ${rightScript}
    window.__timelines = window.__timelines || {};
    window.__timelines[${JSON.stringify(id)}] = tl;
  </script>
</template>
`
}
