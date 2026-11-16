import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 后端 server.servlet.context-path 就是 /api，所以代理不重写路径，
// 前端所有请求写成 /api/xxx 即可与生产部署（同域反代）保持一致。
const BACKEND = process.env.VITE_BACKEND || 'http://127.0.0.1:8081'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        // 图文问诊走 WebSocket，握手路径同样在 /api 下，交给 http-proxy 升协议
        ws: true,
        configure(proxy) {
          // 后端没起来时 vite 会抛 ECONNREFUSED，不接住会把整个 dev server 带走
          proxy.on('error', (err, req) => {
            console.warn('[proxy] 后端不可达', req?.url, err.message)
          })
        }
      }
    }
  },
  build: {
    chunkSizeWarningLimit: 1200
  }
})
