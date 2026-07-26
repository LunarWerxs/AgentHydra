// Shared types, imported by the Vue app via Eden for end-to-end typing.

/** "Sync my settings with Connections" DTO, defined HERE (not re-exported from
 * ./connections.ts) because that module imports Bun-only runtime files (db.ts), which
 * must never be pulled into the web app's vue-tsc pass; ./connections.ts imports it back.
 * Status shape returned by every settings-sync endpoint (matches DevWebUI's SyncStatus). */
export interface SyncStatus {
  ok: true
  /** Sync is turned on (independent of whether a Connections credential exists). */
  enabled: boolean
  /** The daemon holds a Connections credential (owner is signed in). */
  connected: boolean
  /** Signed-in display name, or null when not connected (or a pre-name connection pending refresh). */
  name: string | null
  /** Privacy-relay email; third-party apps never receive the real inbox, shown only as a fallback. */
  email: string | null
  /** Avatar image URL from the IdP, or null when not granted/available. */
  picture: string | null
  /** ISO timestamp of the last successful sync, or null. */
  lastSyncedAt: string | null
  version: number
  /** Last-synced appearance blob (e.g. `{ theme }`) to apply locally, or null. */
  appearance: Record<string, unknown> | null
}
// Instance DTOs ("instance account" = which Anthropic account a Claude Desktop *instance*
// is logged into) are defined in ./core/shared.ts, re-exported here so the web app only
// ever imports types from this one module, same as every other DTO below.
export type {
  CMAccount,
  CMAccountStatus,
  CMActionResult,
  CMDesktopInstall,
  CMInstance,
  InstanceColorKey,
  InstanceIconKey,
} from './core/shared'
// Value re-exports (the curated icon/color key sets + label cap) so the web app drives its
// icon/color pickers from the exact same source of truth the server validates against. These
// are pure literal constants; ./core/shared imports nothing runtime-heavy, so pulling them into
// the browser bundle is safe.
export { INSTANCE_COLOR_KEYS, INSTANCE_ICON_KEYS, INSTANCE_LABEL_MAX } from './core/shared'
/** Portable-window opener result (see ./portable-window.mjs), re-exported here so the web
 * app only ever imports types from this one module, same as every other DTO in this file. */
export type { PortableWindowResult } from './portable-window.mjs'
/** Self-updater DTOs (see ./updater-engine.mjs), re-exported here so the web app only
 * ever imports types from this one module, same as every other DTO in this file. */
export type { UpdateApplyResult, UpdateStatus } from './updater-engine.mjs'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AuthType = 'oauth_token' | 'api_key'
export type QueueStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  /** YOUR allowance is spent (session/weekly). Only time fixes it — monitor.ts resumes off this. */
  | 'rate_limited'
  /** ANTHROPIC'S servers were saturated (529). Nothing is wrong with the run; it is retried
   *  automatically a few times first, and only lands here if the overload outlasted the backoff.
   *  Deliberately NOT 'rate_limited': that would park a seconds-long blip against a 5-hour reset. */
  | 'overloaded'
  | 'canceled'
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

/** A supported conversation store. Claude/Codex are JSONL; OpenCode is its shared SQLite DB. */
export type SessionSource = 'claude' | 'codex' | 'opencode'
export type SessionSourceScope = 'all' | SessionSource

export function isSessionSource(v: unknown): v is SessionSource {
  return v === 'claude' || v === 'codex' || v === 'opencode'
}

/** A session discovered in one of the supported local conversation stores. */
export interface SessionSummary {
  session_id: string
  source: SessionSource
  title: string
  cwd: string
  project: string
  git_branch: string | null
  message_count: number
  created_at: number | null
  last_activity_at: number
  last_role: 'user' | 'assistant' | null
  last_text_preview: string | null
  size_bytes: number
  transcript_path: string
  /** Live status pulled from our own queue, if this session is scheduled/running under us. */
  queue_status: QueueStatus | null
  /** Claude Desktop instance the session ran in: an `~/.claude-instances` dir name,
   *  "default" for the non-isolated install, or null for plain CLI / another provider. */
  instance: string | null
  /** Provider archive state: Claude Desktop metadata, Codex's archived rollouts folder, or
   *  OpenCode's archived timestamp. False when the provider carries no archive signal. */
  archived: boolean
  /** The user's own mark, stored in our `session_marks` table. Mark only: never filters a list. */
  done: boolean
}

