/**
 * 桌面单屏 / 管理端全屏场景模板：
 * - desktop（S06 医生接诊工作台 1280×800）：1184×740 精确 1.6:1 + 42px 墨色标题栏（居中舞台）；
 * - fullscreen（S07 管理端看板 1280×720）：1344×756 精确 16:9 满幅无遮挡展示（避开左进度轨与底字幕留白）。
 */
import {
  buildViewportActionScript,
  CURSOR_AND_RIPPLE_CSS,
  cursorSvgMarkup,
  escHtml,
  FONT_FACE_CSS,
  pickHighlightClicks,
} from './motion-helpers.mjs'

export function renderDesktopSceneHtml(shot, renderPlan) {
  const { width, height } = renderPlan
  const id = shot.shotId
  const clip = shot.clips[0]
  const isFullscreen = shot.layout === 'fullscreen'

  const vpW = isFullscreen ? 1344 : 1184
  const vpH = isFullscreen ? 756 : 740
  const barH = isFullscreen ? 0 : 46
  const shellW = vpW + 4
  const shellH = vpH + barH + 4
  // 舞台可用横轴 x ∈ [264, 1808]（中心 1036），纵轴 y ∈ [64, 858]（中心 461）
  const shellLeft = Math.round(1036 - shellW / 2)
  const shellTop = Math.round(461 - shellH / 2)

  const clicks = isFullscreen
    ? []
    : pickHighlightClicks(shot.events, clip?.slot || 'primary', shot.durationSec, {
        maxCount: 2,
        minGapSec: 1.9,
        zoomTargets: shot.zoomTargets,
      })

  // 桌面端（S06 工作台 / S07 全院看板）均含 200px 左侧导航栏：
  // 保持 1.0x 满幅展示，S06 通过合成光标与 #d92549 点击双波纹聚焦「接诊 / 保存病历 / 结束就诊」，
  // 彻底消除左缘切出半个侧栏字（如「约/诊/历」）的风险。
  const maxScale = 1.0
  const zoomScale = 1.0
  const barTitle = id === 'S06' ? '医生端 · 门诊接诊工作台' : shot.title
  const actionScript = buildViewportActionScript({
    cameraSelector: `#${id}-cam`,
    cursorSelector: `#${id}-cursor`,
    rippleInnerSelector: `#${id}-rip-in`,
    rippleOuterSelector: `#${id}-rip-out`,
    vpW,
    vpH,
    durationSec: shot.durationSec,
    clicks,
    zoomScale,
    maxScale,
    panDampX: 0,
    panDampY: 0,
    holdSec: 0.5,
  })

  return `<template>
  <style>${FONT_FACE_CSS}
    #root {
      position: absolute;
      inset: 0;
      background: #f7f7f7;
      color: #222222;
      font-family: "YuzhuaSC", sans-serif;
    }

    .desk-shell {
      position: absolute;
      left: ${shellLeft}px;
      top: ${shellTop}px;
      width: ${shellW}px;
      height: ${shellH}px;
      border: 2px solid #222222;
      border-radius: ${isFullscreen ? 10 : 14}px;
      background: #ffffff;
      overflow: hidden;
      box-shadow: 0 22px 48px rgba(34, 34, 34, 0.14);
    }

    .desk-bar {
      height: 46px;
      background: #222222;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 22px;
      font-size: 32px;
      font-weight: 600;
      line-height: 1;
    }

    .desk-dots {
      display: inline-flex;
      gap: 8px;
    }
    .desk-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #595959;
    }
    .desk-dot.is-red {
      background: #d92549;
    }

    .desk-viewport {
      position: relative;
      width: ${vpW}px;
      height: ${vpH}px;
      overflow: hidden;
      background: #ffffff;
    }

    .desk-camera {
      position: relative;
      width: ${vpW}px;
      height: ${vpH}px;
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
    <div class="desk-shell" id="${escHtml(id)}-shell" data-layout-allow-overflow>
      ${
        isFullscreen
          ? ''
          : `<div class="desk-bar">
        <span>${escHtml(barTitle)}</span>
        <span class="desk-dots" data-layout-ignore>
          <span class="desk-dot is-red"></span>
          <span class="desk-dot"></span>
          <span class="desk-dot"></span>
        </span>
      </div>`
      }
      <div class="desk-viewport" data-layout-allow-overflow>
        <div class="desk-camera" id="${escHtml(id)}-cam" data-layout-allow-overflow>
          <video
            id="${escHtml(id)}-video"
            class="clip media-fill"
            src="${escHtml(clip?.outputRelPath || '')}"
            muted
            playsinline
            data-start="0"
            data-duration="${shot.durationSec}"
            data-media-start="0"
            data-playback-rate="${shot.effectiveRate}"
            data-track-index="0"
          ></video>
          <div class="camera-ripple" id="${escHtml(id)}-rip-in" data-layout-ignore></div>
          <div class="camera-ripple-outer" id="${escHtml(id)}-rip-out" data-layout-ignore></div>
        </div>
        <div class="viewport-cursor-layer" data-layout-ignore>
          ${cursorSvgMarkup(`${id}-cursor`)}
        </div>
      </div>
    </div>
  </div>

  <script>
    const tl = gsap.timeline({ paused: true });
    ${actionScript}
    window.__timelines = window.__timelines || {};
    window.__timelines[${JSON.stringify(id)}] = tl;
  </script>
</template>
`
}
