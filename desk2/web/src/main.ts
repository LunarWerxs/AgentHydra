import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import './components/servers/browser-request'
import { pauseMotionWhenAway } from './lib/pause-motion'
import { installImeCompositionGuard } from './lib/ime-composition-guard'
import { reloadOnChunkFailure } from './lib/chunk-reload'

installImeCompositionGuard()
pauseMotionWhenAway()
reloadOnChunkFailure(window, sessionStorage)

if (window.location.hash.startsWith('#/parity/')) void import('./dev/parity/ParityPage.vue').then((m) => createApp(m.default).mount('#app'))
else if (import.meta.env.DEV && window.location.hash.startsWith('#/stream-bench')) void import('./dev/stream/StreamBenchPage.vue').then((m) => createApp(m.default).mount('#app'))
else createApp(App).mount('#app')
