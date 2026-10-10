// Shared types, imported by the Vue app via Eden for end-to-end typing.

// CodexInstance below references this type directly, so it is imported as well as re-exported
// (see the Codex re-export block further down).
import type { CodexAccount } from './core/codex-account'
import type { ChatSyncRow } from './core/desktop-chat-types'

export type {
  CodexMoveChat,
  CodexMovePlan,
  CodexMoveRequest,
  CodexMoveResult,
} from './core/codex-chat-move'

// SessionSummary.limit_stop is this exact shape. It is DEFINED in rate-limit-signal.ts because the
// detector and the DTO must never drift, and that module is a zero-import leaf, so pulling it in
// here costs the web app's vue-tsc pass nothing.
import type { LimitStop, SessionLimitStop } from './rate-limit-signal'
// Same reasoning: session-ending.ts imports only that leaf, so this stays free of Bun runtime.
import type { SessionEnding } from './session-ending'

export type { LimitStop, SessionEnding, SessionLimitStop }

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
/** One account's chat list (see ./chat-dossier.ts), re-exported here for the same reason. TYPE
 * re-exports only: chat-dossier reads the desktop stores at runtime and must never be pulled
 * into the browser bundle, and `export type` is erased before it could be. */
export type { ChatListResult, ChatListRow } from './chat-dossier'
// The Codex/ChatGPT instance-account DTOs, defined next to their resolver for the same reason as
// the Claude ones below.
export type {
  CodexAccount,
  CodexAccountStatus,
  CodexAuthMode,
  CodexResetRedeemResult,
  CodexResetRedeemStatus,
} from './core/codex-account'
// Instance DTOs ("instance account" = which Anthropic account a Claude Desktop *instance*
// is logged into) are defined in ./core/shared.ts, re-exported here so the web app only
// ever imports types from this one module, same as every other DTO below.
export type {
  CMAccount,
  CMAccountStatus,
  CMActionResult,
  CMDesktopInstall,
  CMInstance,
  CMLoginHistory,
  CMLoginHistoryEntry,
  InstanceColorKey,
  InstanceIconKey,
} from './core/shared'
// Value re-exports (the curated icon/color key sets + label cap) so the web app drives its
// icon/color pickers from the exact same source of truth the server validates against. These
// are pure literal constants; ./core/shared imports nothing runtime-heavy, so pulling them into
// the browser bundle is safe.
export { INSTANCE_COLOR_KEYS, INSTANCE_ICON_KEYS, INSTANCE_LABEL_MAX } from './core/shared'
/** Self-updater DTOs (see ./updater-engine.mjs), re-exported here so the web app only
 * ever imports types from this one module, same as every other DTO in this file. */
export type { UpdateApplyResult, UpdateStatus } from './updater-engine.mjs'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AuthType = 'oauth_token' | 'api_key'
/** `instance_ref` value meaning "deliberately unpinned — run on the ambient CLI login". A stored
 *  null is ambiguous (it also means "nobody said"), and that ambiguity is what a resume must not
 *  inherit, so the explicit choice needs a value of its own. Never stored: the API turns it into
 *  null and skips the auto-resolve. */
export const AMBIENT_RUN_AS = 'ambient'
export type QueueStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  /** Exit 0, but no independent evidence the run actually produced anything (never-claim-landed
   *  doctrine: an exit code is the process's own self-report, not proof - see
   *  hasCompletionEvidence in dispatch.ts). Distinct from
   *  'completed' on purpose: a caller that filters on 'completed' must never see one of these by
   *  accident, and a desktop delivery must never fire on one. Distinct from 'failed' too - the run
   *  may well have worked; nobody has confirmed it either way. */
  | 'unverified'
  /** YOUR allowance is spent (session/weekly). Only time fixes it — monitor.ts resumes off this. */
  | 'rate_limited'
  /** ANTHROPIC'S servers were saturated (529). Nothing is wrong with the run; it is retried
   *  automatically a few times first, and only lands here if the overload outlasted the backoff.
   *  Deliberately NOT 'rate_limited': that would park a seconds-long blip against a 5-hour reset. */
  | 'overloaded'
  | 'canceled'
/** Whether a finished run has landed in its target desktop instance's app yet. Separate from
 *  QueueStatus on purpose: the RUN is over either way, and conflating "the work finished" with
 *  "you can see it" is exactly how a delivery goes missing without anything looking wrong. */
export type ImportState = 'pending' | 'done' | 'gave_up'
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

/**
 * A supported conversation store, named by the READER that understands it.
 *
 * Claude/Codex are JSONL; OpenCode and Hermes are each their own shared SQLite DB — two different
 * schemas, so two different readers. `dsh` is DeepSeek Harness: one file per session like Claude's,
 * except the bytes are zstd frames, so it needs a reader of its own rather than a catalog row
 * claiming Claude's format (server/src/dsh-sessions.ts). `zswarm` is the swarm's jobs: one JSON job
 * file per "session", where a task's prompt/result stand in for a turn because the swarm has no
 * back-and-forth conversation of its own (server/src/hswarm-sessions.ts). Since 2026-10-03 that is
 * HSwarm's home (ZSwarm is retired; its jobs were imported there), and the id stays `zswarm`
 * because it is a frozen MCP API value (server/mcp-api-levels/). `foreign` is the last: one reader
 * with a small adapter per tool (Grok, Kimi, VS Code Copilot, Copilot CLI, Zed), which share no
 * format with each other but do share the one thing that matters here — a list of conversations
 * that can be read, and no per-token usage to account for. See server/src/foreign-sessions.ts.
 */
export type SessionSource =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'hermes'
  | 'dsh'
  | 'zswarm'
  | 'foreign'
export type SessionSourceScope = 'all' | SessionSource

export function isSessionSource(v: unknown): v is SessionSource {
  return (
    v === 'claude' ||
    v === 'codex' ||
    v === 'opencode' ||
    v === 'hermes' ||
    v === 'dsh' ||
    v === 'zswarm' ||
    v === 'foreign'
  )
}

