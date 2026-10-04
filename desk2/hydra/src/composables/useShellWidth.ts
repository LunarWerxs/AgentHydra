import { useStorage } from '@vueuse/core'
import { registerSharedPref } from './useSharedPrefs'

/**
 * Shared shell width: the app frames itself at a comfortable reading width; the header's
 * full-width toggle is the only thing that changes it. Module-scope singleton so any view can
 * read the choice and App.vue just renders it.
 */
export const SHELL_BASE_MAX = 1000

/** The header's full-width toggle: the shell spans the whole window, no cap at all. A remembered
 *  choice, so it is persisted and mirrored through the daemon like the layout prefs in
 *  useUiPrefs.ts (the port-hop reasoning there applies here too). */
const fullWidth = useStorage('agenthydra.shell.fullWidth', false)
registerSharedPref('agenthydra.shell.fullWidth', fullWidth)

export function useShellWidth() {
  return { fullWidth }
}
