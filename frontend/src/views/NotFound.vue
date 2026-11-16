<script setup>
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <main class="pc-narrow lost">
    <h1 class="big">404</h1>
    <p>页面不存在或已失效</p>
    <el-button type="primary" @click="router.push('/')">回到首页</el-button>
    <p class="pc-muted">
      后台入口：<router-link to="/admin" class="lnk">/admin</router-link>
    </p>
  </main>
</template>

<style scoped>
.lost {
  padding-top: 64px;
  text-align: center;
}

.big {
  margin: 0;
  font-size: 64px;
  font-weight: 800;
  letter-spacing: 2px;
  color: var(--color-primary-soft);
  text-shadow: 0 2px 0 var(--color-primary-disabled);
}

.lnk {
  color: var(--color-ink);
  text-decoration: underline;
}
</style>
