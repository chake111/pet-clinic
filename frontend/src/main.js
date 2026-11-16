import * as Icons from '@element-plus/icons-vue'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import './styles/main.css'
import './styles/admin.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)

// 图标一次性注册：页面里 <el-icon><Calendar /></el-icon> 直接用，不必每页 import
for (const [name, comp] of Object.entries(Icons)) {
  app.component(name, comp)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
