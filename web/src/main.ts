import { createApp } from 'vue'
import { appModeForPath } from './lib/app-mode'
import './style.css'

async function mountApp(): Promise<void> {
  if (appModeForPath(window.location.pathname) === 'instances') {
    const { default: QuickInstancesApp } = await import('./QuickInstancesApp.vue')
    createApp(QuickInstancesApp).mount('#app')
  } else {
    // Keep the full manager and its i18n/toast/component graph out of the quick-mode request. Vite
    // emits this branch as separate chunks, so `/instances` does not merely hide heavyweight UI —
    // the browser never downloads or initializes it.
    const [{ default: App }, { i18n }] = await Promise.all([import('./App.vue'), import('./i18n')])
    // vue-sonner v2 ships its toast styling separately. It is needed only by the full manager.
    await import('vue-sonner/style.css')
    createApp(App).use(i18n).mount('#app')
  }
}

void mountApp()
