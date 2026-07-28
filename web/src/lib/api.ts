import type {
  Account,
  ArchivedScope,
  AuthType,
  ChatGptContextPack,
  CliInstance,
  CMAccount,
  CMActionResult,
  CMDesktopInstall,
  CMInstance,
  CodexInstance,
  EffortLevel,
  InstanceColorKey,
  InstanceIconKey,
  MonitorSettings,
  MonitorView,
  PermissionMode,
  PortableModeSettings,
  PortableWindowResult,
  ProviderSettings,
  QueueItem,
  RunEvent,
  SchedulerState,
  SessionPeriod,
  SessionSearchResult,
  SessionSource,
  SessionSourceScope,
  SessionSummary,
  SyncStatus,
  TailResult,
  TranscriptSettings,
  UpdateApplyResult,
  UpdateStatus,
  UsageCheckResult,
  UsageSettings,
  UsageSnapshot,
} from '@ccmanagerui/server/types'

export type {
  Account,
  ArchivedScope,
  AuthType,
  ChatGptContextPack,
  CliInstance,
  CMAccount,
  CMAccountStatus,
  CMActionResult,
  CMDesktopInstall,
  CMInstance,
  CodexInstance,
  EffortLevel,
  InstanceColorKey,
  InstanceIconKey,
  MonitorSettings,
  MonitorStateName,
  MonitorStatusRow,
  MonitorView,
  PermissionMode,
  PortableModeSettings,
  PortableWindowResult,
  ProviderSettings,
  QueueItem,
  QueueStatus,
  RunEvent,
  SchedulerState,
  SessionPeriod,
  SessionSearchResult,
  SessionSource,
  SessionSourceScope,
  SessionSummary,
  SyncStatus,
  TailEvent,
  TailResult,
  TranscriptSettings,
  UpdateApplyResult,
  UpdateStatus,
  UsageAdvice,
  UsageCheckResult,
  UsageLimit,
  UsageReason,
  UsageSettings,
  UsageSeverity,
  UsageSnapshot,
  UsageSource,
} from '@ccmanagerui/server/types'
// Value re-export: the curated icon/color key sets that drive the instance appearance pickers
// (single source of truth, also validated server-side). See lib/instance-appearance.ts.
export {
  INSTANCE_COLOR_KEYS,
  INSTANCE_ICON_KEYS,
  INSTANCE_LABEL_MAX,
} from '@ccmanagerui/server/types'

// Prod bundles are served by the daemon itself, so same-origin relative URLs follow the
// daemon to whatever port it actually bound (the port-hop). Dev (Vite on :5173) still needs
// the absolute API origin; VITE_API_BASE overrides both.
export const API_BASE =
  import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? '' : 'http://localhost:7787')

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

// --- sessions ---------------------------------------------------------------
export const getSessions = (
  limit = 200,
  instance = '',
  archived: ArchivedScope = 'hide',
  period: SessionPeriod = '24h',
  source: SessionSourceScope = 'all',
) =>
  j<SessionSummary[]>(
    `/api/sessions?limit=${limit}${instance ? `&instance=${encodeURIComponent(instance)}` : ''}` +
      `${archived === 'hide' ? '' : `&archived=${archived}`}&period=${period}` +
      `${source === 'all' ? '' : `&source=${source}`}`,
  )
export const getSession = (id: string, source: SessionSource) =>
  j<SessionSummary>(`/api/sessions/${encodeURIComponent(id)}${sourceQuery(source)}`)
/** Set the user's own "done" mark on a session (distinct from Claude Desktop's read-only
 *  `archived` flag). Mark only: never affects which sessions getSessions() returns. */
const sourceQuery = (source: SessionSource) => `?source=${source}`

export const setSessionDone = (id: string, source: SessionSource, done: boolean) =>
  j<{ session_id: string; source: SessionSource; done: boolean }>(
    `/api/sessions/${encodeURIComponent(id)}/done${sourceQuery(source)}`,
    {
      method: 'POST',
      body: JSON.stringify({ done }),
    },
  )
/** Browser download URL for the raw transcript (save-as copy). API_BASE prefix: this
 *  URL lands in a plain <a href>, which unlike j() would otherwise resolve against the
 *  Vite dev origin instead of the daemon. */
