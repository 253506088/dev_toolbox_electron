import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './theme/global.css'
import './utils/monaco-workers'

/**
 * 创建 Vue 应用并装载全局状态。
 */
function bootstrap(): void {
  const app = createApp(App)
  app.use(createPinia())
  app.mount('#app')
}

bootstrap()
