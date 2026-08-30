import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { basename, join, relative } from 'node:path'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { type AgentPresence, detectAgentTools } from './agent-catalog'
import {
  activityReport,
  analyticsCoverage,
  concurrencyReport,
  dropAnalytics,
  recentEdits,
  refreshAnalytics,
  spendReport,
  warmAnalyticsInBackground,
} from './analytics'
import {
  autoUpdateEnabled,
  getAutoUpdateIntervalSecs,
  lastUpdateCheck,
  loadAutoUpdateSettings,
  recordUpdateCheck,
  setAutoUpdateEnabled,
  setAutoUpdateHooks,
  setAutoUpdateIntervalSecs,
  startAutoUpdate,
  stopAutoUpdate,
} from './auto-update'
import { markDispatchReady } from './boot-state'
import { chatDossier } from './chat-dossier'
import { chatGate } from './chat-gate'
import { resolveRequiredTitle } from './chat-title'
import {
  appEnv,
  CLIPBOARD_DIR,
  CONFIG_DIR,
  DATA_DIR,
  DATA_DIR_NOTICE,
  DB_PATH,
  HOST,
  IS_COMPILED,
  noAutoOpen,
  PORT,
  PORTABLE_WINDOW_SIZE,
  SERVICE_NAME,
  VERSION,
  WEB_DIST_CANDIDATES,
} from './config'
import {
  buildAuthorizeUrl,
  disable,
  enable,
  flushPending,
  handleCallback,
  initConnections,
  logout,
  pullNow,
  pushNow,
  syncStatus,
  updateAppearance,
} from './connections'
import { createChatGptContextPack } from './context-pack'
import { resolveAccount } from './core/accounts'
import {
  associateCliInstance,
  clearCliInstanceAccountAssociations,
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  launchCliInstance,
  linkCliInstanceToDesktop,
  listCliInstances,
  migrateCliInstanceConfigDirs,
  pruneCliInstanceAccountAssociations,
  renameCliInstance,
  setCliInstanceUsage,
} from './core/cli-instances'
import { codexUsageSnapshot, resolveCodexAccount } from './core/codex-account'
import {
  createCodexInstance,
  deleteCodexInstance,
  findCodexInstance,
  focusCodexDesktopInstance,
  launchCodexInstance,
  listCodexInstances,
  openCodexDesktopInstance,
  quitCodexDesktopInstance,
  renameCodexInstance,
} from './core/codex-instances'
import { detectDesktopInstall } from './core/desktop-install'
import { setInstanceMeta } from './core/instance-meta'
import { createInstanceModeShortcut } from './core/instance-mode-shortcut'
import {
  instanceForConfigDir,
  listAllInstances,
  resolveInstance,
  resolveInstanceError,
} from './core/instance-ref'
import {
  focusInstance,
  listInstances,
  openInstance,
  quitInstance,
  revealInstanceFolder,
} from './core/instances'
import {
  CLAUDE_LAUNCH_EFFORTS,
  CODEX_LAUNCH_EFFORTS,
  launchOptionError,
} from './core/launch-options'
import { createInstance, removeInstance } from './core/lifecycle'
import { INSTANCE_COLOR_KEYS, INSTANCE_ICON_KEYS } from './core/shared'
import { createInstanceShortcut } from './core/shortcut'
import { readUiPrefs, writeUiPrefs } from './core/ui-prefs'
import { courierPass } from './courier'
import { coerceQueueItem, db, getSetting, runOutcome, setSetting } from './db'
import { listDeliveries, parseDeliveryState } from './deliveries'
import { buildDetachedSpawn } from './detached-spawn.mjs'
import {
  activeCount,
  cancelItem,
  dispatchItem,
  getRunEvents,
  isActive,
  isSessionActive,
  type RunMessage,
  reattachRuns,
  startImportSweep,
  startRetrySweep,
  subscribeRun,
} from './dispatch'
import { contentDispositionAttachment, safeTranscriptFilename } from './filenames'
import { findFreePort } from './find-free-port.mjs'
import { fleetStatus } from './fleet'
import { fleetGit } from './fleet-git'
import { fleetInstances } from './fleet-instances'
import { fleetUsage } from './fleet-usage'
import { actOnGate, isActBusy, parseActInput } from './gate-actions'
import { parseSweepInput, sweepGateActions } from './gate-sweep'
import { cleanupStaleUpdateArtifacts } from './github-updater'
import { headlessRunsAllowed, NO_HEADLESS_REASON } from './headless-policy'
import { holdSession, listHolds, releaseSession } from './holds'
import {
  clearInstanceInfo,
  findLiveInstance,
  readInstanceInfo,
  singleInstanceProbeAttempts,
  updateInstanceInfo,
  writeInstanceInfo,
} from './instance'
import {
  findDesktopChat,
  instanceRefForSession,
  invalidateSessionMetaCache,
  resolveRunAsRef,
} from './instance-sessions'
import { initFileLogging } from './log-file.mjs'
import { isLoopbackOrigin, loopbackGuard } from './loopback-guard.mjs'
import {
  clearMonitorForAccount,
  getMonitorSettings,
  listMonitorAccounts,
  monitorStatus,
  runMonitorOnce,
  setMonitorForAccount,
  setMonitorSettings,
  startMonitor,
} from './monitor'
import { applyNewChatDefaults } from './new-chat-defaults'
import {
  getNotificationSettings,
  type NotificationSettingsPatch,
  setNotificationSettings,
} from './notify-settings'
import { openUi } from './open-ui'
import { openPortableWindow } from './portable-window.mjs'
import { prestartCheck } from './prestart'
import { startPriceCatalog } from './price-catalog'
import { getProviderSettings, setProviderSettings } from './provider-settings'
import { buildRelaunchArgv } from './relaunch-argv.mjs'
import {
  acknowledgeResetEvents,
  listResetEvents,
  sendTestNotification,
  startResetWatch,
} from './reset-watch'
import { schedulerState, setSchedulerSettings } from './scheduler'
import { captureScreen } from './screenshot'
import { dropSearchIndex, searchIndexStatus } from './search-index'
import { type ExportFormat, exportSession, scanSessionSecrets } from './session-export'
import {
  applyDesktopChatAutomation,
  archiveDesktopChat,
  desktopHomeFor,
  importSessionToDesktop,
  isSessionSuperseded,
  launchTerminalSession,
  liveSessionEntry,
} from './session-launch'
import { resumeSessionInTerminal } from './session-resume'
import { searchSessionBodies } from './session-search'
import { runCost, sessionUsage } from './session-usage'
import {
  getSession,
  listProjects,
  listSessions,
  sessionMarkKey,
  warmSessionScanCache,
} from './sessions'
import { isRelaunchSuccessor, RELAUNCH_FLAG, skipSingleInstanceGuard } from './single-instance'
import {
  isSweepTicking,
  parseSweepLoopPatch,
  runSweepLoopOnce,
  setSweepLoopSettings,
  startSweepLoop,
  sweepLoopStatus,
} from './sweep-loop'
import { findTranscriptAsync, listTranscriptFiles, tailTranscript } from './transcript'
import { buildTranscriptOpenArgv, resolveEditor } from './transcript-open'
import {
  type Account,
  AMBIENT_RUN_AS,
  type ArchivedScope,
  isDispatchedScope,
  isRateLimitScope,
  isSessionPeriod,
  isSessionSource,
  type MonitorView,
  periodCutoffMs,
  type QueueItem,
  type SessionPeriod,
  type SessionSource,
  type UsageCheckResult,
} from './types'
import { uiRenameChat } from './ui-archive'
import { updateProgress } from './update-progress'
import { applyUpdate, checkForUpdate } from './updater'
import {
  allCachedUsage,
  checkUsage,
  dropCachedUsage,
  getCachedUsage,
  isNoData,
  parseUsageOutput,
  setCachedUsage,
  usageAdvice,
} from './usage'
import { budgetSummary, buildUsageBudget } from './usage-budget'
import { dropUsageHistory } from './usage-history'
import {
  getUsageSettings,
  lastAutoRefreshAt,
  setUsageSettings,
  startUsageRefresh,
  sweepUsage,
} from './usage-refresh'
import {
  checkUsageForAccount,
  checkUsageForCliInstance,
  checkUsageForDesktop,
  codexKey,
  surveyUsage,
} from './usage-service'
import { WINDOW_SIZE_HINT_PARAM, windowSizeHintFor } from './window-size'

// Persist console output to <CONFIG_DIR>/logs/daemon.log BEFORE anything else can throw, so the
// crash reason logged just below actually survives the process (the tray runs us with a hidden
// console, so without this the output would vanish). Best-effort; never throws. Shared LunarWerx
// server-lib (./log-file.mjs); the config dir comes from CONFIG_DIR (config.ts), passed in
// explicitly since the shared lib is app-agnostic and has no built-in default.
initFileLogging(CONFIG_DIR)

// Last-resort crash handlers: an unhandled throw/rejection anywhere in the daemon logs what
// happened and exits non-zero instead of dying silently (or, for a rejection, limping on in an
// unknown state). The tray's health watchdog then sees the daemon go unresponsive and relaunches
// it; the console.error here is teed to daemon.log (above), so the reason is on disk even after
// the process is gone. process.exit is safe here; the daemon already exits deliberately in its
// own clean-shutdown paths below (unlike ReDesign, whose entry avoids it for undici's sake).
process.on('uncaughtException', (err) => {
  console.error('[agenthydra] uncaught exception:', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[agenthydra] unhandled rejection:', reason)
  process.exit(1)
})

// --- portable mode (server/src/db.ts settings table; see server/src/portable-window.mjs) ---
function portableModeEnabled(): boolean {
  return getSetting('portable_mode') === '1'
}
function setPortableMode(value: boolean): void {
  setSetting('portable_mode', value ? '1' : '0')
  updateInstanceInfo({ portableMode: value })
}

// --- hide tray icon (server/src/db.ts settings table; read live by misc/AgentHydra-Tray.ps1) ---
function hideTrayIconEnabled(): boolean {
  return getSetting('hide_tray_icon') === '1'
}
function setHideTrayIcon(value: boolean): void {
  setSetting('hide_tray_icon', value ? '1' : '0')
  updateInstanceInfo({ hideTrayIcon: value })
}

// Dispatch-argv enums, validated SERVER-SIDE (the MCP/web schemas are advisory only). permission_mode
// especially: it flows into `claude --permission-mode <v>` (dispatch.ts buildArgv), and
// `bypassPermissions` runs every tool with no approval — so a garbage/unexpected value must be
// rejected here, never passed through to the CLI. A null/absent value is fine (CLI default).
const VALID_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan'])
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const VALID_QUEUE_STATUSES = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'rate_limited',
  'overloaded',
  'canceled',
])
/** Returns an error string if the field is present-but-invalid, else null. */
function invalidEnum(value: unknown, valid: Set<string>, field: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || !valid.has(value))
    return `${field} must be one of: ${[...valid].join(', ')}`
  return null
}

/** Parse a request JSON body as an object. Anything non-object — malformed JSON OR a valid but
 *  non-object literal (`null`, `42`, `"x"`) — degrades to `{}`, so the downstream `body.x` /
 *  `'x' in body` reads never throw a 500 on a hostile or empty body. This is the leniency every
 *  mutating handler here relies on; use it instead of `(await c.req.json().catch(() => ({})))`,
 *  whose `.catch` only covers malformed JSON and still lets a literal `null` crash the reads. */
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const parsed = await c.req.json().catch(() => null)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

/** `min` defaults to 1 because every caller but the paging offset is a count, and a count of zero
 *  is a caller asking for nothing. An offset of zero is page one, so it passes min = 0. */
function boundedQueryInt(raw: string | undefined, fallback: number, max: number, min = 1): number {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * A point in time from a query string: epoch milliseconds, or anything Date can parse (ISO-8601).
 *
 * Both forms, because the two callers want different ones — a UI computes a number, and a person
 * or an agent writing a URL by hand writes "2026-08-01". Anything unparseable returns null, which
 * every caller reads as "no bound", so a typo widens the answer rather than silently emptying it.
 */
function queryEpoch(raw: string | undefined): number | null {
  if (!raw) return null
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && raw.trim() !== '') return asNumber
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

function listAccounts(): Account[] {
  return db
    .query<
      { id: string; label: string; auth_type: string; secret: string; created_at: number },
      []
    >('select * from accounts order by created_at asc')
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      auth_type: r.auth_type as Account['auth_type'],
      secret_masked: maskSecret(r.secret),
      created_at: r.created_at,
    }))
}

const app = new Hono()
// CORS narrowed to loopback origins (defense-in-depth for cross-origin READABILITY); the actual
// cross-site protection is loopbackGuard below, which rejects the REQUEST — see loopback-guard.ts
// for why a CORS allowlist alone is insufficient (the "simple request" write-CSRF bypasses it).
app.use('/api/*', cors({ origin: (origin) => (origin && isLoopbackOrigin(origin) ? origin : '') }))
// Reject browser cross-site requests to the loopback API (drive-by CSRF → RCE). Runs after cors so
// preflight OPTIONS is answered by cors; applies to every /api/* verb. NOT applied to /oauth/*
// (those are legitimate cross-site top-level navigations returning from the OAuth provider).
app.use('/api/*', loopbackGuard)
// No API route needs a multi-megabyte body. Bound parser memory even for a deliberate local/MCP
// misuse; the provenance guard runs first so a rejected browser origin is never allowed to stream.
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: 'request body exceeds 2 MiB' }, 413),
  }),
)

// --- health (also the single-instance probe: body.service must equal SERVICE_NAME) ---
// `dataDir`/`dbPath` are here for one reason: a daemon started from a checkout and the installed
// one used to open DIFFERENT sqlite files, and every forensic session that hit it wasted its time
// reading the wrong database with total confidence. They resolve to one place now, and this states
// which place, so the question is answered by looking rather than by inferring from `distribution`.
// `dataDirNotice` is non-null only when a second, unused state directory is still sitting there.
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    distribution: IS_COMPILED ? 'compiled' : 'source',
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    dataDirNotice: DATA_DIR_NOTICE,
    ts: Date.now(),
  }),
)

// --- self-update (source: git engine; compiled: GitHub Releases — see server/src/updater.ts) --
app.get('/api/update', async (c) => {
  const status = await checkForUpdate()
  // Feed the passive hint with this REAL check, not just the background tick's. Otherwise opening
  // Settings could tell you an update exists while the dot beside it stayed dark for hours.
  recordUpdateCheck(status)
  return c.json({
    ...status,
    // Informational: which mechanism is live. Both compiled + source support check/apply now, so
    // the UI drives the same controls for either; this just lets a caller distinguish them.
    distribution: IS_COMPILED ? 'compiled' : 'source',
    autoUpdate: { enabled: autoUpdateEnabled(), intervalSecs: getAutoUpdateIntervalSecs() },
  })
})
/**
 * The last BACKGROUND check's answer — a plain memory read, no network, no git.
 *
 * Deliberately separate from GET /api/update, which performs a real check: this one is cheap enough
 * for the whole app to poll on a timer, which is what lets an "update available" hint live outside
 * the Settings screen. Before it existed, the only code that ever asked was SettingsView's
 * onMounted, so a user who never opened Settings was never told an update existed.
 *
 * `checked: false` means the first background tick has not landed yet (the loop's first run is one
 * interval out, so a cold boot spends no network on it) — the UI shows nothing rather than
 * asserting "up to date" on the strength of never having looked.
 */