export const sessionFileUrl = (id: string, source: SessionSource) =>
  `${API_BASE}/api/sessions/${encodeURIComponent(id)}/file${sourceQuery(source)}`
/** Get the original transcript's absolute path on the daemon's machine. */
export const getSessionFileLocation = (id: string, source: SessionSource) =>
  j<{ path: string }>(`/api/sessions/${encodeURIComponent(id)}/file-location${sourceQuery(source)}`)
/** Open the transcript on the daemon's machine with the OS default handler. */
export const openSessionFile = (id: string, source: SessionSource) =>
  j<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/open-file${sourceQuery(source)}`, {
    method: 'POST',
  })
/** Put the transcript FILE (not its text) on the clipboard of the daemon's machine, named after the
 *  session. The browser cannot do this — no ClipboardItem type maps to a native file-drop — so it's
 *  a daemon round-trip. `reason: 'unsupported'` comes back on Linux, which has no such convention. */
export const copySessionFile = (id: string, source: SessionSource) =>
  j<{ ok: boolean; filename?: string; reason?: string }>(
    `/api/sessions/${encodeURIComponent(id)}/copy-file${sourceQuery(source)}`,
    { method: 'POST' },
  )
export const getTail = (
  id: string,
  source: SessionSource,
  opts: { limit?: number; textOnly?: boolean } = {},
) =>
  j<TailResult>(
    `/api/sessions/${id}/tail?limit=${opts.limit ?? 40}&textOnly=${opts.textOnly ? '1' : '0'}&source=${source}`,
  )
/** Advanced BODY search: streams every transcript's raw content server-side (substring or
 *  regex, optionally case-sensitive). Deliberately separate from getSessions() above (slower,
 *  opt-in, and never used by the default fast client-side filter). */
export const searchSessionBodies = (
  query: string,
  opts: {
    regex?: boolean
    caseSensitive?: boolean
    instance?: string
    source?: SessionSource
  } = {},
) =>
  j<SessionSearchResult[]>(
    `/api/sessions/search?q=${encodeURIComponent(query)}` +
      `${opts.regex ? '&regex=1' : ''}` +
      `${opts.caseSensitive ? '&case=1' : ''}` +
      `${opts.instance ? `&instance=${encodeURIComponent(opts.instance)}` : ''}` +
      `${opts.source ? `&source=${opts.source}` : ''}`,
  )

// --- accounts ---------------------------------------------------------------
export const getAccounts = () => j<Account[]>('/api/accounts')
export const createAccount = (b: { label: string; auth_type: AuthType; secret: string }) =>
  j<Account>('/api/accounts', { method: 'POST', body: JSON.stringify(b) })
export const deleteAccount = (id: string) =>
  j<{ ok: boolean }>(`/api/accounts/${id}`, { method: 'DELETE' })

// --- queue ------------------------------------------------------------------
/** `instance_ref` value meaning "deliberately unpinned — run on the ambient CLI login", as opposed
 *  to an absent/null ref, which means "nobody said" and auto-resolves to the session's own desktop
 *  instance. Mirrors AMBIENT_RUN_AS in server/src/types.ts. */
export const AMBIENT_RUN_AS = 'ambient'
export interface NewQueueItem {
  session_id?: string
  title: string
  cwd: string
  prompt: string
  model?: string | null
  effort?: EffortLevel | null
  permission_mode?: PermissionMode | null
  account_id?: string | null
  /** Run under a signed-in instance's login: 'desktop:<dir>' or 'cli:<id>' (see server types.ts).
   *  OMIT (or null) on a resume to let the server pin the session's OWN desktop instance;
   *  AMBIENT_RUN_AS opts out of that and runs on the ambient CLI login. */
  instance_ref?: string | null
  new_chat: boolean
  fork: boolean
  /** ISO timestamp; the scheduler won't auto-dispatch before this. */
  not_before?: string | null
}
export const getQueue = () => j<QueueItem[]>('/api/queue')
export const createQueueItem = (b: NewQueueItem) =>
  j<QueueItem>('/api/queue', { method: 'POST', body: JSON.stringify(b) })
export const updateQueueItem = (id: string, patch: Partial<QueueItem>) =>
  j<QueueItem>(`/api/queue/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const deleteQueueItem = (id: string) =>
  j<{ ok: boolean }>(`/api/queue/${id}`, { method: 'DELETE' })
