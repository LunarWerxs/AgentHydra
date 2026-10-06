// AgentHydra's own settings in Desk's Settings dialog (owner, 2026-10-06: the AgentHydra pane's settings
// sidebar moved here, and the pane has none). Every value is AgentHydra's, read and written through
// Desk's /ah/api proxy with the calls the pane made (the daemon's routes in server/src/index.ts). The
// two pane-only preferences, tooltips and privacy mode, are the pane's own localStorage keys: this
// window is the same origin, so the pane follows a change at once through the storage event.
// Left behind with the retired AgentHydra window: portable mode, the quick-instances shortcut, the
// theme picker (Desk has one theme) and Shut down (the daemon is Desk's engine).
import { useStorage } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import { tellHydra } from '@/components/hydra/api'
import type { PaneApi } from './api'
import type { SettingsCondition } from './settings'

/** GET /api/settings: the fields these rows show. */
export interface AhSettings {
  hideTrayIcon: boolean
  mcpRegisterClaudeCode: boolean
  mcpRegistered: boolean
  mcpUrl: string
  mcpConfigPath: string
  mcpRegisterError: string | null
  mcpToolboxPresent: boolean
  mcpMissingComponents: string[]
  notifyEnabled: boolean
  notifySessionReset: boolean
  notifyWeeklyReset: boolean
  notifyMinPct: number
  notifySessionMaxWeeklyPct: number
  notifyDesktop: boolean
  notifyPersistent: boolean
  notifyPersistentIntervalMin: number
  notifyPersistentMaxRepeats: number
  notifyEmail: boolean
  notifyEmailTo: string
  notifyEmailFrom: string
  notifySmtpHost: string
  notifySmtpPort: number
  notifySmtpSecure: boolean
  notifySmtpUser: string
  notifySmtpPassSet: boolean
  // Settings → Instances (the pane's tables): which ones show, the CLI keepalive and paid extra usage.
  showCliInstances: boolean
  showDesktopInstances: boolean
  codexDesktopEnabled: boolean
  codexCliEnabled: boolean
  dshEnabled: boolean
  keepaliveEnabled: boolean
  keepaliveWeeklyFloorPct: number
  allowExtraUsage: boolean
}

type ReadOnly =
  | 'mcpRegistered'
  | 'mcpUrl'
  | 'mcpConfigPath'
  | 'mcpRegisterError'
  | 'mcpToolboxPresent'
  | 'mcpMissingComponents'
  | 'notifySmtpPassSet'
/** What a save sends: any field a person sets, and the SMTP password, which is never read back. */
export type AhSettingsPatch = Partial<Omit<AhSettings, ReadOnly>> & { notifySmtpPass?: string }

/** GET /api/update. */
interface AhUpdateStatus {
  currentVersion: string | null
  currentCommit: string | null
  remote: string | null
  updateAvailable: boolean
  canApply: boolean
  reason: string | null
}

interface AhUpdateProgress {
  phase: string
  message: string
  receivedBytes: number | null
  totalBytes: number | null
}

interface AhSyncStatus {
  enabled: boolean
  connected: boolean
  name: string | null
  email: string | null
  lastSyncedAt: string | null
  appearance: Record<string, unknown> | null
}
type AhSyncResult = ({ ok: true } & AhSyncStatus) | { ok: false; error: string }

interface AhTestResult {
  desktop: { attempted: boolean; ok: boolean; error?: string | null }
  email: { attempted: boolean; ok: boolean; error?: string | null }
}

export type UpdateState = 'checking' | 'up-to-date' | 'available' | 'blocked' | 'no-source' | 'unknown'

// The pane's keys (hydra/src/lib/tooltip-config.ts, composables/useUiPrefs.ts, lib/theme.ts).
const TOOLTIPS_KEY = 'lunarwerx-tooltips-enabled'
const PRIVACY_KEY = 'agenthydra.privacyMode'
const THEME_KEY = 'lunarwerx-theme'

