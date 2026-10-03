import { useStorage } from '@vueuse/core'
import { ref } from 'vue'
import { registerSharedPref } from './useSharedPrefs'

/**
 * Shared shell width: the app frames itself at a comfortable reading width and only
 * widens when the active view genuinely benefits (e.g. a session transcript is open).
 * Module-scope singleton so any view can request width and App.vue just renders it.
 */
export const SHELL_BASE_MAX = 1000
export const SHELL_WIDE_MAX = 1600

const wide = ref(false)

/** The header's full-width toggle: the shell spans the whole window, no cap at all. A remembered
 *  choice, so it is persisted and mirrored through the daemon like the layout prefs in
 *  useUiPrefs.ts (the port-hop reasoning there applies here too). Off leaves `wide` in charge. */
const fullWidth = useStorage('agenthydra.shell.fullWidth', false)
registerSharedPref('agenthydra.shell.fullWidth', fullWidth)

export function useShellWidth() {
  return { wide, fullWidth }
}
