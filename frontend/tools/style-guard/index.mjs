/**
 * 样式护栏：把"已经修过一次、还会再漂"的四条约定写成可执行断言。
 *
 *   1. 页标题只有一档：h1.pc-title 只在 main.css 声明字号，.pc-page-heading 不得复活；
 *   2. 后台页面骨架不复制：views/admin 里不再重写 .page / .filter / .pager 的布局属性；
 *   3. 表格列宽在预算内：任何后台表格的列宽合计不得超过 1440 视口下的可用宽度；
 *   4. 内容栏只有一个来源：外壳宽度必须由 --content-width / --page-margin 推导，不写死 720/760。
 *
 * 这里只做结构判断，不理解视觉；需要看画面时用 frontend/tests 下的浏览器脚本。
 * 纯函数与 IO 分离：auditSources 收 [{ path, text }]，CLI 负责读盘，测试可以直接喂字符串。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 默认扫描根目录：frontend/。 */
export const DEFAULT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 递归收集 .css / .vue，路径统一成 posix 形式，供规则按前缀判断。 */
export function collectSources(root = DEFAULT_ROOT) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(css|vue)$/.test(entry)) {
        out.push({ path: relative(root, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(join(root, 'src'))
  return out
}

/** 1440 视口下后台表格的真实可用宽度：1440 - 216 侧栏 - 主区与卡片的内边距（量测值）。 */
export const TABLE_BUDGET = 1142

/** 判断"页面骨架是否重复实现"时，允许页面保留的属性：只有间距与宽度这类真差异。 */
const ALLOWED_PAGE_PROPS = new Set(['gap', 'max-width', 'align-self'])

/** 去掉 CSS 注释，避免注释里的例子被当成真实声明。 */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
}

/** 取出 .vue 里所有 <style> 块，保留起始行号用于报错定位（行号指向第一行 CSS，不是 <style> 标签）。 */
export function extractStyleBlocks(source) {
  const blocks = []
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/g
  let match
  while ((match = re.exec(source))) {
    const raw = match[1]
    const head = source.slice(0, match.index + match[0].indexOf(raw))
    const lead = raw.startsWith('\n') ? 1 : 0
    blocks.push({ css: lead ? raw.slice(1) : raw, startLine: head.split('\n').length + lead })
  }
  return blocks
}

/** 把一段 CSS 拆成规则列表；@media 等嵌套块里的规则也会收进来（选择器取最内层）。 */
export function parseRules(css, lineOffset = 1) {
  const text = stripComments(css)
  const rules = []
  const stack = []
  let buffer = ''
  let line = lineOffset
  let quote = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\n') line++
    // 引号里的花括号属于字符串值（content: "{"），不参与深度计算
    if (quote) {
      if (char === '\\') {
        buffer += char + (text[index + 1] ?? '')
        index++
        continue
      }
      if (char === quote) quote = ''
      buffer += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      buffer += char
      continue
    }
    if (char === '{') {
      stack.push(buffer.trim())
      buffer = ''
      continue
    }
    if (char === '}') {
      const selector = stack.pop() ?? ''
      // 只收真正带声明的规则；@media 这类容器块出栈时 buffer 已空
      if (selector && !selector.startsWith('@') && buffer.trim()) {
        rules.push({ selector, body: buffer.trim(), line })
      }
      buffer = ''
      continue
    }
    buffer += char
  }
  return rules
}

/** 找出一段文本里某个字面量首次出现的行号，用于模板侧的报错定位。 */
export function lineOf(text, needle) {
  const index = text.indexOf(needle)
  return index < 0 ? 0 : text.slice(0, index).split('\n').length
}

/** 取出一条规则体里声明过的属性名（去重，小写）。 */
export function declaredProps(body) {
  const props = new Set()
  for (const chunk of body.split(';')) {
    const index = chunk.indexOf(':')
    if (index > 0) props.add(chunk.slice(0, index).trim().toLowerCase())
  }
  return props
}

/** 从模板里读 el-table-column 的列宽；min-width 也计入预算，因为它在窄屏就是实际宽度。
 *  cond 记录 v-if 的条件名，用来按视口档位分别核算（例如 wide / roomy）。 */
export function parseTableColumns(template) {
  const columns = []
  const re = /<el-table-column\b([^>]*?)\/?>/g
  let match
  while ((match = re.exec(template))) {
    const attrs = match[1]
    const label = /label="([^"]*)"/.exec(attrs)?.[1] ?? ''
    const width = Number(/[^-]width="(\d+)"/.exec(attrs)?.[1] ?? 0)
    const minWidth = Number(/min-width="(\d+)"/.exec(attrs)?.[1] ?? 0)
    const cond = /v-if="([^"]*)"/.exec(attrs)?.[1] ?? null
    columns.push({ label, width: width || minWidth, minWidth, cond })
  }
  return columns
}

