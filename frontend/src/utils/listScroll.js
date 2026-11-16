import { nextTick } from 'vue'

/** 返回列表时等异步内容渲染后再恢复位置，避免空列表把路由保存的滚动值夹到 0。 */
export async function loadWithSavedScroll(load) {
  const saved = window.history.state?.scroll
  const path = window.location.pathname
  await load()
  await nextTick()
  if (saved && window.location.pathname === path) window.scrollTo(saved)
}
