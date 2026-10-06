import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import './components/servers/browser-request'

if (window.location.hash.startsWith('#/parity/')) void import('./dev/parity/ParityPage.vue').then((m) => createApp(m.default).mount('#app'))
else if (import.meta.env.DEV && window.location.hash.startsWith('#/stream-bench')) void import('./dev/stream/StreamBenchPage.vue').then((m) => createApp(m.default).mount('#app'))
else createApp(App).mount('#app')
