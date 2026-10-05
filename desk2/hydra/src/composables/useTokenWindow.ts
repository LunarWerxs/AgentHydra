// web/src/composables/useTokenWindow.ts — the Tokens column's 5h / Week / Total choice, one per
// table, remembered through the daemon like the other table preferences (useSharedPrefs.ts), and
// the desktop table's per-account figures (the CLI list carries its own).

import type { AccountTokens } from '@agenthydra/server/types'
import { useStorage } from '@vueuse/core'
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

/** Each desktop instance's current account's tokens, by instance dir. One shared copy, read by the
 *  table and refreshed by lib/warm-data.ts (the desktop kind) and when the tab is shown. */
const desktopAccountTokens = ref<Record<string, AccountTokens | null>>({})
export async function refreshDesktopAccountTokens(): Promise<void> {
  try {
    const next = await listDesktopInstanceTokens()
    if (JSON.stringify(next) !== JSON.stringify(desktopAccountTokens.value)) desktopAccountTokens.value = next
  } catch {
    // Keep the last figures; the next refresh asks again.
  }
}
export function useDesktopAccountTokens() {
  void refreshDesktopAccountTokens()
  return desktopAccountTokens
}
