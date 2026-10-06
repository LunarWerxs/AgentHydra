// The Instances pages of Desk's Settings (owner, 2026-10-06): the settings of the AgentHydra pane's three
// tables, CLI, Desktop and Free, which were behind each table's gear (the CLI table's popover, the Desktop
// tab's "Instances settings" dialog). The gear now opens this dialog on its table's page. Which tables
// show, the keepalive and paid extra usage are AgentHydra settings like any other (agenthydra.ts rows).
// What is here is the rest:
// - each table's process columns: the pane's own localStorage keys, as tooltips and privacy mode are, also
//   kept in AgentHydra's ui-prefs store, which the pane reads at start;
// - Claude native control, per desktop account (the daemon's /api/claude-native/settings), moved here
//   with its helpers from the pane (hydra/src/components/ClaudeNativeSettings.vue, retired);
// - the Free table's Keep windows running and its weekly floor, Desk's own (/api/free/settings,
//   server/src/free-instances).
import { useStorage } from '@vueuse/core'
import { computed, ref, watch, type Ref } from 'vue'
import type { FreeSettings } from '@shared/free-instances'
import type { PaneApi } from './api'
import type { AgentHydraSettings } from './agenthydra'
import type { SettingsRowId } from './settings'

/** The pane's column-mode keys (hydra/src/composables/useUsageMode.ts USAGE_MODE_KEYS): true draws the
 *  quota columns, false the process ones. The CLI and Free tables start from the desktop table's. */
export const TABLE_MODE_KEYS = {
  desktop: 'agenthydra.instances.usageMode2',
  cli: 'agenthydra.cli.usageMode',
  free: 'agenthydra.free.usageMode'
} as const
export type InstanceTable = keyof typeof TABLE_MODE_KEYS

const PROCESS_ROWS: Partial<Record<SettingsRowId, InstanceTable>> = {
  ahCliProcess: 'cli',
  ahDesktopProcess: 'desktop',
  ahFreeProcess: 'free'
}
const NATIVE_ROWS: SettingsRowId[] = ['ahNativeAccount', 'ahNativeAuto', 'ahNativeReset']
const FREE_ROWS: SettingsRowId[] = ['ahFreeKeepalive', 'ahFreeFloor']

/** One account's native control (GET /api/claude-native/settings, keyed by normalized profile folder). */
export interface NativeConfig {
  port: number
  mode: 'native-only' | 'prefer-native'
  launchDebugger?: boolean
}
export type NativeSettings = Record<string, NativeConfig>
/** GET /api/instances: what the account menu shows. */
interface DesktopProfile {
  num: number
  dir: string
  name: string
  label?: string | null
}

