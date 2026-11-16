<script setup>
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/client'
import LoginForm from '@/components/LoginForm.vue'

const store = useUserStore()
const route = useRoute()
const router = useRouter()

function onLoginSuccess() {
  ElMessage.success('欢迎回来')
  router.replace(route.query.redirect || '/')
}
</script>

<template>
  <LoginForm :login="store.login" :on-success="onLoginSuccess">
    <span>还没有账号？<router-link to="/register" class="lnk">注册一个</router-link></span>
    <router-link to="/doctors" class="lnk">先浏览医生</router-link>
    <template #switch>
      <router-link to="/admin/login" class="lnk">医生与管理员登录 <span aria-hidden="true">→</span></router-link>
    </template>
  </LoginForm>
</template>
