// node tests/idempotencyKey.test.mjs
//
// 幂等键只用于服务端去重：有 crypto.randomUUID 时原样使用；
// 老浏览器的兜底结果也必须落在后端要求的 [A-Za-z0-9._:-]{8,64} 内。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newIdempotencyKey } from '../src/utils/idempotencyKey.js'

const PATTERN = /^[A-Za-z0-9._:-]{8,64}$/

test('优先使用 crypto.randomUUID', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  assert.equal(newIdempotencyKey({ randomUUID: () => uuid }), uuid)
})

test('没有 randomUUID 时走兜底，字符集与长度符合服务端校验', () => {
  assert.match(newIdempotencyKey({}), PATTERN)
})

test('连续两次兜底结果不同，且不超过 64 字符', () => {
  const first = newIdempotencyKey({})
  const second = newIdempotencyKey({})
  assert.notEqual(first, second)
  assert.ok(first.length <= 64 && second.length <= 64)
})