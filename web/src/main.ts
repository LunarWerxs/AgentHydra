import { createApp } from 'vue'
import { appModeForPath } from './lib/app-mode'
import { migrateLegacyStorageKeys } from './lib/storage-rebrand'
import { migrateLegacyUsageFilterScope } from './lib/usage-filter'
import './style.css'

// Before any component setup runs — useStorage reads its key once and keeps it.
migrateLegacyStorageKeys()
// After the rebrand pass, which is what puts a pre-AgentHydra `…usageFilter.scope2` under the name
// this one looks for. Ordering is the whole reason both live here rather than at their own module
// scope: the second would otherwise migrate a key the first has not moved yet.
migrateLegacyUsageFilterScope()

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
