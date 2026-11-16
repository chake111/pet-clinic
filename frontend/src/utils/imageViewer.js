import { reactive } from 'vue'

/**
 * 全站唯一的图片查看器状态，由 App.vue 挂载的 ImageViewerHost 渲染。
 *
 * 没有沿用各页面自带 preview-src-list 的写法：那样一条消息只能预览自己那一张，
 * 医生看患部照片时没法连着翻同一场问诊的历史图。集中一层之后，调用方只负责
 * 把「这一组」图和每张图的来源交进来。
 */
const viewer = reactive({
  open: false,
  urls: [],
  captions: [],
  title: '',
  owner: null,
  index: 0
})

const toList = (v) =>
  (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s || '').trim())
    .filter(Boolean)

/** urls 允许直接传后端的逗号串；captions 与 urls 一一对应，切换时显示这张图的来源 */
export function openImageViewer(urls, index = 0, { captions = [], title = '', owner = null } = {}) {
  const list = toList(urls)
  if (!list.length) return
  viewer.urls = list
  viewer.captions = captions.length === list.length ? captions.map((c) => c || '') : list.map(() => '')
  viewer.title = title
  viewer.owner = owner
  viewer.index = Math.min(Math.max(Number(index) || 0, 0), list.length - 1)
  viewer.open = true
}

export function closeImageViewer() {
  viewer.open = false
  viewer.urls = []
  viewer.captions = []
  viewer.title = ''
  viewer.owner = null
  viewer.index = 0
}

export function closeImageViewerFor(owner) {
  if (viewer.owner === owner) closeImageViewer()
}

/** 查看器内部切图回写。el-image-viewer 只在挂载时读 initial-index，这里不会再反向触发它 */
export function onViewerSwitch(index) {
  viewer.index = Number(index) || 0
}

export const imageViewer = viewer
