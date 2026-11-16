/**
 * 样式护栏的单元测试与集成测试。
 *
 * 单元部分用字符串喂纯函数，覆盖解析器的边界（多 style 块、@media 嵌套、弹窗内表格、缺属性）；
 * 集成部分直接扫真实的 src —— 护栏通过才说明当前代码没有重新引入这四类漂移。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  TABLE_BUDGET,
  auditSources,
  collectSources,
  columnBudget,
  declaredProps,
  lineOf,
  extractStyleBlocks,
  extractTables,
  parseRules,
  parseTableColumns,
  stripComments
} from '../tools/style-guard/index.mjs'
import { DOCTOR_COLUMNS, hiddenColumns, visibleWidth } from '../src/utils/tableDensity.js'

const scratch = mkdtempSync(join(tmpdir(), 'style-guard-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

test('stripComments：注释被抹成空格，行号不位移', () => {
  const css = '.a { color: red; }\n/* 两行\n注释 */\n.b { color: blue; }'
  const out = stripComments(css)
  assert.equal(out.split('\n').length, css.split('\n').length)
  assert.ok(!out.includes('两行'))
  assert.ok(out.includes('.a { color: red; }'))
})

test('extractStyleBlocks：单块、多块与没有 style 的情况', () => {
  const single = '<template><div /></template>\n<style scoped>\n.a { color: red; }\n</style>'
  assert.equal(extractStyleBlocks(single).length, 1)
  assert.equal(extractStyleBlocks(single)[0].startLine, 3)

  const two = '<template><div /></template>\n<style>\n.a { color: red; }\n</style>\n<style scoped>\n.b { color: blue; }\n</style>'
  const blocks = extractStyleBlocks(two)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].startLine, 6)

  assert.deepEqual(extractStyleBlocks('<template><div /></template>'), [])
})

test('parseRules：普通规则、多选择器与 @media 里的规则', () => {
  const css = [
    '.page { display: flex; gap: 12px; }',
    '.a, .b { color: red; }',
    '@media (max-width: 600px) {',
    '  .top { padding: 0; }',
    '}'
  ].join('\n')
  const rules = parseRules(css)
  assert.equal(rules.length, 3)
  assert.equal(rules[0].selector, '.page')
  assert.equal(rules[2].selector, '.top')
  assert.match(rules[2].body, /padding/)
})

test('parseRules：忽略注释与只有容器的空块', () => {
  const css = '/* .ghost { color: red; } */\n@media print { }'
  assert.deepEqual(parseRules(css), [])
})

test('parseRules：行号随 lineOffset 偏移', () => {
  const rules = parseRules('.a { color: red; }', 12)
  assert.equal(rules[0].line, 12)
})

test('declaredProps：去重、忽略空段与没有冒号的片段', () => {
  const props = declaredProps('display: flex; gap: 12px; display: block; broken;')
  assert.deepEqual([...props], ['display', 'gap'])
  assert.deepEqual([...declaredProps('')], [])
})

test('parseTableColumns：width、min-width、两者并存与都没有', () => {
  const template = [
    '<el-table-column label="医生" min-width="164">',
    '<el-table-column label="经验" width="72" />',
    '<el-table-column label="操作" width="210" min-width="120" />',
    '<el-table-column label="无宽" />'
  ].join('')
  const columns = parseTableColumns(template)
  assert.equal(columns.length, 4)
  assert.deepEqual(columns.map((c) => c.width), [164, 72, 210, 0])
  assert.deepEqual(columns.map((c) => c.label), ['医生', '经验', '操作', '无宽'])
})

test('columnBudget：缺宽度的列按 0 计', () => {
  assert.equal(columnBudget([{ width: 100 }, { width: 0, minWidth: 40 }, { width: 60 }]), 200)
  assert.equal(columnBudget([]), 0)
})

