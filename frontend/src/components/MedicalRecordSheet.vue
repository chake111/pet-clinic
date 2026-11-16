<script setup>
import { computed } from 'vue'
import { toDate } from '@/utils/format'
import { medicalRecordBlocks } from '@/utils/medicalRecord'
import ImageGallery from '@/components/ImageGallery.vue'

const props = defineProps({ record: { type: Object, required: true } })
const blocks = computed(() => {
  const content = medicalRecordBlocks(props.record)
  return [...content.filter(b => b.strong), ...content.filter(b => !b.strong)]
})
const images = computed(() => (props.record.images || '').split(',').filter(Boolean))
</script>

<template>
  <article class="record-sheet" aria-label="电子病历">
    <header class="sheet-heading">
      <h1>电子病历</h1>
      <p><span>病历号</span><span class="record-number">{{ record.recordNo }}</span></p>
    </header>

    <div class="patient">
      <el-avatar :size="40" shape="square" :src="record.petAvatar" alt="">
        {{ record.petName?.[0] || '宠' }}
      </el-avatar>
      <div>
        <h2>{{ record.petName || '已删除的宠物' }}</h2>
        <p>{{ [record.petSpecies, record.petBreed].filter(Boolean).join(' · ') || '品种未填' }}</p>
      </div>
    </div>
    <dl class="record-meta">
      <div><dt>就诊日期</dt><dd>{{ toDate(record.visitDate) }}</dd></div>
      <div><dt>接诊医生</dt><dd>{{ record.doctorName }}<span v-if="record.doctorTitle" class="doctor-title">{{ record.doctorTitle }}</span></dd></div>
      <div><dt>就诊科室</dt><dd>{{ record.departmentName }}</dd></div>
    </dl>

    <section v-for="b in blocks" :key="b.label" class="record-section" :class="{ diagnosis: b.strong }">
      <h2>{{ b.label }}</h2>
      <p>{{ b.value }}</p>
    </section>

    <section v-if="images.length" class="record-section">
      <h2>检查影像</h2>
      <ImageGallery :urls="images" :size="92" label="检查影像" />
    </section>

    <section v-if="record.nextVisitDate" class="record-followup">
      <div><h2>建议复诊</h2><p>{{ toDate(record.nextVisitDate) }} 回院复查</p></div>
      <slot name="followup-action" />
    </section>
    <footer v-if="record.createTime" class="sheet-footer">开具日期 {{ toDate(record.createTime) }}</footer>
  </article>
</template>

<style scoped>
.record-sheet { container-type: inline-size; width: 100%; min-width: 0; padding: 32px; background: var(--color-canvas); border: 1px solid var(--color-hairline); border-radius: var(--radius-md); color: var(--color-ink); overflow-wrap: anywhere; }
.sheet-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px 24px; flex-wrap: wrap; padding-bottom: 20px; border-bottom: 2px solid var(--color-ink); }
.sheet-heading h1 { margin: 0; font-size: 24px; font-weight: 650; line-height: 1.4; }
.sheet-heading p { display: flex; flex-wrap: wrap; gap: 4px 8px; margin: 0; color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.record-number { font-family: ui-monospace, Menlo, Consolas, monospace; }
.patient { display: flex; align-items: center; gap: 12px; margin-top: 24px; }
.patient .el-avatar { flex-shrink: 0; background: var(--color-surface-strong); color: var(--color-muted); }
.patient > div { min-width: 0; }
.patient h2 { margin: 0; font-size: 20px; line-height: 1.4; font-weight: 600; }
.patient p { margin: 4px 0 0; color: var(--color-muted); font-size: 14px; line-height: 1.6; }
.record-meta { display: grid; grid-template-columns: 1fr 1.4fr 1fr; gap: 16px; margin: 20px 0 0; padding-bottom: 24px; }
.record-meta dt { font-size: 14px; color: var(--color-muted); line-height: 1.6; }
.record-meta dd { margin: 4px 0 0; font-size: 15px; line-height: 1.7; }
.doctor-title { display: block; color: var(--color-muted); font-size: 14px; }
.record-section { padding: 22px 0; border-top: 1px solid var(--color-hairline-soft); }
.record-section h2, .record-followup h2 { margin: 0 0 8px; color: var(--color-muted); font-size: 14px; line-height: 1.6; font-weight: 500; }
.record-section p { margin: 0; white-space: pre-wrap; font-size: 16px; line-height: 1.75; }
.record-section.diagnosis { padding: 20px; margin: 0 0 8px; background: var(--color-surface-soft); border-top: 2px solid var(--color-ink); }
.diagnosis h2 { color: var(--color-ink); font-weight: 600; }
.diagnosis p { font-size: 18px; font-weight: 600; line-height: 1.7; }
.diagnosis + .record-section { border-top: 0; }
.record-followup { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 20px 0; border-top: 1px solid var(--color-hairline); }
.record-followup h2 { color: var(--color-ink); margin-bottom: 4px; font-weight: 600; }
.record-followup p { margin: 0; font-size: 16px; line-height: 1.7; }
.sheet-footer { padding-top: 16px; border-top: 1px solid var(--color-hairline-soft); font-size: 13px; line-height: 1.6; color: var(--color-muted); }
@media (max-width: 540px) {
  .record-sheet { padding: 20px; }
  .sheet-heading { gap: 8px; padding-bottom: 16px; }
  .sheet-heading h1 { font-size: 22px; }
  .record-meta { grid-template-columns: 1fr 1fr; gap: 16px 12px; }
  .record-section { padding: 20px 0; }
  .record-section.diagnosis { padding: 16px; }
}
@media (max-width: 300px) {
  .record-sheet { padding: 12px; }
  .record-meta { grid-template-columns: 1fr; }
}
@container (max-width: 260px) {
  .record-meta { grid-template-columns: 1fr; }
  .record-section.diagnosis { padding: 12px; }
}
@media print {
  @page { size: A4; margin: 15mm; }
  .record-sheet { max-width: none; border: 0; border-radius: 0; padding: 0; }
  .sheet-heading, .patient, .record-meta, .record-followup { break-inside: avoid; }
  .record-section h2 { break-after: avoid; }
  .record-section p { orphans: 3; widows: 3; }
  .record-section { padding: 14px 0; }
  .record-section p { font-size: 14px; }
  .record-section.diagnosis { background: transparent; }
}
</style>
