<script setup>
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { recordDetail } from '@/api/admin'
import MedicalRecordSheet from '@/components/MedicalRecordSheet.vue'
import LoadFailure from '@/components/LoadFailure.vue'

const route = useRoute()
const router = useRouter()
const row = ref(null)
const loading = ref(true)

const failed = ref(false)

async function load() {
  loading.value = true
  failed.value = false
  try {
    row.value = await recordDetail(Number(route.params.id))
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

const print = () => window.print()

onMounted(load)
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="bar">
      <el-page-header title="返回" @back="router.back()" />
      <div class="actions" v-if="row && !failed">
        <el-button @click="router.push(`/admin/appointment/${row.appointmentId}`)">关联预约单</el-button>
        <el-button type="primary" @click="print">打印病历</el-button>
      </div>
    </div>
    <LoadFailure v-if="failed" @retry="load" />
    <MedicalRecordSheet v-else-if="row" class="sheet" :record="row" />
    <el-empty v-else-if="!loading" description="暂无病历内容" />
  </div>
</template>

<style scoped>
.page { gap: 20px; }
.bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; width: 100%; max-width: 820px; margin: 0 auto; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.actions .el-button { margin: 0; }
.sheet { width: 100%; max-width: 820px; margin: 0 auto; }
@media screen {
  .sheet { padding: 24px; }
  .sheet :deep(.patient) { margin-top: 16px; }
  .sheet :deep(.record-meta) { margin-top: 16px; padding-bottom: 16px; }
  .sheet :deep(.record-section) { padding: 14px 0; }
  .sheet :deep(.record-section.diagnosis) { padding: 16px; }
  .sheet :deep(.record-followup) { padding: 14px 0; }
}
@media print {
  .bar { display: none; }
  .sheet { max-width: none; }
}
</style>