test('extractTables：弹窗里的表格被标记出来', () => {
  const template = [
    '<el-table :data="rows">',
    '<el-table-column label="甲" width="100" />',
    '</el-table>',
    '<el-dialog>',
    '<el-table :data="detail">',
    '<el-table-column label="乙" width="200" />',
    '</el-table>',
    '</el-dialog>'
  ].join('')
  const tables = extractTables(template)
  assert.equal(tables.length, 2)
  assert.equal(tables[0].inDialog, false)
  assert.equal(tables[1].inDialog, true)
  assert.equal(tables[1].columns[0].label, '乙')
})

test('auditSources：.pc-page-heading 复活时报错', () => {
  const [violation] = auditSources([
    { path: 'src/views/client/MyOrders.vue', text: '<style>\n.pc-page-heading { font-size: 20px; }\n</style>' }
  ])
  assert.equal(violation.rule, 'page-title')
  assert.match(violation.message, /pc-page-heading/)
})

test('auditSources：页标题字号只允许在 main.css 声明', () => {
  const ok = auditSources([
    { path: 'src/styles/main.css', text: 'h1.pc-title { font-size: 24px; }' }
  ])
  assert.deepEqual(ok, [])

  const [bad] = auditSources([
    { path: 'src/views/client/DoctorList.vue', text: '<style>h1.pc-title { font-size: 23px; }</style>' }
  ])
  assert.equal(bad.rule, 'page-title')
})

test('auditSources：页面骨架只允许保留间距类覆盖', () => {
  const ok = auditSources([
    { path: 'src/views/admin/Dashboard.vue', text: '<style>.page { gap: 14px; }</style>' }
  ])
  assert.deepEqual(ok, [])

  const [bad] = auditSources([
    { path: 'src/views/admin/Users.vue', text: '<style>.page { display: flex; gap: 12px; }</style>' }
  ])
  assert.equal(bad.rule, 'admin-skeleton')
  assert.match(bad.message, /display/)
})

test('auditSources：骨架规则不误伤后代选择器与用户端', () => {
  const ok = auditSources([
    { path: 'src/views/admin/Appointments.vue', text: '<style>@media (max-width: 800px) { .filter > .el-select { flex: 1; } }</style>' },
    { path: 'src/views/client/Login.vue', text: '<style>.page { display: grid; }</style>' }
  ])
  assert.deepEqual(ok, [])
})

test('auditSources：表格列宽超出预算时报错，弹窗表格不计入', () => {
  const wide = `<el-table><el-table-column label="甲" width="${TABLE_BUDGET}" /><el-table-column label="乙" width="10" /></el-table>`
  const [bad] = auditSources([{ path: 'src/views/admin/Doctors.vue', text: wide }])
  assert.equal(bad.rule, 'table-budget')
  assert.match(bad.message, /超出/)

  const dialogTable = `<el-dialog><el-table><el-table-column label="甲" width="9999" /></el-table></el-dialog>`
  assert.deepEqual(auditSources([{ path: 'src/views/admin/Users.vue', text: dialogTable }]), [])
})

test('auditSources：外壳宽度写死时报错，用令牌则通过', () => {
  const [bad] = auditSources([
    { path: 'src/layouts/ClientLayout.vue', text: '<style>.top { padding: 10px calc((100% - 720px) / 2); }</style>' }
  ])
  assert.equal(bad.rule, 'shell-width')

  const ok = auditSources([
    { path: 'src/layouts/ClientLayout.vue', text: '<style>.top { padding: 10px max(var(--page-margin), calc((100% - var(--content-width)) / 2)); }</style>' }
  ])
  assert.deepEqual(ok, [])
})

test('auditSources：一次返回多处违规，且按文件顺序排列', () => {
  const violations = auditSources([
    { path: 'src/views/admin/A.vue', text: '<style>.page { display: flex; }</style>' },
    { path: 'src/views/admin/B.vue', text: '<style>.filter { padding: 12px; }</style>' }
  ])
  assert.equal(violations.length, 2)
  assert.equal(violations[0].file, 'src/views/admin/A.vue')
  assert.equal(violations[1].file, 'src/views/admin/B.vue')
})