/** The server's normalized key for an absolute Windows profile folder. */
export function nativeProfileKey(profile: string): string {
  const path = profile.replace(/\//g, '\\')
  const drive = /^([a-z]:)\\/i.exec(path)
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(path)
  if (!drive && !unc) throw Error('An absolute Windows profile directory is required')
  const root = drive ? drive[1] : `\\\\${unc![1]}\\${unc![2]}`
  const rest = path.slice(drive ? drive[0].length : unc![0].length)
  const segments: string[] = []
  for (const segment of rest.split(/\\+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return [root, ...segments].join('\\').toLowerCase()
}

const FIRST_PORT = 1024
const LAST_PORT = 65535
const DEFAULT_PORT = 19300

/**
 * The config that turns automatic startup on or off for one profile. Off keeps an existing manual
 * connection (removing native control is the separate "Use standard controls"); on picks a port no
 * saved profile uses. The server stays the judge of conflicts.
 */
export function automaticNativeConfig(settings: NativeSettings, profile: string, enabled: boolean, preferredPort = DEFAULT_PORT): NativeConfig | null {
  const existing = settings[nativeProfileKey(profile)]
  if (existing) return { ...existing, launchDebugger: enabled }
  if (!enabled) return null
  const used = new Set(Object.values(settings).map((c) => c.port))
  let port = Number.isInteger(preferredPort) && preferredPort >= FIRST_PORT && preferredPort <= LAST_PORT ? preferredPort : DEFAULT_PORT
  for (let remaining = LAST_PORT - FIRST_PORT + 1; remaining > 0; remaining--) {
    if (!used.has(port)) return { port, mode: 'native-only', launchDebugger: true }
    port = port === LAST_PORT ? FIRST_PORT : port + 1
  }
  throw Error('No unused debugger port is available')
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useInstanceSettings(api: PaneApi, ah: AgentHydraSettings) {
  // --- each table's process columns ---
  const desktopMode = useStorage<boolean>(TABLE_MODE_KEYS.desktop, true)
  const modes: Record<InstanceTable, Ref<boolean>> = {
    desktop: desktopMode,
    cli: useStorage<boolean>(TABLE_MODE_KEYS.cli, desktopMode.value),
    free: useStorage<boolean>(TABLE_MODE_KEYS.free, desktopMode.value)
  }
  for (const table of Object.keys(modes) as InstanceTable[]) {
    const key = TABLE_MODE_KEYS[table]
    // The pane trusts AgentHydra's store over its own storage at start: a pane loaded later would turn it back.
    watch(modes[table], (v) => void api.agentHydra('/ui-prefs', { method: 'POST', body: JSON.stringify({ [key]: String(v) }) }).catch(() => {}))
  }
  const processTable = (id: SettingsRowId) => PROCESS_ROWS[id] ?? null
  const processColumns = (table: InstanceTable) => !modes[table].value
  function setProcessColumns(table: InstanceTable, on: boolean) {
    modes[table].value = !on
    ah.savedAt.value = Date.now()
  }

  // --- Claude native control ---
  const native = ref<NativeSettings>({})
  const profiles = ref<DesktopProfile[]>([])
  const profile = ref('')
  const nativeLoading = ref(false)
  const nativeSaving = ref(false)
  const nativeLoaded = ref(false)
  const nativeError = ref<string | null>(null)
  const nativeInstance = computed(() => profiles.value.find((p) => p.dir === profile.value) ?? null)
  const nativeConfig = computed(() => (profile.value ? native.value[nativeProfileKey(profile.value)] : undefined))
  const nativeBusy = computed(() => nativeLoading.value || nativeSaving.value || !nativeLoaded.value || !nativeInstance.value)
  // Privacy mode (the pane's) masks an account's name here too: its number says which it is.
  const accountLabel = (p: DesktopProfile) => (ah.privacy.value ? `#${p.num}` : `#${p.num} ${p.label?.trim() || p.name}`)

  async function loadNative() {
    if (nativeLoading.value || nativeSaving.value) return
    nativeLoading.value = true
    nativeError.value = null
    try {
      const [saved, list] = await Promise.all([
        api.agentHydra<NativeSettings>('/claude-native/settings'),
        api.agentHydra<DesktopProfile[]>('/instances')
      ])
      native.value = saved
      profiles.value = list.filter((p) => /^[a-z]:[\\/]/i.test(p.dir)).sort((a, b) => a.num - b.num)
      nativeLoaded.value = true
      if (!nativeInstance.value)
        profile.value = profiles.value.find((p) => saved[nativeProfileKey(p.dir)]?.launchDebugger)?.dir ?? profiles.value[0]?.dir ?? ''
    } catch (e) {
      nativeLoaded.value = false
      nativeError.value = message(e)
    } finally {
      nativeLoading.value = false
    }
  }

  // Saves the setting only: opening or restarting a desktop is always a separate action.
  async function saveNative(automatic: boolean | null) {
    const p = nativeInstance.value
    if (nativeBusy.value || !p) return
    nativeSaving.value = true
    nativeError.value = null
    try {
      // Against the latest settings, so another account cannot silently take the same port.
      const current = await api.agentHydra<NativeSettings>('/claude-native/settings')
      const config = automatic === null ? null : automaticNativeConfig(current, p.dir, automatic, DEFAULT_PORT + p.num)
      const r = await api.agentHydra<{ ok: true; settings: NativeSettings }>('/claude-native/settings', {
        method: 'PUT',
        body: JSON.stringify({ profile: p.dir, config })
      })
      native.value = r.settings
      ah.savedAt.value = Date.now()
    } catch (e) {
      nativeError.value = message(e)
    } finally {
      nativeSaving.value = false
    }
  }

  const automaticAccounts = computed(() =>
    Object.entries(native.value)
      .filter(([, c]) => c.launchDebugger)
      .map(([key]) => {
        const p = profiles.value.find((i) => nativeProfileKey(i.dir) === key)
        return p ? accountLabel(p) : key
      })
  )

  // --- the Free table's keepalive ---
  const free = ref<FreeSettings | null>(null)
  const freeError = ref<string | null>(null)
  async function loadFree() {
    try {
      free.value = await api.freeSettings()
      freeError.value = null
    } catch (e) {
      freeError.value = message(e)
    }
  }
  async function saveFree(patch: Partial<FreeSettings>) {
    try {
      free.value = await api.patchFreeSettings(patch)
      freeError.value = null
      ah.savedAt.value = Date.now()
    } catch (e) {
      freeError.value = message(e)
    }
  }

  /** The muted lines under a native control or Free keepalive row's description. */
  function rowNotes(id: SettingsRowId): string[] {
    if (id === 'ahFreeKeepalive') return freeError.value ? [freeError.value] : []
    if (id === 'ahNativeAccount') {
      if (nativeError.value) return [nativeError.value]
      if (nativeLoaded.value && !profiles.value.length) return ['No Windows Claude Desktop accounts found.']
      return []
    }
    if (id !== 'ahNativeAuto' || !nativeLoaded.value || !nativeInstance.value) return []
    const c = nativeConfig.value
    return [
      nativeSaving.value ? 'Saving…' : `${c?.launchDebugger ? 'On' : 'Off'}${c ? `, port ${c.port}` : ''}`,
      ...(automaticAccounts.value.length ? [`On for ${automaticAccounts.value.join(', ')}`] : [])
    ]
  }

  return {
    owns: (id: SettingsRowId) => !!PROCESS_ROWS[id] || NATIVE_ROWS.includes(id) || FREE_ROWS.includes(id),
    processTable,
    processColumns,
    setProcessColumns,
    profiles,
    profile,
    accountLabel,
    nativeLoading,
    nativeSaving,
    nativeBusy,
    nativeConfig,
    loadNative,
    saveNative,
    free,
    loadFree,
    saveFree,
    rowNotes
  }
}

export type InstanceSettings = ReturnType<typeof useInstanceSettings>
