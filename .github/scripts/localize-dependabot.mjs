#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PREFIX = /^(build|chore)\((deps(?:-dev)?)\):\s*(.+)$/i

/** 把 Dependabot 的英文标题转成中文；不认识的原样返回 null。 */
export function localizeTitle(title) {
  const match = PREFIX.exec(title)
  if (!match) return null
  const [, kind, scope, rest] = match

  let group = /^bump the (.+?) group(?: across \d+ director(?:y|ies))? with (\d+) updates?$/i.exec(rest)
  if (group) return `${kind}(${scope}): 升级 ${group[1]} 组的 ${group[2]} 个依赖`

  let range = /^bump (.+?) from (.+?) to (.+)$/i.exec(rest)
  if (range) return `${kind}(${scope}): 将 ${range[1]} 从 ${range[2]} 升级到 ${range[3]}`

  let target = /^bump (.+?) to (.+)$/i.exec(rest)
  if (target) return `${kind}(${scope}): 将 ${target[1]} 升级到 ${target[2]}`

  return null
}

function main() {
  const pr = process.env.PR_NUMBER
  const repo = process.env.REPO
  const title = process.env.TITLE

  if (!pr || !repo || !title) {
    console.error('缺少 PR_NUMBER / REPO / TITLE')
    process.exit(1)
  }

  const localized = localizeTitle(title)
  if (!localized) {
    console.log(`未匹配 Dependabot 标题，保持原样: ${title}`)
    process.exit(0)
  }
  if (localized === title) {
    console.log(`标题已是中文: ${title}`)
    process.exit(0)
  }

  execFileSync('gh', ['pr', 'edit', pr, '--repo', repo, '--title', localized], { stdio: 'inherit' })
  console.log(`${title} -> ${localized}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}