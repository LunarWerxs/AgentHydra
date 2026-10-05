// web/src/composables/useTokenWindow.ts — the Tokens column's 5h / Week / Total choice, one per
// table, remembered through the daemon like the other table preferences (useSharedPrefs.ts), and
// the desktop table's per-account figures (the CLI list carries its own).

import type { AccountTokens } from '@agenthydra/server/types'
import { useStorage } from '@vueuse/core'
import { onScopeDispose, ref } from 'vue'
import { listDesktopInstanceTokens } from '@/lib/api'
import { visibleInterval } from '@/lib/visible-poll'
import { TOKEN_WINDOWS, type TokenWindow } from '@/lib/token-window'
import { registerSharedPref } from './useSharedPrefs'

const cliTokenWindow = useStorage<TokenWindow>('agenthydra.cliTokens.window', 'total')
registerSharedPref('agenthydra.cliTokens.window', cliTokenWindow, TOKEN_WINDOWS)
const desktopTokenWindow = useStorage<TokenWindow>('agenthydra.desktopTokens.window', 'total')
registerSharedPref('agenthydra.desktopTokens.window', desktopTokenWindow, TOKEN_WINDOWS)

export const useCliTokenWindow = () => cliTokenWindow
export const useDesktopTokenWindow = () => desktopTokenWindow

/** Each desktop instance's current account's tokens, by instance dir; refreshed every minute while
 *  the table is mounted. */
export function useDesktopAccountTokens() {
  const byDir = ref<Record<string, AccountTokens | null>>({})
  const load = async () => {
    try {
      const next = await listDesktopInstanceTokens()
      if (JSON.stringify(next) !== JSON.stringify(byDir.value)) byDir.value = next
    } catch {
      // Keep the last figures; the next tick asks again.
    }
  }
  void load()
  const stop = visibleInterval(() => void load(), 60_000)
  onScopeDispose(stop)
  return byDir
}
