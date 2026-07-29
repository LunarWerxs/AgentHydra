import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { basename, join, relative } from 'node:path'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import {
  autoUpdateEnabled,
  getAutoUpdateIntervalSecs,
  loadAutoUpdateSettings,
  setAutoUpdateEnabled,
  setAutoUpdateHooks,
  setAutoUpdateIntervalSecs,
  startAutoUpdate,
  stopAutoUpdate,
} from './auto-update'
import { markDispatchReady } from './boot-state'
import {
  CLIPBOARD_DIR,
  CONFIG_DIR,
  HOST,
  IS_COMPILED,
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
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  launchCliInstance,
  linkCliInstanceToDesktop,
  listCliInstances,
  renameCliInstance,
  setCliInstanceUsage,
} from './core/cli-instances'
import {
  createCodexInstance,
  deleteCodexInstance,
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
import { coerceQueueItem, db, getSetting, setSetting } from './db'
import {
  activeCount,
  cancelItem,
  dispatchItem,
  getRunEvents,
  isActive,
  isSessionActive,
  type RunMessage,
  reattachRuns,
  startRetrySweep,
  subscribeRun,
} from './dispatch'
import { contentDispositionAttachment, safeTranscriptFilename } from './filenames'
import { findFreePort } from './find-free-port.mjs'
import { cleanupStaleUpdateArtifacts } from './github-updater'
import {
  clearInstanceInfo,
  findLiveInstance,
  readInstanceInfo,
  updateInstanceInfo,
  writeInstanceInfo,
} from './instance'
import { resolveRunAsRef } from './instance-sessions'
import { initFileLogging } from './log-file.mjs'
import { isLoopbackOrigin, loopbackGuard } from './loopback-guard.mjs'
import {
  getMonitorSettings,
  listMonitorAccounts,
  monitorStatus,
  runMonitorOnce,
  setMonitorForAccount,
  setMonitorSettings,
  startMonitor,
} from './monitor'
import { openUi } from './open-ui'
import { openPortableWindow } from './portable-window.mjs'
import { getProviderSettings, setProviderSettings } from './provider-settings'
import { schedulerState, setSchedulerSettings } from './scheduler'
import { searchSessionBodies } from './session-search'
import { getSession, listSessions, sessionMarkKey, warmSessionScanCache } from './sessions'
import { skipSingleInstanceGuard } from './single-instance'
import { findTranscript, tailTranscript } from './transcript'
import { buildTranscriptOpenArgv, resolveEditor } from './transcript-open'
import {
  type Account,
  AMBIENT_RUN_AS,
  type ArchivedScope,
  isSessionPeriod,
  isSessionSource,
  type MonitorView,
  periodCutoffMs,
  type QueueItem,
  type SessionPeriod,
  type SessionSource,
  type UsageCheckResult,
} from './types'
import { applyUpdate, checkForUpdate } from './updater'
import {
  allCachedUsage,
  checkUsage,
  getCachedUsage,
  isNoData,
  setCachedUsage,
  usageAdvice,
} from './usage'
import { budgetSummary, buildUsageBudget } from './usage-budget'
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
  console.error('[ccmanagerui] uncaught exception:', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[ccmanagerui] unhandled rejection:', reason)
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

// --- hide tray icon (server/src/db.ts settings table; read live by misc/CCManagerUI-Tray.ps1) ---
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

function boundedQueryInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(parsed)))
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
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    distribution: IS_COMPILED ? 'compiled' : 'source',
    ts: Date.now(),
  }),
)