// An update downloads ~100 MB or pulls, installs and rebuilds: minutes, so its request waits up to 20.
const APPLY_TIMEOUT_MS = 20 * 60_000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useAgentHydraSettings(api: PaneApi) {
  const settings = ref<AhSettings | null>(null)
  /** Why AgentHydra could not be read, shown in place of its rows. */
  const down = ref<string | null>(null)
  const error = ref<string | null>(null)
  /** When a setting last saved, for the dialog's "Saved". */
  const savedAt = ref(0)
  const notes = reactive<Partial<Record<'test' | 'repair' | 'sync', string>>>({})

  const tooltips = useStorage(TOOLTIPS_KEY, true)
  const privacy = useStorage(PRIVACY_KEY, false)
  // The privacy switch is also kept by AgentHydra (its ui-prefs store), which the pane reads at start:
  // without this a pane opened later would turn it back.
  watch(privacy, (on) => void api.agentHydra('/ui-prefs', { method: 'POST', body: JSON.stringify({ [PRIVACY_KEY]: String(on) }) }).catch(() => {}))

  async function load() {
    try {
      settings.value = await api.agentHydra<AhSettings>('/settings')
      down.value = null
    } catch (e) {
      down.value = message(e)
    }
  }

  async function save(patch: AhSettingsPatch): Promise<boolean> {
    if (!settings.value) return false
    const before = settings.value
    settings.value = { ...before, ...patch }
    error.value = null
    try {
      settings.value = await api.agentHydra<AhSettings>('/settings', { method: 'POST', body: JSON.stringify(patch) })
      savedAt.value = Date.now()
      // The pane read these at start (a table hidden, the keepalive on): it reads them again now.
      tellHydra({ type: 'desk:settings-changed' })
      return true
    } catch (e) {
      settings.value = before
      error.value = message(e)
      return false
    }
  }

  async function sendTest() {
    notes.test = 'Sending…'
    try {
      const r = await api.agentHydra<AhTestResult>('/notifications/test', { method: 'POST' })
      const said: string[] = []
      if (r.desktop.attempted) said.push(r.desktop.ok ? 'Desktop notification sent.' : `Desktop notification failed: ${r.desktop.error ?? ''}`)
      if (r.email.attempted) said.push(r.email.ok ? 'Test email sent.' : `Test email failed: ${r.email.error ?? ''}`)
      notes.test = said.join(' ') || 'No delivery is on, so nothing was sent.'
    } catch (e) {
      notes.test = `Not sent: ${message(e)}`
    }
  }

  // --- updates ---
  const update = ref<AhUpdateStatus | null>(null)
  const autoUpdate = ref<boolean | null>(null)
  const checking = ref(false)
  const applying = ref(false)
  const progress = ref<AhUpdateProgress | null>(null)
  const applyNote = ref<string | null>(null)
  const applyError = ref<string | null>(null)

  const updateState = computed<UpdateState>(() => {
    if (checking.value || applying.value) return 'checking'
    const s = update.value
    if (!s) return 'unknown'
    if (!s.remote) return 'no-source'
    if (s.updateAvailable) return s.canApply ? 'available' : 'blocked'
    return 'up-to-date'
  })

  async function checkUpdate() {
    checking.value = true
    try {
      update.value = await api.agentHydra<AhUpdateStatus>('/update')
    } catch (e) {
      applyError.value = message(e)
    } finally {
      checking.value = false
    }
  }

  async function loadAutoUpdate() {
    try {
      autoUpdate.value = (await api.agentHydra<{ enabled: boolean }>('/update/settings')).enabled
    } catch {
      autoUpdate.value = null
    }
  }

  async function setAutoUpdate(enabled: boolean) {
    const before = autoUpdate.value
    autoUpdate.value = enabled
    try {
      autoUpdate.value = (await api.agentHydra<{ enabled: boolean }>('/update/settings', { method: 'POST', body: JSON.stringify({ enabled }) })).enabled
      savedAt.value = Date.now()
    } catch (e) {
      autoUpdate.value = before
      error.value = message(e)
    }
  }

  // The daemon restarts itself after an update, so the apply request may end with the connection
  // dropped: then it is the version AgentHydra comes back with that says whether it took.
  async function waitForRestart(): Promise<string | null> {
    const deadline = Date.now() + 90_000
    await new Promise((r) => setTimeout(r, 2000))
    while (Date.now() < deadline) {
      try {
        return (await api.agentHydra<{ version: string }>('/health', { signal: AbortSignal.timeout(2000) })).version
      } catch {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    return null
  }

  async function applyUpdate() {
    applying.value = true
    applyNote.value = null
    applyError.value = null
    progress.value = null
    const before = update.value?.currentVersion ?? null
    const poll = setInterval(() => {
      api
        .agentHydra<AhUpdateProgress>('/update/progress')
        .then((p) => (progress.value = p))
        .catch(() => {}) // floor-ok: one missed progress read; the next second reads again
    }, 1000)
    try {
      const r = await api.agentHydra<{ message: string; restartRequired: boolean }>('/update/apply', {
        method: 'POST',
        signal: AbortSignal.timeout(APPLY_TIMEOUT_MS)
      })
      applyNote.value = r.restartRequired ? `${r.message} Restart AgentHydra from its tray icon to run the new code.` : r.message
    } catch (e) {
      const version = await waitForRestart()
      if (version) applyNote.value = version === before ? `AgentHydra restarted and runs v${version}.` : `Updated to v${version}.`
      else applyError.value = message(e)
    } finally {
      clearInterval(poll)
      progress.value = null
      applying.value = false
      void checkUpdate()
    }
  }

  async function repair() {
    await applyUpdate()
    await load()
    notes.repair = applyError.value ?? (settings.value?.mcpMissingComponents.length ? 'The missing files are still not installed.' : 'Repaired.')
  }

  const progressLabel = computed(() => {
    const p = progress.value
    if (!p || p.phase === 'idle') return null
    if (p.receivedBytes != null && p.totalBytes) {
      const pct = Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
      const mb = (n: number) => (n / 1048576).toFixed(0)
      return `${p.message} ${pct}% (${mb(p.receivedBytes)}/${mb(p.totalBytes)} MB)`
    }
    return p.message || null
  })

  // --- cloud sync ---
  const sync = ref<AhSyncStatus | null>(null)
  const syncBusy = ref(false)
  const confirmDisconnect = ref(false)

  // What syncs of the appearance is the pane's theme; a pulled one is stored for the pane to apply.
  const appearance = () => ({ theme: localStorage.getItem(THEME_KEY) ?? 'dark' })
  function absorbSync(r: AhSyncResult): boolean {
    if (!r.ok) {
      notes.sync = r.error
      return false
    }
    sync.value = r
    notes.sync = undefined
    const theme = r.appearance?.theme
    if (theme === 'light' || theme === 'dark' || theme === 'system') localStorage.setItem(THEME_KEY, theme)
    return true
  }

  async function loadSync() {
    try {
      sync.value = await api.agentHydra<AhSyncStatus>('/settings/sync')
    } catch {
      sync.value = null
    }
  }

  async function syncCall(run: () => Promise<boolean | void>) {
    syncBusy.value = true
    try {
      await run()
    } catch (e) {
      notes.sync = message(e)
    } finally {
      syncBusy.value = false
    }
  }
  const putSync = (body: Record<string, unknown>) =>
    api.agentHydra<AhSyncResult>('/settings/sync', { method: 'PUT', body: JSON.stringify(body) })

  // The sign-in is AgentHydra's own page (Desk sends /oauth/* to it), in a window of its own; the
  // status is read again when this one gets the focus back.
  const connect = () => window.open('/oauth/login', '_blank', 'noopener')
  const setSync = (enabled: boolean) =>
    syncCall(async () => absorbSync(await putSync(enabled ? { enabled, appearance: appearance() } : { enabled })))
  const syncNow = () =>
    syncCall(async () => {
      if (absorbSync(await api.agentHydra<AhSyncResult>('/settings/sync/pull', { method: 'POST' })))
        if (absorbSync(await api.agentHydra<AhSyncResult>('/settings/sync/push', { method: 'POST' }))) notes.sync = 'Synced.'
    })
  function disconnect() {
    if (!confirmDisconnect.value) {
      confirmDisconnect.value = true
      return
    }
    confirmDisconnect.value = false
    void syncCall(async () => absorbSync(await putSync({ enabled: false, forget: true })))
  }

  function syncedLabel(now = Date.now()): string {
    const ts = Date.parse(sync.value?.lastSyncedAt ?? '')
    if (Number.isNaN(ts)) return 'Not synced yet'
    const s = Math.round((now - ts) / 1000)
    if (s < 10) return 'Synced just now'
    const when = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
    return `Synced ${when} ago`
  }

  /** Whether a row's `when` holds right now. */
  function holds(c: SettingsCondition): boolean {
    const s = settings.value
    switch (c) {
      case 'alerts':
        return !!s?.notifyEnabled
      case 'persistent':
        return !!s?.notifyPersistent
      case 'email':
        return !!s?.notifyEmail
      case 'missing':
        return !!s?.mcpMissingComponents.length
      case 'connected':
        return !!sync.value?.connected
      case 'syncing':
        return !!sync.value?.enabled
      case 'keepalive':
        return !!s?.keepaliveEnabled
      case 'native':
      case 'freeKeepalive':
        return false // the Instances settings decide (instances.ts); SettingsView asks them first
    }
  }

  /** The muted lines under a row's description: what AgentHydra says about it right now. */
  function rowNotes(id: string): string[] {
    const s = settings.value
    switch (id) {
      case 'ahMcp':
        if (!s) return []
        return [
          s.mcpRegisterError ??
            (s.mcpRegistered
              ? `Registered at ${s.mcpUrl}`
              : s.mcpRegisterClaudeCode
                ? 'Not registered yet.'
                : 'Not registered, the switch is off.'),
          ...(s.mcpConfigPath ? [`Config: ${s.mcpConfigPath}`] : [])
        ]
      case 'ahRepair':
        return [
          s && !s.mcpToolboxPresent
            ? `Moving chats between accounts will not work: this install is missing ${s.mcpMissingComponents.join(', ')}.`
            : `This install is missing ${s?.mcpMissingComponents.join(', ') ?? ''}.`,
          ...(notes.repair ? [notes.repair] : [])
        ]
      case 'ahTest':
        return notes.test ? [notes.test] : []
      case 'ahSmtpPass':
        return s?.notifySmtpPassSet ? ['A password is stored.'] : []
      case 'ahSync':
        return [
          ...(sync.value?.connected
            ? [`${privacy.value ? 'Connected' : sync.value.name || sync.value.email || 'Connected'} · ${sync.value.enabled ? syncedLabel() : 'Sync is off'}`]
            : []),
          ...(notes.sync ? [notes.sync] : [])
        ]
      case 'ahVersion': {
        const u = update.value
        if (applying.value) return [progressLabel.value ?? 'Updating…']
        const lines = [applyNote.value, applyError.value].filter((l): l is string => !!l)
        if (updateState.value === 'blocked') lines.push(`An update is waiting but cannot be applied: ${u?.reason ?? 'blocked'}.`)
        if (updateState.value === 'available') lines.push('An update is waiting. Click the number to install it; AgentHydra restarts.')
        if (updateState.value === 'no-source') lines.push('This install is not linked to a Git remote, so there is nowhere to pull new versions from.')
        return lines
      }
      default:
        return []
    }
  }

  return {
    settings,
    down,
    error,
    savedAt,
    tooltips,
    privacy,
    load,
    save,
    sendTest,
    update,
    updateState,
    autoUpdate,
    checking,
    applying,
    checkUpdate,
    loadAutoUpdate,
    setAutoUpdate,
    applyUpdate,
    repair,
    sync,
    syncBusy,
    confirmDisconnect,
    loadSync,
    connect,
    setSync,
    syncNow,
    disconnect,
    holds,
    rowNotes
  }
}

export type AgentHydraSettings = ReturnType<typeof useAgentHydraSettings>