/** How a session list treats provider archive state. 'hide' is the default because archived is the
 *  large majority of a real store, so including it buries live work; 'only' makes old work findable. */
export type ArchivedScope = 'hide' | 'include' | 'only'

/** How far back a session list reaches, by last activity. '24h' is the default: the list is a
 *  "what am I working on" surface, and a store holding months of transcripts answers that question
 *  worse the further back it goes. 'all' restores the old unbounded behaviour. */
export type SessionPeriod = '24h' | '7d' | '30d' | 'all'

const PERIOD_MS: Record<Exclude<SessionPeriod, 'all'>, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
}

export function isSessionPeriod(v: unknown): v is SessionPeriod {
  return v === '24h' || v === '7d' || v === '30d' || v === 'all'
}

/** Epoch cutoff for a period, or null for 'all' (no cutoff). */
export function periodCutoffMs(period: SessionPeriod, now = Date.now()): number | null {
  return period === 'all' ? null : now - PERIOD_MS[period]
}

/** One displayable turn from a transcript tail, after the hide-"thinking" filter. */
export interface TailEvent {
  role: 'user' | 'assistant'
  kind: 'text' | 'tool_use' | 'tool_result'
  text: string
  tool_name: string | null
  timestamp: string | null
}

export interface TailResult {
  session_id: string
  source: SessionSource
  title: string
  cwd: string
  events: TailEvent[]
  error?: string
}

/** One session's hits from an advanced BODY search (server/src/session-search.ts). */
export interface SessionSearchResult {
  session_id: string
  source: SessionSource
  cwd: string
  project: string
  match_count: number
  /** True when match_count hit the per-file cap; there may be more matches not shown. */
  truncated: boolean
  snippets: string[]
}

export interface Account {
  id: string
  label: string
  auth_type: AuthType
  /** Never returned in full; masked for display. */
  secret_masked: string
  created_at: number
}

export interface QueueItem {
  id: string
  session_id: string
  title: string
  cwd: string
  prompt: string
  model: string | null
  effort: EffortLevel | null
  permission_mode: PermissionMode | null
  account_id: string | null
  /** Run under an already-signed-in instance's login: 'desktop:<dir>' or 'cli:<id>'. The runner
   *  extracts that instance's OAuth token value-blind at spawn time (core/accounts.ts) — no
   *  pasted credential involved. Mutually exclusive with account_id in practice; when both are
   *  set the instance ref wins (dispatch-runner checks it first). */
  instance_ref: string | null
  new_chat: boolean
  fork: boolean
  status: QueueStatus
  pid: number | null
  position: number
  /** ISO timestamp; the scheduler won't auto-dispatch before this (manual Run ignores it). */
  not_before: string | null
  /** How many times a transient-overload (529) retry has already re-run this item. >0 with a
   *  not_before in the future means "waiting out a backoff", which the always-on retry sweep in
   *  dispatch.ts fires — no scheduler or monitor opt-in involved. */
  retry_attempts: number
  started_at: string | null
  finished_at: string | null
  exit_code: number | null
  created_at: number
}

export interface RunEvent {
  id: number
  queue_item_id: string
  seq: number
  ts: string
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'tool_use' | 'tool_result' | 'meta'
  text: string
  tool_name: string | null
}

export interface SchedulerState {
  enabled: boolean
  running_count: number
  queued_count: number
  spacing_seconds: number
  poll_seconds: number
  max_concurrent: number
  /** "HH:MM" local time used by the composer's "Tomorrow …" quick option. */
  tomorrow_time: string
}

/** Portable-window setting: open the UI in a chromeless Chromium app window instead of a
 * browser tab (both the in-app toggle and the desktop tray launcher honor it). */