export const runQueueItem = (id: string) =>
  j<{ ok: boolean }>(`/api/queue/${id}/run`, { method: 'POST' })
/** Dispatch every due queued item now (ignores scheduler limits, honors the session lock). */
export const runDueQueueItems = () =>
  j<{ ok: boolean; started: number; skipped: number }>('/api/queue/run-due', { method: 'POST' })
export const cancelQueueItem = (id: string) =>
  j<{ ok: boolean }>(`/api/queue/${id}/cancel`, { method: 'POST' })
export const getRunEvents = (id: string) => j<RunEvent[]>(`/api/queue/${id}/events`)
export const streamUrl = (id: string) => `${API_BASE}/api/queue/${id}/stream`

// --- scheduler --------------------------------------------------------------
export const getScheduler = () => j<SchedulerState>('/api/scheduler')
export const updateScheduler = (b: Partial<SchedulerState>) =>
  j<SchedulerState>('/api/scheduler', { method: 'POST', body: JSON.stringify(b) })

// --- instances ----------------------------------------------------------------
// "instance account" = which Anthropic account a Claude Desktop *instance* is logged into
// (distinct from the sqlite `accounts` table above, which holds auth secrets for queue
// dispatch). See server/src/core/shared.ts for the DTO shapes.
export const listInstances = () => j<CMInstance[]>('/api/instances')
export const getInstanceAccount = (dir: string, opts: { noNetwork?: boolean } = {}) =>
  j<CMAccount>(
    `/api/instances/${encodeURIComponent(dir)}/account${opts.noNetwork ? '?noNetwork=1' : ''}`,
  )
export const openInstance = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/open`, { method: 'POST' })
/** `confirmExternal` is the explicit opt-in required to quit the DEFAULT (non-isolated) Claude
 *  Desktop — the server refuses that dir without it (see core/instances.ts quitInstance guard). */
export const quitInstance = (dir: string, opts: { confirmExternal?: boolean } = {}) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/quit`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
export const focusInstance = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/focus`, { method: 'POST' })
export const revealInstanceFolder = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/reveal`, { method: 'POST' })
/** Create a desktop launcher (.lnk on Windows) that opens this instance directly. The result's
 *  `data.path` holds where it landed; a failure carries the MSIX-aware message (same as open). */
export const createInstanceShortcut = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/shortcut`, { method: 'POST' })
export const deleteInstance = (dir: string, confirmName: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  })
/** Update an instance's UI metadata: display label (a pure relabel — never touches the folder,
 *  so it works while the instance runs), icon glyph, and icon color. A field present in the
 *  patch is applied (null clears it to the default); an omitted field is left unchanged. The
 *  result's `data` echoes the sanitized `{ label, icon, color }`. */
export const setInstanceMeta = (
  dir: string,
  patch: {
    label?: string | null
    icon?: InstanceIconKey | null
    color?: InstanceColorKey | null
  },
) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/meta`, {
    method: 'POST',
    body: JSON.stringify(patch),
  })
export const createInstance = (name: string) =>
  j<CMActionResult>('/api/instances', { method: 'POST', body: JSON.stringify({ name }) })
export const getDesktopInstall = (opts: { fresh?: boolean } = {}) =>
  j<CMDesktopInstall>(`/api/desktop-install${opts.fresh ? '?fresh=1' : ''}`)

/** Always-latest classic (Squirrel .exe) Claude Desktop installer — the only Windows build
 *  the Instances tab can launch. ~217 MB full installer; the claude.ai download page instead
 *  serves a ~7 MB ClaudeSetup.exe bootstrapper that installs the unmanageable MSIX build. */
export const CLASSIC_DESKTOP_INSTALLER_URL =
  'https://claude.ai/api/desktop/win32/x64/exe/latest/redirect'
/** Official download page (serves the MSIX bootstrapper for Windows — link kept for reference). */
export const DESKTOP_DOWNLOAD_PAGE_URL = 'https://claude.com/download'