/** A session discovered in one of the supported local conversation stores. */
export interface SessionSummary {
  session_id: string
  source: SessionSource
  /** Which PRODUCT wrote it, as an agent-catalog.ts id ('claude-code', 'openclaude', 'traex', …).
   *  `source` is only the FORMAT, and forks share one. */
  tool: string
  /**
   * The opaque, versioned identity for THIS exact row (server/src/session-locator.ts) — source +
   * product + physical store, not just source + session_id.
   *
   * `source` + `session_id` alone cannot always tell two rows apart: two OpenCode-format products
   * (Kilo, MiMo Code) or two Hermes profiles can hold the same session id (audit AH-35). Every
   * session route accepts `?locator=` alongside the older `?source=`, and a caller that already has
   * this row — because it just listed it — should pass the locator back rather than source alone,
   * which resolves to "the first/newest match for that id+source" and can silently pick the wrong
   * product's session when two of them collide.
   */
  locator: string
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
  /**
   * The instance this conversation ran in, as a display label: an `~/.claude-instances` dir name
   * for Claude Desktop, the Codex instance's NAME for a Codex chat, or null when nothing on disk
   * says (a plain CLI transcript, or a store with no per-account split).
   *
   * Codex rows carried `null` unconditionally until 2026-09-11 — not because the account was
   * unknown but because the reader only ever looked in one CODEX_HOME, so a managed instance's
   * chats were not listed at all (see codexInstanceStores in core/codex-instances.ts). Read
   * `instance_ref` when you need to know WHICH KIND of instance this label names; a Claude dir name
   * and a Codex instance name live in the same field and could in principle collide.
   */
  instance: string | null
  /**
   * The unambiguous form of {@link instance}: `desktop:<dir>` | `cli:<id>` | `codex:<id>`, the same
   * ref core/instance-numbers.ts and the usage cache key on. Null whenever `instance` is.
   *
   * Codex only, today: a Claude row's desktop instance is resolved from a dir name and keeps that
   * as its identity everywhere else in this codebase, so minting a ref for it here would invent a
   * second spelling of something that already has one.
   */
  instance_ref: string | null
  /** The permanent short handle (`#7`) of that instance — the one thing a human or an agent can say
   *  out loud. Null when the row has no instance, 0 never appears. */
  instance_num: number | null
  /** Provider archive state: Claude Desktop metadata, Codex's archived rollouts folder, or
   *  OpenCode's archived timestamp. False when the provider carries no archive signal. */
  archived: boolean
  /** The user's own mark, stored in our `session_marks` table. Mark only: never filters a list. */
  done: boolean
  /**
   * How many subagent sessions this one spawned, counted through the whole chain below it.
   *
   * Only OpenCode reports any: it is the one store that keeps a subagent as a session row of its
   * own, so those rows are hidden from this list and folded into their parent's count instead (see
   * collapseSubagents in server/src/sessions.ts). Carried so the row can SAY it stands for a fan-out
   * — 45 of this machine's 92 OpenCode sessions are subagents, and hiding that many with nothing on
   * screen to account for them is how a fix reads as data loss.
   */
  subagent_count: number
  /**
   * AgentHydra queued work into this session, so it is ours rather than something typed by hand.
   *
   * Known exactly, not inferred: every dispatch passes the session id on the command line
   * (`--session-id` for a new chat, `--resume` for an existing one), so a `queue_items` row for
   * that id IS the fact. Nothing heuristic goes into it.
   */
  dispatched: boolean
  /**
   * Set when this conversation's own provider reported a QUOTA wall inside it — "You've hit your
   * weekly limit · resets 3am". Null means no trusted notice was found, which is not the same as
   * "never rate limited": only the CLI's own report counts as evidence, never model prose or tool
   * output, because matching the patterns against anything else marked every run that merely TALKED
   * about limits (see rate-limit-signal.ts).
   *
   * Claude only, today. Codex and OpenCode record an error but not one this detector is willing to
   * trust, and a false badge here is worse than a missing one.
   */
  limit_stop: SessionLimitStop | null
  /**
   * WHERE this row's `title` came from — the answer to "why is this thread called that?".
   *
   * A title is derived from four different places and only one of them is a label a person chose,
   * so a surprising title is otherwise unattributable: the owner reported threads showing up named
   * "Watcher" with no account, instance or project by that name, and there was no way to ask the
   * app where the string came from. Now there is. See TITLE_SOURCES in server/src/sessions.ts.
   */
  title_source: TitleSource
  /** For `title_source: 'envelope'`, the tag whose name= attribute became the title (e.g.
   *  "scheduled-task"). Null for every other source. This is the field that names the culprit. */
  title_tag: string | null
  /**
   * How many transcripts on disk are THIS conversation, and which of them this row is.
   *
   * One chat routinely ends up in several files: interrupt it and resume, and the CLI opens a new
   * transcript that replays the history and carries on. Both files are real and neither contains
   * the other — measured across 36 such pairs here, every single older copy held turns the newer
   * one does not, and they were the user's own words, typically the last thing said before the
   * interrupt ("See you soon.", "skip domains4sale.uk,, do the rest"). So they are NOT folded away;
   * hiding one would delete something the person actually typed. They are labelled instead, so two
   * rows with the same title read as one conversation in two parts rather than as a mystery.
   *
   * `copy_count` is 1 for the ordinary case. Copies are numbered oldest first, so copy 1 is where
   * the conversation started.
   */
  copy_index: number
  copy_count: number
  /**
   * What ended this transcript — the answer to "why is this conversation in several pieces?".
   *
   * It is the last thing that happened in the file, and for a part that has a later copy it is
   * literally the cause of that copy existing. Measured on a real store, the superseded parts ended
   * 18x on the user pressing stop, 6x on a safety filter refusing the message, 3x on an ordinary
   * turn later picked back up, and 2x on a server overload. Never a mystery — the cause is written
   * in the file; the list simply had no way to say it.
   *
   * Claude only, for the same reason limit_stop is: the markers are the Claude CLI's own.
   */
  ended_because: SessionEnding | null
  /** The model of the session's newest assistant turn, as the transcript records it. */
  model: string | null
  /** The thinking/effort level when the transcript records one, else null. */
  effort: string | null
  /** Work this chat handed off: HSwarm runs and CliMayte tasks it started. Claude rows only; absent
   *  when it handed off none. */
  offloads?: { hswarm: number; climayte: number }
  /** The PC this Desktop chat came from through the chat sync (core/desktop-chat-sync.ts), when it
   *  was another one; absent for this PC's own chats. */
  from_pc?: string
}

/**
 * The four places a session title can come from, worst-understood last.
 *
 *  · 'custom'    — a `custom-title` record: the saved title the writing app displays. Deliberately
 *                  NOT described as "a name you typed", because it cannot be told apart from one
 *                  the app generated — 453 of the newest 500 sessions on the machine this was
 *                  written against carry one, which no person sat and typed. What IS known is that
 *                  it is a deliberate label rather than an inference from the conversation.
 *  · 'ai'        — an `ai-title` record: the model summarising the conversation. A session can
 *                  carry both, with different text; the custom one wins because it is the one its
 *                  own app shows.
 *  · 'store'     — the provider handed us a title as a field (OpenCode's `session.title`, Codex
 *                  Desktop's `thread_name`, a foreign adapter's own label).
 *  · 'envelope'  — the first turn arrived wrapped in a pseudo-tag carrying a name attribute, e.g.
 *                  `<scheduled-task name="nightly-sweep">`, and THAT name became the title. This is
 *                  the surprising one: the string is chosen by whatever wrote the envelope, which
 *                  may be a scheduler, a hook or a harness the user never named.
 *  · 'message'   — the first thing said in the conversation, trimmed.
 *  · 'id'        — nothing else was available, so the session id stands in.
 */
export type TitleSource = 'custom' | 'ai' | 'store' | 'envelope' | 'message' | 'id'

/**
 * One folder that has conversations in it, across every store (server/src/sessions.ts listProjects).
 *
 * The index of the index. A session list only ever answers newest-N, so a caller asked about "all
 * my chat histories" has no way to learn what exists before querying it; a thousand sessions
 * collapse to a few dozen of these, which is small enough to read whole.
 */
export interface ProjectSummary {
  /** The working directory, decoded from the provider's project key when it has to be. */
  cwd: string
  /** The provider's own key for it, kept because that is what `project` on a session row holds. */
  project: string
  sessions: number
  /** How many of those came from each store, so "this repo is half Codex" is visible at a glance. */
  by_source: Record<SessionSource, number>
  first_activity_at: number
  last_activity_at: number
}

/**
 * What credentials a session printed into its own transcript (server/src/session-export.ts).
 *
 * `findings` is always redacted and there is no unredacted form of this type anywhere: the count is
 * meant to make you go and rotate a key, not to be a second place the key lives.
 */
export interface SessionSecretScan {
  session_id: string
  source: SessionSource
  /** How many recognisable secrets are in the transcript. */
  count: number
  /** Each one, redacted, with the turn it appeared in. Capped; `truncated` says when. */
  findings: Array<{ kind: string; redacted: string; turn: number; role: string }>
  truncated: boolean
}

/**
 * One coding agent, as found on this machine (server/src/agent-catalog.ts).
 *
 * Defined here rather than beside the scanner for the same reason SyncStatus is: agent-catalog.ts
 * imports node:fs, and nothing Bun-only may be pulled into the web app's type pass.
 */