app.get('/api/update/available', (c) => {
  const last = lastUpdateCheck()
  if (!last) return c.json({ checked: false, updateAvailable: false })
  return c.json({
    checked: true,
    checkedAt: last.at,
    updateAvailable: last.status.ok && last.status.updateAvailable,
    canApply: last.status.canApply,
    currentVersion: last.status.currentVersion,
    latestVersion: last.status.remoteCommit,
    reason: last.status.reason,
    autoApply: autoUpdateEnabled(),
  })
})
// Where a running apply currently is (see server/src/update-progress.ts). A plain memory read, so
// the UI can poll it every second while its POST /api/update/apply is still in flight — that
// request covers minutes of real work and used to report nothing until it finished.
app.get('/api/update/progress', (c) => c.json(updateProgress()))
app.post('/api/update/apply', async (c) => {
  const result = await applyUpdate()
  // A compiled apply swapped the binary on disk; the running process is still the OLD one, so it
  // MUST relaunch for the update to take effect (a source apply leaves the daemon to be restarted
  // manually — restartGuidance in the UI — matching its historical behavior).
  //
  // The delay is the whole point, and 250ms was too short. relaunchDaemon exits the process 800ms
  // after IT is called, so at 250ms the socket carrying this very response died about a second
  // after the response was written — and a client that had not finished reading by then saw the
  // request fail on an update that had in fact succeeded. That is the "clicked update, it just span
  // forever" report: the work was done in a few seconds and the news never arrived.
  //
  // Three seconds costs a user nothing (the app is about to restart under them either way) and is
  // far more time than a loopback response needs to flush. The client also recovers on its own now
  // by polling /api/health (composables/useUpdates.ts) — belt and braces, because this end of it
  // can only ever be a race that is made unlikely, never one that is closed.
  if (IS_COMPILED && result.ok && result.restartRequired) {
    setTimeout(() => relaunchDaemon(), 3000)
  }
  return c.json(result)
})

// --- auto-update settings (background loop; see server/src/auto-update.ts) -------------------
app.get('/api/update/settings', (c) =>
  c.json({ enabled: autoUpdateEnabled(), intervalSecs: getAutoUpdateIntervalSecs() }),
)
app.post('/api/update/settings', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.enabled === 'boolean') setAutoUpdateEnabled(body.enabled)
  if (typeof body.intervalSecs === 'number') setAutoUpdateIntervalSecs(body.intervalSecs)
  return c.json({ enabled: autoUpdateEnabled(), intervalSecs: getAutoUpdateIntervalSecs() })
})

// --- app settings (portable mode, hide tray icon, usage auto-refresh; see server/src/db.ts) ------
const appSettings = () => ({
  portableMode: portableModeEnabled(),
  hideTrayIcon: hideTrayIconEnabled(),
  transcriptEditor: getSetting('transcript_editor'),
  transcriptEditorResolved: resolveEditor(
    process.platform,
    getSetting('transcript_editor'),
    process.env,
    existsSync,
  ),
  ...getUsageSettings(),
  ...getProviderSettings(),
  // Notification settings ride the same envelope as every other app setting so the web app keeps
  // ONE settings round-trip. The SMTP password is not in here by construction — the DTO carries
  // `notifySmtpPassSet` instead (see notify-settings.ts).
  ...getNotificationSettings(),
})
// Cross-window UI preferences (see core/ui-prefs.ts). Deliberately NOT folded into /api/settings:
// these are a mirror of the browser's own localStorage, written on every toggle, and they must be
// served identically by the quick-instances daemon — which has no settings surface at all.
app.get('/api/ui-prefs', (c) => c.json({ prefs: readUiPrefs() }))
app.post('/api/ui-prefs', async (c) => c.json({ prefs: writeUiPrefs(await jsonBody(c)) }))
app.get('/api/settings', (c) => c.json(appSettings()))
app.post('/api/settings', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.portableMode === 'boolean') setPortableMode(body.portableMode)
  if (typeof body.hideTrayIcon === 'boolean') setHideTrayIcon(body.hideTrayIcon)
  if (typeof body.transcriptEditor === 'string')
    setSetting('transcript_editor', body.transcriptEditor.trim())
  // setUsageSettings re-arms the background timer, so flipping autoRefresh takes effect immediately
  // (no daemon restart).
  setUsageSettings({
    autoRefresh: typeof body.autoRefresh === 'boolean' ? body.autoRefresh : undefined,
    autoRefreshIntervalMin:
      typeof body.autoRefreshIntervalMin === 'number' ? body.autoRefreshIntervalMin : undefined,
    showDesktopInstances:
      typeof body.showDesktopInstances === 'boolean' ? body.showDesktopInstances : undefined,
    showCliInstances:
      typeof body.showCliInstances === 'boolean' ? body.showCliInstances : undefined,
  })
  setProviderSettings({
    codexDesktopEnabled:
      typeof body.codexDesktopEnabled === 'boolean' ? body.codexDesktopEnabled : undefined,
    codexCliEnabled: typeof body.codexCliEnabled === 'boolean' ? body.codexCliEnabled : undefined,
    chatGptHandoffEnabled:
      typeof body.chatGptHandoffEnabled === 'boolean' ? body.chatGptHandoffEnabled : undefined,
  })
  // Notifications: whitelisted field by field, same as the blocks above. setNotificationSettings
  // ignores anything absent, so a patch touching one toggle leaves the rest (and the stored SMTP
  // password) alone.
  setNotificationSettings(notificationPatch(body))
  return c.json(appSettings())
})

// --- reset notifications (server/src/reset-watch.ts) ---------------------------------------------

/** Narrow an untyped request body to the notification patch, dropping anything mistyped. Split out
 *  of the settings handler because the same shape is accepted on the dedicated route below. */
function notificationPatch(body: Record<string, unknown>): NotificationSettingsPatch {
  const b = (k: string) => (typeof body[k] === 'boolean' ? (body[k] as boolean) : undefined)
  const n = (k: string) =>
    typeof body[k] === 'number' && Number.isFinite(body[k]) ? (body[k] as number) : undefined
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
  return {
    notifyEnabled: b('notifyEnabled'),
    notifySessionReset: b('notifySessionReset'),
    notifyWeeklyReset: b('notifyWeeklyReset'),
    notifyMinPct: n('notifyMinPct'),
    notifySessionMaxWeeklyPct: n('notifySessionMaxWeeklyPct'),
    notifyDesktop: b('notifyDesktop'),
    notifyPersistent: b('notifyPersistent'),
    notifyPersistentIntervalMin: n('notifyPersistentIntervalMin'),
    notifyPersistentMaxRepeats: n('notifyPersistentMaxRepeats'),
    notifyEmail: b('notifyEmail'),
    notifyEmailTo: s('notifyEmailTo'),
    notifyEmailFrom: s('notifyEmailFrom'),
    notifySmtpHost: s('notifySmtpHost'),
    notifySmtpPort: n('notifySmtpPort'),
    notifySmtpSecure: b('notifySmtpSecure'),
    notifySmtpUser: s('notifySmtpUser'),
    notifySmtpPass: s('notifySmtpPass'),
  }
}

/** Open reset events (newest first) — what the UI polls to raise its in-app toast. */
app.get('/api/notifications/events', (c) => c.json(listResetEvents()))

/** Acknowledge one event, or every open one when `id` is omitted. Acking stops persistent repeats. */
app.post('/api/notifications/ack', async (c) => {
  const body = await jsonBody(c)
  const id = typeof body.id === 'string' && body.id ? body.id : undefined
  return c.json(acknowledgeResetEvents(id))
})

/** Fire a test notification through the configured channels. Without this, verifying an SMTP
 *  config or a muted Windows toast would mean waiting up to five hours for a real reset. */
app.post('/api/notifications/test', async (c) => c.json(await sendTestNotification()))

