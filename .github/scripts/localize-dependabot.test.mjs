import test from 'node:test'
import assert from 'node:assert/strict'
import { localizeTitle } from './localize-dependabot.mjs'

test('分组更新', () => {
  assert.equal(
    localizeTitle('build(deps): bump the github-actions group with 2 updates'),
    'build(deps): 升级 github-actions 组的 2 个依赖'
  )
})

test('分组更新，带目录数量', () => {
  assert.equal(
    localizeTitle('build(deps): bump the github-actions group across 1 directory with 2 updates'),
    'build(deps): 升级 github-actions 组的 2 个依赖'
  )
})

test('单个依赖，带版本区间', () => {
  assert.equal(
    localizeTitle('build(deps): bump actions/checkout from 6.1.0 to 7.0.1'),
    'build(deps): 将 actions/checkout 从 6.1.0 升级到 7.0.1'
  )
})

test('单个依赖，只有目标版本', () => {
  assert.equal(
    localizeTitle('chore(deps-dev): bump vite to 6.0.0'),
    'chore(deps-dev): 将 vite 升级到 6.0.0'
  )
})

test('已经是中文时返回 null', () => {
  assert.equal(localizeTitle('build(deps): 升级 github-actions 组的 2 个依赖'), null)
})

test('不认识的格式返回 null', () => {
  assert.equal(localizeTitle('fix: something else'), null)
})