export interface AgentPresence {
  /** Catalog id — 'claude-code', 'openclaude', 'traex', … */
  id: string
  name: string
  /** Who makes it. The axis the analytics provider filter offers. */
  vendor: string
  /** Absolute store roots that exist. Never empty: a tool with none is not reported at all. */
  roots: string[]
  /** Files under those roots, capped. */
  files: number
  /** The count hit the cap, so show it as "N+" rather than as an exact figure it is not. */
  truncated: boolean
  lastActivityAt: number | null
  /**
   * The reader that handles this tool's store, or null when we can find it but not read it.
   *
   * A null here is a real answer, not a placeholder: the tool is installed, we know where its
   * conversations are, and nobody has written the parser. Saying so beats omitting it, which would
   * read as "AgentHydra looked and found nothing".
   */
  format: SessionSource | null
  /** Why it is unreadable, when there is a specific reason: 'encrypted', 'credits', 'opt-in'. */
  note?: string
}

// --- the analytics tier (server/src/analytics.ts) ---------------------------
// DTOs only; the runtime module imports them back, same discipline as SyncStatus above.

/** How much of the store the background scan has reached. Every report carries it, because a chart
 *  from a half-warmed store looks identical to one from a complete store and means less. */
export interface AnalyticsCoverage {
  sessions: number
  total: number
  refreshing: boolean
  bytes: number
}

export interface SpendBucket {
  key: string
  weighted: number
  costUsd: number | null
  /** costUsd at the owner's bulk rate (routing discounts); set on the per-model buckets. */
  costAtRateUsd?: number | null
  sessions: number
  turns: number
  /** Only populated where the split is meaningful (per model, per provider). */
  tokens?: TokenBreakdown
}

/**
 * Where the tokens actually went.
 *
 * Reported as four separate figures rather than one total because they cost wildly different
 * amounts: a cache read is a tenth of fresh input, a cache write carries a premium over it, and
 * output is several times either. A single "tokens used" number hides the one fact that explains a
 * bill, which is that most of a heavy user's volume is cache reads.
 *
 * `input` is UNCACHED input on every provider. Anthropic reports it that way; Codex counts cached
 * input inside its input figure, so it is subtracted out before it reaches here.
 */
export interface TokenBreakdown {
  /** Fresh prompt tokens: the ones actually processed. */
  input: number
  /** Prompt tokens served from cache, at roughly a tenth of the price. */
  cacheRead: number
  /** Tokens written INTO the cache, at a premium over fresh input. */
  cacheWrite: number
  /** Generated tokens, the expensive end. */
  output: number
  /** input + cacheRead + cacheWrite + output. */
  total: number
}

/** The sources the Instances usage card draws, one bar segment each. */
export type TokenDaySource = 'desktop' | 'cli' | 'climayte' | 'hswarm'

/** Weighted tokens per local day, per source, for the Instances usage card (analytics.ts). */
export interface TokensByDay {
  /** Oldest day first, one entry per local day in the window. A day a source wrote nothing is 0. */
  days: Array<{ key: string; bySource: Record<TokenDaySource, number> }>
}

export interface SpendReport {
  from: string | null
  to: string | null
  totalCostUsd: number | null
  /** totalCostUsd with each model's provider-group discount taken off; equals it when none is set. */
  totalCostAtRateUsd: number | null
  /** True when any routing discount is set, so the two totals can differ. */
  hasRateDiscount: boolean
  totalWeighted: number
  /** The four categories, summed across every counted session. */
  tokens: TokenBreakdown
  /** Per provider, so "I have Codex usage" is answerable at a glance. */
  byProvider: Array<{
    key: SessionSource
    tokens: TokenBreakdown
    sessions: number
    costUsd: number | null
  }>
  sessions: number
  byModel: SpendBucket[]
  byProject: SpendBucket[]
  byDay: SpendBucket[]
  /** Every clock hour of a window of two days or less (key: the hour's start, ISO UTC), quiet hours
   *  included; absent on a longer window. */
  byHour?: SpendBucket[]
  /** Keyed by the toolkit's account id (`acct-…`). */
  byAccount: SpendBucket[]
  /** Per toolkit source (cli, desktop, climayte, codex, opencode, dsh, hermes, hswarm). */
  bySource: SpendBucket[]
  /** Model calls counted, rollup hours included (`sessions` counts raw rows only). */
  calls: number
  unpricedModels: string[]
  /** The date the prices behind every dollar figure here were last known good. */
  pricesAsOf: string
  /** 'catalog' = downloaded rates; 'bundled' = the table this build shipped with. */
  priceSource: 'catalog' | 'bundled'
  coverage: AnalyticsCoverage
  /** What the toolkit has ingested, per source, so a low figure can be told from a partial one. */
  kitCoverage: {
    sources: Record<string, { events: number; firstTs: number; lastTs: number }>
    cursors: { files: number; newestMtime: number | null }
    dirtyFrom: number | null
  }
  /** Places the answer is narrower than asked (the toolkit's own notes). */
  notes: string[]
}

export interface SessionHealthRow {
  session_id: string
  source: SessionSource
  project: string
  toolErrors: number
  toolErrorStreak: number
  edits: number
  compactions: number
  /** Share (0..1) of what the session wrote still in its files hours later; null = not measured.
   *  See server/src/edit-survival.ts. */
  editSurvival: number | null
}

export interface ActivityReport {
  /** 168 slots, Sunday 00:00 first. */
  hours: number[]
  tools: Array<{ key: string; count: number }>
  /** Engaged time, not wall clock: inter-turn gaps with each one capped. */
  agentMinutes: number
  health: SessionHealthRow[]
  /** Edit survival across the period: how many sessions have a score, their mean, and how many are
   *  old enough to measure but not yet rescanned. */
  editSurvival: { sessions: number; average: number | null; overdue: number }
  coverage: AnalyticsCoverage
}

/**
 * One skill or MCP server that sat in a session's prompt prefix, and whether anything used it.
 *
 * WHY: a skill listing or an MCP server's instructions are re-sent on every API call of every
 * session they load into, used or not. This row is the evidence for "which of them are pure
 * prefix overhead": loaded in N sessions, used in M.
 */
export interface DeadLoadRow {
  /** Skill name, or MCP server name as its tools are prefixed (`mcp__<server>__...`). */
  key: string
  /** Estimated tokens it adds to the prefix (characters / 4 of the text Claude Code injected). */
  loadTokens: number
  sessionsLoaded: number
  sessionsUsed: number
  /** Invocations across the window: Skill tool calls and /slash commands, or MCP tool calls. */
  uses: number
  /** Prefix tokens it carried through sessions that never used it: loadTokens x API calls. */
  deadTokens: number
}

/**
 * One place tokens went, ranked against the others.
 *
 * `structural` sinks are configuration (fixed by uninstalling or scoping something); `behavioral`
 * ones are how sessions are run (fixed by working differently). The sinks overlap - a deep-context
 * call can also carry dead skills - so their shares are lenses on one total, not slices of it.
 */
export interface TokenSink {
  id: 'dead-skills' | 'dead-mcp' | 'deep-context' | 'output' | 'subagents' | 'cache-writes'
  kind: 'structural' | 'behavioral'
  /** `measured` = summed off recorded usage; `estimated` = derived from injected text length. */
  basis: 'measured' | 'estimated'
  /** Weighted tokens, the same unit as TokenSinkReport.totalWeighted, so sinks rank fairly. */
  weighted: number
  /** weighted / totalWeighted. */
  share: number
  /** One line on what reduces it. */
  fix: string
}

export interface TokenSinkReport {
  /** Sessions in the window whose scan recorded sink evidence. */
  sessions: number
  /** API calls across those sessions. */
  calls: number
  totalWeighted: number
  sinks: TokenSink[]
  /** Skills ranked by dead prefix tokens (Claude Code transcripts only). */
  skills: DeadLoadRow[]
  /** MCP servers ranked the same way. */
  mcpServers: DeadLoadRow[]
  /** Calls whose prompt was past `threshold` tokens, the weighted tokens they spent in all, and
   *  `excess`: what they paid to read the part past the line (the deep-context sink's weight). */
  deepContext: { threshold: number; calls: number; weighted: number; excess: number }
  /** Weighted tokens spent inside subagent transcripts, and how many were spawned. */
  subagents: { weighted: number; spawns: number }
  /** Cache reads over all prompt tokens, per account. `key` null = not linked to an account. */
  cacheByAccount: Array<{
    key: string | null
    sessions: number
    cacheRead: number
    prompt: number
    ratio: number
  }>
  coverage: AnalyticsCoverage
}