// Manual handoff only: create a bounded local context attachment, then the browser opens ChatGPT
// and the user chooses what to send. No ChatGPT credentials, cookies, prompts, or responses cross
// this API.
app.post('/api/chatgpt/context-pack', async (c) => {
  if (!getProviderSettings().chatGptHandoffEnabled)
    return c.json({ error: 'ChatGPT handoff is disabled in Settings → Providers.' }, 403)
  const body = await jsonBody(c)
  if (typeof body.cwd !== 'string' || !body.cwd.trim())
    return c.json({ error: 'cwd is required' }, 400)
  if (typeof body.task !== 'string' || !body.task.trim())
    return c.json({ error: 'task is required' }, 400)
  try {
    return c.json(createChatGptContextPack(body.cwd, body.task))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

// --- "Sign in with Connections" + settings-sync (see server/src/connections.ts) ----------------
// Loopback-only daemon: no auth gate, no session cookie; "signed in" simply means the daemon
// holds a refresh token. Login/callback are full-page navigations (not /api), matching the
// family pattern (DevWebUI).
app.get('/oauth/login', async (c) => {
  try {
    const origin = new URL(c.req.url).origin
    if (!isLoopbackOrigin(origin)) return c.redirect('/?connect=failed')
    const url = await buildAuthorizeUrl(origin)
    return c.redirect(url)
  } catch {
    return c.redirect('/?connect=failed')
  }
})
app.get('/oauth/callback', async (c) => {
  const origin = new URL(c.req.url).origin
  if (!isLoopbackOrigin(origin)) return c.redirect('/?connect=failed')
  const code = c.req.query('code')
  const stateTok = c.req.query('state')
  let ok = false
  if (code && stateTok) {
    try {
      ok = await handleCallback(origin, code, stateTok)
    } catch {
      ok = false
    }
  }
  // If sync was already enabled before this sign-in, converge now that we have a token: pull the
  // remote doc (applying it) OR seed the store from local if the remote is empty. Runs in the
  // background so the redirect never waits on the network.
  if (ok && syncStatus().enabled) void enable().catch(() => {})
  return c.redirect(ok ? '/?connected=1' : '/?connect=failed')
})

/** Run a sync op and turn any failure into an inline `{ ok:false, error }` (HTTP 200,
 *  non-fatal; the daemon keeps using local settings and the UI surfaces the reason). */
async function guardSync<T extends object>(
  c: import('hono').Context,
  run: () => Promise<T>,
): Promise<Response> {
  try {
    return c.json(await run())
  } catch (e) {
    const err = e as { code?: string; message?: string }
    const code = err.code ?? (err.message === 'not_signed_in' ? 'not_signed_in' : 'sync_failed')
    return c.json({ ok: false, error: code })
  }
}
app.get('/api/settings/sync', (c) => c.json(syncStatus()))
app.put('/api/settings/sync', async (c) => {
  const b = (await jsonBody(c)) as {
    enabled?: boolean
    forget?: boolean
    appearance?: Record<string, unknown>
  }
  return guardSync(c, async () => {
    if (b.enabled === true) {
      const { status } = await enable(b.appearance)
      return status
    }
    if (b.enabled === false) return disable(b.forget === true)
    if (b.appearance && typeof b.appearance === 'object') await updateAppearance(b.appearance)
    return syncStatus()
  })
})
app.post('/api/settings/sync/pull', (c) =>
  guardSync(c, async () => {
    await pullNow()
    return syncStatus()
  }),
)
app.post('/api/settings/sync/push', (c) =>
  guardSync(c, async () => {
    await pushNow()
    return syncStatus()
  }),
)
app.post('/api/settings/sync/logout', async (c) => {
  await logout()
  return c.json({ ok: true })
})

// --- sessions -----------------------------------------------------------------
app.get('/api/sessions', async (c) => {
  const limit = c.req.query('limit')
  const instance = c.req.query('instance')
  // Anything unrecognized falls back to 'hide': a typo'd scope should show the live list, never
  // silently bury it under the archived majority.
  const archived = c.req.query('archived')
  const scope: ArchivedScope = archived === 'include' || archived === 'only' ? archived : 'hide'
  // Same defensive read as the scope above: an unrecognized period falls back to the default
  // window rather than quietly widening the list to everything on disk.
  const rawPeriod = c.req.query('period')
  const period: SessionPeriod = isSessionPeriod(rawPeriod) ? rawPeriod : '24h'
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : 'all'
  // Unrecognized narrows to nothing, so this one falls back to 'all' as well: never let a bad
  // parameter hide sessions.
  const rawDispatched = c.req.query('dispatched')
  const dispatched = isDispatchedScope(rawDispatched) ? rawDispatched : 'all'
  // Same defensive read once more: an unrecognized value must never narrow the list.
  const rawRateLimited = c.req.query('ratelimited')
  const rateLimited = isRateLimitScope(rawRateLimited) ? rawRateLimited : 'all'
  // An explicit `since` OUTRANKS `period`, and `until` has no period equivalent at all. The canned
  // windows exist because the UI wants three buttons; a caller reconstructing a past week (an MCP
  // client asked to summarise last month, say) needs real bounds, and telling it to fetch 'all' and
  // filter client-side is how a 1,200-session store gets streamed to answer a 20-row question.
  const since = queryEpoch(c.req.query('since'))
  const until = queryEpoch(c.req.query('until'))
  return c.json(
    await listSessions({
      limit: boundedQueryInt(limit, 200, 500),
      offset: boundedQueryInt(c.req.query('offset'), 0, 100_000, 0),
      instance: instance || undefined,
      archived: scope,
      sinceMs: since ?? periodCutoffMs(period),
      untilMs: until,
      source,
      dispatched,
      rateLimited,
      project: c.req.query('project') || undefined,
    }),
  )
})
// Every folder that has conversations in it, from the index alone (no transcript reads). This is
// how a client that was told "search all my chat histories" finds out what "all" is: the session
// list only ever answers newest-N, so without this there is no way to learn that a project exists
// before asking about it. MUST STAY ABOVE `/api/sessions/:id` for the reason spelled out below.
app.get('/api/sessions/projects', async (c) => c.json(await listProjects()))
// Advanced BODY search (streams every transcript file, substring or regex); deliberately a
// separate, slower, opt-in path so the fast metadata list above (GET /api/sessions, used by the
// default client-side filter) is never touched by this. See server/src/session-search.ts.
//
// MUST STAY ABOVE `/api/sessions/:id`. Both are two-segment routes, and the param one wins when it
// is registered first — which is how this endpoint spent its whole life answering
// `{"error":"session not found"}` to every content search, in the SPA and over MCP alike. Adding a
// route below this line that could be read as a session id will break it again.
app.get('/api/sessions/search', async (c) => {
  const query = c.req.query('q') ?? ''
  const regex = c.req.query('regex') === '1'
  const caseSensitive = c.req.query('case') === '1'
  const instance = c.req.query('instance') || undefined
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const limit = boundedQueryInt(c.req.query('limit'), 50, 200)
  // `everything=1` forces the exhaustive scan: every byte of every transcript, tool output
  // included. The index answers faster and completely, but only over what was SAID, so the way
  // past its two limits is an explicit parameter rather than a hidden heuristic.
  const mode = c.req.query('everything') === '1' ? 'scan' : 'auto'
  try {
    // A blank query returns the same SHAPE as a real search rather than an empty array — a caller
    // that has to special-case "did I get results or a response object?" will get it wrong.
    return c.json(
      await searchSessionBodies({ query, regex, caseSensitive, instance, source, limit, mode }),
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
// ONE query, everything the system knows about a chat: metadata + archive flag as it sits on
// disk right now, lineage ids across auto-compact rolls, done-mark, and the live process
// hosting it (if any). Built 2026-08-28 because answering "what happened to chat X" used to
// take an hour of hand-joins across the stores that each hold a quarter of the answer.
// Query by title fragment or ANY id.
// --- the gate (orchestrator rebuild, piece 8 - see server/src/chat-gate.ts) -----------------
// THE mandatory pre-action call: what state is this chat in - running, crashed, or finished
// (with the finished lane pre-classified and the evidence packaged). Deterministic, read-only.
app.get('/api/chats/:id/gate', (c) => {
  const id = c.req.param('id').trim()
  if (!id) return c.json({ error: 'session id required' }, 400)
  const gate = chatGate(id)
  if (!gate) return c.json({ error: 'unknown-session: no transcript found for this id' }, 404)
  return c.json(gate)
})
// --- acting on the verdict (orchestrator rebuild, piece 9 - see server/src/gate-actions.ts) --
// The gate's second half: re-gates the chat itself (a caller-supplied state is never trusted)
// and performs the deterministic deed - archive, surface-for-resume (with the owner's 85%
// overflow rule deciding whether a closed instance may be booted), wait-for-reset, or an
// honest park. The needs-input-review lane carries the caller's autonomy judgment in the body.
app.post('/api/chats/:id/act', async (c) => {
  const id = c.req.param('id').trim()
  if (!id) return c.json({ error: 'session id required' }, 400)
  const body = await jsonBody(c)
  const parsed = parseActInput(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  const result = await actOnGate(id, parsed.input)
  if (!result)
    return c.json(
      {
        error:
          'unknown-session: no transcript found for this id - what cannot be gated cannot be acted on',
      },
      404,
    )
  return c.json(result)
})
// --- the sweep (owner-authorized 2026-08-30) - see server/src/gate-sweep.ts -----------------
// Gate every visible desktop chat (or the given ids) and act within caps, sequentially.
// Caps of 0 make it a pure report. The needs-input lane is never auto-acted: the response
// packages its evidence for the caller's judgment.
app.post('/api/chats/sweep', async (c) => {
  const parsed = parseSweepInput(await jsonBody(c))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  return c.json(await sweepGateActions(parsed.opts))
})
// --- the pre-start check (owner directive 2026-08-30) - see server/src/prestart.ts ----------
// READ-ONLY: the census (instances, then every chat across them), the sanity rail (one open
// instance = detection is wrong, by the owner's own word), the full pure-report gate sweep,
// the big-picture next step per chat, and the junk lists. The FIRST call of any orchestration.
app.get('/api/prestart', async (c) => c.json(await prestartCheck()))
// --- the delivery ledger (deliveries.ts) ----------------------------------------------------
// What the act path staged for surfaced chats and whether anything ever delivered it. The
// list reconciles first (delivered / deaf / expired settled from transcript+registry
// evidence), so the answer is always current. The daemon never SENDS - that stays with an AI
// session's native per-instance channel, per the measured boundary and the no-relay ban.
app.get('/api/deliveries', (c) => {
  const parsed = parseDeliveryState(c.req.query('state'))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  return c.json({ deliveries: listDeliveries(parsed.state) })
})
// --- per-chat automation opt-out - see server/src/holds.ts ----------------------------------
// A hold stops the UNATTENDED machinery touching one chat (no archive, no surface, no
// delivery) while leaving directly requested deeds working. The reason is required.
app.get('/api/holds', (c) => c.json({ holds: listHolds() }))
app.post('/api/sessions/:id/hold', async (c) => {
  const body = await jsonBody(c)
  const r = holdSession(c.req.param('id'), typeof body.reason === 'string' ? body.reason : '')
  return c.json(r, r.ok ? 200 : 400)
})
app.post('/api/sessions/:id/release', (c) => c.json(releaseSession(c.req.param('id'))))

// --- rename a chat through the app's own control ---------------------------------------------
// The one write the daemon cannot make on disk: a RUNNING app holds its chat list in memory and
// re-saves over any file edit. It exists because an IMPORTED chat renders as 'Untitled' whatever
// its disk title says, and an untitled chat is both a naming-law violation and undeliverable -
// the courier aims by rendered name, so it reports those rows as no-title and stops. This is a
// DIRECT request only (never on the machinery's own initiative), so a hold does not gate it.
app.post('/api/chats/:id/rename', async (c) => {
  const body = await jsonBody(c)
  const newTitle = typeof body.new_title === 'string' ? body.new_title.trim() : ''
  if (!newTitle) return c.json({ ok: false, detail: 'new_title is required' }, 400)
  const chat = findDesktopChat(c.req.param('id'))
  if (!chat?.instance)
    return c.json({ ok: false, detail: 'no desktop instance holds this chat' }, 404)
  // The app matches rows by what it RENDERS, which is not always the disk title (that mismatch
  // is the whole reason this route exists), so the caller may name the on-screen row itself.
  const from =
    typeof body.current_title === 'string' && body.current_title.trim()
      ? body.current_title.trim()
      : chat.title
  if (!from)
    return c.json(
      { ok: false, detail: "this chat's current on-screen name is unknown - pass current_title" },
      400,
    )
  return c.json(await uiRenameChat(chat.instance, from, newTitle))
})

// --- the courier (rebuild backlog) - see server/src/courier.ts ------------------------------
// Delivers each pending staged prompt by driving that chat's OWN composer in the running app
// (ui-deliver.ts), after proving the target's conversation is on screen. GET plans without
// typing anything; POST delivers.
app.get('/api/couriers', async (c) => c.json(await courierPass({ act: false })))
app.post('/api/couriers/run', async (c) => c.json(await courierPass({ act: true })))
// --- the standing sweep loop (rebuild backlog) - see server/src/sweep-loop.ts ---------------
// OFF by default; unattended-safe caps (archive unlimited, surface 0 - no deliverer, no
// dormant parking). The last report is served verbatim so the loop's work is inspectable.
app.get('/api/sweep-loop', (c) => c.json(sweepLoopStatus()))
app.post('/api/sweep-loop', async (c) => {
  const parsed = parseSweepLoopPatch(await jsonBody(c))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  setSweepLoopSettings(parsed.patch)
  return c.json(sweepLoopStatus())
})
app.post('/api/sweep-loop/check', async (c) => {
  // Run one tick NOW regardless of the enabled switch (the "check now" pattern the monitor
  // has); the tick still applies the configured caps and the act lock.
  const report = await runSweepLoopOnce({ force: true })
  return c.json({ ran: report !== null, ...sweepLoopStatus() })
})
app.get('/api/chats/dossier', (c) => {
  const q = c.req.query('q') ?? ''
  if (!q.trim())
    return c.json({ error: 'q required: a title fragment or any session/chat id' }, 400)
  return c.json(chatDossier(q.trim()))
})
app.get('/api/sessions/:id', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const s = await getSession(c.req.param('id'), source)
  return s ? c.json(s) : c.json({ error: 'session not found' }, 404)
})
// The user's own mark (distinct from Claude Desktop's read-only isArchived, surfaced via
// include_archived above). Mark only: never used to filter listSessions.
app.post('/api/sessions/:id/done', async (c) => {
  const id = c.req.param('id')
  const rawSource = c.req.query('source')
  const source: SessionSource = isSessionSource(rawSource) ? rawSource : 'claude'
  const body = await jsonBody(c)
  const done = body.done === true
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, ?, ?) ' +
      'on conflict(session_id) do update set done = ?, updated_at = ?',
  ).run(sessionMarkKey(source, id), done ? 1 : 0, Date.now(), done ? 1 : 0, Date.now())
  return c.json({ session_id: id, source, done })
})
// Download a copy of the raw transcript (browser save-as; works over remote too). The filename is
// the session TITLE, not the raw id — the same safeTranscriptFilename the SPA's <a download> uses,
// so the two agree in every deployment shape (the browser honors the <a> name only same-origin and
// this header only cross-origin). getSession re-derives the title (cheap: scanMeta is mtime-cached
// and the sessions list nearly always warmed it first); fall back to the id if the lookup misses.
app.get('/api/sessions/:id/file', async (c) => {
  const id = c.req.param('id')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const tf = await findTranscriptAsync(id, source)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode')
    return c.json(
      { error: 'OpenCode sessions are stored in a shared database, not a raw file' },
      409,
    )
  const session = await getSession(id, tf.source)
  const filename = safeTranscriptFilename(session?.title, tf.session_id)
  return new Response(Bun.file(tf.path), {
    headers: {
      'content-type': 'application/jsonl; charset=utf-8',
      'content-disposition': contentDispositionAttachment(filename),
    },
  })
})
// A readable export: Markdown, or one self-contained HTML file. Reads the WHOLE transcript, not the
// tail window the viewer shows, because a silently truncated document is worse than none. Secrets
// in recognisable formats are replaced on the way out and the document says so — this path exists
// to produce something you send somewhere. See server/src/session-export.ts.
app.get('/api/sessions/:id/export', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const format: ExportFormat = c.req.query('format') === 'html' ? 'html' : 'markdown'
  const thinking = c.req.query('thinking') === '1' || c.req.query('thinking') === 'true'
  const id = c.req.param('id')
  // The transcript index carries no title for a Claude session, so without this the document is
  // headed with a uuid and the file is named after one twice. getSession derives the real title the
  // list shows (cheap: scanMeta is mtime-cached), exactly as the raw-file download does.
  const session = await getSession(id, source)
  const result = await exportSession(id, format, source, {
    thinking,
    title: session?.title,
    cwd: session?.cwd,
  })
  if (!result) return c.json({ error: 'session not found' }, 404)
  return new Response(result.body, {
    headers: {
      'content-type': result.contentType,
      'content-disposition': contentDispositionAttachment(result.filename),
      // What the export left out, for a caller that wants to say so without parsing the document.
      'x-agenthydra-redacted': String(result.redacted),
    },
  })
})
// Reopen a finished session in a real terminal (`claude --resume <id>`), and hand back the command
// line either way so "copy the command" works even where no terminal could be opened. See
// server/src/session-resume.ts.
app.post('/api/sessions/:id/resume-terminal', async (c) => {
  const id = c.req.param('id')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const tf = await findTranscriptAsync(id, source)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  const session = await getSession(id, tf.source)
  return c.json(resumeSessionInTerminal(id, tf.source, session?.cwd || null))
})
// What secrets this session printed, as a count and a redacted list. There is deliberately no
// reveal parameter: the transcript is already open in the viewer on this machine, so this endpoint
// can only add a way to lose credentials, never a way to see something otherwise unreachable.
app.get('/api/sessions/:id/secrets', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const scan = await scanSessionSecrets(c.req.param('id'), source)
  if (!scan) return c.json({ error: 'session not found' }, 404)
  return c.json(scan)
})
// Return the original transcript's absolute location so the SPA can copy it as plain text.
// Resolve it here rather than reconstructing it in the browser: project-folder encoding is lossy,
// and findTranscript also handles the rare case where the same session id exists in two folders.
app.get('/api/sessions/:id/file-location', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const tf = await findTranscriptAsync(c.req.param('id'), source)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode')
    return c.json({ error: 'OpenCode sessions are stored in a shared database' }, 409)
  return c.json({ path: tf.path })
})
// Open the transcript in an editor (loopback daemon: same posture as the portable-window spawn;
// the file opens on the machine the daemon runs on). .jsonl has no OS file association, so handing
// this to the bare default handler would pop Windows' "Pick an app" dialog instead of opening -
// buildTranscriptOpenArgv names an editor explicitly so that never happens (transcript-open.ts).
app.post('/api/sessions/:id/open-file', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const tf = await findTranscriptAsync(c.req.param('id'), source)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode')
    return c.json({ error: 'OpenCode sessions are stored in a shared database' }, 409)
  const cmd = buildTranscriptOpenArgv(
    process.platform,
    tf.path,
    getSetting('transcript_editor'),
    process.env,
    existsSync,
  )
  try {
    Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }).unref()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 500)
  }
})
/**
 * Copy the transcript FILE ITSELF to the OS clipboard — so Ctrl+V in Explorer, Slack or a mail
 * client pastes the .jsonl, not its text.
 *
 * This has to be the daemon's job: a web page cannot do it at all. `navigator.clipboard.write()`
 * only accepts blobs the page itself constructs (text/html/png and friends); no ClipboardItem type
 * maps to a native file-drop (Windows CF_HDROP / macOS NSFilenamesPasteboardType), because letting
 * a page assert "there is a file at this path on your disk" is a filesystem-disclosure primitive.
 * The daemon is already local and already shells out for the sibling open-file route, so it can.
 *
 * The path reaches PowerShell through the ENVIRONMENT, never string-interpolated into -Command: a
 * session title can legally contain a quote or a `$`, and building a script out of one would be
 * both fragile and an injection seam.
 */
app.post('/api/sessions/:id/copy-file', async (c) => {
  const id = c.req.param('id')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const tf = await findTranscriptAsync(id, source)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode')
    return c.json({ error: 'OpenCode sessions are stored in a shared database' }, 409)
  if (process.platform !== 'win32' && process.platform !== 'darwin')
    // Linux has no cross-desktop file-clipboard convention (GNOME and KDE disagree on the private
    // MIME type), so there is nothing honest to spawn. Say so rather than silently no-op.
    return c.json({ ok: false, reason: 'unsupported' }, 501)

  const session = await getSession(id, tf.source)
  const staged = join(CLIPBOARD_DIR, safeTranscriptFilename(session?.title, tf.session_id))
  try {
    rmSync(CLIPBOARD_DIR, { recursive: true, force: true })
    mkdirSync(CLIPBOARD_DIR, { recursive: true })
    await Bun.write(staged, Bun.file(tf.path))
  } catch {
    return c.json({ ok: false, reason: 'stage-failed' }, 500)
  }

  const cmd =
    process.platform === 'win32'
      ? [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // -LiteralPath: a title may contain [ ] which -Path would read as a wildcard.
          'Set-Clipboard -LiteralPath $env:AGENTHYDRA_CLIP_PATH',
        ]
      : [
          'osascript',
          '-e',
          'set the clipboard to (POSIX file (system attribute "AGENTHYDRA_CLIP_PATH"))',
        ]
  try {
    // windowsHide: true on every console-program spawn in this file, not just this one. The daemon
    // only inherits a window-less console today because Tray-Host.ps1 happens to launch it with
    // CreateNoWindow=true. Started any other way (a terminal, Explorer, the compiled portable exe),
    // that inheritance is gone and a plain click on this button would flash a real console window.
    // Stating the intent at the spawn call makes that impossible regardless of how the daemon started.
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, AGENTHYDRA_CLIP_PATH: staged },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    // Awaited, unlike open-file's fire-and-forget: the button reports whether the copy landed, and
    // "it's on your clipboard" is a claim we should only make once the exit code says so.
    const code = await proc.exited
    return code === 0
      ? c.json({ ok: true, filename: basename(staged) })
      : c.json({ ok: false }, 500)
  } catch {
    return c.json({ ok: false }, 500)
  }
})
app.get('/api/sessions/:id/tail', async (c) => {
  const limit = c.req.query('limit')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const flag = (name: string) => {
    const v = c.req.query(name)
    return v === '1' || v === 'true'
  }
  return c.json(
    await tailTranscript(
      c.req.param('id'),
      {
        limit: boundedQueryInt(limit, 40, 200),
        textOnly: flag('textOnly'),
        thinking: flag('thinking'),
        humanOnly: flag('humanOnly'),
      },
      source,
    ),
  )
})
// What this one session spent: token totals and a dollar cost at published list prices, computed
// on demand from the transcript itself (no table, nothing stored — see server/src/session-usage.ts).
// Answers 200 with a `status` rather than an error for a source that records no per-turn usage, so
// the UI can explain the gap instead of showing a zero it cannot justify.
app.get('/api/sessions/:id/usage', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const tf = await findTranscriptAsync(c.req.param('id'), source)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  return c.json(await sessionUsage(tf))
})
// The conversation index behind the fast search path. It holds no text of its own and rebuilds
// itself from the transcripts, so deleting it costs nothing but the time to build it again — which
// is exactly why the delete is offered rather than buried.
app.get('/api/search-index', (c) => c.json(searchIndexStatus()))
app.delete('/api/search-index', (c) => c.json({ ok: dropSearchIndex(), ...searchIndexStatus() }))