// --- self-update (source: git engine; compiled: GitHub Releases — see server/src/updater.ts) --
app.get('/api/update', async (c) =>
  c.json({
    ...(await checkForUpdate()),
    // Informational: which mechanism is live. Both compiled + source support check/apply now, so
    // the UI drives the same controls for either; this just lets a caller distinguish them.
    distribution: IS_COMPILED ? 'compiled' : 'source',
    autoUpdate: { enabled: autoUpdateEnabled(), intervalSecs: getAutoUpdateIntervalSecs() },
  }),
)
app.post('/api/update/apply', async (c) => {
  const result = await applyUpdate()
  // A compiled apply swapped the binary on disk; the running process is still the OLD one, so it
  // MUST relaunch for the update to take effect (a source apply leaves the daemon to be restarted
  // manually — restartGuidance in the UI — matching its historical behavior). Fire after the
  // response is sent so the client sees the result before the port drops.
  if (IS_COMPILED && result.ok && result.restartRequired) {
    setTimeout(() => relaunchDaemon(), 250)
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
})
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
  return c.json(appSettings())
})

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
  return c.json(
    await listSessions(
      boundedQueryInt(limit, 200, 500),
      instance || undefined,
      scope,
      periodCutoffMs(period),
      source,
    ),
  )
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
  const tf = findTranscript(id, source)
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
// Return the original transcript's absolute location so the SPA can copy it as plain text.
// Resolve it here rather than reconstructing it in the browser: project-folder encoding is lossy,
// and findTranscript also handles the rare case where the same session id exists in two folders.
app.get('/api/sessions/:id/file-location', (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const tf = findTranscript(c.req.param('id'), source)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode')
    return c.json({ error: 'OpenCode sessions are stored in a shared database' }, 409)
  return c.json({ path: tf.path })
})
// Open the transcript in an editor (loopback daemon: same posture as the portable-window spawn;
// the file opens on the machine the daemon runs on). .jsonl has no OS file association, so handing
// this to the bare default handler would pop Windows' "Pick an app" dialog instead of opening -
// buildTranscriptOpenArgv names an editor explicitly so that never happens (transcript-open.ts).
app.post('/api/sessions/:id/open-file', (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const tf = findTranscript(c.req.param('id'), source)
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
  const tf = findTranscript(id, source)
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
          'Set-Clipboard -LiteralPath $env:CCMANAGERUI_CLIP_PATH',
        ]
      : [
          'osascript',
          '-e',
          'set the clipboard to (POSIX file (system attribute "CCMANAGERUI_CLIP_PATH"))',
        ]
  try {
    // windowsHide: true on every console-program spawn in this file, not just this one. The daemon
    // only inherits a window-less console today because Tray-Host.ps1 happens to launch it with
    // CreateNoWindow=true. Started any other way (a terminal, Explorer, the compiled portable exe),
    // that inheritance is gone and a plain click on this button would flash a real console window.
    // Stating the intent at the spawn call makes that impossible regardless of how the daemon started.
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, CCMANAGERUI_CLIP_PATH: staged },
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
  const textOnly = c.req.query('textOnly')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  return c.json(
    await tailTranscript(
      c.req.param('id'),
      {
        limit: boundedQueryInt(limit, 40, 200),
        textOnly: textOnly === '1' || textOnly === 'true',
      },
      source,
    ),
  )
})
// Advanced BODY search (streams every transcript file, substring or regex); deliberately a
// separate, slower, opt-in path so the fast metadata list above (GET /api/sessions, used by the
// default client-side filter) is never touched by this. See server/src/session-search.ts.
app.get('/api/sessions/search', async (c) => {
  const query = c.req.query('q') ?? ''
  if (!query.trim()) return c.json([])
  const regex = c.req.query('regex') === '1'
  const caseSensitive = c.req.query('case') === '1'
  const instance = c.req.query('instance') || undefined
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  try {
    return c.json(await searchSessionBodies({ query, regex, caseSensitive, instance, source }))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
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
app.delete('/api/accounts/:id', (c) => {
  db.query('delete from accounts where id = ?').run(c.req.param('id'))
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
  const posRow = db
    .query<{ m: number | null }, []>('select max(position) as m from queue_items')
    .get()
  const position = (posRow?.m ?? 0) + 1
  db.query(
    `insert into queue_items
       (id, session_id, title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, new_chat, fork, status, position, not_before, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    body.title,
    body.cwd,
    body.prompt,
    body.model ?? null,
    body.effort ?? null,
    body.permission_mode ?? null,
    body.account_id ?? null,
    instanceRef,
    body.new_chat ? 1 : 0,
    body.fork ? 1 : 0,
    position,
    notBefore,
    Date.now(),
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
app.get('/api/queue/:id/events', (c) => c.json(getRunEvents(c.req.param('id'))))

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

app.get('/api/usage', async (c) => {
  const account = c.req.query('account')
  const configDir = c.req.query('configDir')
  const refresh = wantsRefresh(c)
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
  const configDirs = c.req.queries('configDir')

  const result = dir
    ? await checkUsageForDesktop(dir)
    : account
      ? await (async () => {
          const resolved = resolveAccountParam(account)
          if (!resolved) return null
          const snapshot = await checkUsageForAccount(resolved.id)
          return { snapshot, cached: false, key: `acct:${resolved.id}`, reason: 'ok' as const }
        })()
      : null
  if (!result)
    return c.json({ error: 'pass dir (a desktop instance) or account (id or label)' }, 400)

  const budget = buildUsageBudget(result.snapshot, result.key, {
    configDirs: configDirs?.length ? configDirs : undefined,
  })
  return c.json({
    snapshot: result.snapshot,
    reason: result.reason,
    advice: usageAdvice(result.snapshot),
    budget,
    summary: budgetSummary(budget, result.snapshot.weekAll?.pct ?? null),
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
app.get('/api/cli-instances', (c) => c.json(listCliInstances()))
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
const SHUTDOWN_TOKEN = process.env.CCMANAGERUI_SHUTDOWN_TOKEN
async function flushConnectionsBeforeExit(): Promise<void> {
  await Promise.race([
    flushPending().catch((error) => {
      console.error(
        `[ccmanagerui] final settings sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
  ])
}

app.post('/api/shutdown', (c) => {
  const trayHeader = c.req.header('x-ccmanagerui-shutdown-token') ?? ''
  const uiSource = c.req.header('x-ccmanagerui-shutdown-source') === 'ui'
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
    __CCMANAGERUI_EMBEDDED_WEB__?: Readonly<Record<string, string>>
  }
).__CCMANAGERUI_EMBEDDED_WEB__
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
 *  auto-update relaunch: a daemon respawned with CCMANAGERUI_RELAUNCH=1 waits for its predecessor
 *  to free the preferred port so it rebinds the SAME port instead of hopping. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortListening(port, HOST))) return
    await new Promise((r) => setTimeout(r, 300))
  }
}

