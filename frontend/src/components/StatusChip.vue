<script setup>
/**
 * 状态标签。色块不单独承载信息：浅底 + 同色文字 + 4px 前置圆点 + 文案，
 * 色盲用户也能分辨（WCAG 1.4.1）。tone 直接吃 dict.js 里的 tag 值；
 * plain 是内容标签（科室、擅长、种类），不带状态语义。
 */
defineProps({
  tone: { type: String, default: 'plain' },
  size: { type: String, default: 'md' }
})
</script>

<template>
  <span class="chip" :class="[`t-${tone}`, `s-${size}`]">
    <i v-if="tone !== 'plain'" class="dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: var(--radius-xs);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
}

.s-lg {
  height: 28px;
  padding: 0 12px;
  font-size: 13px;
}

.dot {
  flex: none;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}

.t-plain {
  border-radius: var(--radius-full);
  border: 1px solid var(--color-hairline);
  background: var(--color-canvas);
  color: var(--color-muted);
  font-weight: 400;
}

.t-ongoing {
  background: var(--color-ongoing-soft);
  color: var(--color-ongoing);
}

.t-success {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.t-warning {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.t-danger {
  background: var(--color-danger-soft);
  color: var(--color-danger-text);
}

.t-terminated {
  background: var(--color-terminated-soft);
  color: var(--color-terminated);
}
</style>