// --- analytics ---------------------------------------------------------------
// Read-only aggregates over per-session TOTALS the background warm computed (server/src/
// analytics.ts). Every one of them reports its own coverage, because a chart drawn from a
// half-warmed store and a chart drawn from a complete one look identical and mean different things.
const analyticsPeriod = (c: { req: { query: (k: string) => string | undefined } }) => {
  const raw = c.req.query('period')
  const period: SessionPeriod = isSessionPeriod(raw) ? raw : '30d'
  return periodCutoffMs(period)
}
let agentToolsCache: { at: number; tools: AgentPresence[] } | null = null
const AGENT_TOOLS_TTL_MS = 60_000
function cachedAgentTools(): AgentPresence[] {
  const now = Date.now()
  if (agentToolsCache && now - agentToolsCache.at < AGENT_TOOLS_TTL_MS) return agentToolsCache.tools
  const tools = detectAgentTools()
  agentToolsCache = { at: now, tools }
  return tools
}

app.get('/api/analytics/spend', (c) => c.json(spendReport({ sinceMs: analyticsPeriod(c) })))
app.get('/api/analytics/activity', (c) => c.json(activityReport({ sinceMs: analyticsPeriod(c) })))
app.get('/api/analytics/concurrency', (c) =>
  c.json({
    buckets: concurrencyReport({
      sinceMs: analyticsPeriod(c),
      bucketMs: boundedQueryInt(c.req.query('bucketMinutes'), 60, 1440) * 60_000,
    }),
  }),
)
app.get('/api/analytics/edits', (c) =>
  c.json({ edits: recentEdits(boundedQueryInt(c.req.query('limit'), 200, 1000)) }),
)
app.get('/api/analytics', (c) => c.json(analyticsCoverage()))
/**
 * Which coding agents are installed on this machine (server/src/agent-catalog.ts).
 *
 * Cached for a minute: it is a bounded directory walk, the answer changes when someone installs a
 * tool, and the UI asks for it on every visit to the analytics tab.
 */
app.get('/api/agent-tools', (c) => c.json({ tools: cachedAgentTools() }))
// Recompute on demand. Bounded by the same wall-clock budget the warm uses, so a click cannot
// wedge the daemon on a store with thousands of transcripts in it.
app.post('/api/analytics/refresh', async (c) =>
  c.json(
    await refreshAnalytics(listTranscriptFiles(), {
      budgetMs: boundedQueryInt(c.req.query('budgetMs'), 30_000, 120_000),
    }),
  ),
)
app.delete('/api/analytics', (c) => c.json({ ok: dropAnalytics(), ...analyticsCoverage() }))
/**
 * Cost of ONE queued run.
 *
 * Not stored, and deliberately: a run is a time window on a session that already has per-turn usage
 * in its transcript, so the honest number is the one computed by re-reading that window. Storing it
 * would add a second figure that can disagree with the session's own.
 */
app.get('/api/queue/:id/cost', async (c) => {
  const id = c.req.param('id')
  const item = db.query<QueueItem, [string]>('select * from queue_items where id = ?').get(id)
  if (!item) return c.json({ error: 'run not found' }, 404)
  return c.json(await runCost(coerceQueueItem(item)))
})

// --- accounts ---------------------------------------------------------------
app.get('/api/accounts', (c) => c.json(listAccounts()))
app.post('/api/accounts', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (
    !body ||
    typeof body.label !== 'string' ||
    !body.label.trim() ||
    typeof body.secret !== 'string' ||
    !body.secret ||
    (body.auth_type !== 'oauth_token' && body.auth_type !== 'api_key')
  ) {
    return c.json({ error: 'label, auth_type (oauth_token|api_key), and secret are required' }, 400)
  }
  const id = crypto.randomUUID()
  db.query(
    'insert into accounts (id, label, auth_type, secret, created_at) values (?, ?, ?, ?, ?)',
  ).run(id, body.label, body.auth_type, body.secret, Date.now())
  return c.json(listAccounts().find((a) => a.id === id))
})
// Deleting an account means deleting everything keyed to it. Only queue_items.account_id is a real
// foreign key (on delete set null); the rest live in files or in tables sqlite won't cascade into,
// so each has to be swept by hand or it outlives the account — a CLI instance badge naming an
// account that's gone, a usage reading served for it, a monitor opt-out waiting to be re-applied.
app.delete('/api/accounts/:id', (c) => {
  const id = c.req.param('id')
  db.query('delete from accounts where id = ?').run(id)
  clearCliInstanceAccountAssociations(id) // cli-instances.json (no FK reaches a file)
  clearMonitorForAccount(id) // monitor_accounts (a table, but no FK)
  dropCachedUsage(`acct:${id}`) // usage-cache.json — same key usage-service.ts writes
  dropUsageHistory(`acct:${id}`) // usage-history.json, capped per key but not per key COUNT
  return c.json({ ok: true })
})