export interface ConcurrencyPoint {
  at: number
  sessions: number
}

export interface EditEntry {
  session_id: string
  source: SessionSource
  project: string
  path: string
  turn: number
  ts: number | null
}

/**
 * Recurring command mistakes, mined from fail-then-fix pairs in the transcripts
 * (server/src/command-corrections.ts). A pair is a shell command that failed with a recognisable
 * error followed, a few commands later, by a similar command with the same base that succeeded.
 */
export type CommandErrorKind =
  | 'unknown-flag'
  | 'missing-arg'
  | 'wrong-path'
  | 'command-not-found'
  | 'permission-denied'

export interface CorrectionExample {
  wrong: string
  right: string
  /** The error line that classified the failure, secret-redacted and truncated. */
  error: string
  count: number
  sessions: number
  lastTs: number | null
}

export interface CorrectionGroup {
  kind: CommandErrorKind
  /** The command the mistake was made with: the program, plus its subcommand for git/npm/cargo-style tools. */
  base: string
  count: number
  sessions: number
  lastTs: number | null
  /** The most frequent distinct wrong -> right pairs, most frequent first. */
  examples: CorrectionExample[]
}

export interface CorrectionReport {
  groups: CorrectionGroup[]
  /** The groups as a rules file (e.g. .claude/rules/cli-corrections.md), ready to copy. */
  markdown: string
  /** Transcripts read in this pass, and how many the store holds. */
  scanned: number
  total: number
  budgetExhausted: boolean
}

/** What one queued run cost, computed from the turns inside its own window. Never stored. */
export interface RunCost {
  id: string
  session_id: string
  status: string
  startedAt: string | null
  finishedAt: string | null
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
    total: number
    turns: number
  }
  costUsd: number | null
  unpricedModels: string[]
  /** The date the prices behind every dollar figure here were last known good. */
  pricesAsOf: string
  status_reason: 'ok' | 'no-window' | 'source-unsupported' | 'unreadable'
}

/** How a session list treats provider archive state. 'hide' is the default because archived is the
 *  large majority of a real store, so including it buries live work; 'only' makes old work findable. */
export type ArchivedScope = 'hide' | 'include' | 'only'

/*
 * How a session list treats work AgentHydra queued.
 *
 * 'all' is the default and stays the default: this narrows a list on request, and is never applied
 * on its own initiative — the same rule `session_marks` carries.
 */
/**
 * How a session list treats conversations that hit a usage wall.
 *
 * 'all' is the default and stays the default, exactly as DispatchedScope does: this narrows a list
 * on request and is never applied on the app's own initiative. 'only' answers "what did I lose to
 * a limit?"; 'pending' narrows that further to the ones still sitting at the wall right now, which
 * is the actionable half — the rest already got resumed and are history.
 */
export type RateLimitScope = 'all' | 'only' | 'pending'

export function isRateLimitScope(v: unknown): v is RateLimitScope {
  return v === 'all' || v === 'only' || v === 'pending'
}

export type DispatchedScope = 'all' | 'queued' | 'manual'

export function isDispatchedScope(v: unknown): v is DispatchedScope {
  return v === 'all' || v === 'queued' || v === 'manual'
}

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

/**
 * One displayable turn from a transcript tail.
 *
 * `thinking` is the model's reasoning block. It is DROPPED unless the caller asks for it, which is
 * the long-standing default and stays that way: it is the bulkiest and least useful part of a
 * transcript to skim. See `TailOptions` in server/src/transcript.ts.
 */
export interface TailEvent {
  role: 'user' | 'assistant'
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text: string
  tool_name: string | null
  timestamp: string | null
  /** A tool_result the transcript itself marked failed (Claude's `is_error`). Absent otherwise. */
  error?: boolean
  /** A Claude tool_use's own id, which names the subagent run an Agent call started (see
   *  tailSubagent in server/src/transcript.ts). Absent for other kinds and other tools. */
  tool_use_id?: string
  /** A message neither side wrote, which the viewer shows as a divider rather than a turn:
   *  `compact` is the summary the CLI writes as a USER message after compacting the context,
   *  `error` the API's own notice (a usage limit, an overload) that explains why a session stopped. */
  notice?: 'compact' | 'error'
  /** A Claude reply's transcript line, which a new chat can branch from (session-branch.ts). */
  uuid?: string
}

export interface TailResult {
  session_id: string
  source: SessionSource
  title: string
  cwd: string
  events: TailEvent[]
  /** True when older kept turns exist above this window, so the viewer can offer to page them in.
   *  Absent from a "not found" answer; a raised `limit` is how a caller asks for them. */
  has_more?: boolean
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
  /** The row's shape inputs, present on a scoped (`view=1`) search so the sidebar can apply its
   *  browser-side shape filter to the hits. */
  shape_of?: {
    message_count: number
    created_at: number | null
    last_activity_at: number
    dispatched: boolean
  }
}

/*
 * A whole body-search answer, hits plus how complete they are.
 *
 * The completeness is not a nicety. The search runs under a wall-clock budget and returns whatever
 * it has when the clock runs out, so a bare list of hits makes "this text appears nowhere" and "we
 * gave up after seven seconds" the same answer. That is a bad trade for a human and a worse one for
 * an agent, which will happily conclude the code it is looking for does not exist.
 */
/**
 * How one queued run ended.
 *
 * The daemon has GROUND TRUTH here: the runner writes `{"__dispatch":"exit","code":N}` and the
 * status is finalized from that exit code, so this is what the process actually did rather than an
 * inference from a transcript. It rides alongside a run's events because the events alone cannot
 * say whether the run finished, died, or was killed.
 */
export interface RunOutcome {
  id: string
  status: QueueStatus
  /** The child's exit code. -1 means the daemon lost the runner (machine slept, process killed)
   *  and finalized the run without ever seeing its exit marker. Null while still queued/running. */
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  /** Wall-clock run time in ms, when both ends are known. */
  duration_ms: number | null
  /** Transient-overload retries already spent on this item. */
  retry_attempts: number
  /** True for a terminal status that is not `completed`: the run stopped without finishing. */
  died: boolean
}

/** A run's recorded output plus how it ended. */
export interface RunEventsResult {
  outcome: RunOutcome
  events: RunEvent[]
}

/** Which code path produced a search answer. The two have genuinely different reach, so no caller
 *  is ever left guessing which one it got. */
export type SearchPath =
  /** The conversation index: complete and instant, but it covers what was SAID (human and
   *  assistant turns matched by word and phrase), not tool output and not arbitrary substrings. */
  | 'index'
  /** The streaming scan: every byte of every transcript, substring or regex, bounded by a
   *  wall-clock budget. Slower and reaches less of the store within that budget. */
  | 'scan'

/** State of the on-disk conversation index (server/src/search-index.ts). */
export interface SearchIndexStatus {
  exists: boolean
  sizeBytes: number
  /** Sessions currently held. */
  sessions: number
  builtAt: number | null
  refreshing: boolean
}