export interface PortableModeSettings {
  portableMode: boolean
  /** Hide the tray's NotifyIcon (the daemon keeps running; the tray keeps re-reading this
   *  live so re-enabling it here restores the icon without a restart). */
  hideTrayIcon: boolean
}

/** Transcript-file-open setting (server/src/transcript-open.ts). */
export interface TranscriptSettings {
  /** Absolute path to an editor; '' = auto-detect. */
  transcriptEditor: string
  /** Read-only echo: the editor that will ACTUALLY open a transcript, after auto-detect and after
   *  discarding an override that points at nothing. Derived, never stored; POST ignores it. Without
   *  showing this, a typo'd override is indistinguishable from a working one (the open silently
   *  no-ops), which is the whole reason a plain path field is safe to keep. */
  transcriptEditorResolved: string
}

// --- usage-check subsystem (Feature B) --------------------------------------
// These DTOs live HERE (the pure, web-safe types hub) rather than in server/src/usage.ts, so the
// Vue app's type-only import path never pulls a Bun-only module. The runtime `usage.ts` imports
// them back, same discipline as SyncStatus above.

/** Server-computed "how bad is this" for one limit. Only the API path supplies it; the text
 *  parser cannot (the `/usage` screen renders severity as color, which we never see). */
export type UsageSeverity = 'normal' | 'warning' | 'critical'

/** One limit line from `/usage`: a percent used and a human reset string. */
export interface UsageLimit {
  pct: number
  /** Human reset string ("Jul 19, 3:59am"), or '' when the window hasn't started. */
  resets: string
  /** ISO-8601 reset timestamp. Present on the API path only; the text screen prints no year, so
   *  the CLI path has to guess one (see parseResetTime). Prefer this when it is here. */
  resetsAt?: string | null
  severity?: UsageSeverity
}

/** Where a snapshot came from. 'api' is the fast direct read; 'cli' is the `claude -p` fallback. */
export type UsageSource = 'api' | 'cli'

/** A parsed snapshot of one account's quota at a moment in time. */
export interface UsageSnapshot {
  /** Account label/email if the caller knew it; the `/usage` text does not name the account. */
  account: string | null
  /** The 5-hour rolling session window. */
  session: UsageLimit | null
  /** The weekly all-models limit — the BINDING cap for pacing decisions. */
  weekAll: UsageLimit | null
  /** A per-model weekly sub-limit (e.g. "Fable"), when present. */
  weekModel: (UsageLimit & { label: string }) | null
  capturedAt: string
  /** Optional for back-compat with snapshots cached before the API path existed. */
  source?: UsageSource
}

/**
 * Why a usage check turned out the way it did — lets the UI explain a "—" instead of showing it
 * silently. 'ok' = real numbers; the rest are actionable no-data reasons.
 */
export type UsageReason =
  | 'ok'
  | 'logged_out' // desktop instance isn't signed in
  | 'no_token' // desktop instance signed in but no usable/decryptable token
  | 'not_logged_in' // CLI instance has no login and no associated account
  | 'check_failed' // the probe ran but returned no parseable usage
  | 'unknown'

/**
 * The actionable verdict derived from a snapshot — what an agent should DO about these numbers.
 *
 * This exists because the raw percentages are not self-interpreting: an AI (or a person) reading
 * "98%" still has to know that the weekly all-models bucket is the binding cap, that a 0% session
 * alongside it means nothing, and that the correct response is to write your working context to disk
 * BEFORE you get cut off mid-task. See usageAdvice() in server/src/usage.ts.
 */
export interface UsageAdvice {
  severity: 'unknown' | UsageSeverity
  /** The binding weekly all-models %, or null if unknown. */
  bindingPct: number | null
  /** True when the agent should save/offload its working context before doing more work. */
  shouldOffload: boolean
  /** True when a heavy multi-agent fan-out is a reasonable idea right now. */
  safeToFanOut: boolean
  advice: string
}

// --- quantifying the percentage ---------------------------------------------
// The usage endpoint reports a percentage and NOTHING else (limit_dollars / used_dollars /
// remaining_dollars are all null on a subscription; there are no token counts). A bare "98%" cannot
// tell an agent whether it can afford a task. These three DTOs turn it into something budgetable:
// a rate (UsageForecast), a countable spend (TokenSpend), and the two combined (UsageBudget).

