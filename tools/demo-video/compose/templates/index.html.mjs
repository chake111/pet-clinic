/**
 * 根合成 index.html 模板生成器。
 * 遵循 HyperFrames 契约：
 * - 根只放场景宿主、常驻进度轨宿主与字幕轨宿主；
 * - 品牌名与文案通过 data-composition-variables 从 frontend/src/brand.js 注入，绝不硬编码；
 * - data-duration 与所有镜头严格对齐且 ≤ 60s。
 */
import { escHtml, FONT_FACE_CSS } from './motion-helpers.mjs'

export function renderIndexHtml(renderPlan) {
  const { width, height, fps, totalDurationSec, brand, shots } = renderPlan

  const compVars = [
    { id: 'brand_name', type: 'string', label: '品牌简称', default: brand.name },
    { id: 'brand_tagline', type: 'string', label: '品牌定位', default: brand.tagline },
    { id: 'brand_title', type: 'string', label: '品牌标题', default: brand.title },
    { id: 'color_ink', type: 'color', label: '墨色', default: '#222222' },
    { id: 'color_action', type: 'color', label: '红章色', default: '#d92549' },
    { id: 'color_desk', type: 'color', label: '桌面纸底', default: '#f7f7f7' },
  ]

  const sceneHosts = shots
    .map(
      (shot, idx) => `      <div
        id="${escHtml(shot.shotId)}"
        class="clip"
        data-composition-id="${escHtml(shot.shotId)}"
        data-composition-src="compositions/${escHtml(shot.shotId)}.html"
        data-start="${shot.startSec}"
        data-duration="${shot.durationSec}"
        data-track-index="0"
        data-track-kind="graphics"
        data-width="${width}"
        data-height="${height}"
        style="z-index: ${10 + idx}"
      ></div>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN" data-composition-variables='${escHtml(JSON.stringify(compVars))}'>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${escHtml(brand.title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>${FONT_FACE_CSS}
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      html,
      body {
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: #f7f7f7;
        font-family: "YuzhuaSC", sans-serif;
      }
      #root {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${totalDurationSec}"
      data-fps="${fps}"
      data-width="${width}"
      data-height="${height}"
    >
${sceneHosts}
      <div
        id="overlay-rail"
        class="clip"
        data-composition-id="overlay-rail"
        data-composition-src="compositions/overlay-rail.html"
        data-start="0"
        data-duration="${totalDurationSec}"
        data-track-index="1"
        data-track-kind="graphics"
        data-width="${width}"
        data-height="${height}"
        style="z-index: 60"
      ></div>
      <div
        id="overlay-captions"
        class="clip"
        data-composition-id="overlay-captions"
        data-composition-src="compositions/overlay-captions.html"
        data-start="0"
        data-duration="${totalDurationSec}"
        data-track-index="2"
        data-track-kind="captions"
        data-width="${width}"
        data-height="${height}"
        style="z-index: 70"
      ></div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`
}
