<script setup>
import ImageViewerHost from '@/components/ImageViewerHost.vue'
</script>

<template>
  <router-view />
  <!-- 图片查看器挂在路由之外：切页面也不会把正在看的图关掉 -->
  <ImageViewerHost />
</template>