/** One historical reading, kept so the % can be differentiated into a rate. */
export interface UsageSample {
  at: string
  sessionPct: number | null
  weekAllPct: number
  weekResetsAt: string | null
}

/** The percentage, differentiated. See server/src/usage-history.ts. */
export interface UsageForecast {
  /** Point-estimate burn, in percent per hour. Null = unmeasurable. NOTE: a value of 0 does NOT mean
   *  "idle" — the source percentage is an integer, so 0 means "slower than this span can resolve".
   *  Do not make decisions on this; use burnPctPerHourUpper. */
  burnPctPerHour: number | null
  /** The quantization-safe UPPER bound on the burn. Every derived figure below is computed from THIS,
   *  so the forecast errs pessimistic: a needless warning is cheap, a false "work freely" is not. */
  burnPctPerHourUpper: number | null
  remainingPct: number | null
  /** Hours until the cap is hit, in the WORST case consistent with the readings. Null = unmeasurable. */
  headroomHours: number | null
  /** ISO instant the cap is projected to be hit (worst case). Null = unmeasurable. */
  exhaustsAt: string | null
  hoursToReset: number | null
  /**
   * THE FIELD THAT DECIDES THINGS. False = the cap will not bite before it resets, so work freely no
   * matter how alarming the % looks. True = you will be cut off in `headroomHours`. Null = unknown.
   */
  exhaustsBeforeReset: boolean | null
  /** How many readings the forecast is based on (more = more trustworthy). */
  samples: number
}

/** Tokens actually spent, counted from the transcripts. See server/src/usage-tokens.ts. */
export interface TokenSpend {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** Plain sum of the four. Reported for transparency, but do NOT budget with it: a cached prefix is
   *  re-read on every turn, so this mostly measures (context size x turns), not cost. */
  raw: number
  /**
   * The unit to budget in: base-input-token EQUIVALENTS, i.e. the four counts converted to one scale
   * by their price ratios (cache read x0.1, cache write x1.25, output x5) and by the model's own
   * price (Opus ~5x Sonnet, Haiku ~0.27x). This is proportional to what actually burns quota.
   */
  weighted: number
  /** Assistant turns counted. */
  turns: number
  byModel: Record<string, { weighted: number; output: number; turns: number }>
}

/** How much to trust a token-derived number. */
export type BudgetConfidence = 'good' | 'rough' | 'none'

/**
 * The answer to "how much can I actually spend?", in tokens rather than percent.
 *
 * `tokensPerPercent` is MEASURED, not given: tokens/hour (from transcripts) divided by percent/hour
 * (from the usage history). Anthropic never tells us the real quota, so we infer its size from how
 * fast our own measurable spend moves the needle.
 */
export interface UsageBudget {
  forecast: UsageForecast
  /** Spend in the lookback window used to derive the rate. */
  spend: TokenSpend
  lookbackHours: number
  /** Weighted (cost-equivalent) tokens per hour over the lookback. */
  weightedPerHour: number | null
  /** Empirically-derived size of 1% of the weekly quota, in weighted tokens. */
  weightedPerPercent: number | null
  /** Estimated weighted tokens left before the weekly cap. */
  remainingWeighted: number | null
  /**
   * THE PRACTICAL QUANTITY. Roughly how many more assistant turns fit in the remaining quota, at the
   * average cost of your recent turns. An agent can reason about turns; it cannot easily predict its
   * own raw token totals. Null when there's nothing to derive it from.
   */
  remainingTurns: number | null
  /** Average weighted cost of one recent assistant turn (what remainingTurns divides by). */
  weightedPerTurn: number | null
  confidence: BudgetConfidence
  /** Why the confidence is what it is, and what would make it wrong. Always populated. */
  caveat: string
}

/** Response of a usage-check route: the snapshot + whether it came from cache + its cache key. */
export interface UsageCheckResult {
  snapshot: UsageSnapshot
  cached: boolean
  key: string
  /** Why the result is what it is (esp. for a no-data snapshot). Optional for back-compat. */
  reason?: UsageReason
  /** What to do about these numbers. Attached by the routes so an MCP caller never re-derives it. */
  advice?: UsageAdvice
}

