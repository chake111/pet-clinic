import { computed } from 'vue'
import { defineStore } from 'pinia'
import * as userApi from '@/api/user'
import { createSession } from '@/stores/session'

const USER_KEY = 'pet_clinic_client_user'

/**
 * 用户端登录态。token 与展示用的用户信息都落 localStorage，
 * 刷新后不必再打一次 profile 接口，首屏不会被请求卡住。
 */
export const useUserStore = defineStore('client', () => {
  const { token, user, apply, refresh, logout } = createSession({
    kind: 'client', userKey: USER_KEY, fetchProfile: userApi.profile
  })

  /* nickname 在前：LoginVo 的 name 只是登录那一刻的快照，改完昵称不会更新；
     profile 接口回的是 SysUser，昵称落在 nickname 上 */
  const logged = computed(() => !!token.value)
  const userId = computed(() => user.value?.id)
  const nickname = computed(
    () => user.value?.nickname || user.value?.name || user.value?.username || ''
  )

  async function login(form) {
    const vo = await userApi.login(form)
    apply(vo)
    return vo
  }

  async function register(form) {
    // 注册接口直接返回登录态，省一次跳转后再登录
    const vo = await userApi.register(form)
    apply(vo)
    return vo
  }

  return { token, user, logged, userId, nickname, login, register, apply, refresh, logout }
})