test('collectSources：递归收集 css/vue，路径用 / 分隔', () => {
  const root = join(scratch, 'root')
  mkdirSync(join(root, 'src', 'views', 'admin'), { recursive: true })
  writeFileSync(join(root, 'src', 'styles.css'), '.a { color: red; }')
  writeFileSync(join(root, 'src', 'views', 'admin', 'A.vue'), '<template><div /></template>')
  writeFileSync(join(root, 'src', 'views', 'admin', 'note.md'), '忽略我')

  const sources = collectSources(root)
  assert.deepEqual(sources.map((s) => s.path).sort(), ['src/styles.css', 'src/views/admin/A.vue'])
  assert.ok(sources.every((s) => !s.path.includes('\\')))
})

test('auditSources：模板里写回 .pc-page-heading 也算复活', () => {
  const [violation] = auditSources([
    { path: 'src/views/client/MyOrders.vue', text: '<template>\n  <h1 class="pc-page-heading">我的预约</h1>\n</template>' }
  ])
  assert.equal(violation.rule, 'page-title')
  assert.equal(violation.line, 2)
})

test('auditSources：.pc-title 不带 h1 前缀同样不许声明字号', () => {
  const [violation] = auditSources([
    { path: 'src/views/client/Home.vue', text: '<style>.pc-title { font-size: 19px; }</style>' }
  ])
  assert.equal(violation.rule, 'page-title')
})

test('parseRules：字符串里的花括号不参与深度计算', () => {
  const rules = parseRules('.a { content: "{"; color: red; }\n.b { color: blue; }')
  assert.deepEqual(rules.map((r) => r.selector), ['.a', '.b'])
  assert.match(rules[0].body, /content: "\{"/)
})

test('parseRules：转义引号不会提前结束字符串', () => {
  const rules = parseRules('.a { content: "a\\"b{c}"; color: red; }')
  assert.equal(rules.length, 1)
  assert.match(rules[0].body, /color: red/)
})

test('lineOf：返回字面量首次出现的行号', () => {
  assert.equal(lineOf('a\nb\nc', 'c'), 3)
  assert.equal(lineOf('a\nb', 'zz'), 0)
})

test('auditSources：pageTitleFile 可换，便于检查别的入口文件', () => {
  const sources = [{ path: 'src/other.css', text: 'h1.pc-title { font-size: 24px; }' }]
  assert.equal(auditSources(sources).length, 1)
  assert.deepEqual(auditSources(sources, { pageTitleFile: 'src/other.css' }), [])
})

test('parseRules：多余的右括号不会让解析器崩掉', () => {
  assert.deepEqual(parseRules('}\n.a { color: red; }').map((r) => r.selector), ['.a'])
})

test('集成：真实 src 通过全部规则', () => {
  const violations = auditSources(collectSources())
  assert.deepEqual(violations, [], violations.map((v) => `${v.file}:${v.line} ${v.message}`).join('\n'))
})

test('集成：医生表与病历表都在预算内，且状态列留有余量', () => {
  const sources = collectSources()
  for (const file of ['src/views/admin/Doctors.vue', 'src/views/admin/Records.vue']) {
    const template = sources.find((s) => s.path === file).text
    const [table] = extractTables(template)
    const total = columnBudget(table.columns)
    assert.ok(total <= TABLE_BUDGET, `${file} 列宽 ${total} 超出 ${TABLE_BUDGET}`)
    assert.ok(total <= TABLE_BUDGET - 10, `${file} 列宽 ${total} 顶到预算上限，没有余量`)
  }
})