// --- CLI instances (Feature A) ----------------------------------------------

/** A CLI instance: a `CLAUDE_CONFIG_DIR` associated with an account, logged in once. */
export interface CliInstance {
  id: string
  name: string
  configDir: string
  associatedAccountId: string | null
  associatedAccountLabel: string | null
  /**
   * The DESKTOP instance this CLI login belongs to (an `~/.claude-instances` dir). A desktop app
   * and a CLI login are two independent auth stores, but in practice they are the SAME Anthropic
   * account used for two different purposes — so linking them lets the UI group them as one account
   * and lets each act as the other's usage-check fallback. Null = not linked.
   */
  associatedDesktopDir: string | null
  /** Display label of the linked desktop instance, cached for rendering. */
  associatedDesktopLabel: string | null
  loggedIn: boolean
  lastUsageCheck: UsageSnapshot | null
  createdAt: number
}

/** An isolated Codex CLI + Desktop login rooted at its own CODEX_HOME. */
export interface CodexInstance {
  id: string
  name: string
  codexHome: string
  loggedIn: boolean
  /** Electron/Chromium profile isolated from both the regular app and the other instances. */
  desktopUserDataDir: string
  isDesktopRunning: boolean
  desktopPid: number | null
  createdAt: number
}

/** Provider/surface visibility plus opt-in integrations. */
export interface ProviderSettings {
  codexDesktopEnabled: boolean
  codexCliEnabled: boolean
  chatGptHandoffEnabled: boolean
}

/** Bounded, secret-screened repository context returned for a manual ChatGPT handoff. */
export interface ChatGptContextPack {
  filename: string
  content: string
  prompt: string
  includedFiles: string[]
  omittedFiles: number
  estimatedTokens: number
  truncated: boolean
  warnings: string[]
}

// --- usage settings ----------------------------------------------------------

/** Auto-refresh + section-visibility settings (persisted in the db `settings` table). */
export interface UsageSettings {
  /** Periodically re-check every checkable instance in the background. ON by default: the direct
   *  API read costs ~300ms and no quota, so there is no reason to make the user click. */
  autoRefresh: boolean
  /** Minutes between auto-refresh sweeps. */
  autoRefreshIntervalMin: number
  /** Show the desktop-instances table (for people who only use the CLI). */
  showDesktopInstances: boolean
  /** Show the CLI-instances table (for people who only use the desktop app). */
  showCliInstances: boolean
}

// --- auto-resume monitor (Feature E) ----------------------------------------

export type MonitorStateName = 'scheduled' | 'blocked_weekly' | 'needs_human' | 'done'

export interface MonitorSettings {
  /** Master switch (OFF by default — it auto-prompts sessions while you sleep). */
  enabled: boolean
  /** Resume a session at most this many times before marking it "needs human". */
  maxAttempts: number
  /** Minutes of slack added after the detected 5-hour reset before firing the resume. */
  resumeBufferMin: number
  /** The locked resume prompt (a code-constant default; advanced override). */
  resumePrompt: string
}

/** One tracked rate-limited stop and the state of its (possible) auto-resume. */
export interface MonitorStatusRow {
  itemId: string
  sessionId: string
  accountId: string | null
  title: string | null
  state: MonitorStateName
  message: string | null
  resumeAttempts: number
  resumeItemId: string | null
  updatedAt: string
  /** True when the monitor FOUND this session sitting at a limit on disk rather than watching a run
   *  of its own stop (rate-limit-discovery.ts) — i.e. a session started outside the app entirely.
   *  Surfaced so a stop the app went looking for never reads as one the user queued. */
  discovered: boolean
}

/** The whole monitor view for the UI: settings + tracked stops + per-account overrides. */
export interface MonitorView {
  settings: MonitorSettings
  status: MonitorStatusRow[]
  /** account_id → enabled (absent = follows the global switch). */
  accounts: Record<string, boolean>
}