// --- queue ------------------------------------------------------------------
app.get('/api/queue', (c) =>
  c.json(
    db
      .query<QueueItem, []>('select * from queue_items order by position asc, created_at asc')
      .all()
      .map(coerceQueueItem),
  ),
)
app.post('/api/queue', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (
    !body ||
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    typeof body.cwd !== 'string' ||
    !body.cwd.trim() ||
    typeof body.prompt !== 'string' ||
    !body.prompt.trim()
  ) {
    return c.json({ error: 'title, cwd, and prompt are required' }, 400)
  }
  if ('new_chat' in body && typeof body.new_chat !== 'boolean')
    return c.json({ error: 'new_chat must be a boolean' }, 400)
  if ('fork' in body && typeof body.fork !== 'boolean')
    return c.json({ error: 'fork must be a boolean' }, 400)
  if (body.session_id != null && (typeof body.session_id !== 'string' || !body.session_id.trim()))
    return c.json({ error: 'session_id must be a non-empty string' }, 400)
  for (const field of ['model', 'account_id', 'instance_ref'] as const) {
    if (body[field] != null && typeof body[field] !== 'string')
      return c.json({ error: `${field} must be a string or null` }, 400)
  }
  if (
    typeof body.account_id === 'string' &&
    !db.query('select 1 from accounts where id = ?').get(body.account_id)
  )
    return c.json({ error: `unknown account '${body.account_id}'` }, 400)
  const id = crypto.randomUUID()
  const sessionId = body.new_chat ? (body.session_id ?? crypto.randomUUID()) : body.session_id
  if (!sessionId)
    return c.json({ error: 'session_id is required when resuming an existing session' }, 400)
  // SURFACE PURITY, refused early with a readable error (owner law 2026-08-26, hardened same
  // day: "much more programmatic guardrails, so it can't make mistakes"). A thread that lives in
  // a desktop sidebar is NEVER continued headless — a queued `--resume` of it is exactly the
  // cross-open the owner banned. dispatch.ts enforces the same rule at the spawn chokepoint, so
  // this route check is the friendly message rather than the enforcement; `force` records the
  // owner's deliberate override ON THE ROW (allow_headless) so the chokepoint honours it too.
  // Checked for EVERY row, new_chat included. A new chat normally mints its own id and sails
  // through, but this route accepts a caller-supplied id even when new_chat is true, and the
  // runner then passes it as `--session-id` — so exempting new_chat let
  // `{new_chat: true, session_id: <an existing desktop chat>}` write headless turns into that
  // chat. The question is about the ID, never about the caller's label for the request.
  // NO HEADLESS (owner law 2026-08-27), refused at the point of ASKING rather than only at the
  // point of running. The chokepoint in dispatch.ts is still the enforcement and still refuses
  // every one of these; without this the route would happily accept the row and hand back an id,
  // and the caller would find out only when it failed later. Queueing work into something that
  // cannot run it is a dead end with a receipt. The two paragraphs above describe the narrower
  // check this replaces, whose `force` escape is also gone: an override that defeats "never" is
  // the old behaviour behind a flag.
  if (!headlessRunsAllowed()) return c.json({ error: NO_HEADLESS_REASON }, 409)
  const allowHeadless = body.force === true
  if (!allowHeadless && (await desktopHomeFor(sessionId)))
    return c.json(
      {
        error:
          'surface-violation: this thread lives in the desktop app — continue it there (native delivery), never headless. force:true is the owner-only escape.',
      },
      409,
    )
  if (
    body.not_before != null &&
    (typeof body.not_before !== 'string' || Number.isNaN(Date.parse(body.not_before)))
  ) {
    return c.json({ error: 'not_before must be an ISO timestamp' }, 400)
  }
  const enumError =
    invalidEnum(body.permission_mode, VALID_PERMISSION_MODES, 'permission_mode') ??
    invalidEnum(body.effort, VALID_EFFORTS, 'effort')
  if (enumError) return c.json({ error: enumError }, 400)
  // normalize to UTC ISO so the scheduler's lexicographic compare is always sound
  const notBefore = body.not_before ? new Date(Date.parse(body.not_before)).toISOString() : null
  // Run-as resolution (resolveRunAsRef documents the precedence). A caller that names NEITHER an
  // instance nor an account is not asking for the ambient CLI login — it simply hasn't said, and for
  // a resume the right answer is knowable: the desktop instance this chat actually belongs to.
  // Without this, a resume of an instance's chat goes out on a DIFFERENT account's credentials,
  // which is how "You've hit your weekly limit" shows up for an account nowhere near its limit.
  // Resolved once, HERE, so the choice is STORED on the row: visible on the card, editable, and
  // carried forward into an auto-resume (monitor.ts copies instance_ref).
  const instanceRef = resolveRunAsRef(body, sessionId)
  // Owner rule 2026-08-30 (new-chat-defaults.ts): a NEW chat that names no model starts on
  // Opus + the ultracode keyword; explicit choices pass through untouched. Applied HERE at
  // storage so the queue row shows exactly what will run.
  if (body.ultracode !== undefined && typeof body.ultracode !== 'boolean')
    return c.json({ error: 'ultracode must be a boolean' }, 400)
  // Same strictness as ultracode (review-confirmed asymmetry): a non-string model is a caller
  // bug, and silently defaulting it to opus would hide that the intended value was dropped.
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string')
    return c.json({ error: 'model must be a string' }, 400)
  const newChatSpec = applyNewChatDefaults({
    newChat: body.new_chat === true,
    model: typeof body.model === 'string' ? body.model : null,
    prompt: body.prompt,
    ultracode: body.ultracode,
  })
  const posRow = db
    .query<{ m: number | null }, []>('select max(position) as m from queue_items')
    .get()
  const position = (posRow?.m ?? 0) + 1
  db.query(
    `insert into queue_items
       (id, session_id, title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, new_chat, fork, status, position, not_before, created_at, allow_headless)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    body.title,
    body.cwd,
    newChatSpec.prompt,
    newChatSpec.model,
    body.effort ?? null,
    body.permission_mode ?? null,
    body.account_id ?? null,
    instanceRef,
    body.new_chat ? 1 : 0,
    body.fork ? 1 : 0,
    position,
    notBefore,
    Date.now(),
    allowHeadless ? 1 : 0,
  )
  return c.json(coerceQueueItem(db.query('select * from queue_items where id = ?').get(id)))
})
app.patch('/api/queue/:id', async (c) => {
  const id = c.req.param('id')
  const existing = db.query('select * from queue_items where id = ?').get(id)
  if (!existing) return c.json({ error: 'queue item not found' }, 404)
  const body = await jsonBody(c)
  // reject (don't silently coerce) the two fields where a bad value corrupts the item:
  // a cleared schedule dispatches early, a "null" session id reaches the CLI as --resume null
  if (
    'not_before' in body &&
    body.not_before != null &&
    (typeof body.not_before !== 'string' || Number.isNaN(Date.parse(body.not_before)))
  ) {
    return c.json({ error: 'not_before must be an ISO timestamp' }, 400)
  }
  if ('session_id' in body && (typeof body.session_id !== 'string' || !body.session_id.trim())) {
    return c.json({ error: 'session_id must be a non-empty string' }, 400)
  }
  for (const field of ['title', 'cwd', 'prompt'] as const) {
    if (field in body && (typeof body[field] !== 'string' || !(body[field] as string).trim()))
      return c.json({ error: `${field} must be a non-empty string` }, 400)
  }
  for (const field of ['model', 'account_id', 'instance_ref'] as const) {
    if (field in body && body[field] != null && typeof body[field] !== 'string')
      return c.json({ error: `${field} must be a string or null` }, 400)
  }
  if (
    'status' in body &&
    (typeof body.status !== 'string' || !VALID_QUEUE_STATUSES.has(body.status))
  )
    return c.json({ error: `status must be one of: ${[...VALID_QUEUE_STATUSES].join(', ')}` }, 400)
  if ('position' in body && (typeof body.position !== 'number' || !Number.isFinite(body.position)))
    return c.json({ error: 'position must be a finite number' }, 400)
  for (const field of ['new_chat', 'fork'] as const) {
    if (field in body && typeof body[field] !== 'boolean')
      return c.json({ error: `${field} must be a boolean` }, 400)
  }
  if (
    typeof body.account_id === 'string' &&
    !db.query('select 1 from accounts where id = ?').get(body.account_id)
  )
    return c.json({ error: `unknown account '${body.account_id}'` }, 400)
  // Same server-side enum guard as POST: never patch a garbage permission_mode/effort into a row
  // (permission_mode reaches `claude --permission-mode <v>`). Only checked when the field is present.
  const patchEnumError =
    ('permission_mode' in body
      ? invalidEnum(body.permission_mode, VALID_PERMISSION_MODES, 'permission_mode')
      : null) ?? ('effort' in body ? invalidEnum(body.effort, VALID_EFFORTS, 'effort') : null)
  if (patchEnumError) return c.json({ error: patchEnumError }, 400)
  const allow: Record<string, (v: any) => unknown> = {
    session_id: String,
    title: String,
    cwd: String,
    prompt: String,
    model: (v) => (v == null ? null : String(v)),
    effort: (v) => (v == null ? null : String(v)),
    permission_mode: (v) => (v == null ? null : String(v)),
    account_id: (v) => (v == null ? null : String(v)),
    // An edit is always an explicit choice, so there is nothing to auto-resolve here — but the
    // picker still speaks the sentinel, and storing it verbatim would fail the run at launch
    // ("run-as instance reference is malformed"). Unpin instead.
    instance_ref: (v) => (v == null || v === AMBIENT_RUN_AS ? null : String(v)),
    status: String,
    position: (v) => Math.trunc(Number(v)),
    // normalized to UTC ISO (unparseable → null); scheduler compares these as text
    not_before: (v) => {
      if (v == null) return null
      const ms = Date.parse(String(v))
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null
    },
    new_chat: (v) => (v ? 1 : 0),
    fork: (v) => (v ? 1 : 0),
  }
  const fields: string[] = []
  const values: unknown[] = []
  for (const [k, coerce] of Object.entries(allow)) {
    if (k in body) {
      fields.push(`${k} = ?`)
      values.push(coerce(body[k]))
    }
  }
  if (fields.length) {
    values.push(id)
    db.query(`update queue_items set ${fields.join(', ')} where id = ?`).run(...(values as any[]))
    // The new-chat defaults hold on the PATCH door too (review-confirmed backdoor: flipping
    // new_chat true on a defaults-skipped resume row silently started a brand-new chat
    // outside Opus+ultracode). Applied to the EFFECTIVE row after the update, so a patch that
    // also sets model/prompt is respected as the explicit choice it is.
    if (body.new_chat === true) {
      const row = db
        .query<{ model: string | null; prompt: string }, [string]>(
          'select model, prompt from queue_items where id = ?',
        )
        .get(id)
      if (row) {
        const spec = applyNewChatDefaults({
          newChat: true,
          model: row.model,
          prompt: row.prompt,
        })
        if (spec.model !== row.model || spec.prompt !== row.prompt)
          db.query('update queue_items set model = ?, prompt = ? where id = ?').run(
            spec.model,
            spec.prompt,
            id,
          )
      }
    }
  }
  return c.json(coerceQueueItem(db.query('select * from queue_items where id = ?').get(id)))
})
app.delete('/api/queue/:id', (c) => {
  const id = c.req.param('id')
  if (isActive(id)) return c.json({ error: 'cannot delete a running item; cancel it first' }, 409)
  db.query('delete from queue_items where id = ?').run(id)
  return c.json({ ok: true })
})
app.post('/api/queue/:id/run', (c) => {
  const id = c.req.param('id')
  const row = db.query('select * from queue_items where id = ?').get(id)
  if (!row) return c.json({ error: 'queue item not found' }, 404)
  if (isActive(id)) return c.json({ error: 'already running' }, 409)
  const item = coerceQueueItem(row)
  if (isSessionActive(item.session_id))
    return c.json({ error: 'another run is already active for this session' }, 409)
  void dispatchItem(item)
  return c.json({ ok: true, started: true })
})
// Manual bulk drain: dispatch every currently-due queued item at once. Deliberately
// ignores the scheduler's enabled/spacing/max_concurrent limits (same semantics as
// pressing Run on each card) but honors the per-session run lock; items whose session
// is (or just became) busy stay queued and are reported as skipped.
app.post('/api/queue/run-due', (c) => {
  const due = db
    .query<QueueItem, [string]>(
      `select * from queue_items
       where status = 'queued' and (not_before is null or not_before <= ?)
       order by position asc, created_at asc`,
    )
    .all(new Date().toISOString())
  let started = 0
  let skipped = 0
  for (const row of due) {
    const item = coerceQueueItem(row)
    // dispatchItem registers the session synchronously before its first await, so a
    // second due item for the same session correctly lands in the skipped bucket
    if (isActive(item.id) || isSessionActive(item.session_id)) {
      skipped++
      continue
    }
    void dispatchItem(item)
    started++
  }
  return c.json({ ok: true, started, skipped })
})
app.post('/api/queue/:id/cancel', (c) => c.json({ ok: cancelItem(c.req.param('id')) }))
// A run's events PLUS how it ended. The events alone cannot say whether the run finished, died or
// was killed — an agent reading a truncated-looking log has no way to tell a short answer from a
// crash — and the daemon already knows, because the runner reports the child's exit code.
app.get('/api/queue/:id/events', (c) => {
  const id = c.req.param('id')
  const item = db.query<QueueItem, [string]>('select * from queue_items where id = ?').get(id)
  if (!item) return c.json({ error: 'run not found' }, 404)
  return c.json({ outcome: runOutcome(coerceQueueItem(item)), events: getRunEvents(id) })
})

// --- live run stream (SSE) --------------------------------------------------
app.get('/api/queue/:id/stream', (c) => {
  const id = c.req.param('id')
  return streamSSE(c, async (stream) => {
    const buffer: RunMessage[] = []
    let closed = false
    const unsub = subscribeRun(id, (m) => buffer.push(m))
    stream.onAbort(() => {
      closed = true
      unsub()
    })
    // backlog first, deduped against anything the subscription also captured
    const seen = new Set<number>()
    for (const ev of getRunEvents(id)) {
      seen.add(ev.id)
      await stream.writeSSE({ data: JSON.stringify({ type: 'event', data: ev }) })
    }
    let ticks = 0
    while (!closed) {
      while (buffer.length) {
        const m = buffer.shift()!
        if (m.type === 'event' && seen.has(m.data.id)) continue
        if (m.type === 'event') seen.add(m.data.id)
        await stream.writeSSE({ data: JSON.stringify(m) })
      }
      await stream.sleep(300)
      if (++ticks % 50 === 0) await stream.writeSSE({ data: '', event: 'ping' })
    }
  })
})

// --- scheduler --------------------------------------------------------------
app.get('/api/scheduler', (c) => c.json(schedulerState()))
app.post('/api/scheduler', async (c) => {
  const body = await jsonBody(c)
  return c.json(
    setSchedulerSettings({
      spacing_seconds: typeof body.spacing_seconds === 'number' ? body.spacing_seconds : undefined,
      poll_seconds: typeof body.poll_seconds === 'number' ? body.poll_seconds : undefined,
      max_concurrent: typeof body.max_concurrent === 'number' ? body.max_concurrent : undefined,
      tomorrow_time: typeof body.tomorrow_time === 'string' ? body.tomorrow_time : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    }),
  )
})

// --- multi-instance (isolated Claude Desktop instances) --------------------
// "instance account" = which Anthropic account a Desktop *instance* is logged into (resolved
// by decrypting its local safeStorage token cache); distinct from the sqlite `accounts` table
// above (Anthropic auth secrets for queue dispatch). Never touches that table.
app.get('/api/instances', async (c) => {
  return c.json(await listInstances())
})

// --- instance numbers -------------------------------------------------------
// The whole fleet under ONE numbering, flattened across desktop / CLI / Codex. This is what makes
// "check instance 7" a sentence a human can say and a tool can act on: every other identifier an
// instance has is either a file path or a uuid. Kept at its own top-level path rather than under
// /api/instances/* so it can never be mistaken for (or shadowed by) a `:dir` route.
app.get('/api/instance-numbers', async (c) => c.json(await listAllInstances()))

// Resolve one reference — a number, a `#N`, a dir/id, an explicit `kind:id` ref, or an unambiguous
// name. 404 carries a reason, because "no such number" and "that number's instance was deleted"
// call for different fixes.
app.get('/api/instance-numbers/resolve', async (c) => {
  const ref = c.req.query('ref') ?? ''
  const hit = await resolveInstance(ref)
  if (hit) return c.json(hit)
  return c.json({ error: await resolveInstanceError(ref) }, 404)
})

// Reverse lookup: which instance owns this credential dir. Answers "which one am I?" for an agent
// that knows only its own CLAUDE_CONFIG_DIR / CODEX_HOME. Null (200) for the plain ~/.claude login,
// which is a real answer — it belongs to no managed instance — not an error.
app.get('/api/instance-numbers/whoami', async (c) => {
  const configDir = c.req.query('configDir') ?? ''
  return c.json(await instanceForConfigDir(configDir))
})
// Which Claude Desktop build is installed; the Instances tab warns when only the MSIX
// package is present (not launchable with --user-data-dir; see core/desktop-install.ts).
app.get('/api/desktop-install', async (c) => {
  const fresh = c.req.query('fresh')
  return c.json(await detectDesktopInstall({ fresh: fresh === '1' || fresh === 'true' }))
})
app.get('/api/instances/:dir/account', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const noNetwork = c.req.query('noNetwork')
  const account = await resolveAccount(dir, {
    noNetwork: noNetwork === '1' || noNetwork === 'true',
  })
  return c.json(account)
})
app.post('/api/instances/:dir/open', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  return c.json(await openInstance(dir))
})
app.post('/api/instances/:dir/quit', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const body = await jsonBody(c)
  // Quitting the DEFAULT (non-isolated) Claude Desktop — the user's real chats — needs an explicit
  // opt-in from the caller (the UI shows a confirmation first); quitInstance refuses it otherwise.
  // Mirrors the delete route's confirmName pattern one section below.
  return c.json(await quitInstance(dir, { confirmExternal: body.confirmExternal === true }))
})
app.post('/api/instances/:dir/focus', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  return c.json(await focusInstance(dir))
})
app.post('/api/instances/:dir/reveal', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  return c.json(await revealInstanceFolder(dir))
})
// Create a desktop launcher (.lnk on Windows) that opens THIS instance directly with its
// isolated --user-data-dir; see core/shortcut.ts. Runs on the daemon's machine, matching the
// loopback posture of /open and /reveal.
app.post('/api/instances/:dir/shortcut', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  return c.json(await createInstanceShortcut(dir))
})
// One-click shortcut for the lightweight instance-only launcher. Unlike the per-instance shortcut
// above, this opens the chooser and does not launch Claude until the user selects an account.
app.post('/api/instance-mode/shortcut', async (c) => {
  return c.json(await createInstanceModeShortcut())
})
app.delete('/api/instances/:dir', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const body = await jsonBody(c)
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : undefined
  return c.json(await removeInstance(dir, { confirmName }))
})
// Update an instance's UI metadata: display label (renaming is now a pure relabel — it never
// touches the on-disk folder, so it works while the instance is running), plus icon + color.
// A field present in the body is applied (null clears it to the default); an absent field is
// left unchanged. Values are sanitized/validated in core/instance-meta.ts.
app.post('/api/instances/:dir/meta', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const body = await jsonBody(c)

  const patch: Parameters<typeof setInstanceMeta>[1] = {}
  if ('label' in body) patch.label = typeof body.label === 'string' ? body.label : null
  if ('icon' in body) {
    patch.icon =
      typeof body.icon === 'string' && (INSTANCE_ICON_KEYS as readonly string[]).includes(body.icon)
        ? (body.icon as (typeof INSTANCE_ICON_KEYS)[number])
        : null
  }
  if ('color' in body) {
    patch.color =
      typeof body.color === 'string' &&
      (INSTANCE_COLOR_KEYS as readonly string[]).includes(body.color)
        ? (body.color as (typeof INSTANCE_COLOR_KEYS)[number])
        : null
  }

  const meta = setInstanceMeta(dir, patch)
  return c.json({ ok: true, action: 'meta', dir, message: 'updated', data: meta })
})
app.post('/api/instances', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'name is required' }, 400)
  }
  return c.json(await createInstance(body.name))
})

// --- usage-check subsystem (Feature B) --------------------------------------
// Read an account's remaining Claude quota by spawning `claude -p "/usage"` (usage.ts), auth
// injected the SAME way dispatch does (usage-service.ts). Each result is cached per key so the UI
// never stampedes real `claude` processes; `?refresh=1` forces a fresh probe. A no-data snapshot
// (all-null) is returned honestly — never faked as "0% used".

/** Resolve an `account` query param that may be an account id OR a free-text label. */
function resolveAccountParam(param: string): { id: string; label: string } | null {
  const byId = db
    .query<{ id: string; label: string }, [string]>('select id, label from accounts where id = ?')
    .get(param)
  if (byId) return byId
  return (
    db
      .query<{ id: string; label: string }, [string]>(
        'select id, label from accounts where label = ?',
      )
      .get(param) ?? null
  )
}

const wantsRefresh = (c: Context): boolean => {
  const v = c.req.query('refresh')
  return v === '1' || v === 'true'
}

/** A Codex instance's quota, cache-aware. Extracted from the route so `/api/usage?instance=N` can
 *  reach the Codex family through the same code the Codex route uses, rather than a second copy of
 *  the "signed out vs read failed" reasoning that would inevitably drift from it. */
async function codexUsageResult(
  codexHome: string,
  id: string,
  refresh: boolean,
): Promise<UsageCheckResult> {
  const key = codexKey(id)
  if (!refresh) {
    const cached = getCachedUsage(key)
    if (cached) return { snapshot: cached, cached: true, key, reason: 'ok' }
  }
  const { account, usage } = await resolveCodexAccount(codexHome)
  if (!usage) {
    // Distinguish "not signed in" from "signed in but the read failed", exactly as the Claude
    // routes do — a bare "—" with no reason reads as a bug.
    const reason: UsageCheckResult['reason'] =
      account.status === 'loggedout' ? 'not_logged_in' : 'check_failed'
    // codexUsageSnapshot(null, …) is the all-null shape — the same "checked, nothing to report"
    // snapshot the Claude paths return, so the chip renders "—" with a reason rather than "0%".
    return { snapshot: codexUsageSnapshot(null, account.label), cached: false, key, reason }
  }
  setCachedUsage(key, usage)
  return { snapshot: usage, cached: false, key, reason: 'ok' }
}

app.get('/api/usage', async (c) => {
  const account = c.req.query('account')
  const configDir = c.req.query('configDir')
  const instance = c.req.query('instance')
  const refresh = wantsRefresh(c)

  // `instance` is the number-first path: one param that takes `7`, `#7`, a dir, an id or a name and
  // routes to whichever family's credential chain applies. It comes FIRST because it is the only
  // one of the three that is unambiguous — `account` and `configDir` each address one store.
  if (instance) {
    const hit = await resolveInstance(instance)
    if (!hit) return c.json({ error: await resolveInstanceError(instance) }, 404)
    const result: UsageCheckResult =
      hit.kind === 'desktop'
        ? await checkUsageForDesktop(hit.handle)
        : hit.kind === 'cli'
          ? ((await checkUsageForCliInstance(hit.handle)) ?? {
              snapshot: parseUsageOutput('', hit.name),
              cached: false,
              key: hit.ref,
              reason: 'check_failed',
            })
          : await codexUsageResult(hit.configDir, hit.handle, refresh)
    // Echo WHICH instance answered. Without it a caller that passed a name has no confirmation it
    // reached the account it meant — and that is the whole failure mode numbers exist to prevent.
    return c.json({
      ...result,
      advice: result.advice ?? usageAdvice(result.snapshot),
      instance: {
        num: hit.num,
        kind: hit.kind,
        name: hit.name,
        email: hit.email,
        plan: hit.plan,
      },
    })
  }

  if (account) {
    const resolved = resolveAccountParam(account)
    if (!resolved) return c.json({ error: `unknown account '${account}'` }, 404)
    const key = `acct:${resolved.id}`
    if (!refresh) {
      const cached = getCachedUsage(key)
      if (cached)
        return c.json({
          snapshot: cached,
          cached: true,
          key,
          reason: 'ok',
        } satisfies UsageCheckResult)
    }
    const snapshot = await checkUsageForAccount(resolved.id)
    return c.json({
      snapshot,
      cached: false,
      key,
      reason: isNoData(snapshot) ? 'check_failed' : 'ok',
      advice: usageAdvice(snapshot),
    } satisfies UsageCheckResult)
  }
  if (configDir) {
    const key = `dir:${configDir}`
    if (!refresh) {
      const cached = getCachedUsage(key)
      if (cached)
        return c.json({
          snapshot: cached,
          cached: true,
          key,
          reason: 'ok',
          advice: usageAdvice(cached),
        } satisfies UsageCheckResult)
    }
    const snapshot = await checkUsage({ configDir, account: configDir })
    // Only cache a real reading — a no-data result is the absence of a number, not a number.
    if (!isNoData(snapshot)) setCachedUsage(key, snapshot)
    return c.json({
      snapshot,
      cached: false,
      key,
      reason: isNoData(snapshot) ? 'check_failed' : 'ok',
      advice: usageAdvice(snapshot),
    } satisfies UsageCheckResult)
  }
  return c.json({ error: 'pass account (id or label) or configDir' }, 400)
})

