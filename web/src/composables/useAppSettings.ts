// Usage-related app settings, shared as a module singleton because TWO views need them: SettingsView
// writes them, InstancesView reads them (it hides the desktop or CLI table when told to). A plain
// per-component ref would let the two drift out of sync until a reload.
//
// Same shape as the other composables here (module-level refs + action wrappers). The server is the
// source of truth; every setter round-trips through /api/settings and takes the server's echo, so a
// rejected/clamped value (e.g. an out-of-range interval) is what ends up on screen.
import { ref } from 'vue'
import * as api from '@/lib/api'

/** Interval choices offered in the UI (minutes). The server clamps to [5, 1440] regardless. */
export const USAGE_REFRESH_INTERVALS = [5, 15, 30, 60] as const

// Defaults mirror the server's (see getUsageSettings in server/src/usage-refresh.ts): auto-refresh
// ON, both sections visible. They only show for the moment before the first load resolves.
const autoRefresh = ref(true)
const autoRefreshIntervalMin = ref(15)
const showDesktopInstances = ref(true)
const showCliInstances = ref(true)
const codexDesktopEnabled = ref(true)
const codexCliEnabled = ref(true)
const chatGptHandoffEnabled = ref(false)
// '' = auto-detect (server/src/transcript-open.ts picks the first installed editor it knows).
const transcriptEditor = ref('')
// Server-derived echo: what will ACTUALLY open a transcript once auto-detect has run and an
// override pointing at nothing has been discarded. Read-only here; never sent back in a patch.
const transcriptEditorResolved = ref('')
const loaded = ref(false)

function absorb(s: api.AppSettings): void {
  autoRefresh.value = s.autoRefresh
  autoRefreshIntervalMin.value = s.autoRefreshIntervalMin
  showDesktopInstances.value = s.showDesktopInstances
  showCliInstances.value = s.showCliInstances
  codexDesktopEnabled.value = s.codexDesktopEnabled
  codexCliEnabled.value = s.codexCliEnabled
  chatGptHandoffEnabled.value = s.chatGptHandoffEnabled
  transcriptEditor.value = s.transcriptEditor
  transcriptEditorResolved.value = s.transcriptEditorResolved
  loaded.value = true
}

/** Load from the server. Safe to call from several components; a failure keeps the last-known values. */
async function load(): Promise<void> {
  try {
    absorb(await api.getSettings())
  } catch {
    // keep last-known values; the settings screen still works, it just shows stale toggles
  }
}

/** Apply a patch and absorb the server's echo. Returns false if the write failed. Widened past
 *  UsageSettings (rather than a second copy of this function) so transcriptEditor round-trips
 *  through the exact same load/absorb contract as every other setting here. */
async function update(patch: Partial<api.AppSettings>): Promise<boolean> {
  try {
    absorb(await api.updateSettings(patch))
    return true
  } catch {
    return false
  }
}

export function useAppSettings() {
  return {
    autoRefresh,
    autoRefreshIntervalMin,
    showDesktopInstances,
    showCliInstances,
    codexDesktopEnabled,
    codexCliEnabled,
    chatGptHandoffEnabled,
    transcriptEditor,
    transcriptEditorResolved,
    loaded,
    load,
    update,
  }
}
