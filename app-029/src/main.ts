import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { initFonts } from './logic/fontLoader'
import './styles/main.css'

// 先把本机 IndexedDB 里的持久字体登记读进字库，再挂载页面，
// 保证刷新/重开后字库页与项目里立刻能看到、能选用上传过的字体。
initFonts().finally(() => {
  createApp(App).use(router).mount('#app')
})