// Whole usage cache (bulk-hydrate the Instances table on load without checking anything).
app.get('/api/usage/cache', (c) =>
  c.json({ cache: allCachedUsage(), lastAutoRefreshAt: lastAutoRefreshAt() }),
)

// Every instance's usage in ONE call: the whole-fleet survey. This is the endpoint an AI agent wants
// ("which of my accounts has headroom?") and what the auto-refresh sweep exposes on demand. Each row
// carries the advisory verdict too, so a caller never has to re-derive "is 98% bad".
app.get('/api/usage/survey', async (c) => {
  const rows = await surveyUsage()
  return c.json({
    rows: rows.map((r) => ({ ...r, advice: usageAdvice(r.result.snapshot) })),
    lastAutoRefreshAt: lastAutoRefreshAt(),
  })
})

// Force one background sweep now (the same pass the auto-refresh timer runs).
app.post('/api/usage/refresh', async (c) => c.json({ ok: true, checked: await sweepUsage() }))

// The BUDGET: the percentage turned into quantities an agent can actually plan with — a burn rate, a
// deadline, and an estimated token headroom derived from real transcript spend. See usage-budget.ts.
// `configDir` (repeatable) names which Claude config dirs' transcripts count toward this account's
// spend; it defaults to the plain ~/.claude login.
app.get('/api/usage/budget', async (c) => {
  const dir = c.req.query('dir')
  const account = c.req.query('account')
  const instance = c.req.query('instance')
  const configDirs = c.req.queries('configDir')

  // `instance` (a number, dir, id or name) is the one form that reaches ALL THREE families — the
  // older `dir` only ever addressed a desktop instance, so a CLI or Codex login had no way to ask
  // for a budget at all.
  const hit = instance ? await resolveInstance(instance) : null
  if (instance && !hit) return c.json({ error: await resolveInstanceError(instance) }, 404)

  const result = hit
    ? hit.kind === 'desktop'
      ? await checkUsageForDesktop(hit.handle)
      : hit.kind === 'cli'
        ? await checkUsageForCliInstance(hit.handle)
        : await codexUsageResult(hit.configDir, hit.handle, true)
    : dir
      ? await checkUsageForDesktop(dir)
      : account
        ? await (async () => {
            const resolved = resolveAccountParam(account)
            if (!resolved) return null
            const snapshot = await checkUsageForAccount(resolved.id)
            return { snapshot, cached: false, key: `acct:${resolved.id}`, reason: 'ok' as const }
          })()
        : // A bare credential dir — the plain `~/.claude` login, or any CLAUDE_CONFIG_DIR that has
          // been /login'd. Without this branch the ONE account that belongs to no instance and no
          // dispatch row (the everyday default login) could get a percentage from /api/usage but
          // never a burn rate, which is the number that actually decides whether to keep going.
          configDirs?.length
          ? await (async () => {
              const cd = configDirs[0] as string
              const snapshot = await checkUsage({ configDir: cd, account: cd })
              return {
                snapshot,
                cached: false,
                key: `dir:${cd}`,
                reason: isNoData(snapshot) ? ('check_failed' as const) : ('ok' as const),
              }
            })()
          : null
  if (!result)
    return c.json(
      {
        error:
          'pass instance (its number), dir (a desktop instance), account (id or label) or configDir (a logged-in Claude config dir)',
      },
      400,
    )

  // A CLI instance's transcripts live under its OWN config dir, so that is the right default for
  // "how many tokens did this account spend" — the ~/.claude fallback would measure a different
  // login entirely and quietly report someone else's burn.
  const spendDirs = configDirs?.length
    ? configDirs
    : hit?.kind === 'cli'
      ? [hit.configDir]
      : undefined

  const budget = buildUsageBudget(result.snapshot, result.key, { configDirs: spendDirs })
  return c.json({
    snapshot: result.snapshot,
    reason: result.reason,
    advice: usageAdvice(result.snapshot),
    budget,
    summary: budgetSummary(budget, result.snapshot.weekAll?.pct ?? null),
    ...(hit
      ? {
          instance: {
            num: hit.num,
            kind: hit.kind,
            name: hit.name,
            email: hit.email,
            plan: hit.plan,
          },
        }
      : {}),
  })
})

// Desktop instance usage. The credential chain (own safeStorage token → LINKED CLI instance's login
// → dispatch account matching the email) lives in usage-service.ts so the routes, the MCP tools, and
// the auto-refresh sweep all resolve it identically.
app.get('/api/instances/:dir/usage', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  if (!wantsRefresh(c)) {
    const key = `desktop:${dir}`
    const cached = getCachedUsage(key)
    if (cached)
      return c.json({
        snapshot: cached,
        cached: true,
        key,
        reason: 'ok',
      } satisfies UsageCheckResult)
  }
  return c.json(await checkUsageForDesktop(dir))
})

// --- CLI instances (Feature A) ----------------------------------------------
// Reconcile associations against the live account table before listing: this is where a record that
// went dangling before the delete route learned to clean up (or via a hand-edited db) heals itself,
// rather than showing a badge for an account that isn't there. One id-only read of a tiny table,
// and the prune writes nothing when nothing dangles — so the UI's polling stays free.
app.get('/api/cli-instances', (c) => {
  pruneCliInstanceAccountAssociations(
    db
      .query<{ id: string }, []>('select id from accounts')
      .all()
      .map((r) => r.id),
  )
  return c.json(listCliInstances())
})
app.post('/api/cli-instances', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.name !== 'string' || !body.name.trim())
    return c.json({ error: 'name is required' }, 400)
  return c.json(createCliInstance(body.name))
})
app.post('/api/cli-instances/:id/launch', async (c) => {
  const body = await jsonBody(c)
  const optionError = launchOptionError(body, CLAUDE_LAUNCH_EFFORTS)
  if (optionError) return c.json({ error: optionError }, 400)
  return c.json(
    launchCliInstance(c.req.param('id'), {
      model: typeof body.model === 'string' ? body.model : undefined,
      effort: typeof body.effort === 'string' ? body.effort : undefined,
    }),
  )
})
app.post('/api/cli-instances/:id/login', (c) =>
  c.json(launchCliInstance(c.req.param('id'), { login: true })),
)
app.post('/api/cli-instances/:id/rename', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  return c.json(renameCliInstance(c.req.param('id'), body.name))
})
app.post('/api/cli-instances/:id/associate', async (c) => {
  const body = await jsonBody(c)
  const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : null
  const accountLabel =
    typeof body.accountLabel === 'string'
      ? body.accountLabel
      : accountId
        ? (resolveAccountParam(accountId)?.label ?? null)
        : null
  return c.json(associateCliInstance(c.req.param('id'), accountId, accountLabel))
})
app.delete('/api/cli-instances/:id', async (c) => {
  const body = await jsonBody(c)
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : undefined
  return c.json(deleteCliInstance(c.req.param('id'), confirmName))
})
// Link this CLI instance to a DESKTOP instance (or clear it with desktopDir: null). Same account,
// two logins — the link is what lets the UI group them and lets each back the other up for usage.
app.post('/api/cli-instances/:id/link-desktop', async (c) => {
  const body = await jsonBody(c)
  const desktopDir = typeof body.desktopDir === 'string' && body.desktopDir ? body.desktopDir : null
  let desktopLabel = typeof body.desktopLabel === 'string' ? body.desktopLabel : null
  if (desktopDir && !desktopLabel) {
    const inst = (await listInstances()).find((i) => i.dir === desktopDir)
    if (!inst) return c.json({ error: `unknown desktop instance '${desktopDir}'` }, 404)
    desktopLabel = inst.label ?? inst.name
  }
  return c.json(linkCliInstanceToDesktop(c.req.param('id'), desktopDir, desktopLabel))
})

app.get('/api/cli-instances/:id/usage', async (c) => {
  const id = c.req.param('id')
  const inst = getCliInstance(id)
  if (!inst) return c.json({ error: 'CLI instance not found' }, 404)
  if (!wantsRefresh(c) && inst.lastUsageCheck)
    return c.json({
      snapshot: inst.lastUsageCheck,
      cached: true,
      key: `cli:${id}`,
      reason: 'ok',
    } satisfies UsageCheckResult)
  // The credential chain (own login → associated account → LINKED desktop token) lives in
  // usage-service.ts; mirror the snapshot onto the record so the list view renders it without a check.
  const result = await checkUsageForCliInstance(id)
  if (!result) return c.json({ error: 'CLI instance not found' }, 404)
  setCliInstanceUsage(id, result.snapshot)
  return c.json(result)
})

// --- Codex CLI instances ----------------------------------------------------
app.get('/api/codex-instances', async (c) => c.json(await listCodexInstances()))
// Identity, on demand. The LIST already carries a local identity for every row (auth.json is plain
// JSON, so that read is nearly free), so this route exists for the LIVE refresh: it re-reads the
// plan from the server-computed value rather than the token's mint-time claim.
app.get('/api/codex-instances/:id/account', async (c) => {
  const inst = await findCodexInstance(c.req.param('id'))
  if (!inst) return c.json({ error: 'Codex instance not found' }, 404)
  const noNetwork = c.req.query('noNetwork')
  const { account } = await resolveCodexAccount(inst.codexHome, {
    noNetwork: noNetwork === '1' || noNetwork === 'true',
  })
  return c.json(account)
})
// Quota. One call answers identity AND usage on the OpenAI side, so unlike the Claude routes there
// is no second probe to run — the snapshot is a by-product of resolving the account.
app.get('/api/codex-instances/:id/usage', async (c) => {
  const id = c.req.param('id')
  const inst = await findCodexInstance(id)
  if (!inst) return c.json({ error: 'Codex instance not found' }, 404)
  return c.json(await codexUsageResult(inst.codexHome, id, wantsRefresh(c)))
})
app.post('/api/codex-instances', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.name !== 'string' || !body.name.trim())
    return c.json({ error: 'name is required' }, 400)
  return c.json(createCodexInstance(body.name))
})
app.post('/api/codex-instances/:id/launch', async (c) => {
  const body = await jsonBody(c)
  const optionError = launchOptionError(body, CODEX_LAUNCH_EFFORTS)
  if (optionError) return c.json({ error: optionError }, 400)
  return c.json(
    launchCodexInstance(c.req.param('id'), {
      model: typeof body.model === 'string' ? body.model : undefined,
      effort: typeof body.effort === 'string' ? body.effort : undefined,
    }),
  )
})
app.post('/api/codex-instances/:id/login', (c) =>
  c.json(launchCodexInstance(c.req.param('id'), { login: true })),
)
app.post('/api/codex-instances/:id/desktop/open', async (c) =>
  c.json(await openCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/desktop/focus', async (c) =>
  c.json(await focusCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/desktop/quit', async (c) =>
  c.json(await quitCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/rename', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  return c.json(renameCodexInstance(c.req.param('id'), body.name))
})
app.delete('/api/codex-instances/:id', async (c) => {
  const body = await jsonBody(c)
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : undefined
  return c.json(await deleteCodexInstance(c.req.param('id'), confirmName))
})

// --- auto-resume monitor (Feature E) ----------------------------------------
const monitorView = (): MonitorView => ({
  settings: getMonitorSettings(),
  status: monitorStatus(),
  accounts: listMonitorAccounts(),
})
app.get('/api/monitor', (c) => c.json(monitorView()))
app.post('/api/monitor', async (c) => {
  const body = await jsonBody(c)
  setMonitorSettings({
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    maxAttempts: typeof body.maxAttempts === 'number' ? body.maxAttempts : undefined,
    resumeBufferMin: typeof body.resumeBufferMin === 'number' ? body.resumeBufferMin : undefined,
    resumePrompt: typeof body.resumePrompt === 'string' ? body.resumePrompt : undefined,
  })
  return c.json(monitorView())
})
app.post('/api/monitor/account', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.accountId !== 'string' || typeof body.enabled !== 'boolean')
    return c.json({ error: 'accountId and enabled are required' }, 400)
  setMonitorForAccount(body.accountId, body.enabled)
  return c.json(monitorView())
})
// Force one monitor pass now (manual "check for resumable stops").
app.post('/api/monitor/check', async (c) => {
  await runMonitorOnce()
  return c.json({ ok: true, ...monitorView() })
})

// --- fleet observation (orchestrator rebuild - see server/src/fleet.ts) ----------------------
// Deterministic and read-only: the observation core every later rebuild piece reads. Grows one
// key per landed piece: sessions (piece 1, fleet.ts), usage (piece 2, fleet-usage.ts), git
// (piece 3, fleet-git.ts), instances (piece 4, fleet-instances.ts - account identity). Zero
// AI, zero writes, zero settings.
app.get('/api/fleet', async (c) => {
  const status = fleetStatus()
  // Sections fail INDEPENDENTLY: one broken store must not 500 the sessions/usage that already
  // resolved. A failed section is null plus a named entry in `errors` - reported, never hidden.
  const errors: string[] = []
  const section = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run()
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  const [git, instances] = await Promise.all([
    section('git', () => fleetGit(status.sessions.map((s) => s.cwd))),
    section('instances', () => fleetInstances()),
  ])
  return c.json({ ...status, usage: fleetUsage(), git, instances, errors })
})

