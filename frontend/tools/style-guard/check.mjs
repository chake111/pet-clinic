#!/usr/bin/env node
/**
 * 样式护栏的命令行入口：读 frontend/src 下的 .css 与 .vue，跑 auditSources，按文件打印违规。
 *
 *   node tools/style-guard/check.mjs            正常检查，有违规则退出码 1
 *   node tools/style-guard/check.mjs --verbose  同时打印扫描到的文件数
 */
import { auditSources, collectSources } from './index.mjs'

const sources = collectSources()
const violations = auditSources(sources)

if (process.argv.includes('--verbose')) console.log(`扫描 ${sources.length} 个文件`)
if (!violations.length) {
  console.log('样式护栏通过')
  process.exit(0)
}
for (const v of violations) {
  console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.message}`)
}
console.error(`\n共 ${violations.length} 处违规`)
process.exit(1)
