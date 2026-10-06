import { createApp } from 'vue'
import { installPrivacy } from './composables/usePrivacy'
import { hydrateSharedPrefs } from './composables/useSharedPrefs'
import { appModeForPath } from './lib/app-mode'
import { installImeCompositionGuard } from './lib/ime-composition-guard'
import { pauseMotionWhenAway } from './lib/pause-motion'
import { startSignInNudgeSession } from './lib/sign-in-nudge'
import { migrateLegacyStorageKeys } from './lib/storage-rebrand'
import { migrateLegacyUsageFilterScope } from './lib/usage-filter'
import './style.css'

// Keep input-method (IME) composition keystrokes away from every @keydown.enter handler: on
// Safari and Chrome-on-macOS the Enter that commits a CJK candidate otherwise submits half-typed
// text. One document-level guard (kit-synced) instead of a check at ~every Enter handler.
installImeCompositionGuard()

// Hold animation still while the window is unfocused or hidden (idle GPU).
pauseMotionWhenAway()

// Before any component setup runs — useStorage reads its key once and keeps it.
migrateLegacyStorageKeys()
// After the rebrand pass, which is what puts a pre-AgentHydra `…usageFilter.scope2` under the name
// this one looks for. Ordering is the whole reason both live here rather than at their own module
// scope: the second would otherwise migrate a key the first has not moved yet.
migrateLegacyUsageFilterScope()

async function mountApp(): Promise<void> {
  const quick = appModeForPath(window.location.pathname) === 'instances'
  if (quick) {
    const { default: QuickInstancesApp } = await import('./QuickInstancesApp.vue')
    const app = createApp(QuickInstancesApp)
    installPrivacy(app)
    app.mount('#app')
  } else {
    // Keep the full manager and its i18n/toast/component graph out of the quick-mode request. Vite
    // emits this branch as separate chunks, so `/instances` does not merely hide heavyweight UI —
    // the browser never downloads or initializes it.
    //
    // All three in ONE Promise.all: the toast stylesheet used to be awaited on its own line AFTER
    // this, which made a second serial round trip out of a request that has no dependency on the
    // first two. Nothing here needs anything else here.
    const [{ default: App }, { i18n }] = await Promise.all([
      import('./App.vue'),
      import('./i18n'),
      // vue-sonner v2 ships its toast styling separately. It is needed only by the full manager.
      import('vue-sonner/style.css'),
    ])
    const app = createApp(App).use(i18n)
    installPrivacy(app)
    app.mount('#app')
  }

  // Pull the cross-window preferences (usage mode + usage filter). AFTER the mount above, and it
  // has to be after: registration happens when composables/useInstanceFilter.ts and useUsageMode.ts
  // are first imported, which is part of loading the view chunk. Hoisted to module scope this would
  // run against an empty registry and silently apply nothing.
  //
  // Not awaited, either. Those refs are already painted from localStorage, so blocking first paint
  // on a round trip would trade a visible delay for a correction almost nobody needs; this lands a
  // beat later and fixes up the case that motivated it — the quick window running on its own port,
  // with its own empty storage. See composables/useSharedPrefs.ts.
  //
  // The one-time switch-on of folded tool calls and reasoning rides on it, because the store wins
  // on hydrate: run before, and the store's old `false` lands on top. The full manager only; the
  // dynamic import is the module App.vue already loaded, so it costs no request.
  void hydrateSharedPrefs().then(async () => {
    if (quick) return
    const { switchOnWorkRowsOnce } = await import('./composables/useUiPrefs')
    switchOnWorkRowsOnce()
  })
}

// Counts one session for the Connections sign-in prompt. Here, not in SettingsView, because that
// view is lazy: an owner who never opens Settings would never accrue a session and so could never
// pass the prompt's gate. Counting only - nothing is shown from this call.
startSignInNudgeSession({ appId: 'agenthydra', appName: 'AgentHydra' })

void mountApp()
