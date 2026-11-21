/**
 * 独立底部字幕轨子合成（data-track-kind="captions"）：
 * - 仅服务于宽幅分屏/桌面/全屏镜头（S03 / S04 / S06 / S07）：
 *   - 手机单路镜头（S01 / S02 / S05）已在右侧留白纸卡中呈现大号故事字幕，底部不再重复叠加；
 *   - 片尾落地页（S08）本身含真实落地页文案与大字 CTA，不叠加底部字幕条；
 * - 支持单句与多段切换（如 S03 前半「等不及？先在线问问」→ 后半「医生这边实时收到」）；
 * - 当 featureTag 为空时（如 S04 / S07）不画空红胶囊，改以 8px 红竖线维持品牌识别；
 * - 严格落在 80% 标题安全区底部留白（x ∈ [248, 1728], y = 880..960），避开 B 站底栏与顶弹幕。
 */
import { escHtml, FONT_FACE_CSS } from './motion-helpers.mjs'

export function renderOverlayCaptionsHtml(renderPlan) {
  const { width, height, shots } = renderPlan

  // 仅宽幅舞台且有字幕内容的镜头走底部安全区字幕条
  const barEntries = []
  for (const s of shots) {
    if (s.layout === 'phone' || s.layout === 'ending') continue
    const segs = s.captionSegments || []
    for (const seg of segs) {
      if (!seg.text) continue
      barEntries.push({
        domId: `cap-${s.shotId}-${seg.index}`,
        shotId: s.shotId,
        featureTag: s.featureTag || '',
        text: seg.text,
        absStartSec: seg.absStartSec,
        absEndSec: seg.absEndSec,
        isFirstSegInShot: seg.index === 0,
      })
    }
  }

  const groupsHtml = barEntries
    .map((entry) => {
      const hasTag = Boolean(entry.featureTag)
      const tagHtml = hasTag ? `<span class="cap-tag">${escHtml(entry.featureTag)}</span>` : ''
      const barCls = hasTag ? 'cap-bar' : 'cap-bar no-tag'
      return `      <div class="cap-group" id="${escHtml(entry.domId)}">
        <div class="${barCls}">
          ${tagHtml}
          <span class="cap-text">${escHtml(entry.text)}</span>
        </div>
      </div>`
    })
    .join('\n')

  const scriptLines = []
  for (const entry of barEntries) {
    const sel = `#${entry.domId}`
    const enterT = Math.round((entry.absStartSec + (entry.isFirstSegInShot ? 0.12 : 0.06)) * 1000) / 1000
    const exitStart = Math.round(Math.max(enterT + 0.35, entry.absEndSec - 0.16) * 1000) / 1000
    const exitEnd = Math.round(Math.max(exitStart + 0.08, entry.absEndSec - 0.02) * 1000) / 1000

    scriptLines.push(`tl.set(${JSON.stringify(sel)}, { opacity: 0, y: 10, visibility: "hidden" }, 0);`)
    scriptLines.push(`tl.set(${JSON.stringify(sel)}, { visibility: "visible" }, ${enterT});`)
    scriptLines.push(
      `tl.fromTo(${JSON.stringify(sel)}, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.2, ease: "power3.out" }, ${enterT});`,
    )
    scriptLines.push(
      `tl.to(${JSON.stringify(sel)}, { opacity: 0, y: -4, duration: ${Math.round((exitEnd - exitStart) * 1000) / 1000}, ease: "power2.in" }, ${exitStart});`,
    )
    scriptLines.push(`tl.set(${JSON.stringify(sel)}, { opacity: 0, visibility: "hidden" }, ${exitEnd});`)
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

    /* 80% 标题安全区底部留白带：x ∈ [248, 1728], y ∈ [880, 960] */
    .subtitle-zone {
      position: absolute;
      left: 248px;
      top: 880px;
      width: 1480px;
      height: 80px;
      overflow: visible;
    }

    .cap-group {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      visibility: hidden;
    }

    .cap-bar {
      display: inline-flex;
      align-items: stretch;
      background: #222222;
      box-shadow: 0 10px 28px rgba(34, 34, 34, 0.18);
      border: 1px solid #222222;
    }

    .cap-bar.no-tag {
      border-left: 8px solid #d92549;
    }

    .cap-tag {
      display: inline-flex;
      align-items: center;
      padding: 0 22px;
      background: #d92549;
      color: #ffffff;
      font-size: 32px;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }

    .cap-text {
      display: inline-flex;
      align-items: center;
      padding: 12px 30px;
      color: #ffffff;
      font-size: 44px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
  </style>

  <div id="root" data-composition-id="overlay-captions" data-width="${width}" data-height="${height}">
    <div class="subtitle-zone" data-layout-allow-caption-zone>
${groupsHtml}
    </div>
  </div>

  <script>
    const tl = gsap.timeline({ paused: true });
    ${scriptLines.join('\n    ')}
    window.__timelines = window.__timelines || {};
    window.__timelines["overlay-captions"] = tl;
  </script>
</template>
`
}
