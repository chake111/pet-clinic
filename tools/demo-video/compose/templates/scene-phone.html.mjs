/**
 * 手机框单路场景模板（S01 / S02 / S05）：
 * - 左侧 9:19.5 手机框（372×800 匹配 390×844 DPR 2 实录），支持克制的跟随点击推近 + 光标 + #d92549 波纹；
 * - 右侧留白诊单纸卡（位于 80% 标题安全区中段，避开 B 站底栏与顶弹幕）：
 *   直接以大号 54px 墨色粗体呈现宠主口吻故事字幕 + 可选 #d92549 小标签（空则不画）+ 品牌小标；
 *   不输出任何内部开发规格文案，也不再底部重复叠黑字幕条，640×360 下极其清晰；
 * - 第 1 镜（index === 1）t=0.0s 即展示完整产品首页与首句故事字幕，零黑屏零空帧。
 */
import {
  buildViewportActionScript,
  CURSOR_AND_RIPPLE_CSS,
  cursorSvgMarkup,
  escHtml,
  FONT_FACE_CSS,
  pickHighlightClicks,
} from './motion-helpers.mjs'

const PHONE_VP_W = 372
const PHONE_VP_H = 800

export function renderPhoneSceneHtml(shot, renderPlan) {
  const { width, height, brand } = renderPlan
  const id = shot.shotId
  const clip = shot.clips[0]
  const videoSrc = clip ? clip.outputRelPath : ''
  const isTicketShot = id === 'S05'
  const maxScale = isTicketShot ? 1.06 : 1.09
  const zoomScale = Math.min(Number(shot.zoomConfig?.scale || maxScale), maxScale)
  const clicks = pickHighlightClicks(shot.events, clip?.slot || 'primary', shot.durationSec, {
    maxCount: 2,
    minGapSec: 1.9,
    zoomTargets: shot.zoomTargets,
  })

  const storyText = shot.captionSegments?.[0]?.text || shot.subtitle || ''
  const featureTag = shot.featureTag || ''

  const entranceScript =
    shot.index === 1
      ? `// 第 1 镜第 0 帧即呈现完整产品界面与首句故事字幕，零黑屏
    tl.set("#${id}-phone-shell", { opacity: 1, y: 0 }, 0);
    tl.set("#${id}-story-card", { opacity: 1, x: 0 }, 0);`
      : `tl.set("#${id}-phone-shell", { opacity: 1, y: 0 }, 0);
    tl.fromTo("#${id}-story-card", { opacity: 0.35, x: 20 }, { opacity: 1, x: 0, duration: 0.26, ease: "power3.out" }, 0);`

  const viewportActionScript = buildViewportActionScript({
    cameraSelector: `#${id}-cam`,
    cursorSelector: `#${id}-cursor`,
    rippleInnerSelector: `#${id}-rip-in`,
    rippleOuterSelector: `#${id}-rip-out`,
    vpW: PHONE_VP_W,
    vpH: PHONE_VP_H,
    durationSec: shot.durationSec,
    clicks,
    zoomScale,
    maxScale,
    panDampX: isTicketShot ? 0.08 : 0.2,
    panDampY: isTicketShot ? 0.24 : 0.4,
    holdSec: Number(shot.zoomConfig?.holdSec || 0.52),
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

    /* 手机框居中偏左：x = 324..712, y = 132..948（90% 动作安全区内，避开 B 站底栏） */
    .phone-shell {
      position: absolute;
      left: 324px;
      top: 132px;
      width: 388px;
      height: 816px;
      padding: 8px;
      border-radius: 46px;
      background: #222222;
      box-shadow: 0 22px 48px rgba(34, 34, 34, 0.16);
    }

    .phone-viewport {
      position: relative;
      width: ${PHONE_VP_W}px;
      height: ${PHONE_VP_H}px;
      border-radius: 38px;
      overflow: hidden;
      background: #ffffff;
    }

    .phone-camera {
      position: relative;
      width: ${PHONE_VP_W}px;
      height: ${PHONE_VP_H}px;
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

    /* 右侧留白故事字幕卡：x = 796..1696, y = 386..680（严格位于 80% 标题安全区中段，与手机垂直居中） */
    .story-card {
      position: absolute;
      left: 796px;
      top: 386px;
      width: 900px;
      background: #ffffff;
      border: 1.5px solid #222222;
      border-top: 5px solid #d92549;
      padding: 44px 56px 54px;
      box-shadow: 10px 10px 0 rgba(34, 34, 34, 0.07);
    }

    .story-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      min-height: 44px;
      margin-bottom: 30px;
    }

    .story-tag {
      display: inline-flex;
      align-items: center;
      padding: 6px 20px;
      background: #d92549;
      color: #ffffff;
      font-size: 32px;
      font-weight: 600;
      letter-spacing: 0.03em;
      line-height: 1.25;
      white-space: nowrap;
    }

    .story-spacer {
      width: 48px;
      height: 4px;
      background: #d92549;
    }

    .story-brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 32px;
      font-weight: 700;
      color: #222222;
      margin-left: auto;
    }
    .story-brand img {
      width: 32px;
      height: 32px;
      display: block;
    }

    .story-rule {
      height: 1px;
      background: #ebebeb;
      margin-bottom: 34px;
    }

    .story-caption {
      font-size: 54px;
      font-weight: 700;
      line-height: 1.34;
      color: #222222;
      letter-spacing: 0.01em;
      text-wrap: balance;
    }
${CURSOR_AND_RIPPLE_CSS}
  </style>

  <div id="root" data-composition-id="${escHtml(id)}" data-width="${width}" data-height="${height}">
    <div class="phone-shell" id="${escHtml(id)}-phone-shell" data-layout-allow-overflow>
      <div class="phone-viewport" data-layout-allow-overflow>
        <div class="phone-camera" id="${escHtml(id)}-cam" data-layout-allow-overflow>
          <video
            id="${escHtml(id)}-video"
            class="clip media-fill"
            src="${escHtml(videoSrc)}"
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

    <section class="story-card" id="${escHtml(id)}-story-card" data-layout-allow-caption-zone>
      <div class="story-head">
        ${
          featureTag
            ? `<span class="story-tag">${escHtml(featureTag)}</span>`
            : `<span class="story-spacer" data-layout-ignore></span>`
        }
        <span class="story-brand">
          <img src="assets/brand/logo.svg" alt="${escHtml(brand.name)}" data-layout-ignore />
          <span>${escHtml(brand.name)}</span>
        </span>
      </div>
      <div class="story-rule" data-layout-ignore></div>
      <p class="story-caption">${escHtml(storyText)}</p>
    </section>
  </div>

  <script>
    const tl = gsap.timeline({ paused: true });
    ${entranceScript}
    ${viewportActionScript}
    window.__timelines = window.__timelines || {};
    window.__timelines[${JSON.stringify(id)}] = tl;
  </script>
</template>
`
}