// --- self-update --------------------------------------------------------------
/** /api/update returns the engine status PLUS the daemon's distribution: a 'compiled' (packaged
 *  release) build can't git-pull, so the UI hides the update controls and points at Releases. */
export type UpdateStatusWithDistribution = UpdateStatus & {
  distribution?: 'source' | 'compiled'
}
export const checkUpdate = () => j<UpdateStatusWithDistribution>('/api/update')
export const applyUpdate = () => j<UpdateApplyResult>('/api/update/apply', { method: 'POST' })

export interface AutoUpdateSettings {
  enabled: boolean
  intervalSecs: number
}
export const getAutoUpdateSettings = () => j<AutoUpdateSettings>('/api/update/settings')
export const updateAutoUpdateSettings = (b: Partial<AutoUpdateSettings>) =>
  j<AutoUpdateSettings>('/api/update/settings', { method: 'POST', body: JSON.stringify(b) })

// --- app shutdown -------------------------------------------------------------
/** Full app shutdown from the UI. The daemon drops the tray's shutdown sentinel and exits, so the
 *  tray tears the WHOLE app down (window + daemon + tray icon) rather than reviving the daemon.
 *  Same-origin and token-free by design: the `-shutdown-source: ui` header (no tray token) is what
 *  the daemon treats as a user "Shut down" (see server/src/index.ts /api/shutdown). */
export const shutdownApp = () =>
  j<{ ok: boolean }>('/api/shutdown', {
    method: 'POST',
    headers: { 'x-ccmanagerui-shutdown-source': 'ui' },
  })

// --- app settings (portable mode, hide tray icon, usage auto-refresh + section visibility) -------
/** Everything /api/settings returns: window/tray, usage, provider, and editor settings. */
export type AppSettings = PortableModeSettings &
  UsageSettings &
  ProviderSettings &
  TranscriptSettings
export const getSettings = () => j<AppSettings>('/api/settings')
export const updateSettings = (b: Partial<AppSettings>) =>
  j<AppSettings>('/api/settings', { method: 'POST', body: JSON.stringify(b) })
export const openPortableWindow = () =>
  j<PortableWindowResult>('/api/portable-window', { method: 'POST' })
export const createChatGptContextPack = (cwd: string, task: string) =>
  j<ChatGptContextPack>('/api/chatgpt/context-pack', {
    method: 'POST',
    body: JSON.stringify({ cwd, task }),
  })

// --- "Sync my settings with Connections" (see server/src/connections.ts) -----------------------
/** A handled sync failure — returned at HTTP 200 so it's non-blocking. */
export interface SyncErrorResult {
  ok: false
  error: string
}
export type SyncResult = SyncStatus | SyncErrorResult

/** Read the current sync status (enabled/connected/email/appearance/etc). */
export const getSyncStatus = () => j<SyncStatus>('/api/settings/sync')
/**
 * Turn sync on/off, disconnect, or push an updated appearance blob.
 * `{ enabled: true, appearance }` seeds/pulls; `{ enabled: false }` turns off (keeps the
 * connection); `{ enabled: false, forget: true }` disconnects fully.
 */
export const setSync = (b: {
  enabled?: boolean
  forget?: boolean
  appearance?: Record<string, unknown>
}) => j<SyncResult>('/api/settings/sync', { method: 'PUT', body: JSON.stringify(b) })
/** Force a pull of the remote synced settings now. */
export const syncPull = () => j<SyncResult>('/api/settings/sync/pull', { method: 'POST' })
/** Force a push of the current local settings now. */
export const syncPush = () => j<SyncResult>('/api/settings/sync/push', { method: 'POST' })

// --- usage-check subsystem (Feature B) -----------------------------------------
// Read an account's remaining Claude quota. A check is a ~300ms call to the same quota endpoint the
// CLI's `/usage` screen reads (it only falls back to spawning `claude` when no OAuth token works),
// and reading quota does not consume quota — so refreshing freely is fine. Results are cached
// server-side per key; pass refresh to force a fresh read.
/** Check a registered dispatch account's usage (by id or label). */
export const checkAccountUsage = (account: string, refresh = false) =>
  j<UsageCheckResult>(
    `/api/usage?account=${encodeURIComponent(account)}${refresh ? '&refresh=1' : ''}`,
  )