export interface SessionSearchResponse {
  results: SessionSearchResult[]
  /** Which path answered. 'index' is complete over conversation; 'scan' is bounded by budgetMs. */
  searched: SearchPath
  /** True when the index answered and therefore tool output was NOT searched. The caller should
   *  offer the exhaustive scan rather than implying the answer covers everything on disk. */
  conversationOnly: boolean
  /** The budget ran out: a transcript was abandoned mid-read, or whole files were never opened.
   *  A miss is NOT evidence of absence when this is true. */
  budgetExhausted: boolean
  /** The hit list was cut to `limit`. Not a timeout — searching longer would not add rows. */
  limitReached: boolean
  /** File-backed transcripts opened, out of how many were in scope. OpenCode and Hermes are
   *  excluded from both: each is one or more indexed SQLite stores, searched in full and not
   *  time-bounded. */
  filesSearched: number
  filesTotal: number
  /** The wall-clock budget that applied, so a caller can say "stopped after 7 s". */
  budgetMs: number
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
   *  set the instance ref wins (dispatch-runner checks it first).
   *
   *  Null on a STORED row means "ambient CLI login". On a CREATE/PATCH body it means "not
   *  specified", which for a resume auto-resolves to the session's own desktop instance
   *  (instance-sessions.ts instanceRefForSession) — send AMBIENT_RUN_AS to opt out. */
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
  /** When set ('desktop:<dir>'), a run that COMPLETES is imported into that instance's desktop
   *  app as a visible chat (session-launch.ts importSessionToDesktop), titled import_title.
   *  This is how a migration or handoff lands on the user's screen without anyone polling.
   *  Optional (absent = null) so synthetic QueueItem literals — discovered rate-limit stops,
   *  test fixtures — stay valid; real DB rows always carry the columns post-migration. */
  import_to?: string | null
  import_title?: string | null
  /** How that delivery went. null = nothing to deliver; 'pending' = the always-on sweep in
   *  dispatch.ts is still trying (the target app was shut, or the session was live, when the run
   *  finished); 'done' = it is in the app; 'gave_up' = the deadline passed unreachable.
   *  `import_error` is the last refusal, kept so a give-up is explainable rather than mute. */
  import_state?: ImportState | null
  import_error?: string | null
  /** Deliberate SURFACE-PURITY override. dispatch.ts refuses to launch a headless run against a
   *  session that lives in a desktop app (owner law 2026-08-26: desktop stays desktop, and the
   *  reported failure was desktop chats becoming "a headless thing I couldn't see"). Only a
   *  caller that explicitly forced it sets this, so the refusal cannot be routed around by
   *  accident. Optional so synthetic QueueItem literals stay valid. */
  allow_headless?: boolean
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

// --- failure incidents (server/src/incidents.ts) ------------------------------------------------
// Defined HERE rather than in incidents.ts, same reasoning as QueueItem above: incidents.ts imports
// db.ts (Bun-only runtime), which must never reach the web app's vue-tsc pass, so the DTO lives in
// this Bun-free module and incidents.ts imports it back.
export type IncidentState = 'open' | 'acked' | 'resolved'
export const INCIDENT_STATES: readonly IncidentState[] = ['open', 'acked', 'resolved']

export interface Incident {
  id: string
  scope: string
  key: string
  error_sig: string
  state: IncidentState
  failure_type: string
  first_seen_at: string
  last_seen_at: string
  acked_at: string | null
  resolved_at: string | null
  /** Occurrences folded into this incident, including the one that created it. */
  count: number
  /** Redacted, length-bounded error text. */
  error: string
  output_file: string | null
}

// --- live agent status (server/src/agent-status.ts) --------------------------------------------
// Bun-free for the same reason as Incident above: the web session list reads it.

/** What a person needs to know about a session right now: it is working, it is waiting on you (a
 *  permission prompt, a question, a usage wall), or its turn is done. */
export type AgentStatusState = 'working' | 'blocked' | 'done'
/** Who wrote a status row. Kept on the row so a reader can say where a verdict came from. */
export type AgentStatusSource = 'claude-hook' | 'rate-limit'

export interface AgentStatus {
  sessionId: string
  /** The folded state, decided once when the row was written. Show it; never re-derive it. */
  state: AgentStatusState
  /** The lead agent's own state, kept beside the fold: mainState 'done' with state 'working' is a
   *  lead that finished while a sub-agent it started is still running. */
  mainState: 'working' | 'done'
  /** Sub-agents the lead started that have not reported stopping. */
  subagents: number
  /** Why a blocked row is blocked (the hook's notification type, or 'rate-limit'); else null. */
  waiting: string | null
  source: AgentStatusSource
  /** The hook event (or 'rate-limit') that last changed the row. */
  event: string
  cwd: string | null
  /** When the fact the row reflects happened (ISO). */
  at: string
  /** Read back from disk after a daemon restart and not confirmed by any event since. It is history,
   *  never live: the daemon cannot know what the session did while it was down. */
  restoredUnconfirmed: boolean
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

/** The tray's setting. */
export interface TraySettings {
  /** Hide the tray's NotifyIcon (the daemon keeps running; the tray keeps re-reading this
   *  live so re-enabling it here restores the icon without a restart). */
  hideTrayIcon: boolean
}

/**
 * The MCP-registration half of /api/settings (see server/src/mcp-register.ts).
 *
 * Carries the SWITCH and, separately, what Claude Code's config file actually says. The two can
 * disagree - a read-only config, a hand-written entry - and the panel has to be able to show a
 * switch that is on over a registration that did not land, rather than reporting the wish as the
 * fact. Everything but the switch is derived on read; POST ignores it.
 */
export interface McpRegistrationSettings {
  mcpRegisterClaudeCode: boolean
  /** Is an entry present AND pointing at this daemon's current URL? */
  mcpRegistered: boolean
  /** The file the entry lives in, shown so a failure names something the user can go and look at. */
  mcpConfigPath: string
  /** The URL that is (or would be) registered. */
  mcpUrl: string
  /** Why the last attempt could not be completed; null when there is nothing wrong. */
  mcpRegisterError: string | null
  /** Desk's browser tools under the `browser` key, with the same fields as the agenthydra entry. */
  mcpBrowser: {
    registered: boolean
    url: string
    /** Set when another server holds the `browser` key; it is left as it is. */
    conflict: string | null
    error: string | null
  }
  /**
   * Is the Python toolbox installed beside the executable?
   *
   * Registration is only half of "the MCP server works". Every chat-moving tool (move_chat,
   * move_chats, the orchestrator_* family) runs a script out of orchestrator/, so an install
   * without that folder answers `no orch.py under <dir>` to all of them while every other tool
   * behaves perfectly - which reads as the feature being broken rather than absent.
   */
  mcpToolboxPresent: boolean
  /** Release-owned folders this install is missing, restorable by re-applying the current version
   *  (see missingComponents in server/src/github-updater.ts). Empty on a healthy install. */
  mcpMissingComponents: string[]
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
  /** Identifies the Codex login this cached quota belongs to. Never a credential. */
  codexAccountId?: string | null
  /** Provider-specific quotas, kept separate from the main account's windows. */
  additionalLimits?: { label: string; session: UsageLimit | null; weekAll: UsageLimit | null }[]
  /** A successful Codex read explicitly reports no main short-window cap. */
  sessionLimitUnavailable?: boolean
  /** Account label/email if the caller knew it; the `/usage` text does not name the account. */
  account: string | null
  /** The 5-hour rolling session window. */
  session: UsageLimit | null
  /** The weekly all-models limit — the BINDING cap for pacing decisions. */
  weekAll: UsageLimit | null
  /** A per-model weekly sub-limit (e.g. "Fable"), when present. */
  weekModel: (UsageLimit & { label: string }) | null
  /** Whether the account has claude.ai "extra usage" switched on, i.e. BILLS usage past its limits
   *  instead of stopping (the usage endpoint's `extra_usage.is_enabled`). Absent or null when the
   *  reading did not say (the CLI text fallback, Codex). */
  extraUsage?: boolean | null
  capturedAt: string
  /** Cached snapshots persist across app upgrades, so a
   *  cache entry from before this field existed must still deserialize.
   *  Optional because snapshots cached before the API path existed carry no source. */
  source?: UsageSource
  /** Banked usage-limit resets still unused. Codex: `rate_limit_reset_credits.available_count` on
   *  the usage payload. Claude Desktop: the claude.ai reset grants, read from the running app (see
   *  claude-app-usage.ts) and carried over from the last reading while the app is closed; its date
   *  is `claudeApp.checkedAt`. Undefined when never read; null when the provider answered but
   *  reported none. */
  resetCredits?: number | null
  /** Claude Desktop: when the soonest-ending grant holding a reset expires (ISO). */
  resetCreditsExpiresAt?: string | null
  /** Claude Desktop: what only the signed-in claude.ai session serves. Undefined until the running
   *  app has been read once; a closed app keeps its last reading. */
  claudeApp?: ClaudeAppUsage
  /** Set only on a reading KEPT after its account signed out (usage-cache.ts lastKnownUsage): when
   *  it was set aside. The numbers are from before that, for the tables to show dimmed; nothing
   *  that ranks accounts by room ever reads them (owner, 2026-10-01). */
  signedOutAt?: string
}

/** What switching an account's claude.ai extra usage off did (extra-usage.ts turnOffExtraUsage). */
export interface ExtraUsageOffResult {
  /** True only when a fresh reading confirms extra usage is now off. */
  ok: boolean
  /** The account's extra usage after the call, from a fresh reading; null when it could not be read. */
  extraUsage: boolean | null
  detail: string
}

/** Claude Desktop facts read from the running app's own claude.ai session (claude-app-usage.ts). */
export interface ClaudeAppUsage {
  /** When the app was read (ISO). Everything here, and `resetCredits`, is as of this moment. */
  checkedAt: string
  /** The one-time Claude Code and Cowork credit; null when the account has none. */
  codeCredit: ClaudeCodeCredit | null
  /** Usage credits: whether usage past the plan limits is billed. Null when not reported. */
  usageCredits: ClaudeUsageCredits | null
  /** This week's usage split by product, in claude.ai's order; null before it has one. */
  weeklySplit: { key: string; label: string; pct: number }[] | null
}

/** claude.ai's one-time "Claude Code and Cowork credit" (`iguana_necktie`). */
export interface ClaudeCodeCredit {
  /** 'unclaimed' is offered but never claimed: it cannot be spent until a person claims it.
   *  'locked' is claimed but held back by Anthropic (`lockedReason` says why). */
  state: 'active' | 'unclaimed' | 'locked'
  limitUsd: number | null
  remainingUsd: number | null
  expiresAt: string | null
  lockedReason: string | null
}

/** claude.ai "usage credits" (`spend`): usage past the plan limits, billed to the account. */
export interface ClaudeUsageCredits {
  enabled: boolean
  /** Anthropic's reason code when off (e.g. `org_level_disabled_until`); null when none given. */
  disabledReason: string | null
  /** Spent this billing period, in `currency` units. */
  used: number | null
  /** The monthly cap, in `currency` units; null when uncapped or never set. */
  limit: number | null
  currency: string | null
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
  // A CLOSED desktop instance whose stored grant the usage endpoint no longer accepts. Split
  // out of check_failed because the two need OPPOSITE advice: check_failed says 'try again in
  // a moment', which is false here - nothing refreshes that grant except opening the app, so
  // retrying forever is exactly the wrong thing to tell someone (owner hit this, 2026-09-07).
  | 'stale_token_app_closed'
  // The usage endpoint answered 429. Distinct from every other failure because the account is
  // FINE and there is nothing to fix - retrying is the one thing that cannot help, and telling
  // someone to 'try again in a moment' while they hammer a rate limit is worse than saying
  // nothing (owner hit exactly this on a signed-in account, 2026-09-07).
  | 'rate_limited'
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
  /** permanent - usage-history.json persists across upgrades, and a
   *  sample written before this field existed must still deserialize.
   *  The 5-hour window's reset instant: what keys a session window for the dollar calibration
   *  (quota-calibration.ts). Absent on older samples, which then feed only the weekly one. */
  sessionResetsAt?: string | null
}

/** One bucket of the fleet's pooled Claude usage. See usage-history.ts fleetUsageSeries. */
export interface FleetUsagePoint {
  /** ISO instant the bucket ends at. */
  t: string
  /** Mean weekly % over the accounts that contributed; a window that has reset counts as 0. */
  week: number | null
  /** Mean 5-hour % over the contributing accounts that have one. */
  session: number | null
  accounts: number
}

/** GET /api/usage/history. */
export interface FleetUsageHistory {
  from: string
  to: string
  bucketMinutes: number
  points: FleetUsagePoint[]
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
   * The unit to budget in: the four counts converted to one scale by weights fitted to the
   * subscription meter (cache read 0.1, cache write 3.2 or 5.1 by TTL, output 31) and by the model's
   * list price relative to Sonnet (Opus 2x, Fable 5x, Haiku 5.5 0.14x, Haiku 4.5 0.5x). See
   * usage-tokens.ts.
   */
  weighted: number
  /** Assistant turns counted. */
  turns: number
  byModel: Record<string, ModelSpend>
}

/** One model's share of a {@link TokenSpend}. */
export interface ModelSpend {
  weighted: number
  output: number
  turns: number
  /** The raw counts, kept per model because a DOLLAR cost has to be computed at that model's own
   *  published rates (server/src/pricing.ts) — `weighted` deliberately collapses the models into
   *  one scale and cannot be turned back into money. */
  input: number
  cacheRead: number
  /** Cache WRITES, split by TTL: a 1-hour write costs 2x base input where a 5-minute write costs
   *  1.25x, so one combined figure cannot be priced (or weighed) correctly. Transcripts carry the split
   *  (`usage.cache_creation`); when they don't, the whole write lands on 5m (the default TTL). */
  cacheCreation5m: number
  cacheCreation1h: number
}

/** Why a session has no usage figure. 'ok' is the only state that carries numbers. */
export type SessionUsageStatus = 'ok' | 'source-unsupported' | 'unreadable'

/**
 * Tokens and dollars for ONE session, computed on demand by streaming that single transcript.
 * Nothing is stored: see server/src/session-usage.ts.
 */
export interface SessionUsage {
  session_id: string
  source: SessionSource
  status: SessionUsageStatus
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
    /** Plain sum of the four, i.e. every token the API charged for in this session. */
    total: number
    /** Assistant turns counted. */
    turns: number
  }
  /** USD at published list prices, or null when no model in the session has a published price.
   *  A non-null value alongside a non-empty `unpricedModels` is a LOWER BOUND. */
  costUsd: number | null
  pricedModels: string[]
  /** Model ids that carried tokens but have no published price — never guessed at. */
  unpricedModels: string[]
  /** The day the prices in force were last known good (ISO date) — the download date when a
   *  catalog is in force, this build's own constant otherwise. A stale figure must read stale. */
  pricesAsOf: string
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
  /** The quota windows calibrated into dollars. See server/src/quota-calibration.ts. */
  dollars: QuotaDollars
}

/** Why one quota window was left out of the dollar calibration. Each names a way the window's
 *  (percent moved, dollars spent) pair stops describing the account's real capacity. */
export type QuotaWindowCensor =
  | 'capped' // the window hit 100%: spend past the cap never shows in the percentage
  | 'higher_tier_capped' // the weekly cap cut a 5-hour window short
  | 'went_backwards' // the percentage fell inside one window key: a reset we did not record
  | 'unrecorded_usage' // the percentage rose while no priced turn was recorded here
  | 'unpriced' // a turn in the window has no published price, so its dollars are a lower bound
  | 'too_small' // moved too few points for an integer percentage to resolve

/** What one quota window (weekly or 5-hour) is worth in dollars, measured, not published. */
export interface QuotaCapacity {
  /** List-price dollars one percent of this window buys. Null until a clean window exists. */
  usdPerPct: number | null
  /** usdPerPct x 100: what a whole window is worth. */
  capacityUsd: number | null
  /** usdPerPct x the percent still unused at the current reading. */
  dollarsLeft: number | null
  /** Clean windows the slope was fitted to. */
  windows: number
  /** Windows set aside, by reason. */
  censored: Partial<Record<QuotaWindowCensor, number>>
  confidence: BudgetConfidence
}

/** Both quota windows in dollars, plus what the figures assume. */
export interface QuotaDollars {
  weekly: QuotaCapacity
  session: QuotaCapacity
  /** When the slope was last fitted (ISO), or null when it never has been. */
  calibratedAt: string | null
  caveat: string
}

/** Response of a usage-check route: the snapshot + whether it came from cache + its cache key. */
export interface UsageCheckResult {
  snapshot: UsageSnapshot
  cached: boolean
  key: string
  /** Same reasoning as UsageSnapshot.source above: cached
   *  results from before this field existed must still deserialize.
   *  Why the result is what it is (esp. for a no-data snapshot). Optional for the same reason. */
  reason?: UsageReason
  /** What to do about these numbers. Attached by the routes so an MCP caller never re-derives it. */
  advice?: UsageAdvice
  /**
   * The concrete failure behind a no-data result, when one is known - e.g. `HTTP 401` from the
   * usage endpoint. Exists because `reason: 'check_failed'` is a category, not a diagnosis: it
   * cannot tell a refused token from a rate limit from a dead network, and every one of those
   * reached the user as the same sentence. Never populated on success.
   */
  detail?: string
}

// --- CLI instances (Feature A) ----------------------------------------------

/** Tokens in one span, the four kinds kept apart (core/account-tokens.ts). */
export interface TokenParts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** What an ACCOUNT has run on this PC: its current 5-hour window, current week and all time. */
export interface AccountTokens {
  fiveHour: TokenParts
  week: TokenParts
  total: TokenParts
}

/** The owner's say over how much of AgentHydra's work one account gets (owner, 2026-10-09: "set certain
 *  accounts as priority ... This is priority, like, top, and then up to 50% of five-hour, 50% of week").
 *  Set from the CLI table (core/cli-instances.ts setCliInstancePlacement), shared with the other PCs in
 *  the CliMayte queue snapshot (the newer `updatedAt` wins). */
export interface AccountPlacement {
  /** New work goes to a higher one first, among the accounts it fits: 2 Top, 1 High, 0 Normal, -1 Low. */
  priority: number
  /** This account's stop line on each window in place of the fleet's 85% (1-84): no new work at it,
   *  a session there hands off at it, and one still working is stopped CAP_CEILING_GAP above it. Null:
   *  the fleet's line. */
  maxSessionPct: number | null
  maxWeekPct: number | null
  /** When it was set (epoch ms). */
  updatedAt: number
}

/** A CLI instance: a `CLAUDE_CONFIG_DIR` associated with an account, logged in once. */
export interface CliInstance {
  /** Permanent short handle (`#7`), shared with desktop + Codex instances in one sequence. See
   *  core/instance-numbers.ts. Re-derived from the registry on every hydrate; the copy that ends
   *  up in the store file is a mirror, never the source of truth. */
  num: number
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
  /** Why `loggedIn` is false although the credential file exists: a login CliMayte found dead and
   *  `claude auth status` has not passed since (core/cli-instances.ts setCliLoginVeto). */
  loginNote?: string
  loggedIn: boolean
  /** The signed-in account's plan ("Pro", "Max 5×", "Max 20×", ...), from the login's own
   *  credentials (cliPlanLabel); null when signed out or not stated. */
  planLabel?: string | null
  /** The signed-in account's email and its name on Claude, from the login's own `.claude.json`
   *  (cliAccountIdentity); null when signed out or not stated. Set on every read. */
  accountEmail?: string | null
  accountName?: string | null
  /** The name was made by AgentHydra (pairing, then the account's email), not typed by a person, so
   *  nameCliInstancesByAccount keeps it on the signed-in account's email. A rename sets it false. */
  autoNamed?: boolean
  lastUsageCheck: UsageSnapshot | null
  /** Claude sessions running on this account now (its live registry, CliMayte workers included). Set by
   *  GET /api/cli-instances only; absent elsewhere. */
  liveSessions?: number
  /** When this login was last used on this PC (ms): its newest prompt or keepalive nudge. Set by GET
   *  /api/cli-instances only; null when neither is known. */
  lastActiveAt?: number | null
  /** What the account signed in here now has run on this PC (core/account-tokens.ts). Set by GET
   *  /api/cli-instances only; null when signed out, and until the first sweep after a daemon start. */
  tokens?: AccountTokens | null
  /** Workers CliMayte runs on this account from the other PC right now (climayte-remote.ts). Their tokens
   *  are not in `tokens`, which counts this PC's transcripts only. Set by GET /api/cli-instances only. */
  remoteWorkers?: number
  /** What the CLI said the last time its `/limit-reset` was run from AgentHydra (core/cli-limit-reset.ts).
   *  Undefined until then. The only honest reading there is: the usage endpoint will not say. */
  lastLimitReset?: CliLimitResetResult | null
  /** The owner's priority and caps for this account (AccountPlacement). Absent: Normal, the fleet's line. */
  placement?: AccountPlacement
  /** The last nudge the keepalive sent this account (session-keepalive.ts). Set by GET
   *  /api/cli-instances only; null when it was never nudged. */
  lastNudge?: CliNudgeRecord | null
  /** The login was moved to another PC from here (core/cli-login-move.ts): when, and the bundle file.
   *  Cleared when this instance is signed in again. */
  movedAway?: { at: number; file: string } | null
  createdAt: number
}

/** One nudge the keepalive sent an idle CLI account to start its 5-hour window (session-keepalive.ts). */
export interface CliNudgeRecord {
  at: number
  /** The window was seen running after it. */
  ok: boolean
  /** What happened, in words: the window it started, or why it did not. */
  note: string
  /** When the window it started ends (ISO), when a reading said so. */
  resetsAt: string | null
  /** The model the CLI reported running. */
  model: string | null
  costUsd: number | null
}

/** What the Login sync dialog shows (core/cli-login-sync.ts). Never a token, key or login. */
export interface CliLoginSyncStatus {
  configured: boolean
  enabled: boolean
  /** The store's host, or null when not set up. */
  url: string | null
  lastSyncAt: number | null
  lastError: string | null
  /** This PC shares its CliMayte queue through the store and reads the other PCs' (climayte-queue-sync). */
  shareQueue: boolean
  /** Why the queue could not sync at the last pass, apart from `lastError` (the logins'); null when it did. */
  queueError: string | null
  /** This PC shares its visible desktop chats through the store and reads the other PCs' (desktop-chat-sync). */
  shareChats: boolean
  /** Why the chats could not sync at the last chat pass, apart from `lastError` and `queueError`; null when they did. */
  chatsError: string | null
  /** The synced chats with the PC each came from; [] while sharing is off. */
  chats: ChatSyncRow[]
  logins: Array<{
    /** A CLI instance's id, or a desktop account's uuid. */
    id: string
    kind: 'cli' | 'desktop'
    num: number | null
    /** The CLI instance's name, or the desktop profile's folder name. */
    name: string
    /** Signed in on this PC. */
    here: boolean
    /** The store holds a copy (as of the last pass). */
    inStore: boolean
    /** Left out of sync on this PC. */
    excluded: boolean
    /** This PC and the store agreed on it at the last pass. */
    inSync: boolean
    /** A real sync error for this login, or null. The dialog shows it as "Can't sync"; a row sync
     *  leaves alone says why in `note`, never here. */
    problem: string | null
    /** Why sync leaves it as it is: signed in separately on this PC ('own'), a newer login waiting
     *  for its desktop instance to close ('waiting'), a CLI login taken from its desktop instance,
     *  which is the one that syncs ('fed'), or signed out until it is signed in again: logged out
     *  on a PC, or ended by Anthropic, its tokens emptied by the CLI ('signedOut'). */
    note: 'own' | 'waiting' | 'fed' | 'signedOut' | null
  }>
  /** The newest first: what the passes did. */
  events: Array<{
    at: number
    num: number | null
    action: 'pushed' | 'pulled' | 'created' | 'skipped' | 'signedOut' | 'merged' | 'error'
    note: string
  }>
}

/** One login's line in a move between PCs (core/cli-login-move.ts). Never carries a secret. */
export interface CliLoginMoveRow {
  id: string
  num: number | null
  name: string
  ok: boolean
  message: string
  /** Import: how the instance here was found ('id', 'account') or that it was 'created'. */
  matchedBy?: 'id' | 'account' | 'created'
  /** Import: the account `claude auth status` reported for the login here. */
  signedInAs?: string | null
}

/** The answer to a move out (export) or in (import) of CLI logins. */
export interface CliLoginMoveResult {
  ok: boolean
  message: string
  /** Export: the bundle written. */
  file?: string | null
  rows: CliLoginMoveRow[]
}

/** One run of a CLI account's `/limit-reset`, in the CLI's own words (core/cli-limit-reset.ts). */
export interface CliLimitResetResult {
  ok: boolean
  /** reset: it happened. used: this week's reset is spent. unavailable: none offered now.
   *  available: a check found a banked reset and backed out of using it. */
  outcome: 'reset' | 'used' | 'unavailable' | 'available' | 'error'
  /** The CLI's own line, or why it could not be reached. */
  message: string
  /** When the next weekly reset becomes available, as the CLI worded it ("Oct 7"), if it said. */
  nextAvailable: string | null
  at: number
}

/** An isolated Codex CLI + Desktop login rooted at its own CODEX_HOME. */
export interface CodexInstance {
  /** Permanent short handle (`#7`), shared with the Claude desktop + CLI instances in one
   *  sequence. See core/instance-numbers.ts. */
  num: number
  id: string
  name: string
  codexHome: string
  loggedIn: boolean
  /**
   * Which ChatGPT account this CODEX_HOME is signed into. Attached EAGERLY on every list, unlike
   * the Claude side's lazily-resolved `CMInstance.account`: a CODEX_HOME's auth.json is plain JSON,
   * so the local read is a file read plus a base64 decode rather than a safeStorage/DPAPI round
   * trip. Carries the last-known plan from the token's claims; the live usage call refreshes it.
   * Null only when the store row could not be read at all.
   */
  account: CodexAccount | null
  /** Electron/Chromium profile isolated from both the regular app and the other instances. */
  desktopUserDataDir: string
  isDesktopRunning: boolean
  desktopPid: number | null
  /**
   * True for a row this app did NOT create: the default Codex install, or a Codex Desktop found
   * running from a profile outside our instances root. They are listed because they are real
   * accounts doing real work, and mirror `CMInstance.isExternal` on the Claude side — but they have
   * no store row, so they cannot be renamed or deleted.
   */
  isExternal: boolean
  /** True for the ONE default (non-isolated) Codex install. Always external; never deletable. */
  isDefault: boolean
  /** Epoch ms; 0 for a discovered row, which has no creation record of ours. */
  createdAt: number
}

/** Provider/surface visibility plus opt-in integrations. */
export interface ProviderSettings {
  codexDesktopEnabled: boolean
  codexCliEnabled: boolean
  /** Show the DeepSeek Harness instances section. Default on. */
  dshEnabled: boolean
  chatGptHandoffEnabled: boolean
  /** Keep every account's rolling 5-hour window ticking by spending one throwaway turn on any that
   *  is idle. OFF by default — it is the only setting here that costs quota. */
  keepaliveEnabled: boolean
  /** Weekly-usage percentage at or above which an account is left alone by the keepalive. */
  keepaliveWeeklyFloorPct: number
  /** Let work on this machine's Claude accounts run on paid extra usage (usage credits) past their
   *  limits. OFF by default — with it off nothing AgentHydra manages bills it: CliMayte stops a task
   *  before its account would bill and moves it, and the extra-usage guard (extra-usage.ts) stops
   *  every Claude session on an account that has extra usage switched on once it nears its limit. */
  allowExtraUsage: boolean
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

// --- reset notifications -----------------------------------------------------
// "Tell me the moment my quota comes back." The percentages already flow through the usage sweep;
// these types are about turning the EDGE (a window rolling over) into something that reaches the
// user while the app is in the tray and they're looking at something else.

/** Which quota window rolled over. */
export type ResetKind = 'session' | 'weekAll'

/**
 * One detected reset, kept until acknowledged.
 *
 * It outlives the process on purpose (persisted to disk): a reset that fires at 3am while the
 * daemon is restarting for an auto-update would otherwise be lost, which is the one case the whole
 * feature exists for. `repeats` is what persistent ("annoying") mode counts.
 */
export interface ResetEvent {
  id: string
  /** Usage-cache key of the instance whose window reset (`desktop:<dir>` / `cli:<id>`). */
  key: string
  /** Human label for the instance, resolved when the event was raised. */
  label: string
  kind: ResetKind
  /** ISO instant the window was scheduled to reset at. */
  resetAt: string
  /** ISO instant we noticed. Later than `resetAt` by however long the detection lagged. */
  detectedAt: string
  /** The percentage that was in use just before the rollover — the "you were at 97%" in the copy. */
  previousPct: number | null
  /** The percentage read after it. Usually near 0; null when the post-reset read had no numbers. */
  currentPct: number | null
  acknowledged: boolean
  /** How many times it has been re-raised by persistent mode (0 = only the original). */
  repeats: number
  /** ISO instant of the most recent delivery — what the repeat interval is measured from. */
  lastNotifiedAt: string
}

/** Per-channel outcome of one delivery attempt, so the UI can say WHICH channel failed. */
export interface NotifyDeliveryResult {
  desktop: { attempted: boolean; ok: boolean; error?: string }
  email: { attempted: boolean; ok: boolean; error?: string }
}

/** Notification settings (persisted in the db `settings` table; the SMTP password is sealed). */
export interface NotificationSettings {
  /** Master switch for reset notifications. */
  notifyEnabled: boolean
  /** Notify when the 5-hour session window rolls over. */
  notifySessionReset: boolean
  /** Notify when the weekly (all-models) window rolls over. */
  notifyWeeklyReset: boolean
  /** Suppress a reset whose pre-reset usage was below this. 0 = notify on every reset. */
  notifyMinPct: number
  /**
   * Suppress a 5-HOUR reset when the same account's WEEKLY cap is still at or above this.
   *
   * A session window coming back does not make an account usable if the weekly all-models cap is
   * still spent — the account stays blocked, so the toast is pure noise. This is the same judgement
   * the Instances tab's usage filter makes when it sets a row aside (see lib/usage-filter.ts, same
   * default of 80), applied to notifications: an account outside the filter should not be paging
   * you about a window that changes nothing.
   *
   * Only gates `session` events; a WEEKLY reset is always the one that actually unblocks an account
   * and is never suppressed by this. 100 keeps only the fully-exhausted case suppressed; to silence
   * session resets outright, turn off notifySessionReset.
   */
  notifySessionMaxWeeklyPct: number
  /** Raise a native OS notification (Windows toast / macOS / notify-send). */
  notifyDesktop: boolean
  /** Persistent ("annoying") mode: keep re-raising until acknowledged. */
  notifyPersistent: boolean
  /** Minutes between repeats in persistent mode. */
  notifyPersistentIntervalMin: number
  /** Stop after this many repeats (0 = never stop until acknowledged). */
  notifyPersistentMaxRepeats: number
  /** Also send an email. */
  notifyEmail: boolean
  notifyEmailTo: string
  notifyEmailFrom: string
  notifySmtpHost: string
  notifySmtpPort: number
  /** true = implicit TLS (465); false = plaintext connect + STARTTLS (587/25). */
  notifySmtpSecure: boolean
  notifySmtpUser: string
  /** Read-only echo: whether a password is stored. The password itself never leaves the server. */
  notifySmtpPassSet: boolean
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
