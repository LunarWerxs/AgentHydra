// web/src/composables/useTokenWindow.ts — the Tokens column's 5h / Week / Total choice, remembered
// through the daemon like the other table preferences (useSharedPrefs.ts), and the per-account tokens
// of the desktop instances. The one Tokens column serves every kind (lib/instance-table.ts).

import type { AccountTokens } from '@agenthydra/server/types'
import { useStorage } from '@vueuse/core'
import { shallowRef } from 'vue'
import { listDesktopInstanceTokens } from '@/lib/api'
import { TOKEN_WINDOWS, type TokenWindow } from '@/lib/token-window'
import { registerSharedPref } from './useSharedPrefs'

const desktopTokenWindow = useStorage<TokenWindow>('agenthydra.desktopTokens.window', 'total')
registerSharedPref('agenthydra.desktopTokens.window', desktopTokenWindow, TOKEN_WINDOWS)

export const useDesktopTokenWindow = () => desktopTokenWindow

/** Each desktop instance's current account's tokens, by instance dir. One shared copy, read by the
 *  table and refreshed by lib/warm-data.ts (the desktop kind) and when the tab is shown. */
const desktopAccountTokens = shallowRef<Record<string, AccountTokens | null>>({})
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