test('集成：医生表的密度阶梯在任意宽度下都放得下', () => {
  // 扫 450–1800 每一像素：切到更窄一档时，可见列必须立刻放得下，不允许有"过渡区"溢出。
  // 450 是最窄一档（医生 + 状态 + 操作）；再窄就取消固定操作列、整表横向滚动，见 Doctors.vue 的 pinActions。
  for (let width = 450; width <= 1800; width++) {
    const hidden = hiddenColumns(width)
    const shown = DOCTOR_COLUMNS.filter((c) => !hidden.has(c.key))
    const total = shown.reduce((sum, c) => sum + c.width, 0)
    assert.ok(total <= width, `容器 ${width}px 时可见列仍有 ${total}px，溢出 ${total - width}px`)
    assert.ok(shown.some((c) => c.key === 'status'), `容器 ${width}px 时状态列被收掉`)
    assert.ok(shown.some((c) => c.key === 'actions'), `容器 ${width}px 时操作列被收掉`)
  }
})

test('集成：密度阶梯里的列宽与 Doctors.vue 模板一致', () => {
  // 一处改了另一处没跟上，阶梯的算术就是错的；这条把两边钉在一起
  const template = collectSources().find((s) => s.path === 'src/views/admin/Doctors.vue').text
  const [table] = extractTables(template)
  assert.equal(table.columns.length, DOCTOR_COLUMNS.length)
  for (const [index, column] of DOCTOR_COLUMNS.entries()) {
    assert.equal(table.columns[index].label, column.label, `第 ${index + 1} 列应为 ${column.label}`)
    assert.equal(table.columns[index].minWidth || table.columns[index].width, column.width,
      `${column.label} 列宽在模板与 tableDensity.js 里不一致`)
    // 条件也要对上：把「问诊费」写成 hidden.has('rating') 时算术照样成立，只有肉眼能发现
    const cond = table.columns[index].cond
    if (cond) {
      const key = /hidden\.has\('([^']+)'\)/.exec(cond)?.[1]
      assert.equal(key, column.key, `${column.label} 列的 v-if 判断的是 ${key}，应为 ${column.key}`)
    } else {
      assert.ok(['doctor', 'status', 'actions'].includes(column.key),
        `${column.label} 列没有 v-if，只允许医生/状态/操作这样做`)
    }
  }
})

test('tableDensity：五档分别收起哪些列', () => {
  assert.equal(hiddenColumns(1200).size, 0)
  assert.deepEqual([...hiddenColumns(1000)].sort(), ['appointments', 'experience'])
  assert.deepEqual([...hiddenColumns(800)].sort(), ['appointments', 'experience', 'fee', 'rating'])
  assert.deepEqual([...hiddenColumns(720)].sort(), ['appointments', 'experience', 'fee', 'online', 'rating'])
  assert.equal(hiddenColumns(500).has('specialty'), true, '最窄一档应连擅长一起收')
  assert.equal(hiddenColumns(500).has('status'), false, '状态任何宽度都不收')
})

test('tableDensity：阶梯里写了也不许收掉医生、状态与操作', () => {
  const ladder = [{ min: 0, drop: ['doctor', 'status', 'actions', 'fee'] }]
  const hidden = hiddenColumns(300, ladder)
  assert.equal(hidden.has('status'), false, '状态是这张表最需要一眼读到的列')
  assert.equal(hidden.has('actions'), false, '操作列是唯一出口')
  assert.equal(hidden.has('doctor'), false, '医生列承载身份，同样不参与收起')
  assert.equal(hidden.has('fee'), true)
})

test('tableDensity：阶梯没有兜底档时回落到最后一档', () => {
  const ladder = [{ min: 1000, drop: [] }, { min: 800, drop: ['fee'] }]
  assert.equal(hiddenColumns(500, ladder).has('fee'), true)
  assert.equal(hiddenColumns(1200, ladder).size, 0)
})

test('tableDensity：visibleWidth 只累加可见列', () => {
  assert.equal(visibleWidth(1200), DOCTOR_COLUMNS.reduce((s, c) => s + c.width, 0))
  assert.equal(visibleWidth(1000), 1112 - 72 - 72)
  assert.equal(visibleWidth(500), 160 + 80 + 210)
})
