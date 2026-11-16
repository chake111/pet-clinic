<script setup>
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAdminStore } from '@/stores/admin'
import LoginForm from '@/components/LoginForm.vue'

const store = useAdminStore()
const route = useRoute()
const router = useRouter()

function onLoginSuccess(vo) {
  ElMessage.success(`欢迎，${vo.name || vo.username}`)
  router.replace(route.query.redirect || (vo.role === 'DOCTOR' ? '/admin/appointments' : '/admin/dashboard'))
}
</script>

<template>
  <LoginForm staff :login="store.login" :on-success="onLoginSuccess">
    <template #switch>
      <router-link to="/" class="lnk"><span aria-hidden="true">←</span> 回到用户端</router-link>
    </template>
  </LoginForm>
</template>
