// web/src/composables/useTokenWindow.ts — the Tokens column's 5h / Week / Total choice, one per
// table, remembered through the daemon like the other table preferences (useSharedPrefs.ts), and
// the desktop table's per-account figures (the CLI list carries its own).

import type { AccountTokens } from '@agenthydra/server/types'
import { useIntervalFn, useStorage } from '@vueuse/core'
import { ref } from 'vue'
import { listDesktopInstanceTokens } from '@/lib/api'
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
      byDir.value = await listDesktopInstanceTokens()
    } catch {
      // Keep the last figures; the next tick asks again.
    }
  }
  useIntervalFn(load, 60_000, { immediateCallback: true })
  return byDir
}