/** Check usage for a desktop instance (own token → linked CLI instance's login → dispatch account). */
export const checkDesktopInstanceUsage = (dir: string, refresh = false) =>
  j<UsageCheckResult>(
    `/api/instances/${encodeURIComponent(dir)}/usage${refresh ? '?refresh=1' : ''}`,
  )
/** The whole server-side usage cache, keyed by `desktop:<dir>` / `acct:<id>` / `cli:<id>` etc. */
export const getUsageCache = () =>
  j<{ cache: Record<string, UsageSnapshot>; lastAutoRefreshAt: string | null }>('/api/usage/cache')
/** Force one background refresh sweep now (the same pass the auto-refresh timer runs). */
export const refreshAllUsage = () =>
  j<{ ok: boolean; checked: number }>('/api/usage/refresh', { method: 'POST' })

// --- CLI instances (Feature A) -------------------------------------------------
export const listCliInstances = () => j<CliInstance[]>('/api/cli-instances')
export const createCliInstance = (name: string) =>
  j<CMActionResult>('/api/cli-instances', { method: 'POST', body: JSON.stringify({ name }) })
export const launchCliInstance = (id: string, opts: { model?: string; effort?: string } = {}) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/launch`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
/** Open a terminal for the USER to /login this CLI instance (the daemon never logs in itself). */
export const cliInstanceLogin = (id: string) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/login`, { method: 'POST' })
export const renameCliInstance = (id: string, name: string) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const associateCliInstance = (
  id: string,
  accountId: string | null,
  accountLabel?: string | null,
) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/associate`, {
    method: 'POST',
    body: JSON.stringify({ accountId, accountLabel }),
  })
/**
 * Link this CLI instance to a DESKTOP instance (pass null to unlink). They are normally the same
 * Anthropic account with two separate logins, so linking groups them in the UI and lets each act as
 * the other's usage-check fallback when one's token is expired.
 */
export const linkCliInstanceToDesktop = (
  id: string,
  desktopDir: string | null,
  desktopLabel?: string | null,
) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/link-desktop`, {
    method: 'POST',
    body: JSON.stringify({ desktopDir, desktopLabel }),
  })
export const deleteCliInstance = (id: string, confirmName: string) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  })
export const checkCliInstanceUsage = (id: string, refresh = false) =>
  j<UsageCheckResult>(
    `/api/cli-instances/${encodeURIComponent(id)}/usage${refresh ? '?refresh=1' : ''}`,
  )

// --- Codex CLI + Desktop instances -------------------------------------------
export const listCodexInstances = () => j<CodexInstance[]>('/api/codex-instances')
export const createCodexInstance = (name: string) =>
  j<CMActionResult>('/api/codex-instances', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const launchCodexInstance = (id: string, opts: { model?: string; effort?: string } = {}) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/launch`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
export const codexInstanceLogin = (id: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/login`, {
    method: 'POST',
  })
export const openCodexDesktopInstance = (id: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/desktop/open`, {
    method: 'POST',
  })
export const focusCodexDesktopInstance = (id: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/desktop/focus`, {
    method: 'POST',
  })
export const quitCodexDesktopInstance = (id: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/desktop/quit`, {
    method: 'POST',
  })
export const renameCodexInstance = (id: string, name: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const deleteCodexInstance = (id: string, confirmName: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  })

// --- auto-resume monitor (Feature E) -------------------------------------------
export const getMonitor = () => j<MonitorView>('/api/monitor')
export const updateMonitor = (b: Partial<MonitorSettings>) =>
  j<MonitorView>('/api/monitor', { method: 'POST', body: JSON.stringify(b) })
export const setMonitorAccount = (accountId: string, enabled: boolean) =>
  j<MonitorView>('/api/monitor/account', {
    method: 'POST',
    body: JSON.stringify({ accountId, enabled }),
  })
/** Force one monitor pass now (manual "check for resumable stops"). */
export const runMonitorCheck = () =>
  j<{ ok: boolean } & MonitorView>('/api/monitor/check', { method: 'POST' })