// Capture what is actually ON SCREEN, and hand back the path so the caller can LOOK at it.
// Everything else this daemon reports is read from disk, and disk is not the screen - the gap
// between them is where the archive-that-stayed-visible and the title-that-got-wiped both
// lived. An AI session can read the returned PNG directly; a human can open it. Nothing here
// interprets the image, deliberately: it is a camera, not a judge.
app.post('/api/screenshot', async (c) => {
  const body = await jsonBody(c)
  const result = await captureScreen(typeof body.path === 'string' ? body.path : undefined)
  return c.json(result, result.ok ? 200 : 500)
})
// Start a NEW interactive Claude session in a VISIBLE terminal window, pinned to an instance's
// account. Unlike a headless queue run it is on the user's screen and joins the live
// registry, so peer messaging can reach it.
app.post('/api/sessions/launch-terminal', async (c) => {
  const body = await jsonBody(c)
  if (
    typeof body.cwd !== 'string' ||
    !body.cwd.trim() ||
    typeof body.prompt !== 'string' ||
    !body.prompt.trim()
  )
    return c.json({ error: 'cwd and prompt are required' }, 400)
  if (body.effort != null && invalidEnum(body.effort, VALID_EFFORTS, 'effort'))
    return c.json({ error: invalidEnum(body.effort, VALID_EFFORTS, 'effort') }, 400)
  // An unattended window must be able to ask for a mode that does not stop on shell
  // approvals. Validated against the same set every other entry point uses,
  // because 'bypassPermissions' runs every tool with no approval and a typo must not silently
  // become something else.
  if (body.permission_mode != null && !VALID_PERMISSION_MODES.has(String(body.permission_mode)))
    return c.json(
      { error: `permission_mode must be one of ${[...VALID_PERMISSION_MODES].join(', ')}` },
      400,
    )
  // resume_session_id continues an existing thread in the window (owner's no-headless rule:
  // continuations happen where they can be watched). Refuse it while that thread is live, and
  // refuse a done-marked lineage (one lineage, one continuation — its successor owns the task).
  if (typeof body.resume_session_id === 'string' && body.resume_session_id.trim()) {
    const rid = body.resume_session_id.trim()
    if (liveSessionEntry(rid))
      return c.json(
        { ok: false, reason: 'session-live: stop its process before a terminal resume' },
        409,
      )
    if (body.force !== true && isSessionSuperseded(rid))
      return c.json(
        {
          ok: false,
          reason:
            'superseded: session is done-marked (handed off/migrated); resuming would duplicate its successor — pass force:true only if you have verified there is no successor',
        },
        409,
      )
  }
  const result = await launchTerminalSession({
    cwd: body.cwd,
    prompt: body.prompt,
    instanceRef: typeof body.instance_ref === 'string' ? body.instance_ref : null,
    model: typeof body.model === 'string' ? body.model : null,
    effort: typeof body.effort === 'string' ? body.effort : null,
    resumeSessionId: typeof body.resume_session_id === 'string' ? body.resume_session_id : null,
    force: body.force === true,
    permissionMode: typeof body.permission_mode === 'string' ? body.permission_mode : null,
  })
  return c.json(result, result.ok ? 200 : 422)
})
// Import a FINISHED session into a desktop instance's app as a visible chat (the app's own
// claude://resume one-way import, targeted at one instance via its profile dir). Refuses a
// session that is currently live — the import rewrites the transcript.
app.post('/api/sessions/:id/import-desktop', async (c) => {
  const sessionId = c.req.param('id')
  const body = await jsonBody(c)
  const ref =
    typeof body.instance_ref === 'string' && body.instance_ref.trim()
      ? body.instance_ref.trim()
      : instanceRefForSession(sessionId)
  if (!ref?.startsWith('desktop:'))
    return c.json(
      { ok: false, error: "instance_ref ('desktop:<dir>') is required — none could be inferred" },
      400,
    )
  if (body.force !== true && isSessionSuperseded(sessionId))
    return c.json(
      {
        ok: false,
        error:
          'superseded: session is done-marked (handed off/migrated); importing would revive a retired lineage — pass force:true only if you have verified there is no successor',
      },
      409,
    )
  // THE NAMING REQUIREMENT (owner directive, 2026-08-29): a chat must not land with a generic
  // name. The caller supplies a real title, or restates the current one exactly (proof of a
  // programmatic review) - chat-title.ts is the one definition of both doors.
  const imported = await getSession(sessionId, 'claude')
  const titled = resolveRequiredTitle({
    title: body.title,
    confirmTitle: body.confirm_title,
    currentTitle: imported?.title ?? null,
  })
  if (!titled.ok) return c.json({ ok: false, error: titled.error }, 400)
  const result = await importSessionToDesktop({
    sessionId,
    instanceDir: ref.slice('desktop:'.length),
    title: titled.title,
    force: body.force === true,
  })
  return c.json(result, result.ok ? 200 : 422)
})
// Stamp a desktop chat's automation posture to bypassPermissions (owner rule, restated
// 2026-08-28: every migrated chat MUST be bypass before it starts; all chats default to
// bypass). Same running-app caveat as every metadata write: verify via the dossier before
// booting and re-stamp when the app re-saved the old mode.
app.post('/api/sessions/:id/automation', async (c) => {
  const sessionId = c.req.param('id')
  const home = await desktopHomeFor(sessionId).catch(() => null)
  if (!home) return c.json({ ok: false, error: 'no desktop entry for this session' }, 404)
  const stamped = applyDesktopChatAutomation(home, sessionId)
  invalidateSessionMetaCache()
  return c.json(
    {
      ok: stamped,
      mode: 'bypassPermissions',
      caveat:
        'a RUNNING app may re-save the old mode; verify via the dossier before booting and re-stamp if needed',
    },
    stamped ? 200 : 422,
  )
})
// Archive (or unarchive) a chat in the DESKTOP app by flipping its metadata flag across every
// profile that carries it. Honest caveat in the response: for a profile whose app was running,
// the change shows only after that instance next restarts (and could be re-saved away by the
// running app; the AgentHydra done-mark is the immediate signal either way).
app.post('/api/sessions/:id/desktop-archive', async (c) => {
  const body = await jsonBody(c)
  const sessionId = c.req.param('id')
  const result = await archiveDesktopChat(sessionId, body.archived !== false)
  // SAY when the flag landed under a running app, rather than returning a bare ok:true for a
  // chat the owner can still see. Measured 2026-08-26 by asking the app itself right after
  // this call: disk said archived, the app still reported isArchived:false, and the chat
  // stayed in the sidebar. Reporting that as success is how "archived" came to mean "still
  // there".
  const underRunningApp = (result.hits ?? []).some((h) => h.changed && h.wasRunning)
  if (underRunningApp)
    return c.json({
      ...result,
      visibleNow: false,
      note:
        'the flag is written, but that app is RUNNING and holds its chat list in memory, so ' +
        'the chat is STILL ON SCREEN until that instance next restarts. To retire it ' +
        "immediately, archive it through the app's own UI - misc/Manage-DesktopChat.ps1 " +
        'automates exactly that click and verifies it landed.',
    })
  return c.json(result, result.ok ? 200 : 404)
})
// The default first message a migrated chat receives when the caller supplies no prompt.
const MIGRATION_NOTICE =
  '[agenthydra] You are being migrated to a different account and this thread will appear ' +
  "in the owner's desktop app shortly. In a few lines: state what this thread is working on, " +
  'what is verified complete so far, and the concrete next steps. Do not start new work in ' +
  'this turn and do not touch any files; after this turn, this notice is spent - resume ' +
  'normally when the owner next asks.'
// Move a chat to a different account, end to end: stop its live process if it has one (this is
// user-initiated — the chat is being moved, so its current run ends), flag its old desktop
// entries archived, then IMPORT it into the target instance's app under its real title. The
// chat continues life on the new account, visible where the user looks.
//
// NOTHING HEADLESS HAPPENS HERE, and that is the point (owner law 2026-08-26). An earlier
// design ran a one-turn "migration notice" resume through the queue on the target account and
// let the finalize hook import the result — which meant every migrated desktop chat spent its
// first turn as an invisible headless run, the exact failure the owner reported ("every chat
// you were migrating from desktop to desktop ended up being migrated to a headless thing I
// couldn't see"). The transcript store is SHARED across instances, so moving a thread needs no
// turn at all: archive the old entries, import into the new profile, done. Any prompt the
// caller wants delivered is sent afterwards through the app's own native message channel, which
// boots the chat's engine in the app where the owner can watch it.
app.post('/api/sessions/:id/migrate', async (c) => {
  const sessionId = c.req.param('id')
  const body = await jsonBody(c)
  const ref = typeof body.instance_ref === 'string' ? body.instance_ref.trim() : ''
  if (!ref.startsWith('desktop:'))
    return c.json({ ok: false, error: "instance_ref ('desktop:<dir>') is required" }, 400)
  // Optional prompt override. The same-instance variant of this endpoint is the REVIVE path for
  // an imported chat the owner never clicked (live-but-deaf to peer messages, measured): kill
  // its passive process, run the caller's message as the resume turn, land it back imported —
  // the nudge gets delivered through the front door instead of queueing into a void.
  const prompt =
    typeof body.prompt === 'string' && body.prompt.trim()
      ? body.prompt.trim().slice(0, 8000)
      : MIGRATION_NOTICE
  const s = await getSession(sessionId, 'claude')
  if (!s) return c.json({ ok: false, error: 'session not found' }, 404)
  // THE NAMING REQUIREMENT (owner directive, 2026-08-29): a migration is a landing, so the
  // same contract as import-desktop - a real new title, or the current one restated exactly.
  const migrateTitle = resolveRequiredTitle({
    title: body.title,
    confirmTitle: body.confirm_title,
    currentTitle: s.title ?? null,
  })
  if (!migrateTitle.ok) return c.json({ ok: false, error: migrateTitle.error }, 400)
  // One lineage, one continuation — checked BEFORE the kill below, so a refused migrate never
  // leaves the thread stopped. A done-marked session was already handed off or migrated; moving
  // it again would spin up a second continuation of work its successor owns.
  if (body.force !== true && isSessionSuperseded(sessionId))
    return c.json(
      {
        ok: false,
        error:
          'superseded: session is done-marked (already handed off/migrated); migrating would duplicate its successor — pass force:true only if you have verified there is no successor',
      },
      409,
    )

  // A live chat's process must stop before anything appends to its transcript. User-initiated:
  // clicking "migrate" means "move this thread", current turn included.
  const live = liveSessionEntry(sessionId)
  if (live) {
    try {
      process.kill(live.pid)
    } catch {
      // Already exiting — the wait below settles it either way.
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && liveSessionEntry(sessionId)) {
      await new Promise((r) => setTimeout(r, 250))
    }
    if (liveSessionEntry(sessionId))
      return c.json({ ok: false, error: 'could not stop the live session process' }, 409)
  }

  // Old desktop entries: flagged archived now, BEFORE the import creates the fresh entry in
  // the target profile.
  await archiveDesktopChat(sessionId, true).catch(() => null)

  // NO CONSOLE IN AUTOMATION (owner ruling, 2026-08-29): every migration lands in the
  // target desktop app - the old terminal fallback for homeless threads is gone. Console is
  // only ever for chats a person deliberately created in a console.
  // Desktop surface: the thread lands in the target instance's app as a chat, dormant. The
  // daemon has no messaging tools of its own, so the PROMPT is not delivered here — an
  // interactive caller delivers it through the app's own message channel, which BOOTS the
  // dormant chat's engine and runs the turn in the app (measured 2026-08-26). No click is
  // involved, and no headless process is created.
  const imported = await importSessionToDesktop({
    sessionId,
    instanceDir: ref.slice('desktop:'.length),
    title: migrateTitle.title,
    force: body.force === true,
  })
  if (!imported.ok) return c.json({ ok: false, error: imported.reason ?? 'import failed' }, 422)
  // The move rewrote metadata in TWO stores (archived in the source, created in the target), and
  // the scan behind every session listing caches for 15s. Without this the very next read serves
  // the pre-migrate rows: the caller sees the chat still on the old account, and setPreferred
  // never gets to pick the live copy over the source's fresh tombstone.
  invalidateSessionMetaCache()
  return c.json({
    ok: true,
    surface: 'desktop',
    stoppedLive: !!live,
    ranHeadless: false,
    prompt,
    promptDelivery: 'deliver-natively-via-the-app-message-channel (boots the chat; no click)',
  })
})

// --- portable window (opens this daemon's own UI in a chromeless app window) -------------------
app.post('/api/portable-window', async (c) => {
  // readInstanceInfo() is populated at boot (writeInstanceInfo below) before the server starts
  // accepting requests, so it always reflects the port we actually bound; PORT is just a
  // last-resort fallback for an unusual boot order.
  const url = readInstanceInfo()?.url ?? `http://${HOST}:${PORT}`
  const profileDir = join(CONFIG_DIR, 'portable-profile')
  // First-run size only — openPortableWindow yields to the profile's saved placement once the
  // user has resized the window themselves (see PORTABLE_WINDOW_SIZE in config.ts). A forwarded
  // --app launch (a window already open on this profile) ignores --window-size AND the saved
  // placement, so also tag the URL with the size this window should have and the page corrects
  // itself with resizeTo (web/src/lib/window-size-hint.ts). The query string is not part of
  // Chromium's placement key; a URL that won't parse just goes out un-hinted.
  let target = url
  try {
    const hint = windowSizeHintFor(profileDir, url, PORTABLE_WINDOW_SIZE)
    if (hint) {
      const u = new URL(url)
      u.searchParams.set(WINDOW_SIZE_HINT_PARAM, hint)
      target = u.toString()
    }
  } catch {
    // unparseable base URL: open it un-hinted rather than fail the route
  }
  return c.json(await openPortableWindow(target, { profileDir, initialSize: PORTABLE_WINDOW_SIZE }))
})

// --- full-shutdown sentinel (web-UI "Shut down") -----------------------------
// A marker file the PowerShell tray host polls (misc/Tray-Host.ps1 watch timer) so a user "Shut
// down" from the web UI tears the WHOLE app down — window + daemon + tray icon — instead of the
// watchdog reviving the daemon. Lives beside runtime.json in CONFIG_DIR (matches the tray's
// SentinelFile = <cmHome>\shutdown.request). Written ONLY for a UI-source shutdown that lacks the
// tray's session token (the tray's own Restart/Quit carry it, so they don't trip this). Cleared on
// boot so a stale one from a hard-killed run never causes a spurious quit. Best-effort throughout.
const SHUTDOWN_REQUEST_FILE = join(CONFIG_DIR, 'shutdown.request')
function writeShutdownRequest(): void {
  try {
    writeFileSync(SHUTDOWN_REQUEST_FILE, JSON.stringify({ ts: Date.now() }), { mode: 0o600 })
  } catch {
    /* best-effort: a tray that misses the sentinel still has its own Quit */
  }
}
function clearShutdownRequest(): void {
  try {
    rmSync(SHUTDOWN_REQUEST_FILE, { force: true })
  } catch {
    /* best-effort */
  }
}