// --- boot: single-instance guard, port hop, publish runtime pointer ---------
// The dev launcher (CCMANAGERUI_PORT_FIXED) and the auto-update successor
// (CCMANAGERUI_RELAUNCH) are exempt; see skipSingleInstanceGuard for why, and
// single-instance.test.ts for the regression guard on the relaunch exemption.
const releaseDoubleClick =
  (globalThis as { __CCMANAGERUI_RELEASE_BUILD__?: boolean }).__CCMANAGERUI_RELEASE_BUILD__ ===
    true &&
  process.env.CCMANAGERUI_RELAUNCH !== '1' &&
  !process.env.CCMANAGERUI_SHUTDOWN_TOKEN

if (!skipSingleInstanceGuard()) {
  // Re-probe (3 attempts, 2s each) rather than trusting ONE 1s probe. This decides whether to
  // become a second daemon, so a false "nothing running" is expensive and self-concealing: we
  // then wait out waitForPortFree, hop to PORT+1, and overwrite runtime.json — two live daemons,
  // the pointer aimed at the newer one, and open tabs stranded on the older. That is exactly what
  // the field logs show (paired starts ~6.4s apart == one 1s probe + the 5s waitForPortFree,
  // then the hop). A stale pointer with nothing listening still resolves in well under a second
  // (connections are refused instantly), so this costs a genuine cold start almost nothing.
  const live = await findLiveInstance(2000, 3)
  if (live) {
    console.log(
      `\n  CC Manager UI is already running  →  ${live.url}\n  Not starting a second instance.\n`,
    )
    if (releaseDoubleClick && process.env.CCMANAGERUI_NO_OPEN !== '1') openUi(live.url)
    process.exit(0)
  }
}
// A daemon relaunched by the auto-updater (CCMANAGERUI_RELAUNCH=1) waits for its predecessor to
// free the preferred port BEFORE probing/binding, so it rebinds the SAME port (an open browser
// tab's SSE then reconnects seamlessly instead of the daemon hopping to a port the tab can't reach).
if (process.env.CCMANAGERUI_RELAUNCH === '1') await waitForPortFree(PORT, 8000)
// Probe the SAME interface the server binds (HOST); the wildcard probe misses a
// squatter that holds only 127.0.0.1 (e.g. wrangler dev's workerd on 8787).
// A tray "Restart"/"Rebuild & Restart" spawns the successor while the predecessor is still
// tearing down: its /api/health probe already fails (so the single-instance guard passes) yet
// the socket lingers for a few seconds. Without the wait the successor hops to PORT+1 and every
// open tab on the old port starts erroring; the "crashes on relaunch" symptom. A genuine
// squatter (some other app on the port) just costs this one bounded wait, then we hop as before.
let boundPort = PORT
if (process.env.CCMANAGERUI_PORT_FIXED !== '1') {
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
console.log(`[ccmanagerui] http://${HOST}:${boundPort}${moved}`)

// --- Connections cloud sync (opt-in; see server/src/connections.ts) ---------
// Load the persisted session/sync state into memory before the server starts accepting requests.
initConnections()

// Restart the daemon so a freshly-applied update takes over. The tray is a bare supervisor that
// never relaunches us, so the daemon must relaunch ITSELF: spawn a DETACHED copy of this exact
// launch command (CCMANAGERUI_RELAUNCH=1 so the successor waits for our port), then gracefully
// shut THIS daemon down to free the port. Shared by the auto-update loop AND the manual
// /api/update/apply route (a compiled apply swapped the binary on disk — process.execPath now
// points at the NEW exe, so respawning it boots the updated build). Returns false (no shutdown)
// if the successor couldn't be spawned, so we never exit without one.
function relaunchDaemon(): boolean {
  try {
    // In a compiled binary process.argv is ['bun', '<virtual embedded path>', ...realArgs] — a
    // placeholder pair, NOT respawnable. process.execPath + (real script in source mode) + the
    // real args (argv.slice(2)) is the one shape that relaunches correctly in both modes.
    const relaunchArgs = IS_COMPILED
      ? process.argv.slice(2)
      : [process.argv[1]!, ...process.argv.slice(2)]
    const child = spawn(process.execPath, relaunchArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CCMANAGERUI_RELAUNCH: '1', PORT: String(PORT) },
    })
    child.unref()
  } catch (e) {
    console.error('[ccmanagerui] relaunch failed to spawn; staying on the running version.', e)
    return false
  }
  console.log('[ccmanagerui] update applied, relaunching the daemon…')
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
  hasActiveRuns: () => activeCount() > 0,
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

