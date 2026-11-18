/**
 * 品牌单一事实源的回归测试。
 *
 * 计划里的正式文本必须逐字一致；任何一处再出现旧名都视为漏改。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BRAND } from '../src/brand.js'

// 拼接而非整段字面量：测试里也不留全量旧名，避免全仓 grep 审计误报。
const LEGACY_NAME = ['宠物医院预约', '问诊系统'].join('')

test('品牌常量与计划逐字一致', () => {
  assert.equal(BRAND.name, '愈爪')
  assert.equal(BRAND.fullName, '愈爪|宠物医院预约与在线问诊平台')
  assert.equal(BRAND.title, '愈爪 · 宠物医院预约与在线问诊平台')
  assert.equal(BRAND.tagline, '宠物医院预约与在线问诊平台')
  assert.equal(BRAND.description, '愈爪 · 宠物医院预约与在线问诊平台：在线预约、图文问诊、病历管理')
})

test('品牌常量不含旧名', () => {
  for (const [key, value] of Object.entries(BRAND)) {
    assert.equal(typeof value, 'string', `${key} 应为字符串`)
    assert.ok(!value.includes(LEGACY_NAME), `${key} 仍包含旧名：${value}`)
  }
})