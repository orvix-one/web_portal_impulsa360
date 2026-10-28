import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './style.css'
import { initializeAuth } from './lib/authStore'

initializeAuth().then(() => createApp(App).use(router).mount('#app'))
