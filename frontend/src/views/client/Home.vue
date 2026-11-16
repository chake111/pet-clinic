<script setup>
import { loadWithSavedScroll } from '@/utils/listScroll'
import LoadFailure from '@/components/LoadFailure.vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { homeData } from '@/api/user'
import { NOTICE_TYPE, text } from '@/utils/dict'
import { toDate } from '@/utils/format'
import DoctorCard from '@/components/DoctorCard.vue'
import DeptIcon from '@/components/DeptIcon.vue'

/**
 * 首页。后端把科室、推荐医生、公告打包在一个接口里返回，
 * 首屏一次请求就能画完。未登录也可浏览（需求 G3）。
 */
const router = useRouter()
const failed = ref(false)
const loading = ref(true)
const keyword = ref('')
const showAllDepartments = ref(false)
const data = reactive({ departments: [], doctors: [], notices: [] })
const visibleDepartments = computed(() => showAllDepartments.value ? data.departments : data.departments.slice(0, 6))

async function load() {
  loading.value = true
  failed.value = false
  try {
    const res = await homeData()
    Object.assign(data, { departments: [], doctors: [], notices: [] }, res || {})
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

function search() {
  router.push({ path: '/doctors', query: keyword.value.trim() ? { keyword: keyword.value.trim() } : {} })
}

const byDept = (d) => router.push({ path: '/doctors', query: { departmentId: d.id, name: d.name } })

onMounted(() => loadWithSavedScroll(load))
</script>

<template>
  <div class="pc-narrow home" v-loading="loading">
    <LoadFailure v-if="failed" @retry="load" />
    <section class="hero">
      <h1>为爱宠，找到合适的医生</h1>
      <el-input v-model="keyword" placeholder="医生姓名或擅长领域" aria-label="搜索医生"
                clearable size="large" @keyup.enter="search" @clear="search">
        <template #prefix><el-icon><Search /></el-icon></template>
        <template #append>
          <el-button icon="Search" @click="search">搜索</el-button>
        </template>
      </el-input>
    </section>

    <h2 class="pc-section-title">
      就诊科室
      <el-button v-if="data.departments.length > 6" class="more" link
                 :aria-expanded="showAllDepartments" aria-controls="home-departments"
                 @click="showAllDepartments = !showAllDepartments">
        {{ showAllDepartments ? '收起科室' : '全部科室' }}
      </el-button>
    </h2>
    <div id="home-departments" class="depts">
      <button v-for="d in visibleDepartments" :key="d.id" class="dept" @click="byDept(d)">
        <span class="ico"><DeptIcon :name="d.icon" :size="26" /></span>
        <span class="nm">{{ d.name }}</span>
      </button>
    </div>
    <div v-if="!failed && !loading && !data.departments.length" class="pc-empty">暂无就诊科室</div>

    <div class="quick">
      <router-link to="/me/orders"><el-icon><Tickets /></el-icon><span>我的预约</span><el-icon class="arrow"><ArrowRight /></el-icon></router-link>
      <router-link to="/consult"><el-icon><ChatDotRound /></el-icon><span>在线问诊</span><el-icon class="arrow"><ArrowRight /></el-icon></router-link>
    </div>

    <h2 class="pc-section-title">
      推荐医生
      <el-link class="more" underline="never" @click="router.push('/doctors')">查看全部 →</el-link>
    </h2>
    <div class="doctors">
      <DoctorCard v-for="d in data.doctors" :key="d.id" :doctor="d" />
      <el-empty v-if="!failed && !loading && !data.doctors.length" description="暂无出诊医生" />
    </div>

    <h2 class="pc-section-title">
      公告与养宠科普
      <el-link class="more" underline="never" @click="router.push('/notices')">更多 →</el-link>
    </h2>
    <div class="notices pc-card">
      <router-link v-for="n in data.notices" :key="n.id" :to="`/notice/${n.id}`" class="notice">
        <span class="tt">
          <em v-if="n.topFlag === 1" class="top">置顶</em>
          {{ n.title }}
        </span>
        <span class="meta">
          <i>{{ text(NOTICE_TYPE, n.type) }}</i>
          <i>{{ toDate(n.publishTime || n.createTime) }}</i>
        </span>
      </router-link>
      <div v-if="!failed && !loading && !data.notices.length" class="pc-empty">暂无公告</div>
    </div>
  </div>
</template>

<style scoped>
/* A 方向：搜索、科室和医生沿同一阅读轴展开。 */
.home { padding: 20px var(--page-margin) 32px; }
.hero { color: var(--color-ink); animation: home-enter .3s var(--ease); }
.hero h1 { margin: 0 0 16px; font-size: 23px; font-weight: 700; line-height: 1.4; text-wrap: balance; }
.hero :deep(.el-input__wrapper) { min-height: 48px; border-radius: var(--radius-md) 0 0 var(--radius-md); }
.hero :deep(.el-input-group__append) { padding-inline: 16px; border-radius: 0 var(--radius-md) var(--radius-md) 0; }
.hero :deep(.el-input-group__append .el-button) { transition: transform .15s var(--ease); }
.hero :deep(.el-input-group__append .el-button:active) { transform: scale(.96); }
.depts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 4px; padding: 8px; background: var(--color-canvas); border-radius: var(--radius-lg); }
.depts:empty { display: none; }
.dept { min-width: 0; min-height: 56px; padding: 6px 2px; border: 0; background: transparent; border-radius: var(--radius-sm); cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; transition: background-color .18s var(--ease), transform .18s var(--ease); }
.ico { display: grid; place-items: center; }
.nm { font-size: 13px; color: var(--color-body); line-height: 1.5; overflow-wrap: anywhere; }
.quick { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 10px; padding: 4px 0 8px; border-bottom: 1px solid var(--color-hairline-soft); }
.quick a { min-width: 0; min-height: 40px; display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 2px; font-size: 14px; border-radius: var(--radius-xs); transition: background-color .18s var(--ease); }
.quick a + a { border-left: 1px solid var(--color-hairline); padding-left: 16px; }
.quick .el-icon { font-size: 21px; flex-shrink: 0; }
.quick .arrow { margin-left: auto; font-size: 13px; color: var(--color-muted); }
.dept:active { transform: scale(.96); }
/* 焦点沿用 ink：聚焦不是动作，不能每次 Tab 都亮一次主 CTA 的红 */
.dept:focus-visible, .quick a:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; }
@media (hover: hover) and (pointer: fine) {
  .dept:hover, .quick a:hover { background: var(--color-surface-strong); }
}
@keyframes home-enter { from { opacity: .7; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) {
  .hero { animation: none; }
  .dept, .quick a, .hero :deep(.el-input-group__append .el-button) { transition: none; }
}
@media (max-width: 359px) { .home { padding-inline: 16px; } .hero h1 { font-size: 21px; } }
.more { margin-left: auto; font-size: var(--font-label); font-weight: 400; }
.doctors { display: grid; gap: 12px; }

.notices { padding: 0; border: 0; border-radius: 0; background: transparent; }
.notice {
  display: flex; flex-direction: column; align-items: stretch; justify-content: space-between; gap: 12px;
  padding: 12px 0; border-bottom: 1px solid var(--color-hairline-soft);
}
.notice:last-child { border-bottom: none; }
.tt { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; line-height: 1.65; }
.top {
  font-style: normal; font-size: 12px; color: var(--color-on-primary); background: var(--color-ink);
  border-radius: var(--radius-xs); padding: 1px 4px; margin-right: 4px;
}
.meta { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--color-muted); flex-shrink: 0; }
.meta i { font-style: normal; }

@media (min-width: 560px) {
  .depts { grid-template-columns: repeat(6, minmax(0, 1fr)); }
}
</style>