/**
 * 按 <el-table> 分块，弹窗里的表格单独标记：它们跑在受限容器里，不占页面宽度预算。
 * @returns {{columns: {label: string, width: number, minWidth: number}[], inDialog: boolean}[]}
 */
export function extractTables(template) {
  const dialogs = []
  const dialogRe = /<el-dialog\b[\s\S]*?<\/el-dialog>/g
  let dialogMatch
  while ((dialogMatch = dialogRe.exec(template))) {
    dialogs.push([dialogMatch.index, dialogMatch.index + dialogMatch[0].length])
  }

  const tables = []
  const tableRe = /<el-table\b[\s\S]*?<\/el-table>/g
  let match
  while ((match = tableRe.exec(template))) {
    const inDialog = dialogs.some(([start, end]) => match.index >= start && match.index < end)
    tables.push({ columns: parseTableColumns(match[0]), inDialog })
  }
  return tables
}

/** 列宽合计：有 width 用 width，否则用 min-width，两者都没有按 0 计。 */
export function columnBudget(columns) {
  return columns.reduce((sum, column) => sum + (column.width || column.minWidth || 0), 0)
}

/**
 * 对一组源文件跑全部规则。
 * @param {{path: string, text: string}[]} sources 路径相对仓库 frontend 目录，用 / 分隔
 * @param {{budget?: number, pageTitleFile?: string}} [options]
 * @returns {{rule: string, file: string, line: number, message: string}[]}
 */
export function auditSources(sources, options = {}) {
  const budget = options.budget ?? TABLE_BUDGET
  const pageTitleFile = options.pageTitleFile ?? 'src/styles/main.css'
  const violations = []
  const report = (rule, file, line, message) => violations.push({ rule, file, line, message })

  for (const { path, text } of sources) {
    const isVue = path.endsWith('.vue')
    const styles = isVue ? extractStyleBlocks(text) : [{ css: text, startLine: 1 }]

    // 规则 1 之模板侧：类名写回模板里也算复活，不只查 <style>
    if (text.includes('pc-page-heading')) {
      report('page-title', path, lineOf(text, 'pc-page-heading'), '页标题只走 h1.pc-title 一档，.pc-page-heading 已废弃')
    }

    for (const block of styles) {
      for (const rule of parseRules(block.css, block.startLine)) {
        const selector = rule.selector.replace(/\s+/g, ' ')

        // 规则 1 之样式侧：页标题字号只允许出现在 main.css，且不限于 h1 前缀
        if (/\.pc-title\b/.test(selector) && declaredProps(rule.body).has('font-size') && path !== pageTitleFile) {
          report('page-title', path, rule.line, '页标题字号只在 main.css 的 h1.pc-title 声明，页面不要再覆写')
        }

        // 规则 2：后台页面骨架不复制（只认 .page / .filter / .pager 本身，后代选择器不算）
        if (path.startsWith('src/views/admin/')) {
          const skeleton = /^\.(page|filter|pager)(?:\[[^\]]*\])?(?::[\w-]+)?$/.exec(selector)
          if (skeleton) {
            const extra = [...declaredProps(rule.body)].filter((prop) => !ALLOWED_PAGE_PROPS.has(prop))
            if (extra.length) {
              report('admin-skeleton', path, rule.line,
                `.${skeleton[1]} 的布局属性由 admin.css 的公共骨架提供，页面里不应再写 ${extra.join('、')}`)
            }
          }
        }

        // 规则 4：外壳宽度不写死
        const literal = /\(\s*100%\s*-\s*\d{3}px\s*\)/.exec(rule.body) || /max-width:\s*(7[0-9]{2})px/.exec(rule.body)
        if (literal && /\.(top|tabs|pc-cta-bar|pc-narrow)\b/.test(selector)) {
          report('shell-width', path, rule.line,
            `外壳宽度要从 --content-width / --page-margin 推导，不要写死 ${literal[1] ?? literal[0]}`)
        }
      }
    }

    // 规则 3：表格列宽预算（只算页面上的表格，弹窗内的表格在受限容器里各自排版）
    if (isVue && text.includes('<el-table')) {
      for (const table of extractTables(text)) {
        if (table.inDialog) continue
        const total = columnBudget(table.columns)
        if (total > budget) {
          report('table-budget', path, 1,
            `表格列宽合计 ${total}px 超出 ${budget}px 预算 ${total - budget}px；状态列会被固定操作列压住`)
        }
      }
    }
  }

  return violations
}