// --- graceful shutdown (tray Quit calls this before falling back to taskkill) ---
const SHUTDOWN_TOKEN = appEnv('SHUTDOWN_TOKEN')
async function flushConnectionsBeforeExit(): Promise<void> {
  await Promise.race([
    flushPending().catch((error) => {
      console.error(
        `[agenthydra] final settings sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
  ])
}

app.post('/api/shutdown', (c) => {
  const trayHeader = c.req.header('x-agenthydra-shutdown-token') ?? ''
  const uiSource = c.req.header('x-agenthydra-shutdown-source') === 'ui'
  // The tray's Restart/Quit carry the session token (source=ui + token). A user "Shut down" from
  // the web UI is source=ui WITHOUT the token — allowed, and it drops the sentinel so the tray
  // tears the whole app down rather than reviving the daemon. A non-UI request must still bear the
  // token (or be rejected). Harmless when no tray is running: nobody polls the sentinel, and the
  // next boot clears it.
  const tokenOk = !!SHUTDOWN_TOKEN && trayHeader === SHUTDOWN_TOKEN
  if (!uiSource && !tokenOk) return c.json({ error: 'forbidden' }, 403)
  if (uiSource && !tokenOk) writeShutdownRequest()
  setTimeout(async () => {
    await flushConnectionsBeforeExit()
    clearInstanceInfo()
    stopAutoUpdate()
    process.exit(0)
  }, 150)
  return c.json({ ok: true })
})

// --- serve the built SPA (single-process / production) ----------------------
const embeddedWeb = (
  globalThis as {
    __AGENTHYDRA_EMBEDDED_WEB__?: Readonly<Record<string, string>>
  }
).__AGENTHYDRA_EMBEDDED_WEB__
const dist = WEB_DIST_CANDIDATES.find((p) => existsSync(p))
if (embeddedWeb) {
  app.get('/*', async (c) => {
    let pathname = decodeURIComponent(new URL(c.req.url).pathname)
    if (pathname === '/' || pathname === '') pathname = '/index.html'
    const lastSeg = pathname.slice(pathname.lastIndexOf('/') + 1)
    const isAsset = pathname.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(lastSeg)
    const embeddedPath = embeddedWeb[pathname]
    if (embeddedPath) {
      return new Response(Bun.file(embeddedPath), {
        headers: {
          'cache-control': pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      })
    }
    if (isAsset) return c.text('not found', 404, { 'cache-control': 'no-store' })
    return new Response(Bun.file(embeddedWeb['/index.html']!), {
      headers: { 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' },
    })
  })
} else if (dist) {
  const root = relative(process.cwd(), dist).replaceAll('\\', '/') || '.'
  app.use('/assets/*', serveStatic({ root }))
  // a stale hashed chunk must 404, not fall through to index.html (wrong MIME → module load error)
  app.get('/assets/*', (c) => c.text('not found', 404, { 'cache-control': 'no-store' }))
  // root-level public files (favicon.svg/.ico, …) must resolve as real files; without this the
  // SPA fallback below answers the browser's favicon request with index.html and the tab icon
  // (and the header logo, which uses the same asset) never loads.
  app.use('/*', serveStatic({ root }))
  app.get('/*', serveStatic({ path: `${root}/index.html` }))
}

/** True if something is already listening on `port` on `host` (non-intrusive TCP probe). Local to
 *  index.ts rather than editing the kit's find-free-port.mjs; shape follows DevWebUI's ports.ts. */
function isPortListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (v: boolean) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(300)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    try {
      sock.connect(port, host)
    } catch {
      done(false)
    }
  })
}

/** Poll until `port` is free (the predecessor released it), up to timeoutMs. Used by the
 *  auto-update relaunch: a daemon respawned with AGENTHYDRA_RELAUNCH=1 waits for its predecessor
 *  to free the preferred port so it rebinds the SAME port instead of hopping. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortListening(port, HOST))) return
    await new Promise((r) => setTimeout(r, 300))
  }
}

// --- boot: single-instance guard, port hop, publish runtime pointer ---------
// The dev launcher (AGENTHYDRA_PORT_FIXED) and the auto-update successor
// (AGENTHYDRA_RELAUNCH) are exempt; see skipSingleInstanceGuard for why, and
// single-instance.test.ts for the regression guard on the relaunch exemption.
const releaseDoubleClick =
  (globalThis as { __AGENTHYDRA_RELEASE_BUILD__?: boolean }).__AGENTHYDRA_RELEASE_BUILD__ ===
    true &&
  !isRelaunchSuccessor() &&
  !appEnv('SHUTDOWN_TOKEN')

if (!skipSingleInstanceGuard()) {
  // Re-probe (3 attempts, 2s each) rather than trusting ONE 1s probe. This decides whether to
  // become a second daemon, so a false "nothing running" is expensive and self-concealing: we
  // then wait out waitForPortFree, hop to PORT+1, and overwrite runtime.json — two live daemons,
  // the pointer aimed at the newer one, and open tabs stranded on the older. That is exactly what
  // the field logs show (paired starts ~6.4s apart == one 1s probe + the 5s waitForPortFree,
  // then the hop). A stale pointer with nothing listening still resolves in well under a second
  // (connections are refused instantly), so this costs a genuine cold start almost nothing.
  // Attempts are chosen from the pointer rather than fixed at 3: a pointer whose process is gone
  // is a tombstone, and re-probing it only buys 500ms of setTimeout on the boot right after a
  // crash. See singleInstanceProbeAttempts in instance.ts.
  const live = await findLiveInstance(2000, singleInstanceProbeAttempts(3))
  if (live) {
    console.log(
      `\n  AgentHydra is already running  →  ${live.url}\n  Not starting a second instance.\n`,
    )
    if (releaseDoubleClick && !noAutoOpen()) openUi(live.url)
    process.exit(0)
  }
}
// A daemon relaunched by the auto-updater (AGENTHYDRA_RELAUNCH=1) waits for its predecessor to
// free the preferred port BEFORE probing/binding, so it rebinds the SAME port (an open browser
// tab's SSE then reconnects seamlessly instead of the daemon hopping to a port the tab can't reach).
if (isRelaunchSuccessor()) await waitForPortFree(PORT, 8000)
// Probe the SAME interface the server binds (HOST); the wildcard probe misses a
// squatter that holds only 127.0.0.1 (e.g. wrangler dev's workerd on 8787).
// A tray "Restart"/"Rebuild & Restart" spawns the successor while the predecessor is still
// tearing down: its /api/health probe already fails (so the single-instance guard passes) yet
// the socket lingers for a few seconds. Without the wait the successor hops to PORT+1 and every
// open tab on the old port starts erroring; the "crashes on relaunch" symptom. A genuine
// squatter (some other app on the port) just costs this one bounded wait, then we hop as before.
let boundPort = PORT
if (process.env.AGENTHYDRA_PORT_FIXED !== '1') {
  if (await isPortListening(PORT, HOST)) await waitForPortFree(PORT, 5000)
  boundPort = await findFreePort(PORT, 50, HOST)
}

writeInstanceInfo(boundPort, {
  portableMode: portableModeEnabled(),
  hideTrayIcon: hideTrayIconEnabled(),
})
// Clear any stale full-shutdown sentinel left by a previous (possibly hard-killed) run, so a
// leftover file can't make the tray quit the instant it next polls. The tray clears it at its own
// startup too; this covers a daemon started without the tray (dev).
clearShutdownRequest()
process.on('exit', () => clearInstanceInfo())
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    await flushConnectionsBeforeExit()
    clearInstanceInfo()
    stopAutoUpdate()
    process.exit(0)
  })

const moved = boundPort !== PORT ? `  (port ${PORT} was busy)` : ''
console.log(`[agenthydra] http://${HOST}:${boundPort}${moved}`)
console.log(`[agenthydra] state: ${DB_PATH}`)
// Loud on purpose. This line only prints when a second state directory exists, and the whole cost
// of that situation is someone not knowing about it (see resolveDataDir in config.ts).
if (DATA_DIR_NOTICE) console.warn(`[agenthydra] WARNING: ${DATA_DIR_NOTICE}`)

// --- Connections cloud sync (opt-in; see server/src/connections.ts) ---------
// Load the persisted session/sync state into memory before the server starts accepting requests.
initConnections()

// Restart the daemon so a freshly-applied update takes over. The tray is a bare supervisor that
// never relaunches us, so the daemon must relaunch ITSELF: spawn a DETACHED copy of this exact
// launch command (AGENTHYDRA_RELAUNCH=1 so the successor waits for our port), then gracefully
// shut THIS daemon down to free the port. Shared by the auto-update loop AND the manual
// /api/update/apply route (a compiled apply swapped the binary on disk — process.execPath now
// points at the NEW exe, so respawning it boots the updated build). Returns false (no shutdown)
// if the successor couldn't be spawned, so we never exit without one.
function relaunchDaemon(): boolean {
  try {
    // In a compiled binary process.argv is ['bun', '<virtual embedded path>', ...realArgs] — a
    // placeholder pair, NOT respawnable. The shared kit builder handles that, pins the port we are
    // actually SERVING on (never the preferred one), and keeps the argv a fixed point so it cannot
    // grow by two tokens on every update. No `command` here: main.ts's daemon mode takes no verb.
    const relaunchArgv = buildRelaunchArgv(process.argv, {
      execPath: process.execPath,
      isCompiled: IS_COMPILED,
      boundPort,
      relaunchFlag: RELAUNCH_FLAG,
    })
    // Through buildDetachedSpawn, not a plain spawn. `detached: true` is NOT a process-tree escape
    // on Windows — the shared primitive's own header says so, and that is the reason it exists.
    // Left as a plain spawn the successor stays inside THIS process's tree for the whole ~800ms
    // handoff, so a tray Quit (`taskkill /T /F`) landing in that window kills the outgoing daemon
    // AND its replacement, leaving the user with none. That hand-off is also why the relaunch
    // signal and the port ride as FLAGS above: WMI does not carry our environment block.
    // hideWindow: the successor is a CONSOLE program (bun), and WMI's default STARTUPINFO gives
    // it a VISIBLE console on the owner's desktop at every auto-update - the recurring mystery
    // "command prompt that says starting" (found live 2026-08-30). Same ShowWindow=0 mechanism
    // the dispatch runner's WMI launch verified on 2026-07-15; closing such a stray console
    // would also CTRL_CLOSE_EVENT-kill the daemon living in it.
    const plan = buildDetachedSpawn(process.platform, relaunchArgv, { hideWindow: true })
    const child = spawn(plan.argv[0] as string, plan.argv.slice(1), {
      cwd: process.cwd(),
      detached: plan.detached,
      stdio: 'ignore',
      windowsHide: true,
      // boundPort, NOT PORT. PORT is the port this daemon PREFERRED (config/env); boundPort is the
      // one it is actually serving on, and they diverge for every daemon that has ever hopped. The
      // successor uses this value for BOTH of its jobs, so handing it the preferred port breaks both:
      // waitForPortFree() waits out its full 8s on a port the predecessor never held (nothing is
      // going to release it), and findFreePort() then binds that port instead of the one the user's
      // open tab is on — so a healthy daemon moves out from under the tab and its SSE stream dies.
      // Passing boundPort makes the wait apply to the socket actually being released and keeps the
      // daemon on ONE port across updates, which is the whole point of the handoff.
      env: { ...process.env, AGENTHYDRA_RELAUNCH: '1', PORT: String(boundPort) },
    })
    child.unref()
  } catch (e) {
    console.error('[agenthydra] relaunch failed to spawn; staying on the running version.', e)
    return false
  }
  console.log('[agenthydra] update applied, relaunching the daemon…')
  setTimeout(async () => {
    await flushConnectionsBeforeExit()
    clearInstanceInfo()
    stopAutoUpdate()
    process.exit(0)
  }, 800) // let the successor start, then free the port
  return true
}

// --- auto-update loop (opt-in; see server/src/auto-update.ts) ---------------
// Prime the runtime flags from persisted settings now; the timer itself only starts after boot
// (startAutoUpdate below), one interval out, so a fresh launch is never interrupted.
loadAutoUpdateSettings()
setAutoUpdateHooks({
  // Don't auto-update (which relaunches the daemon) while dispatch runs are in flight.
  // Busy means MORE than dispatch runs (review-confirmed): a standing-sweep tick or any act
  // (UIA archive click, instance boot+import) mid-flight must not be killed by a relaunch.
  hasActiveRuns: () => activeCount() > 0 || isSweepTicking() || isActBusy(),
  relaunch: relaunchDaemon,
})

// A compiled build's self-updater renames the old exe + web/dist aside during a swap; sweep any
// such leftovers from a previous update now (best-effort, compiled-only). See github-updater.ts.
if (IS_COMPILED) cleanupStaleUpdateArtifacts()

// --- reattach in-flight dispatch runs (they OUTLIVE the daemon; see dispatch.ts) --------------
// A tray Quit / auto-update relaunch / crash leaves detached `claude` runs still executing. Recover
// them now: rebuild each run's events from its on-disk log and resume tailing to completion, so the
// UI shows them live again and their final status is recorded instead of being stuck 'running'.
// The scheduler/monitor auto-dispatchers stay parked (boot-state.ts) until this settles, so they
// can't double-dispatch a surviving run's session before it's back in the `active` map.
void reattachRuns().finally(markDispatchReady)

startAutoUpdate()

// --- transient-overload retry sweep (ALWAYS ON; see server/src/dispatch.ts) --------------------
// Re-fires runs that died on a 529 once their few-second backoff elapses. Not behind the scheduler
// or monitor switches on purpose: those govern hours-scale autonomy ("run my queue", "prompt my
// sessions while I sleep"), whereas this just finishes the run the user started by hand seconds
// ago and which died on someone else's server hiccup.
startRetrySweep()

// --- desktop delivery sweep (ALWAYS ON; see server/src/dispatch.ts) ---------------------------
// Finishes landing migrated/handed-off chats in their target instance's app. The import refuses a
// target that is not running (firing it at a closed instance would BOOT that account), so a run
// that finishes while the owner is asleep used to reach a console.error and vanish. Now it stays
// pending and lands when that app is next open, or gives up after a day and says why.
startImportSweep()

// --- auto-resume monitor loop (opt-in; OFF by default; see server/src/monitor.ts) -------------
// The poll loop always runs; each tick is a no-op unless `monitor_enabled` is set. It watches for
// dispatch runs that stopped 'rate_limited' (their QUOTA is spent — a 529 is handled by the retry
// sweep above, not here), gates each on the weekly cap via checkUsage, and schedules a
// `claude --resume` for just after the 5-hour reset.
startMonitor()
startSweepLoop()

// --- background usage refresh (ON by default; see server/src/usage-refresh.ts) -----------------
// A check is now a ~300ms HTTPS GET against the quota endpoint, not a `claude` spawn, and reading
// your quota does not consume it — so keeping the numbers warm costs essentially nothing. Toggle in
// Settings → Usage.
startUsageRefresh()

// --- one-time repair: CLI config dirs still naming the pre-rebrand config root ------------------
// See migrateCliInstanceConfigDirs. A no-op on every install except one carried across the
// ccmanagerui → agenthydra rename, where it is what makes an existing CLI login readable again.
{
  const migrated = migrateCliInstanceConfigDirs()
  if (migrated.length)
    console.log(`[cli-instances] repointed ${migrated.length} config dir(s) to ${CONFIG_DIR}`)
}

// --- reset notifications (ON by default; see server/src/reset-watch.ts) ------------------------
// The sweep above keeps the numbers warm; this turns the EDGE — a 5-hour or weekly window rolling
// over — into a native OS notification. `recheck` is injected rather than imported so reset-watch
// never imports usage-service (which imports back into the usage stack).
startResetWatch({
  recheck: async (key) => {
    if (key.startsWith('desktop:')) {
      await checkUsageForDesktop(key.slice('desktop:'.length))
      return
    }
    if (key.startsWith('cli:')) await checkUsageForCliInstance(key.slice('cli:'.length))
  },
})

// Explicit serve, NOT Bun's implicit `export default { fetch }` sugar: the implicit form only
// auto-serves when THIS file is the process entrypoint, and the compiled binary reaches the daemon
// via main.ts's dynamic import (where the default export would be silently inert — verified: the
// daemon "booted", logged its URL, and listened on nothing).
const server = Bun.serve({
  port: boundPort,
  hostname: HOST,
  fetch: app.fetch,
  idleTimeout: 255,
})

// --- prices (see server/src/price-catalog.ts) --------------------------------------------------
// Synchronous cache read, then a deferred download if that cache is stale. Placed BEFORE the
// analytics warm so a restart prices its first scan from last run's catalog rather than from the
// build's table, and never awaited: a daemon that cannot reach the network still prices every
// model it shipped knowing about.
startPriceCatalog()

// --- warm the sessions list (see server/src/sessions.ts warmSessionScanCache) ------------------
// Deliberately AFTER Bun.serve: parsing transcripts is the slowest thing this daemon does, and the
// point is to overlap it with the browser starting up rather than to delay listening on the port.
// .catch, not `void`: this is unawaited and runs AFTER the port is bound, so an unhandled rejection
// here takes the daemon down in the worst possible shape — the port reads as claimed, then nothing
// ever serves it. Warming is purely an optimization (the list still builds on demand), so any
// failure must degrade to a cold first request, never to a dead process.
warmSessionScanCache()
  .catch((error) => {
    console.error('[agenthydra] session-scan warm failed; the list will build on demand:', error)
  })
  // Analytics AFTER the list warm, not alongside it. Both read the same transcripts, and the list
  // is what the user is waiting for; racing them would slow the visible thing to speed up a tab
  // nobody has opened yet. Fire-and-forget by design (see warmAnalyticsInBackground).
  .finally(() => warmAnalyticsInBackground())

if (releaseDoubleClick && !noAutoOpen()) {
  const url = `http://127.0.0.1:${server.port}/`
  if (!openUi(url))
    console.error(`[agenthydra] Could not open a browser automatically. Open ${url} manually.`)
}

export type App = typeof app
