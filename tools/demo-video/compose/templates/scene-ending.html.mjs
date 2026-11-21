/**
 * 片尾落地页 + 红章闪动 + 大字 CTA 模板（S08）：
 * - 前段（0 ~ flashT）：展示 record.mjs 实录的脱敏 /demo 落地页（已隐藏账号/密码/即将上线），
 *   镜头聚焦红章位置并触发一次利落的 #d92549 红章闪动转场；
 * - 后段（flashT ~ end，确保停留 ≥ 2.4s 满足 HyperFrames 结尾阅读时长）：
 *   呈现墨色纸面风格 CTA 卡片（复用 agent-assets/logo.svg + tuantuan.webp + brand.js 文案），
 *   突出大字 URL「yuzhua-petclinic.top/demo」与下一行「免注册 · 三端直接进入 · 链接在简介」；
 * - 零账号名、零密码、零二维码、零个人信息；全部核心排版位于 80% 标题安全区内。
 */
import { computeSafeZoomTransform, escHtml, FONT_FACE_CSS } from './motion-helpers.mjs'

const LANDING_VP_W = 1344
const LANDING_VP_H = 756

export function renderEndingSceneHtml(shot, renderPlan) {
  const { width, height, brand } = renderPlan
  const id = shot.shotId
  const clip = shot.clips[0]
  const hasVideo = Boolean(clip?.outputRelPath)
  const ctaUrl = shot.ending?.ctaUrl || 'yuzhua-petclinic.top/demo'
  const ctaSubline = shot.ending?.ctaSubline || '免注册 · 三端直接进入 · 链接在简介'
  const stampLabel = shot.ending?.stampLabel || '在线演示'

  // 确保后段 CTA 卡片至少停留 minOutroHoldSec（与 overlay-captions 共享 flashSec）
  const flashT = Number.isFinite(shot.ending?.flashSec)
    ? shot.ending.flashSec
    : hasVideo
      ? Math.round(Math.max(1.6, Math.min(2.4, shot.durationSec - 2.65)) * 1000) / 1000
      : 0.25

  // 从 timeline.json 事件中寻找红章坐标，否则默认取 agent-draft.html 首纸红章区域
  const stampEv = (shot.events || []).find((e) => e.target)
  const stampNx = stampEv?.target?.nx ?? 0.34
  const stampNy = stampEv?.target?.ny ?? 0.62
  const stampPxX = Math.round(stampNx * LANDING_VP_W)
  const stampPxY = Math.round(stampNy * LANDING_VP_H)
  const stampScale = Number(shot.zoomTargets?.[0]?.scale || 1.16)
  const stampZoom = computeSafeZoomTransform(LANDING_VP_W, LANDING_VP_H, stampNx, stampNy, stampScale)

  const landingBlock = hasVideo
    ? `    <div class="landing-stage" id="${escHtml(id)}-landing" data-layout-allow-overflow>
      <div class="landing-viewport" data-layout-allow-overflow>
        <div class="landing-camera" id="${escHtml(id)}-landing-cam" data-layout-allow-overflow>
          <video
            id="${escHtml(id)}-video"
            class="clip media-fill"
            src="${escHtml(clip.outputRelPath)}"
            muted
            playsinline
            data-start="0"
            data-duration="${flashT}"
            data-media-start="0"
            data-playback-rate="${shot.effectiveRate}"
            data-track-index="0"
          ></video>
          <div class="stamp-pulse" id="${escHtml(id)}-stamp-pulse" style="left:${stampPxX}px;top:${stampPxY}px;" data-layout-ignore></div>
        </div>
      </div>
    </div>`
    : ''

  const pushStart = Math.round(Math.max(0.95, flashT - 1.15) * 1000) / 1000
  const phase1Script = hasVideo
    ? `tl.set("#${id}-landing", { opacity: 1, scale: 1 }, 0);
    tl.set("#${id}-landing-cam", { scale: 1, x: 0, y: 0 }, 0);
    // 前 1.2s 完整展示含团团全头与红章的 /demo 落地页，再轻推向红章并闪切 CTA
    tl.to("#${id}-landing-cam", { scale: ${stampZoom.scale}, x: ${stampZoom.x}, y: ${stampZoom.y}, duration: 0.65, ease: "power2.inOut" }, ${pushStart});
    // 红章闪一下
    tl.fromTo("#${id}-stamp-pulse", { scale: 0.45, opacity: 0.95 }, { scale: 2.5, opacity: 0, duration: 0.38, ease: "power2.out" }, ${Math.round((flashT - 0.38) * 1000) / 1000});
    tl.to("#${id}-landing", { opacity: 0, duration: 0.16, ease: "power2.in" }, ${Math.round((flashT - 0.16) * 1000) / 1000});`
    : ''

  const flashStart = Math.round(Math.max(0, flashT - 0.18) * 1000) / 1000
  const cardEnter = Math.round(flashT * 1000) / 1000

  return `<template>
  <style>${FONT_FACE_CSS}
    #root {
      position: absolute;
      inset: 0;
      background: #f7f7f7;
      color: #222222;
      font-family: "YuzhuaSC", sans-serif;
    }

    /* 前段：脱敏后的真实 /demo 落地页居中展示（S08 无底字幕条，上下 160px 对称留白） */
    .landing-stage {
      position: absolute;
      left: 286px;
      top: 160px;
      width: ${LANDING_VP_W + 4}px;
      height: ${LANDING_VP_H + 4}px;
      border: 2px solid #222222;
      border-radius: 10px;
      background: #ffffff;
      overflow: hidden;
      box-shadow: 0 24px 54px rgba(34, 34, 34, 0.15);
      z-index: 4;
    }

    .landing-viewport {
      position: relative;
      width: ${LANDING_VP_W}px;
      height: ${LANDING_VP_H}px;
      overflow: hidden;
    }

    .landing-camera {
      position: relative;
      width: ${LANDING_VP_W}px;
      height: ${LANDING_VP_H}px;
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

    .stamp-pulse {
      position: absolute;
      width: 96px;
      height: 96px;
      margin-left: -48px;
      margin-top: -48px;
      border-radius: 50%;
      border: 6px solid #d92549;
      background: rgba(217, 37, 73, 0.24);
      opacity: 0;
      pointer-events: none;
    }

    /* 红章转场闪光层 */
    .red-flash {
      position: absolute;
      inset: 0;
      background: #d92549;
      opacity: 0;
      pointer-events: none;
      z-index: 25;
    }

    /* 后段：纸面墨线大字 CTA 卡片（严格位于 80% 标题安全区 x∈[192,1728], y∈[108,972]） */
    .end-wrap {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 12;
      opacity: 0;
    }

    .end-paper {
      position: relative;
      width: 1180px;
      margin-top: 44px;
      background: #ffffff;
      border: 2px solid #222222;
      padding: 64px 76px 68px;
      box-shadow: 14px 14px 0 rgba(34, 34, 34, 0.08);
    }

    .end-dog {
      position: absolute;
      left: 56px;
      top: 0;
      width: 268px;
      height: auto;
      transform: translateY(-70%);
      pointer-events: none;
    }

    .end-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 34px;
    }

    .end-lockup {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .end-lockup img {
      width: 48px;
      height: 48px;
      display: block;
    }
    .end-brand-name {
      font-size: 40px;
      font-weight: 700;
      color: #222222;
      line-height: 1.15;
    }
    .end-brand-tag {
      font-size: 32px;
      font-weight: 500;
      color: #595959;
      margin-left: 14px;
    }

    .end-stamp {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 12px 28px;
      background: #d92549;
      color: #ffffff;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 0.06em;
      border: 2px solid #d92549;
    }

    .end-rule {
      height: 1px;
      background: #ebebeb;
      margin-bottom: 38px;
    }

    .end-url {
      font-size: 66px;
      font-weight: 700;
      color: #222222;
      letter-spacing: -0.02em;
      line-height: 1.18;
      margin-bottom: 20px;
    }

    .end-subline {
      font-size: 36px;
      font-weight: 500;
      color: #3f3f3f;
      line-height: 1.4;
      letter-spacing: 0.02em;
    }
  </style>

  <div id="root" data-composition-id="${escHtml(id)}" data-width="${width}" data-height="${height}">
${landingBlock}
    <div class="red-flash" id="${escHtml(id)}-flash" data-layout-ignore></div>

    <div class="end-wrap" id="${escHtml(id)}-cta">
      <article class="end-paper">
        <img class="end-dog" src="assets/brand/tuantuan.webp" alt="" data-layout-ignore />
        <div class="end-header">
          <div class="end-lockup">
            <img src="assets/brand/logo.svg" alt="${escHtml(brand.name)}" data-layout-ignore />
            <span class="end-brand-name">${escHtml(brand.name)}</span>
            <span class="end-brand-tag">${escHtml(brand.tagline)}</span>
          </div>
          <span class="end-stamp" id="${escHtml(id)}-stamp">${escHtml(stampLabel)}</span>
        </div>
        <div class="end-rule" data-layout-ignore></div>
        <h1 class="end-url" id="${escHtml(id)}-url">${escHtml(ctaUrl)}</h1>
        <p class="end-subline" id="${escHtml(id)}-subline">${escHtml(ctaSubline)}</p>
      </article>
    </div>
  </div>

  <script>
    const tl = gsap.timeline({ paused: true });
    ${phase1Script}
    // 红章利落闪一下切入大字 CTA
    tl.set("#${id}-flash", { opacity: 0 }, 0);
    tl.to("#${id}-flash", { opacity: 0.28, duration: 0.12, ease: "power2.in" }, ${flashStart});
    tl.to("#${id}-flash", { opacity: 0, duration: 0.22, ease: "power2.out" }, ${Math.round((flashStart + 0.12) * 1000) / 1000});

    tl.set("#${id}-cta", { opacity: 0, y: 18 }, 0);
    tl.to("#${id}-cta", { opacity: 1, y: 0, duration: 0.3, ease: "power3.out" }, ${cardEnter});

    // 红章到位后再轻闪一拍吸引视线
    tl.fromTo("#${id}-stamp", { scale: 1 }, { scale: 1.09, duration: 0.14, ease: "power2.out" }, ${Math.round((cardEnter + 0.28) * 1000) / 1000});
    tl.to("#${id}-stamp", { scale: 1, duration: 0.18, ease: "power2.inOut" }, ${Math.round((cardEnter + 0.42) * 1000) / 1000});

    window.__timelines = window.__timelines || {};
    window.__timelines[${JSON.stringify(id)}] = tl;
  </script>
</template>
`
}
