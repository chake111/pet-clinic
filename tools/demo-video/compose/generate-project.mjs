/**
 * 由 renderPlan + 本机字体 + 只读品牌素材，在 output/demo-video/<date>/hf-project/
 * 物化一套完整、纯离线可渲染的 HyperFrames 工程，并做敏感词静态审计。
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderIndexHtml } from './templates/index.html.mjs'
import { renderOverlayRailHtml } from './templates/overlay-rail.html.mjs'
import { renderOverlayCaptionsHtml } from './templates/overlay-captions.html.mjs'
import { renderPhoneSceneHtml } from './templates/scene-phone.html.mjs'
import { renderSplitSceneHtml } from './templates/scene-split.html.mjs'
import { renderDesktopSceneHtml } from './templates/scene-desktop.html.mjs'
import { renderEndingSceneHtml } from './templates/scene-ending.html.mjs'

function renderSceneByLayout(shot, renderPlan) {
  switch (shot.layout) {
    case 'phone':
      return renderPhoneSceneHtml(shot, renderPlan)
    case 'split':
      return renderSplitSceneHtml(shot, renderPlan)
    case 'desktop':
    case 'fullscreen':
      return renderDesktopSceneHtml(shot, renderPlan)
    case 'ending':
      return renderEndingSceneHtml(shot, renderPlan)
    default:
      throw new Error(`未知镜头布局类型: ${shot.shotId} -> ${shot.layout}`)
  }
}

/**
 * 静态检查生成的 HTML 中是否出现任何 storyboard.forbiddenVisibleText。
 */
function auditGeneratedHtml(writtenFiles, forbiddenList) {
  const hits = []
  for (const { relPath, content } of writtenFiles) {
    // 剔除 <style> 与 <script> 标签外仅检查全文（含属性/注释也一并拦截，防意外泄露）
    for (const term of forbiddenList || []) {
      if (!term) continue
      // 跳过纯 CSS 类名/路由无关项时的精确敏感词检查（如账号名/密码/待上线文案）
      if (term === 'admin') {
        // admin 可能出现在代码注释或非可见文本，仅检查可见文本节点
        const visibleOnly = content
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/<[^>]+>/g, ' ')
        if (/\badmin\b/i.test(visibleOnly)) {
          hits.push({ file: relPath, term })
        }
      } else if (content.includes(term)) {
        hits.push({ file: relPath, term })
      }
    }
  }
  return hits
}

export function generateHyperFramesProject({
  repoRoot,
  hfProjectDir,
  renderPlan,
  fontPath,
  storyboard,
}) {
  const compsDir = join(hfProjectDir, 'compositions')
  const fontsDir = join(hfProjectDir, 'assets', 'fonts')
  const brandDir = join(hfProjectDir, 'assets', 'brand')
  mkdirSync(compsDir, { recursive: true })
  mkdirSync(fontsDir, { recursive: true })
  mkdirSync(brandDir, { recursive: true })

  // 1. 拷贝中文字体（SIL OFL 1.1 NotoSansSC-VF.ttf，不入 Git 仓库）
  if (!existsSync(fontPath)) {
    throw new Error(`找不到中文字体文件: ${fontPath}（可通过 YUZHUA_FONT_PATH 指定）`)
  }
  copyFileSync(fontPath, join(fontsDir, 'NotoSansSC-VF.ttf'))

  // 2. 只读拷贝品牌 SVG 标志与团团吉祥物（严禁修改 deploy/demo/ 源文件）
  const logoSrc = resolve(repoRoot, storyboard?.visualTheme?.assets?.logo || 'deploy/demo/agent-assets/logo.svg')
  const mascotSrc = resolve(repoRoot, storyboard?.visualTheme?.assets?.mascot || 'deploy/demo/agent-assets/tuantuan.webp')
  if (!existsSync(logoSrc)) throw new Error(`找不到品牌图标: ${logoSrc}`)
  if (!existsSync(mascotSrc)) throw new Error(`找不到吉祥物素材: ${mascotSrc}`)
  copyFileSync(logoSrc, join(brandDir, 'logo.svg'))
  copyFileSync(mascotSrc, join(brandDir, 'tuantuan.webp'))

  // 3. 写入 HyperFrames 工程配置文件
  const hfConfig = {
    $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
    registry: 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry',
    paths: {
      blocks: 'compositions',
      components: 'compositions/components',
      assets: 'assets',
    },
    media: {
      autoProxy: true,
    },
    authoringSkill: 'hyperframes',
  }
  writeFileSync(join(hfProjectDir, 'hyperframes.json'), JSON.stringify(hfConfig, null, 2) + '\n', 'utf8')
  writeFileSync(
    join(hfProjectDir, 'meta.json'),
    JSON.stringify(
      {
        name: 'demo-video',
        title: renderPlan.brand.title,
        width: renderPlan.width,
        height: renderPlan.height,
        fps: renderPlan.fps,
        duration: renderPlan.totalDurationSec,
        silent: true,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  // 4. 生成根 index.html、双叠层（进度轨 + 字幕轨）与 8 个镜头子合成
  const writtenFiles = []
  const writeHtml = (relPath, content) => {
    const absPath = join(hfProjectDir, relPath)
    writeFileSync(absPath, content, 'utf8')
    writtenFiles.push({ relPath, absPath, content })
  }

  writeHtml('index.html', renderIndexHtml(renderPlan))
  writeHtml('compositions/overlay-rail.html', renderOverlayRailHtml(renderPlan))
  writeHtml('compositions/overlay-captions.html', renderOverlayCaptionsHtml(renderPlan))

  for (const shot of renderPlan.shots) {
    const html = renderSceneByLayout(shot, renderPlan)
    writeHtml(`compositions/${shot.shotId}.html`, html)
  }

  // 5. 静态审计：严禁出现任何禁用账号名/密码/待上线提示
  const forbidden = storyboard?.forbiddenVisibleText || [
    'doctor13',
    'zhangsan',
    'admin',
    'doctor01',
    'Yuzhua@2026',
    '演示视频即将上线',
  ]
  const leaks = auditGeneratedHtml(writtenFiles, forbidden)
  if (leaks.length > 0) {
    throw new Error(
      `生成模板命中敏感/禁用词：\n${leaks.map((h) => `  - ${h.file}: "${h.term}"`).join('\n')}`,
    )
  }

  return {
    hfProjectDir,
    fileCount: writtenFiles.length,
    files: writtenFiles.map((f) => f.relPath),
  }
}