// --- auto-resume monitor loop (opt-in; OFF by default; see server/src/monitor.ts) -------------
// The poll loop always runs; each tick is a no-op unless `monitor_enabled` is set. It watches for
// dispatch runs that stopped 'rate_limited' (their QUOTA is spent — a 529 is handled by the retry
// sweep above, not here), gates each on the weekly cap via checkUsage, and schedules a
// `claude --resume` for just after the 5-hour reset.
startMonitor()

// --- background usage refresh (ON by default; see server/src/usage-refresh.ts) -----------------
// A check is now a ~300ms HTTPS GET against the quota endpoint, not a `claude` spawn, and reading
// your quota does not consume it — so keeping the numbers warm costs essentially nothing. Toggle in
// Settings → Usage.
startUsageRefresh()

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

// --- warm the sessions list (see server/src/sessions.ts warmSessionScanCache) ------------------
// Deliberately AFTER Bun.serve: parsing transcripts is the slowest thing this daemon does, and the
// point is to overlap it with the browser starting up rather than to delay listening on the port.
void warmSessionScanCache()

if (releaseDoubleClick && process.env.CCMANAGERUI_NO_OPEN !== '1') {
  const url = `http://127.0.0.1:${server.port}/`
  if (!openUi(url))
    console.error(`[ccmanagerui] Could not open a browser automatically. Open ${url} manually.`)
}

export type App = typeof app
