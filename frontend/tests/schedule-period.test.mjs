import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reactive, ref, computed } from 'vue'

// 执行页面实际的表单逻辑；接口替身记录提交，避免写入业务数据。
const source = readFileSync(new URL('../src/views/admin/Schedules.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '')
const calls = []
const warnings = []
const bindings = {
  reactive, ref, computed, onMounted: () => {}, today: () => '2099-01-01',
  PERIOD: {}, text: (_, p) => ['','上午','下午','夜间'][p],
  ElMessage: { warning: (m) => warnings.push(m), success: () => {} },
  schedulePage: async () => ({ records: [], total: 0 }),
  createSchedule: async (f) => calls.push(['create', f]),
  updateSchedule: async (id, f) => calls.push(['update', f]),
  batchSchedule: async (f) => { calls.push(['batch', f]); return { created: 1, skipped: 0 } }
}
const page = new Function(...Object.keys(bindings), script + '\nreturn { form, batch, editing, periodRange, periodError, onPeriod, openEdit, submit, submitBatch, addPeriod, booked }')(...Object.values(bindings))

for (const [period, startTime, endTime] of [[1, '08:00:00', '12:00:00'], [2, '13:00:00', '18:00:00'], [3, '18:00:00', '22:00:00']]) {
  assert.deepEqual(page.periodRange(period), [startTime, endTime])
  assert.equal(page.periodError({ period, startTime, endTime }), '')
  assert.ok(page.periodError({ period, startTime: '07:59:59', endTime }))
  assert.ok(page.periodError({ period, startTime, endTime: '22:00:01' }))
  assert.ok(page.periodError({ period, startTime, endTime: startTime }))
}
page.form.doctorId = 1
Object.assign(page.form, { startTime: '14:00:00', endTime: '16:00:00' })
await page.submit()
assert.equal(calls.length, 0)
assert.match(warnings.at(-1), /08:00–12:00/)

page.openEdit({ id: 9, doctorId: 1, workDate: '2020-01-01', period: 1, startTime: '14:00:00', endTime: '16:00:00', totalNum: 20, status: 1 })
page.form.totalNum = 25
await page.submit()
assert.equal(calls.at(-1)[0], 'update')
assert.equal(calls.at(-1)[1].startTime, '14:00:00')
// 编辑请求体不含 status：停诊位只由 /stop 与 /resume 写。带上虽然服务端会忽略，
// 但会让人误以为编辑弹窗能改状态——H1 的前端半边就靠这条钉住。
assert.ok(!('status' in calls.at(-1)[1]), '编辑请求体不应包含 status 字段')
assert.equal(page.form.status, 1, 'openEdit 不应回填排班状态')
page.form.startTime = '13:30:00'
const before = calls.length
await page.submit()
assert.equal(calls.length, before)
page.form.period = 2
page.onPeriod(2)
assert.equal(page.form.startTime, '13:30:00')
assert.equal(page.form.endTime, '17:30:00')
await page.submit()
assert.equal(calls.length, before + 1)
page.onPeriod(3)
assert.equal(page.form.startTime, '18:00:00')
assert.equal(page.form.endTime, '21:30:00')

Object.assign(page.batch, { doctorId: 1, endDate: '2099-01-01', periods: [{ period: 1, startTime: '14:00:00', endTime: '16:00:00', totalNum: 20 }] })
const beforeBatch = calls.length
await page.submitBatch()
assert.equal(calls.length, beforeBatch)
Object.assign(page.batch.periods[0], { startTime: '08:00:00', endTime: '12:00:00' })
await page.submitBatch()
assert.equal(calls.at(-1)[0], 'batch')
page.addPeriod()
page.addPeriod()
page.addPeriod()
assert.deepEqual(page.batch.periods.map((p) => p.period), [1, 2, 3])
page.batch.periods.splice(1, 1)
page.addPeriod()
assert.deepEqual(page.batch.periods.map((p) => p.period), [1, 3, 2])
const optionDisabled = source.match(/:disabled="(batch\.periods\.some[^"\n]+)"/)[1]
const isDisabled = new Function('batch', 'p', 'o', 'return ' + optionDisabled)
assert.equal(isDisabled(page.batch, page.batch.periods[0], { value: 1 }), false)
assert.equal(isDisabled(page.batch, page.batch.periods[0], { value: 2 }), true)
page.batch.periods[1] = { ...page.batch.periods[0] }
const beforeDuplicate = calls.length
await page.submitBatch()
assert.equal(calls.length, beforeDuplicate)
assert.equal(warnings.at(-1), '每个时段只能配置一次')
const minExpression = source.match(/v-model="form.totalNum" :min="([^"]+)"/)[1]
const minimum = new Function('editing', 'booked', 'return ' + minExpression)
assert.equal(minimum(null, page.booked), 1)
assert.equal(minimum({ totalNum: 20, remainNum: 20 }, page.booked), 1)
assert.equal(minimum({ totalNum: 20, remainNum: 17 }, page.booked), 3)
console.log('schedule-period passed: boundaries, switching, legacy edits, batch uniqueness, capacity minimum')
