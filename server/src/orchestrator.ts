// server/src/orchestrator.ts — the attention watcher (docs/ORCHESTRATOR.md).
//
// THE SHAPE. Ten chats across five desktop instances finish one by one, print their recap, and
// sit waiting for the same sentence ("Resume working on whatever you recommend next"). This module
// is the deterministic half of automating that babysitting: a 60-second pass over what is already
// on disk that decides WHAT NEEDS ATTENTION, published as a feed. The judgment half — actually
// talking to a live chat — belongs to an interactive "reviewer" session running /orchestrate,
// because peer messaging is only available to interactive sessions (measured 2026-08-25: a
// headless dispatched run has no ListAgents/SendMessage; a live one delivers cross-instance in
// seconds). So the daemon watches, the reviewer speaks, and this file must NEVER try to speak:
// no Anthropic calls, no messaging, no dispatching, no touching repos.
//
// THE ACTION GATE (owner law 2026-08-26, restoring the split above after it drifted). For a
// while this file also ACTED: auto-revive dispatched headless resumes, the archive janitor
// flipped flags, the visibility sweep imported chats — all blind, no AI judgment. The owner's
// ruling: EVERY action (a revive, an archive, an import) is CHECKED by the orchestrator AI
// before it is made. So detectors now write PROPOSALS (proposals.ts) instead of acting; the
// reviewer decides each one and executes the approved ones itself, through the desktop app's
// own native channels — never headless (owner law, same day: desktop stays desktop, CLI stays
// CLI, headless stays headless; no thread is ever continued on a surface it does not live on).
// The only things this file still does by itself are thread-neutral hygiene: naming untitled
// chats from the scanner (owner order: names are managed automatically), cleaning dead-pid
// registry residue, and restarting an idle app so already-approved changes become visible.
//
// WHAT IT READS, all local, all already there:
//   · ~/.claude/sessions/<pid>.json — the CLI's live-session registry: peer name (the SendMessage
//     address), transcript sessionId, cwd, pid. The deterministic bridge between the messaging
//     world and the transcript world. Entries whose pid is gone are ignored.
//   · The session's transcript tail — quietness (file mtime), what ended the last turn (the same
//     classifyEnding the sessions list trusts), the last assistant text (the recap the reviewer
//     judges from), context tokens (last assistant usage), spawn_task chips, the last real human
//     message (a recent one pauses orchestration of that chat — the human outranks everything).
//   · usage-cache.json — the usage sweep's snapshots. Read only; this module never probes quota.
//   · git status of live-session cwds — dirty-for-how-long, branch, unpushed count.
//
// FEED DISCIPLINE. Every item has a stable key and an ack row (orchestrator_acks): the reviewer
// acks what it acts on, and the item stays suppressed until the cooldown passes — except a
// session item whose transcript has MOVED since the ack re-arms on its own, because new activity
// then new idleness is a new situation, not a repeat of the old one. Without that rule a nudged
// chat that finishes its next task inside the cooldown would sit invisible, which is the exact
// failure this whole feature exists to end.
//
// OFF by default, like the auto-resume monitor and for the same reason: it looks at everything
// you are doing on a timer, and that should be a choice.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// Text imports: bundled into compiled builds, so a packaged AgentHydra can still install the
// commands on a machine that has no checkout and no docs/ directory.
import DELAYO_COMMAND from '../../docs/delayo-command.md' with { type: 'text' }
import ORCHESTRATE_COMMAND from '../../docs/orchestrate-command.md' with { type: 'text' }
import RESUMEO_COMMAND from '../../docs/resumeo-command.md' with { type: 'text' }
import {
  type CodexTail,
  type CodexThread,
  listRecentCodexThreads,
  readCodexTail,
} from './codex-orchestration'
import { listInstances } from './core/instances'
import { db, getSetting, setSetting } from './db'
import { isSessionActive } from './dispatch'
import { instanceRefForSession, sessionMetaMap } from './instance-sessions'
import { listProposalsForView, maintainProposals, proposeAction } from './proposals'
import { classifyEnding, type SessionEnding } from './session-ending'
import { desktopChatArchiveState, sweepUntitledDesktopChats } from './session-launch'
import type {
  AttentionItem,
  OrchestratorInstance,
  OrchestratorSettings,
  OrchestratorView,
  UsageSnapshot,
} from './types'
import { allCachedUsage } from './usage-cache'
import { desktopKey } from './usage-service'

// --- settings ---------------------------------------------------------------

function num(key: string, fallback: number, min: number, max: number): number {
  const raw = getSetting(key)
  // Number('') is 0, which is finite — an unset key must mean the fallback, never the min clamp.
  if (!raw.trim()) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export function getOrchestratorSettings(): OrchestratorSettings {
  return {
    enabled: getSetting('orch_enabled') === '1',
    tickSecs: num('orch_tick_secs', 60, 30, 600),
    idleQuietSecs: num('orch_idle_quiet_secs', 150, 30, 3600),
    ctxHandoffTokens: num('orch_ctx_handoff_tokens', 700_000, 50_000, 2_000_000),
    softPct: num('orch_soft_pct', 80, 1, 100),
    warnPct: num('orch_warn_pct', 85, 1, 100),
    hardPct: num('orch_hard_pct', 90, 1, 100),
    sessionHighPct: num('orch_session_high_pct', 90, 1, 100),
    resetSoonMins: num('orch_reset_soon_mins', 120, 0, 24 * 60),
    spikePct: num('orch_spike_pct', 5, 1, 100),
    dirtyMins: num('orch_dirty_mins', 60, 1, 7 * 24 * 60),
    staleTaskMins: num('orch_stale_task_mins', 120, 10, 24 * 60),
    nudgeCooldownMins: num('orch_nudge_cooldown_mins', 15, 1, 24 * 60),
    openInstances:
      getSetting('orch_open_instances') === 'when-exhausted' ? 'when-exhausted' : 'never',
    openMinPlan: getSetting('orch_open_min_plan') || 'Max 20',
    reviewerReservePct: num('orch_reviewer_reserve_pct', 75, 1, 100),
    handoffSurface: ((): OrchestratorSettings['handoffSurface'] => {
      const hs = getSetting('orch_handoff_surface')
      return hs === 'queue' || hs === 'terminal' ? hs : 'desktop'
    })(),
    newChatModel: getSetting('orch_new_chat_model') || 'opus',
    newChatEffort: ((): OrchestratorSettings['newChatEffort'] => {
      const e = getSetting('orch_new_chat_effort')
      return e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' ? e : 'max'
    })(),
    newChatUltracode: getSetting('orch_new_chat_ultracode') !== '0',
    migrateOnLimit: getSetting('orch_migrate_on_limit') === '1',
    maxActiveChats: num('orch_max_active_chats', 0, 0, 500),
    watchCodex: getSetting('orch_watch_codex') !== '0',
  }
}

export function setOrchestratorSettings(
  patch: Partial<OrchestratorSettings>,
): OrchestratorSettings {
  if (typeof patch.enabled === 'boolean') setSetting('orch_enabled', patch.enabled ? '1' : '0')
  const clamp = (key: string, v: unknown, min: number, max: number) => {
    if (typeof v === 'number' && Number.isFinite(v))
      setSetting(key, String(Math.min(max, Math.max(min, Math.floor(v)))))
  }
  clamp('orch_tick_secs', patch.tickSecs, 30, 600)
  clamp('orch_idle_quiet_secs', patch.idleQuietSecs, 30, 3600)
  clamp('orch_ctx_handoff_tokens', patch.ctxHandoffTokens, 50_000, 2_000_000)
  clamp('orch_soft_pct', patch.softPct, 1, 100)
  clamp('orch_warn_pct', patch.warnPct, 1, 100)
  clamp('orch_hard_pct', patch.hardPct, 1, 100)
  clamp('orch_session_high_pct', patch.sessionHighPct, 1, 100)
  clamp('orch_reset_soon_mins', patch.resetSoonMins, 0, 24 * 60)
  clamp('orch_spike_pct', patch.spikePct, 1, 100)
  clamp('orch_dirty_mins', patch.dirtyMins, 1, 7 * 24 * 60)
  clamp('orch_stale_task_mins', patch.staleTaskMins, 10, 24 * 60)
  clamp('orch_nudge_cooldown_mins', patch.nudgeCooldownMins, 1, 24 * 60)
  if (patch.openInstances === 'never' || patch.openInstances === 'when-exhausted')
    setSetting('orch_open_instances', patch.openInstances)
  if (typeof patch.openMinPlan === 'string' && patch.openMinPlan.trim())
    setSetting('orch_open_min_plan', patch.openMinPlan.trim().slice(0, 40))
  clamp('orch_reviewer_reserve_pct', patch.reviewerReservePct, 1, 100)
  if (
    patch.handoffSurface === 'terminal' ||
    patch.handoffSurface === 'queue' ||
    patch.handoffSurface === 'desktop'
  )
    setSetting('orch_handoff_surface', patch.handoffSurface)
  if (typeof patch.newChatModel === 'string' && patch.newChatModel.trim())
    setSetting('orch_new_chat_model', patch.newChatModel.trim().slice(0, 60))
  if (
    patch.newChatEffort === 'low' ||
    patch.newChatEffort === 'medium' ||
    patch.newChatEffort === 'high' ||
    patch.newChatEffort === 'xhigh' ||
    patch.newChatEffort === 'max'
  )
    setSetting('orch_new_chat_effort', patch.newChatEffort)
  if (typeof patch.newChatUltracode === 'boolean')
    setSetting('orch_new_chat_ultracode', patch.newChatUltracode ? '1' : '0')
  if (typeof patch.migrateOnLimit === 'boolean')
    setSetting('orch_migrate_on_limit', patch.migrateOnLimit ? '1' : '0')
  clamp('orch_max_active_chats', patch.maxActiveChats, 0, 500)
  if (typeof patch.watchCodex === 'boolean')
    setSetting('orch_watch_codex', patch.watchCodex ? '1' : '0')
  return getOrchestratorSettings()
}

// --- the prompts the orchestrator sends into chats ---------------------------
// Every message the machinery sends a chat is a named template the owner can edit (Settings ->
// Automation -> Prompts). The shipped texts are the defaults and stay authoritative when a key
// is unset or blank; an edit is stored per key and survives updates. Placeholders in <angle
// brackets> (<n>, <cwd>, <duration>, <m>, <x>) are substituted by the sender before delivery.

export const ORCHESTRATOR_PROMPT_DEFAULTS = {
  /** The classic nudge for an idle chat whose recap recommends safe next steps. */
  resumeNudge: 'Resume working on whatever you recommend next.',
  /** Sent when a chat's context passes ctxHandoffTokens. */
  handoffRequest:
    'Your context is getting very large. Finish anything in flight, update all relevant ' +
    'markdown files, then give me a handoff prompt a fresh session can use to continue ' +
    'seamlessly - include repo paths, current verified state, and next steps.',
  /** Sent when a chat has been waiting on background tasks that went silent. */
  staleTaskNudge:
    '[orchestrator] You have been waiting on background tasks that have produced nothing for ' +
    '<duration> - they are almost certainly dead or their completion never woke you. Check ' +
    'their status and output files now, kill or restart what is needed, and continue the work. ' +
    'If their results are unrecoverable, redo that work directly. Do not go back to waiting.',
  /** Sent to every live chat on an account that crossed the hard weekly cutoff. */
  hardCutoff:
    'URGENT: this account is at <n>% weekly. Stop after your current step, commit and sync ' +
    'your own files (path-scoped git add, never git add -A; check repo visibility before any ' +
    'push), and give me a handoff prompt. Do not start anything new.',
  /** Sent once to a chat that stopped on a 529 server overload. */
  overloadNudge: 'You stopped on a server overload. Please continue where you left off.',
  /** Sent to the longest-idle chat of a repo that has sat dirty past dirtyMins. */
  commitNudge:
    'The repo at <cwd> has had <n> uncommitted file(s) for <m> minutes and nothing is syncing ' +
    'them. If those changes are yours and complete: commit and push ONLY your own files ' +
    '(path-scoped git add, never git add -A). Before any push, check whether the repo is ' +
    'PUBLIC and follow the public-repo warning protocol. If they are not your changes, say so ' +
    'and stop.',
  /** Sent to a chat working on a non-main branch. */
  branchNudge:
    "You are on branch '<x>'. Standing rule: all work on main, one branch only. Merge your " +
    'work back onto main without discarding anything, then continue on main.',
  /** The resume turn for a session whose process died mid-work (restart/crash/kill). */
  orphanRevive:
    '[orchestrator] Your process died mid-work (computer restart or crash). Review your last ' +
    'steps, verify what actually landed on disk, and resume from where you truly are - files ' +
    'may be ahead of or behind your notes.',
  /** The last turn a thread runs before it is archived as FINISHED (owner rule 2026-08-26:
   *  "if you are going to archive a chat that wasn't migrated, ask the chat to update any
   *  relevant markdown files, just to make sure all documentation is current"). A retired
   *  thread is the last place its own knowledge exists, so the closeout is what turns a
   *  conversation into documentation before it stops being readable. Deliberately says NOT to
   *  use shell commands: an imported/revived chat usually runs in a mode that raises an
   *  approval prompt for those, and the remote owner can never click it - measured, five chats
   *  frozen that way. Migrations do NOT get this: that thread is continuing, not ending. */
  closeoutDocs:
    '[orchestrator] This thread is being retired and archived. Before it closes, capture what ' +
    'exists ONLY in this conversation: update the relevant markdown file(s) in this repo with ' +
    'what this thread did, what is VERIFIED complete versus merely attempted, what is still ' +
    'outstanding, and any decisions, gotchas or dead ends a future session would otherwise ' +
    'have to rediscover. Do NOT run shell commands (they stall on an approval nobody can ' +
    'click) - use the file tools only, and do not commit. If nothing here is still worth ' +
    'keeping, say so plainly rather than inventing content. Reply with three lines: what you ' +
    'wrote, where, and what you could not verify. Do not start any new work.',
  /** The one-turn notice a chat runs while being migrated to another account. Starts with the
   *  [orchestrator] marker so transcript parsers classify it as plumbing, never as the human's
   *  standing instruction (a marker-less version once made every migrated thread read as
   *  human-held, and the reviewer politely never touched them again). */
  migrationNotice:
    '[orchestrator] You are being migrated to a different account and this thread will appear ' +
    "in the owner's desktop app shortly. In a few lines: state what this thread is working on, " +
    'what is verified complete so far, and the concrete next steps. Do not start new work in ' +
    'this turn and do not touch any files; after this turn, this notice is spent - resume ' +
    'normally when the owner or the orchestrator next asks.',
} as const

export type OrchestratorPromptKey = keyof typeof ORCHESTRATOR_PROMPT_DEFAULTS

const PROMPT_SETTING_KEYS: Record<OrchestratorPromptKey, string> = {
  resumeNudge: 'orch_prompt_resume_nudge',
  handoffRequest: 'orch_prompt_handoff_request',
  staleTaskNudge: 'orch_prompt_stale_task_nudge',
  hardCutoff: 'orch_prompt_hard_cutoff',
  overloadNudge: 'orch_prompt_overload_nudge',
  commitNudge: 'orch_prompt_commit_nudge',
  branchNudge: 'orch_prompt_branch_nudge',
  orphanRevive: 'orch_prompt_orphan_revive',
  closeoutDocs: 'orch_prompt_closeout_docs',
  migrationNotice: 'orch_prompt_migration_notice',
}

/** The resolved prompt set: the owner's edit where one exists, the shipped default otherwise. */
export function getOrchestratorPrompts(): Record<OrchestratorPromptKey, string> {
  const out = {} as Record<OrchestratorPromptKey, string>
  for (const key of Object.keys(ORCHESTRATOR_PROMPT_DEFAULTS) as OrchestratorPromptKey[]) {
    const stored = getSetting(PROMPT_SETTING_KEYS[key]).trim()
    out[key] = stored || ORCHESTRATOR_PROMPT_DEFAULTS[key]
  }
  return out
}

/** Store edits. Blank, or text identical to the default, clears the override (so a reset in the
 *  UI is just "save the default text" and future default improvements reach that machine). */
export function setOrchestratorPrompts(
  patch: Partial<Record<OrchestratorPromptKey, string>>,
): Record<OrchestratorPromptKey, string> {
  for (const key of Object.keys(ORCHESTRATOR_PROMPT_DEFAULTS) as OrchestratorPromptKey[]) {
    const v = patch[key]
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    setSetting(
      PROMPT_SETTING_KEYS[key],
      trimmed && trimmed !== ORCHESTRATOR_PROMPT_DEFAULTS[key] ? trimmed.slice(0, 4000) : '',
    )
  }
  return getOrchestratorPrompts()
}

// --- tiny persisted KV (dirty-since, usage baselines) -----------------------

function kvGet(key: string): string | null {
  return (
    db
      .query<{ value: string }, [string]>('select value from orchestrator_kv where key = ?')
      .get(key)?.value ?? null
  )
}

function kvSet(key: string, value: string): void {
  db.query(
    `insert into orchestrator_kv (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString())
}

function kvDelete(key: string): void {
  db.query('delete from orchestrator_kv where key = ?').run(key)
}

// --- holds (/delayo and /resumeo) -------------------------------------------
// A held thread is one the owner has parked: lower priority right now, too much else running.
// The watcher drops every session-scoped item for it, so the reviewer never sees it to nudge.
// No expiry — a hold stands until /resumeo lifts it (parking for days is a legitimate use).

const HOLD_PREFIX = 'hold:'

export function setSessionHold(sessionId: string, held: boolean): void {
  if (held) kvSet(HOLD_PREFIX + sessionId, new Date().toISOString())
  else kvDelete(HOLD_PREFIX + sessionId)
}

export function listSessionHolds(): Array<{ sessionId: string; heldAt: string }> {
  return db
    .query<{ key: string; value: string }, [string]>(
      'select key, value from orchestrator_kv where key like ?',
    )
    .all(`${HOLD_PREFIX}%`)
    .map((r) => ({ sessionId: r.key.slice(HOLD_PREFIX.length), heldAt: r.value }))
}

// --- acks -------------------------------------------------------------------

export function ackAttention(key: string, action: string, cooldownMins?: number): void {
  const mins = Number.isFinite(cooldownMins)
    ? Math.min(24 * 60, Math.max(1, Math.floor(cooldownMins as number)))
    : getOrchestratorSettings().nudgeCooldownMins
  const now = new Date()
  db.query(
    `insert into orchestrator_acks (key, action, until, acked_at) values (?, ?, ?, ?)
     on conflict(key) do update set action = excluded.action, until = excluded.until, acked_at = excluded.acked_at`,
  ).run(
    key,
    action.slice(0, 200),
    new Date(now.getTime() + mins * 60_000).toISOString(),
    now.toISOString(),
  )
}

interface AckRow {
  key: string
  until: string
  acked_at: string
}

function activeAcks(nowMs: number): Map<string, AckRow> {
  // Prune anything a week past its cooldown while we are here — the table is a working set,
  // not a ledger (the reviewer's own transcript is the ledger of what it did).
  db.query('delete from orchestrator_acks where until < ?').run(
    new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString(),
  )
  const rows = db.query<AckRow, []>('select key, until, acked_at from orchestrator_acks').all()
  const map = new Map<string, AckRow>()
  const now = new Date(nowMs).toISOString()
  for (const r of rows) if (r.until > now) map.set(r.key, r)
  return map
}

// --- the live-session registry ----------------------------------------------

export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  /** The peer-messaging address (SendMessage target). */
  name: string
  startedAt: number
  transcriptPath: string | null
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The CLI's transcript-store encoding of a cwd: every non-alphanumeric character becomes '-'. */
export function projectKeyForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function transcriptPathFor(claudeHome: string, cwd: string, sessionId: string): string | null {
  const direct = join(claudeHome, 'projects', projectKeyForCwd(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  // The key preserves the cwd's casing as the session recorded it, which is not always the casing
  // in the registry (drive letters wander between 'D:' and 'd:'). The sessionId is globally unique,
  // so a bounded search across project dirs settles it.
  try {
    for (const dir of readdirSync(join(claudeHome, 'projects'))) {
      const p = join(claudeHome, 'projects', dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // No projects dir at all — reported as unreadable per-session below.
  }
  return null
}

/** A registry file that outlived its process: the session died un-gracefully (computer restart,
 *  crash, kill) — a graceful exit deletes its own `<pid>.json`. Mid-process death is a resumable
 *  scenario, so these are surfaced, not silently dropped. */
export interface OrphanSession extends LiveSession {
  /** The stale registry file itself — the evidence, and the cleanup handle. */
  registryPath: string
}

function scanRegistry(claudeHome: string): { live: LiveSession[]; orphans: OrphanSession[] } {
  const dir = join(claudeHome, 'sessions')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return { live: [], orphans: [] }
  }
  const live: LiveSession[] = []
  const orphans: OrphanSession[] = []
  for (const f of files) {
    try {
      const reg = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (typeof reg?.sessionId !== 'string' || typeof reg?.cwd !== 'string') continue
      if (typeof reg.pid !== 'number') continue
      const entry: LiveSession = {
        pid: reg.pid,
        sessionId: reg.sessionId,
        cwd: reg.cwd,
        name: typeof reg.name === 'string' ? reg.name : reg.sessionId.slice(0, 8),
        startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : 0,
        transcriptPath: transcriptPathFor(claudeHome, reg.cwd, reg.sessionId),
      }
      if (pidAlive(reg.pid)) live.push(entry)
      else orphans.push({ ...entry, registryPath: join(dir, f) })
    } catch {
      // One unreadable registry entry must not hide the others.
    }
  }
  return { live, orphans }
}

function readLiveRegistry(claudeHome: string): LiveSession[] {
  return scanRegistry(claudeHome).live
}

export function readOrphanedRegistry(claudeHome: string): OrphanSession[] {
  return scanRegistry(claudeHome).orphans
}

/** Recent transcripts on disk: the raw material of the STRANDED-chat scan. A PC restart shuts
 *  sessions down GRACEFULLY, and a graceful exit deletes its own registry file — so the
 *  dead-pid orphan pass has no residue to read, while the chat's transcript still ends
 *  mid-turn and its entry still sits un-archived in a desktop sidebar. This enumerates the
 *  store cheaply (measured: 0.06s for 1331 files); the caller applies every gate. */
export interface RecentTranscript {
  sessionId: string
  path: string
  mtimeMs: number
}

const STRANDED_WINDOW_MS = 48 * 3600 * 1000

/** Tools that raise an approval prompt in every mode except 'bypassPermissions'. Deliberately
 *  narrow: file edits are auto-approved under 'acceptEdits', so including them would turn a
 *  normal slow Write into a false "frozen" report, and a detector that cries wolf gets ignored. */
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'PowerShell'])

export function listRecentTranscripts(claudeHome: string, nowMs: number): RecentTranscript[] {
  const root = join(claudeHome, 'projects')
  const out: RecentTranscript[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return []
  }
  for (const d of dirs) {
    let files: string[] = []
    try {
      files = readdirSync(join(root, d))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(root, d, f)
      try {
        const m = statSync(path).mtimeMs
        if (nowMs - m <= STRANDED_WINDOW_MS)
          out.push({ sessionId: f.slice(0, -'.jsonl'.length), path, mtimeMs: m })
      } catch {
        // A file deleted mid-scan is just not recent.
      }
    }
  }
  return out
}

/** Remove a stale registry file and its `<pid>.*.key` siblings. Only ever called for entries
 *  whose pid is verifiably dead — this is residue, not state. */
function cleanOrphanFiles(orphan: OrphanSession): void {
  try {
    rmSync(orphan.registryPath, { force: true })
    const dir = dirname(orphan.registryPath)
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${orphan.pid}.`) && f.endsWith('.key'))
        rmSync(join(dir, f), { force: true })
    }
  } catch {
    // Best-effort: a locked file just means the orphan shows again next tick.
  }
}

// --- transcript tail parsing (pure; exported for tests) ---------------------

export interface ChipInTail {
  id: string
  title: string
  prompt: string
}

export interface TailInfo {
  /** What ended the last meaningful record, per session-ending.ts. */
  ending: SessionEnding | null
  /** Last assistant text (the recap, when there is one). */
  lastAssistantText: string | null
  /** Context tokens at the last assistant event (input + cache read + cache creation). */
  ctxTokens: number | null
  /** The last turn's final assistant record ended on tool_use with nothing after it. */
  midTurn: boolean
  /** WHICH tool that dangling call was, when midTurn came from an assistant tool_use. The
   *  difference between "waiting on a long build" and "frozen at an approval prompt" starts
   *  here: only some tools prompt, and only in some permission modes. */
  pendingTool: string | null
  /** A "What I did / Am I 100% done / Do I recommend" recap block is present. */
  recapDetected: boolean
  /** The tail mentions a handoff prompt (the context-rollover protocol's deliverable). */
  handoffDetected: boolean
  /** spawn_task chips offered in the tail window. */
  chips: ChipInTail[]
  /** Last message typed by the actual human (injected/cross-session/tool traffic excluded). */
  lastHumanText: string | null
  /** ISO timestamp of that human message, when the record carried one. */
  lastHumanAt: string | null
  /** ISO timestamp of the newest record in the window — when the ENGINE last did anything.
   *  Compared against the live registry's process startedAt, this is the deterministic deaf
   *  test: a process with NO record newer than its own spawn has never run a turn. */
  lastEventAt: string | null
  /** No parseable user/assistant record found in the window that was read. */
  unreadable: boolean
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n')
  return ''
}

/** True for user records that were not typed by the human: cross-session mail, task
 *  notifications, command output echoes, tool results, interrupt bookkeeping. */
export function isInjectedUserText(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('Another Claude session sent a message') ||
    t.startsWith('<cross-session-message') ||
    t.startsWith('<task-notification>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('[Request interrupted') ||
    // Orchestrator plumbing (migration notices, revive prompts, reviewer nudges) is marked with
    // this prefix by convention. Counting it as "the human said something" made every migrated
    // thread read as human-held, so the reviewer never touched it again.
    t.startsWith('[orchestrator]')
  )
}

export function parseTranscriptTail(raw: string): TailInfo {
  const lines = raw.split('\n').filter((l) => l.trim())
  const info: TailInfo = {
    ending: null,
    lastAssistantText: null,
    ctxTokens: null,
    midTurn: false,
    pendingTool: null,
    recapDetected: false,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    lastEventAt: null,
    unreadable: true,
  }
  let isNewestMeaningful = true
  // Newest record last on disk, so walk backwards; the first line of a byte-window is often a
  // truncated JSON line, which the parse guard simply skips.
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: {
      type?: string
      timestamp?: string
      message?: { content?: unknown; usage?: Record<string, number> }
    }
    try {
      ev = JSON.parse(lines[i])
    } catch {
      continue
    }
    const type = ev?.type
    if (type !== 'user' && type !== 'assistant' && type !== 'result') continue
    info.unreadable = false
    const newest = isNewestMeaningful
    isNewestMeaningful = false
    if (newest && typeof ev.timestamp === 'string') info.lastEventAt = ev.timestamp
    const text = textOf(ev.message?.content)
    if (info.ending === null) {
      const e = classifyEnding(ev, text)
      if (e !== null) info.ending = e
    }
    if (type === 'assistant' && ev.message) {
      const usage = ev.message.usage
      if (info.ctxTokens === null && usage) {
        info.ctxTokens =
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0)
      }
      const content = ev.message.content
      if (Array.isArray(content)) {
        for (const b of content as Array<{
          type?: string
          id?: string
          name?: string
          input?: { title?: string; prompt?: string }
        }>) {
          if (b.type === 'tool_use' && /spawn_task$/.test(b.name ?? '')) {
            info.chips.push({
              id: b.id ?? `${i}`,
              title: (b.input?.title ?? '').slice(0, 120),
              prompt: (b.input?.prompt ?? '').slice(0, 1500),
            })
          }
        }
        const dangling = newest
          ? (content as Array<{ type?: string; name?: string }>).find((b) => b.type === 'tool_use')
          : undefined
        if (dangling) {
          // The newest record overall is an assistant record that ends in a tool call: the runtime
          // is (or was) mid-turn, waiting on that tool. Distinct from "finished and waiting".
          info.midTurn = true
          info.pendingTool = dangling.name ?? null
        }
      }
      if (info.lastAssistantText === null) {
        const t = text.trim()
        if (t) info.lastAssistantText = t.slice(-4000)
      }
    } else {
      if (
        newest &&
        type === 'user' &&
        Array.isArray(ev.message?.content) &&
        (ev.message.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result')
      ) {
        // The newest record is a tool result with no assistant turn after it yet: the runtime is
        // between a tool finishing and the model's next step — also mid-turn.
        info.midTurn = true
      }
      if (type === 'user' && info.lastHumanText === null) {
        const t = text.trim()
        if (t && !isInjectedUserText(t)) {
          info.lastHumanText = t.slice(0, 400)
          info.lastHumanAt = typeof ev.timestamp === 'string' ? ev.timestamp : null
        }
      }
    }
    if (
      info.lastAssistantText !== null &&
      info.lastHumanText !== null &&
      info.ctxTokens !== null &&
      info.ending !== null
    )
      break
  }
  if (info.lastAssistantText) {
    info.recapDetected = /##\s*(What I did|Am I 100% done|Do I recommend)/i.test(
      info.lastAssistantText,
    )
    info.handoffDetected = /handoff prompt/i.test(info.lastAssistantText)
  }
  return info
}

/** Read the last `bytes` of a file. Some transcripts carry multi-megabyte single lines (pasted
 *  logs, giant tool results), so callers escalate the window until a record parses. */
function tailOfFile(path: string, bytes: number): string {
  const size = statSync(path).size
  const start = Math.max(0, size - bytes)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const TAIL_WINDOWS = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024]

function readTailInfo(path: string): TailInfo {
  let info: TailInfo | null = null
  const size = statSync(path).size
  for (const w of TAIL_WINDOWS) {
    info = parseTranscriptTail(tailOfFile(path, w))
    if (!info.unreadable || w >= size) return info
  }
  return info as TailInfo
}

// --- git hygiene ------------------------------------------------------------

export interface GitInfo {
  isRepo: boolean
  branch: string | null
  detached: boolean
  dirtyCount: number
  dirtySample: string[]
  aheadCount: number | null
}

const notARepo = new Set<string>()

async function gitInfoFor(cwd: string): Promise<GitInfo | null> {
  if (notARepo.has(cwd)) return null
  if (!existsSync(cwd)) return null
  const proc = Bun.spawn(['git', '-C', cwd, 'status', '--porcelain=v1', '--branch'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    windowsHide: true,
  })
  const killer = setTimeout(() => proc.kill(), 10_000)
  const [out, code] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited])
  clearTimeout(killer)
  if (code !== 0) {
    // Not a work tree (or git absent). Cached for the process lifetime: a directory does not
    // usually become a repo mid-session, and a wrong "no" self-heals on the next daemon start.
    notARepo.add(cwd)
    return null
  }
  const lines = out.split('\n').filter((l: string) => l.length > 0)
  const head = lines[0] ?? ''
  const detached = /^## HEAD \(no branch\)/.test(head)
  const branch = detached ? null : (head.match(/^## ([^.\s]+)/)?.[1] ?? null)
  const ahead = head.match(/ahead (\d+)/)
  const dirty = lines.slice(1)
  return {
    isRepo: true,
    branch,
    detached,
    dirtyCount: dirty.length,
    dirtySample: dirty.slice(0, 5).map((l) => l.trim()),
    aheadCount: ahead ? Number(ahead[1]) : null,
  }
}

// --- usage banding (pure; exported for tests) --------------------------------

export type UsageBand = 'ok' | 'elevated' | 'high' | 'critical'

export function bandForPct(pct: number, s: OrchestratorSettings): UsageBand {
  if (pct >= s.hardPct) return 'critical'
  if (pct >= s.warnPct) return 'high'
  if (pct >= s.softPct) return 'elevated'
  return 'ok'
}

const BAND_RANK: Record<UsageBand, number> = { ok: 0, elevated: 1, high: 2, critical: 3 }

export function resetsSoon(
  resetsAt: string | null | undefined,
  nowMs: number,
  s: OrchestratorSettings,
): boolean {
  if (!resetsAt) return false
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t)) return false
  return t > nowMs - 60_000 && t - nowMs <= s.resetSoonMins * 60_000
}

interface UsagePrev {
  pct: number
  atMs: number
  band: UsageBand
}

/** Compare the usage cache against the previous pass's baselines and produce alert items.
 *  Pure: baselines in, baselines out; the caller persists them. */
export function computeUsageItems(
  cache: Record<string, UsageSnapshot>,
  prev: Record<string, UsagePrev>,
  s: OrchestratorSettings,
  nowMs: number,
  nowIso: string,
): { items: AttentionItem[]; next: Record<string, UsagePrev> } {
  const items: AttentionItem[] = []
  const next: Record<string, UsagePrev> = {}
  for (const [key, snap] of Object.entries(cache)) {
    if (key.startsWith('codex:')) continue // Claude quota only; Codex pacing is not this feature
    const wk = snap.weekAll
    if (!wk || typeof wk.pct !== 'number') continue
    // A reading captured before its own weekly reset describes LAST week — alerting on it is a
    // zombie ("100% critical" from a month-old snapshot of an instance nobody runs anymore).
    // Same for a reading nothing has refreshed in a day: absence of data, not data.
    const capturedMs = Date.parse(snap.capturedAt ?? '')
    if (!Number.isNaN(capturedMs) && nowMs - capturedMs > 24 * 3600 * 1000) continue
    if (wk.resetsAt) {
      const resetMs = Date.parse(wk.resetsAt)
      if (!Number.isNaN(resetMs) && resetMs < nowMs) continue
    }
    const band = bandForPct(wk.pct, s)
    const soon = resetsSoon(wk.resetsAt ?? null, nowMs, s)
    const p = prev[key]
    next[key] = { pct: wk.pct, atMs: nowMs, band }
    const detail: Record<string, unknown> = {
      account: snap.account,
      weeklyPct: wk.pct,
      weeklyResetsAt: wk.resetsAt ?? null,
      sessionPct: snap.session?.pct ?? null,
      band,
      resetsSoon: soon,
      capturedAt: snap.capturedAt,
    }
    // Spike: a jump of ≥ spikePct between two readings within 30 minutes — the "something just
    // launched a billion subtasks" tripwire.
    if (p && nowMs - p.atMs <= 30 * 60_000 && wk.pct - p.pct >= s.spikePct) {
      items.push({
        key: `usage-spike:${key}`,
        kind: 'usage_alert',
        instanceRef: key,
        summary: `usage spike: ${snap.account ?? key} weekly ${p.pct}% -> ${wk.pct}% in ${Math.round((nowMs - p.atMs) / 60_000)}m`,
        detail: { ...detail, spikeFromPct: p.pct },
        firstSeenAt: nowIso,
        seenCount: 1,
      })
    }
    // Band escalation (and standing critical): the reset-soon exemption turns a high reading
    // into a dump target instead of an alarm.
    const escalated = !p || BAND_RANK[band] > BAND_RANK[p.band]
    if (band !== 'ok' && !soon && (escalated || band === 'critical')) {
      items.push({
        key: `usage:${key}:${band}`,
        kind: 'usage_alert',
        instanceRef: key,
        summary: `${snap.account ?? key} weekly at ${wk.pct}% (${band})${
          band === 'critical' ? ' — hard-cutoff territory' : ''
        }`,
        detail: { ...detail, hardCutoff: band === 'critical' },
        firstSeenAt: nowIso,
        seenCount: 1,
      })
    }
  }
  return { items, next }
}

// --- the desktop fleet as a routing table (pure; exported for tests) ---------

/** "Max 20×" out of "tobix <a@b> · Max 20×". Null when the label has no plan suffix. */
export function planOfAccountLabel(account: string | null | undefined): string | null {
  const m = account?.match(/·\s*([^·]+)$/)
  return m ? m[1].trim() : null
}

/**
 * Join the desktop instance list with the usage cache. A RUNNING instance with zero chats is
 * still open capacity — the first live run counted "open accounts" from the session registry
 * and missed exactly that instance, which is why this table exists in the feed at all.
 */
export function buildInstanceRows(
  instances: Array<{ dir: string; name: string; isRunning: boolean }>,
  cache: Record<string, UsageSnapshot>,
  s: OrchestratorSettings,
  nowMs: number,
): OrchestratorInstance[] {
  const rows: OrchestratorInstance[] = instances.map((i) => {
    const ref = desktopKey(i.dir)
    const snap = cache[ref]
    const capturedMs = Date.parse(snap?.capturedAt ?? '')
    const stale = !snap || Number.isNaN(capturedMs) || nowMs - capturedMs > 24 * 3600 * 1000
    const wk = stale ? null : (snap?.weekAll ?? null)
    return {
      ref,
      name: i.name,
      isRunning: i.isRunning,
      account: snap?.account ?? null,
      plan: planOfAccountLabel(snap?.account),
      weeklyPct: wk?.pct ?? null,
      weeklyResetsAt: wk?.resetsAt ?? null,
      sessionPct: stale ? null : (snap?.session?.pct ?? null),
      band: wk && typeof wk.pct === 'number' ? bandForPct(wk.pct, s) : 'unknown',
      resetsSoon: wk ? resetsSoon(wk.resetsAt ?? null, nowMs, s) : false,
      stale,
    }
  })
  // Running first, then the router's preference order. The 5-HOUR window is the tiebreak inside
  // a weekly band (owner rule 2026-08-25: with several accounts open, spread work so no one
  // account's 5-hour window gets hammered): the weekly band decides who is ELIGIBLE, the session
  // pct decides who is NEXT, and weekly pct settles the rest. An account resetting soon ranks
  // with the healthy ones — its week is about to wipe, the standing dump-target exemption.
  const bandRank = (r: OrchestratorInstance): number =>
    r.resetsSoon ? 0 : { ok: 0, elevated: 1, high: 2, critical: 3, unknown: 4 }[r.band]
  return rows.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1
    const br = bandRank(a) - bandRank(b)
    if (br !== 0) return br
    const sp = (a.sessionPct ?? 101) - (b.sessionPct ?? 101)
    if (sp !== 0) return sp
    return (a.weeklyPct ?? 101) - (b.weeklyPct ?? 101)
  })
}

// --- the pass ---------------------------------------------------------------

/**
 * Newest background-task output mtime for a session (`<tmp>/claude/<projectKey>/<sessionId>/
 * tasks/*.output`), or null when the session has no task dir. Background tasks leave no
 * liveness metadata on disk — only output files — so "dead" is a silence judgment: a session
 * that is waiting on tasks while BOTH its transcript and its task outputs have been silent
 * past the threshold is stuck on dead work (measured 2026-08-25: sessions sat "waiting" 9-12
 * hours on tasks whose output had stopped, and the wait rubric skipped them forever).
 */
function taskActivityMtime(cwd: string, sessionId: string): number | null {
  try {
    const dir = join(tmpdir(), 'claude', projectKeyForCwd(cwd), sessionId, 'tasks')
    let newest: number | null = null
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.output')) continue
      const m = statSync(join(dir, f)).mtimeMs
      if (newest === null || m > newest) newest = m
    }
    return newest
  } catch {
    return null
  }
}

export interface OrchestratorDeps {
  nowMs: () => number
  claudeHome: () => string
  registry: (claudeHome: string) => LiveSession[]
  /** Registry files whose pid is dead: sessions that died mid-process (restart/crash/kill). */
  orphans: (claudeHome: string) => OrphanSession[]
  /** Transcripts touched within the stranded window — see listRecentTranscripts. */
  recentTranscripts: (claudeHome: string, nowMs: number) => RecentTranscript[]
  /** Is a headless dispatch currently running this session (an in-flight run, not stranded). */
  dispatchActive: (sessionId: string) => boolean
  /** Recent Codex rollouts - the other agent this machine runs. */
  codexThreads: (nowMs: number) => CodexThread[]
  codexTail: (path: string) => CodexTail
  /** Desktop-chat metadata by session id: which instance's sidebar, and its archive flag. */
  sessionMeta: () => Map<
    string,
    { instance: string; archived: boolean; permissionMode?: string | null }
  >
  tailInfo: (path: string) => TailInfo
  mtimeMs: (path: string) => number | null
  /** See taskActivityMtime. Null = the session has no background-task outputs at all. */
  taskActivity: (cwd: string, sessionId: string) => number | null
  git: (cwd: string) => Promise<GitInfo | null>
  usage: () => Record<string, UsageSnapshot>
  instanceRef: (sessionId: string) => string | null
  desktopInstances: () => Promise<Array<{ dir: string; name: string; isRunning: boolean }>>
}

const defaultDeps: OrchestratorDeps = {
  nowMs: () => Date.now(),
  claudeHome: () => join(homedir(), '.claude'),
  registry: readLiveRegistry,
  orphans: readOrphanedRegistry,
  recentTranscripts: listRecentTranscripts,
  codexThreads: (nowMs) => listRecentCodexThreads(nowMs),
  codexTail: readCodexTail,
  dispatchActive: isSessionActive,
  sessionMeta: sessionMetaMap,
  tailInfo: readTailInfo,
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  },
  taskActivity: taskActivityMtime,
  git: gitInfoFor,
  usage: allCachedUsage,
  instanceRef: instanceRefForSession,
  desktopInstances: async () =>
    (await listInstances()).map((i) => ({
      dir: i.dir,
      name: i.label ?? i.name,
      isRunning: i.isRunning,
    })),
}

interface TickState {
  attention: AttentionItem[]
  instances: OrchestratorInstance[]
  lastTickAt: string | null
  lastTickMs: number | null
  liveSessions: number
  usageAgeSecs: number | null
  runningChats: number
  slotsFree: number | null
}

const state: TickState = {
  attention: [],
  instances: [],
  lastTickAt: null,
  lastTickMs: null,
  liveSessions: 0,
  usageAgeSecs: null,
  runningChats: 0,
  slotsFree: null,
}

/** Last-known live identity per session, so the holds list can name a parked thread even
 *  between passes. Advisory display data only — the hold itself lives in sqlite. */
const lastNames = new Map<string, { name: string; cwd: string }>()

/** firstSeenAt/seenCount continuity between passes, keyed by item key (in-memory is right:
 *  "how long has this been pending" resets naturally with the daemon). */
const seen = new Map<string, { firstSeenAt: string; count: number }>()

function withContinuity(items: AttentionItem[]): AttentionItem[] {
  const liveKeys = new Set(items.map((i) => i.key))
  for (const k of [...seen.keys()]) if (!liveKeys.has(k)) seen.delete(k)
  return items.map((i) => {
    const s = seen.get(i.key)
    if (s) {
      s.count += 1
      return { ...i, firstSeenAt: s.firstSeenAt, seenCount: s.count }
    }
    seen.set(i.key, { firstSeenAt: i.firstSeenAt, count: 1 })
    return i
  })
}

export async function runOrchestratorOnce(deps: OrchestratorDeps = defaultDeps): Promise<void> {
  const started = deps.nowMs()
  const s = getOrchestratorSettings()
  const nowIso = new Date(started).toISOString()
  const items: AttentionItem[] = []

  const sessions = deps.registry(deps.claudeHome())
  state.liveSessions = sessions.length

  // Held threads (/delayo): no session-scoped item may be generated for them at all — the
  // reviewer cannot nudge what it never sees. They still count for git grouping (a held chat's
  // repo is still that repo), but are never chosen as a nudge addressee.
  const holdSet = new Set(listSessionHolds().map((h) => h.sessionId))
  // One lineage, one continuation. A done-marked session was handed off, migrated onward, or
  // closed out — its successor owns the task now. Nudging the old copy back to life sets two
  // sessions working (and overwriting) the same files, which is exactly what the owner reported
  // (2026-08-25: chats complaining their work was overridden by other chats). Done-marked
  // sessions generate no nudge items and are never a hygiene addressee; the archive janitor is
  // what retires their desktop entries.
  const doneSet = new Set(
    db
      .query<{ session_id: string }, []>('select session_id from session_marks where done = 1')
      .all()
      .map((r) => r.session_id),
  )
  for (const sess of sessions) lastNames.set(sess.sessionId, { name: sess.name, cwd: sess.cwd })

  // Desktop metadata for every chat: which sidebar it lives in, whether it is archived, and its
  // automation posture. Read ONCE, before the per-session loop, because the loop now needs the
  // posture too (see the approval-stall diagnosis below) and the scan is cached anyway.
  let metaMap: Map<
    string,
    { instance: string; archived: boolean; permissionMode?: string | null }
  > = new Map()
  try {
    metaMap = deps.sessionMeta()
  } catch {
    // No desktop metadata just means the owner-archived and stranded checks skip this tick.
  }

  // -- per-session ------------------------------------------------------------
  // Chats actively WORKING right now (transcript fresher than the idle threshold). Held and
  // done-marked ones included: a busy chat holds a concurrency slot no matter its bookkeeping.
  let runningChats = 0
  const byCwd = new Map<string, { session: LiveSession; quietSecs: number; held: boolean }[]>()
  for (const sess of sessions) {
    if (!sess.transcriptPath) {
      items.push({
        key: `unreadable:${sess.sessionId}`,
        kind: 'errored',
        sessionId: sess.sessionId,
        peerName: sess.name,
        cwd: sess.cwd,
        summary: `live session ${sess.name}: transcript not found on disk`,
        firstSeenAt: nowIso,
        seenCount: 1,
      })
      continue
    }
    const mtime = deps.mtimeMs(sess.transcriptPath)
    if (mtime === null) continue
    const quietSecs = Math.max(0, Math.round((started - mtime) / 1000))
    if (quietSecs < s.idleQuietSecs) runningChats++
    // A done-marked session is treated like a held one from here down: it still anchors its
    // repo for git grouping, but must never be nudged or chosen as a hygiene addressee — its
    // successor owns the work (see doneSet above).
    const held = holdSet.has(sess.sessionId) || doneSet.has(sess.sessionId)
    const list = byCwd.get(sess.cwd) ?? []
    list.push({ session: sess, quietSecs, held })
    byCwd.set(sess.cwd, list)
    if (held) continue
    // The owner's tell for a purity break (2026-08-26): a thread showing "unknown account" is
    // one running with no desktop home — broken headless residue, or work started outside the
    // app. On the desktop surface every thread must live in a desktop app, so an unmapped
    // live session is flagged every pass — busy or idle — until it is landed or retired.
    if (s.handoffSurface === 'desktop' && deps.instanceRef(sess.sessionId) === null) {
      items.push({
        key: `unmapped:${sess.sessionId}`,
        kind: 'errored',
        sessionId: sess.sessionId,
        peerName: sess.name,
        cwd: sess.cwd,
        summary: `${sess.name} runs under an UNKNOWN ACCOUNT (no desktop home) — surface-purity break: land it in a desktop app when it finishes, or retire it`,
        detail: { unmappedInstance: true, quietSecs },
        firstSeenAt: nowIso,
        seenCount: 1,
      })
    }
    if (quietSecs < s.idleQuietSecs) continue

    let tail: TailInfo
    try {
      tail = deps.tailInfo(sess.transcriptPath)
    } catch {
      continue
    }
    const iref = deps.instanceRef(sess.sessionId)
    const base = {
      sessionId: sess.sessionId,
      peerName: sess.name,
      cwd: sess.cwd,
      instanceRef: iref ?? undefined,
      tailSnippet: tail.lastAssistantText ?? undefined,
      firstSeenAt: nowIso,
      seenCount: 1,
    }
    const detail: Record<string, unknown> = {
      quietSecs,
      ctxTokens: tail.ctxTokens,
      recapDetected: tail.recapDetected,
      handoffDetected: tail.handoffDetected,
      midTurn: tail.midTurn,
      ending: tail.ending,
      lastHumanText: tail.lastHumanText,
      lastHumanAt: tail.lastHumanAt,
      account: iref ? (deps.usage()[iref]?.account ?? null) : null,
      accountWeeklyPct: iref ? (deps.usage()[iref]?.weekAll?.pct ?? null) : null,
    }
    if (tail.unreadable) {
      items.push({
        ...base,
        key: `unreadable:${sess.sessionId}`,
        kind: 'errored',
        summary: `live session ${sess.name}: no parseable record in the transcript tail`,
        detail,
      })
    } else if (
      sess.startedAt > 0 &&
      tail.lastEventAt !== null &&
      Date.parse(tail.lastEventAt) < sess.startedAt &&
      // A chat that WORKED recently is not deaf-stalled, it is between turns — every
      // queue-revive re-imports the chat as a fresh passive child, so without this gate the
      // just-revived chat would be re-flagged 150s later and re-revived hourly forever. The
      // 30-minute quiet floor turns the cycle into "revive again only once it has genuinely
      // sat", which for a chat with pending work is a sane work cadence, and the reviewer
      // retires finished ones (done-mark) so the cycle converges.
      started - Date.parse(tail.lastEventAt) >= 30 * 60_000
    ) {
      // LIVE BUT DEAF: the process exists yet not one record has landed since it spawned — an
      // import/migrate delivery child whose engine never started (measured: peer messages
      // queue into it forever and are never processed). Masquerading as ordinary idle is what
      // let a migrated chat sit six hours as "idle 6m" while every reviewer nudge vanished
      // into the void (owner-reported, 2026-08-25). Classified as orphaned so the revive
      // machinery owns it; the reviewer must NOT SendMessage it.
      items.push({
        ...base,
        key: `orphan:${sess.sessionId}`,
        kind: 'orphaned',
        summary: `${sess.name} is LIVE BUT DEAF — no turn has run since its process spawned (an import child awaiting activation); revive machinery's jurisdiction, never nudge`,
        detail: {
          ...detail,
          deaf: true,
          awaitingActivation: true,
          processStartedAt: new Date(sess.startedAt).toISOString(),
        },
      })
    } else if (tail.ending === 'interrupted') {
      items.push({
        ...base,
        key: `intr:${sess.sessionId}`,
        kind: 'interrupted',
        summary: `${sess.name} was interrupted by the user ${fmtQuiet(quietSecs)} ago`,
        detail,
      })
    } else if (tail.ending === 'usage-limit') {
      items.push({
        ...base,
        key: `limit:${sess.sessionId}`,
        kind: 'limit_stopped',
        summary: `${sess.name} stopped at a usage limit ${fmtQuiet(quietSecs)} ago (auto-resume monitor's jurisdiction)`,
        detail,
      })
    } else if (tail.ending === 'error' || tail.ending === 'refused' || tail.ending === 'overload') {
      items.push({
        ...base,
        key: `err:${sess.sessionId}`,
        kind: 'errored',
        summary: `${sess.name} ended on ${tail.ending} ${fmtQuiet(quietSecs)} ago`,
        detail,
      })
    } else {
      const handoffDue = typeof tail.ctxTokens === 'number' && tail.ctxTokens >= s.ctxHandoffTokens
      // "Waiting on a background task" only excuses a session while the task shows signs of
      // life. Transcript AND task outputs both silent past the threshold means the tasks are
      // dead (or their completion never woke the session) — flagged so the reviewer intervenes
      // instead of waiting forever (measured: sessions sat "waiting" 9-12h on silent tasks).
      const taskMtime = deps.taskActivity(sess.cwd, sess.sessionId)
      const taskAgeSec = taskMtime === null ? null : Math.round((started - taskMtime) / 1000)
      const staleSecs = s.staleTaskMins * 60
      const staleTasks =
        tail.midTurn && quietSecs >= staleSecs && (taskAgeSec === null || taskAgeSec >= staleSecs)
      detail.taskNewestAgeSec = taskAgeSec
      detail.staleTasks = staleTasks
      // FROZEN AT AN APPROVAL PROMPT, the same evidence read correctly. A chat stuck mid-tool
      // used to be reported as "waiting on dead background tasks", which is the wrong diagnosis
      // and the wrong fix. Measured 2026-08-26: five revived chats each ran one Bash call and
      // froze for good at a permission prompt the remote owner could never click - alive,
      // ~300MB, no CPU, nothing in any log. It is indistinguishable from thinking unless you
      // ask the one question that separates them: does this chat's permission mode prompt for
      // the tool it is sitting on? The app creates imported chats as 'acceptEdits', which
      // auto-approves edits and prompts on every shell command, so a dangling Bash there is an
      // approval stall; under 'bypassPermissions' the same dangling Bash is simply a long build.
      const perm = metaMap.get(sess.sessionId)?.permissionMode ?? null
      const promptsForPendingTool =
        perm !== null && perm !== 'bypassPermissions' && SHELL_TOOLS.has(tail.pendingTool ?? '')
      const approvalStall = staleTasks && promptsForPendingTool
      detail.permissionMode = perm
      detail.pendingTool = tail.pendingTool
      detail.approvalStall = approvalStall
      items.push({
        ...base,
        key: `idle:${sess.sessionId}`,
        kind: handoffDue ? 'handoff_due' : 'idle_pending',
        summary: `${sess.name} idle ${fmtQuiet(quietSecs)}${
          tail.recapDetected ? ' with a recap' : ''
        }${
          approvalStall
            ? ` — FROZEN AT A PERMISSION PROMPT: sitting on ${tail.pendingTool} for ${fmtQuiet(
                quietSecs,
              )} while running in '${perm}' mode, which asks approval for that tool and nobody can click it. Not dead tasks; it needs reviving without shell commands (or the owner's chat set to bypass)`
            : staleTasks
              ? ` — WAITING ON DEAD BACKGROUND TASKS (task output silent ${
                  taskAgeSec === null ? fmtQuiet(quietSecs) : fmtQuiet(taskAgeSec)
                }); intervene`
              : tail.midTurn
                ? ' (tail ends mid-tool: likely a background task)'
                : ''
        }${
          handoffDue ? ` at ${Math.round((tail.ctxTokens ?? 0) / 1000)}k context — hand off` : ''
        }`,
        detail,
      })
    }
    for (const chip of tail.chips) {
      items.push({
        ...base,
        tailSnippet: undefined,
        key: `chip:${sess.sessionId}:${chip.id}`,
        kind: 'chip',
        summary: `${sess.name} offered a task chip: ${chip.title || '(untitled)'}`,
        detail: { title: chip.title, prompt: chip.prompt },
      })
    }
  }

  // -- orphaned sessions: died mid-process (computer restart, crash, kill) -----
  // A graceful CLI exit deletes its own ~/.claude/sessions/<pid>.json; a registry file whose
  // pid is dead means the session was killed with its thread unfinished — the owner's restart
  // scenario (2026-08-25). Mid-process death is a RESUMABLE scenario, so each one gets an
  // attention item; superseded/finished residue is cleaned instead, so a revived chat's stale
  // file never shadows its live successor (self-healing once the owner clicks the chat back
  // to life or a resume lands).
  const liveIds = new Set(sessions.map((x) => x.sessionId))
  const newestOrphan = new Map<string, OrphanSession>()
  for (const o of deps.orphans(deps.claudeHome())) {
    const prevO = newestOrphan.get(o.sessionId)
    if (!prevO) {
      newestOrphan.set(o.sessionId, o)
    } else if (o.startedAt >= prevO.startedAt) {
      // Two crashes can leave two files for one session — keep the newest, clean the older.
      cleanOrphanFiles(prevO)
      newestOrphan.set(o.sessionId, o)
    } else {
      cleanOrphanFiles(o)
    }
  }
  for (const orphan of newestOrphan.values()) {
    if (liveIds.has(orphan.sessionId)) {
      cleanOrphanFiles(orphan) // superseded: the session lives again under a new pid
      continue
    }
    if (doneSet.has(orphan.sessionId) || metaMap.get(orphan.sessionId)?.archived) {
      cleanOrphanFiles(orphan) // finished or owner-closed: residue, not resumable work
      continue
    }
    if (holdSet.has(orphan.sessionId)) continue // parked stays parked, even dead
    if (!orphan.transcriptPath) continue
    const mtime = deps.mtimeMs(orphan.transcriptPath)
    if (mtime === null) continue
    const quietSecs = Math.max(0, Math.round((started - mtime) / 1000))
    if (quietSecs < s.idleQuietSecs) continue // could still be relaunching — let it settle
    let tail: TailInfo
    try {
      tail = deps.tailInfo(orphan.transcriptPath)
    } catch {
      continue
    }
    const iref = deps.instanceRef(orphan.sessionId)
    items.push({
      key: `orphan:${orphan.sessionId}`,
      kind: 'orphaned',
      sessionId: orphan.sessionId,
      peerName: orphan.name,
      cwd: orphan.cwd,
      instanceRef: iref ?? undefined,
      tailSnippet: tail.lastAssistantText ?? undefined,
      summary: `${orphan.name} died mid-process ${fmtQuiet(quietSecs)} ago (computer restart, crash, or kill — its process is gone)${
        tail.midTurn ? ', mid-turn' : ''
      } — resumable per the surface preference`,
      detail: {
        quietSecs,
        pid: orphan.pid,
        midTurn: tail.midTurn,
        ending: tail.ending,
        ctxTokens: tail.ctxTokens,
        recapDetected: tail.recapDetected,
        handoffDetected: tail.handoffDetected,
        lastHumanText: tail.lastHumanText,
        lastHumanAt: tail.lastHumanAt,
      },
      firstSeenAt: nowIso,
      seenCount: 1,
    })
  }

  // -- stranded desktop chats: killed GRACEFULLY mid-work, so no residue -------
  // A PC restart shuts sessions down cleanly, and a clean exit deletes its own registry file —
  // the orphan pass above then has nothing to read, while the chat still sits un-archived in a
  // desktop sidebar with a transcript that ends mid-turn. Found live 2026-08-25: the owner's
  // "CLICK TO RESUME" architect chat sat pending through a restart precisely this way. Scan
  // recent transcripts (48h window; the store scan is ~60ms) and surface any non-live,
  // non-done, non-held, non-archived DESKTOP chat whose tail is mid-work as the same
  // 'orphaned' scenario. midTurn-only keeps precision: a finished chat idling in a sidebar is
  // the sidebar's normal state, not a stranding.
  const orphanFlagged = new Set(
    items.filter((i) => i.kind === 'orphaned').map((i) => i.sessionId as string),
  )
  for (const t of deps.recentTranscripts(deps.claudeHome(), started)) {
    if (liveIds.has(t.sessionId) || orphanFlagged.has(t.sessionId)) continue
    if (doneSet.has(t.sessionId) || holdSet.has(t.sessionId)) continue
    const meta = metaMap.get(t.sessionId)
    if (!meta || meta.archived) continue // only chats that live in a desktop sidebar
    if (deps.dispatchActive(t.sessionId)) continue // an in-flight headless run is not stranded
    const quietSecs = Math.max(0, Math.round((started - t.mtimeMs) / 1000))
    if (quietSecs < s.idleQuietSecs) continue
    let tail: TailInfo
    try {
      tail = deps.tailInfo(t.path)
    } catch {
      continue
    }
    if (!tail.midTurn) continue
    const title = scannerTitleFor(t.sessionId)
    items.push({
      key: `orphan:${t.sessionId}`,
      kind: 'orphaned',
      sessionId: t.sessionId,
      instanceRef: deps.instanceRef(t.sessionId) ?? undefined,
      tailSnippet: tail.lastAssistantText ?? undefined,
      summary: `${title ?? t.sessionId.slice(0, 8)} is STRANDED mid-work ${fmtQuiet(quietSecs)} ago — no process (graceful shutdown/restart left no residue), still open in the ${meta.instance} app's sidebar; revive per the surface preference`,
      detail: {
        quietSecs,
        stranded: true,
        instance: meta.instance,
        midTurn: tail.midTurn,
        ending: tail.ending,
        ctxTokens: tail.ctxTokens,
        lastHumanText: tail.lastHumanText,
        lastHumanAt: tail.lastHumanAt,
      },
      firstSeenAt: nowIso,
      seenCount: 1,
    })
  }

  // -- Codex threads (the other half of a unified manager) --------------------
  // Observe-only by construction: Codex exposes no live-process registry and no message
  // channel, so these items tell the owner what is waiting without pretending the reviewer can
  // drive it. Every one carries source:'codex' and deliverable:false for exactly that reason -
  // a reviewer that nudged one would be talking into a void, the same failure the deaf-chat
  // rail exists to stop.
  if (s.watchCodex) {
    try {
      for (const t of deps.codexThreads(started)) {
        if (doneSet.has(t.sessionId) || holdSet.has(t.sessionId)) continue
        const quietSecs = Math.max(0, Math.round((started - t.mtimeMs) / 1000))
        if (quietSecs < s.idleQuietSecs) continue
        const tail = deps.codexTail(t.path)
        if (tail.unreadable) continue
        if (t.cwd) {
          const list = byCwd.get(t.cwd) ?? []
          byCwd.set(t.cwd, list) // its repo still counts for git hygiene, even unmessageable
        }
        const kind: AttentionItem['kind'] =
          tail.ending === 'interrupted' ? 'interrupted' : 'idle_pending'
        items.push({
          key: `codex:${t.sessionId}`,
          kind,
          sessionId: t.sessionId,
          cwd: t.cwd ?? undefined,
          tailSnippet: tail.lastAgentText ?? undefined,
          summary: `[codex] ${t.sessionId.slice(0, 8)} ${
            tail.ending === 'interrupted'
              ? 'was interrupted'
              : tail.ending === 'mid-turn'
                ? 'stopped mid-turn'
                : 'finished'
          } ${fmtQuiet(quietSecs)} ago${tail.recapDetected ? ' with a recap' : ''} - Codex cannot be messaged, so this is for the owner to pick up`,
          detail: {
            source: 'codex',
            deliverable: false,
            quietSecs,
            ending: tail.ending,
            recapDetected: tail.recapDetected,
            rolloutPath: t.path,
          },
          firstSeenAt: nowIso,
          seenCount: 1,
        })
      }
    } catch (err) {
      console.error('[agenthydra] codex scan failed:', err)
    }
  }

  // -- git hygiene, one look per distinct cwd ---------------------------------
  for (const [cwd, sess] of byCwd) {
    let g: GitInfo | null = null
    try {
      g = await deps.git(cwd)
    } catch {
      g = null
    }
    if (!g?.isRepo) {
      kvDelete(`dirtySince:${cwd}`)
      continue
    }
    if (g.detached || (g.branch && g.branch !== 'main' && g.branch !== 'master')) {
      items.push({
        key: `branch:${cwd}`,
        kind: 'branch_off_main',
        cwd,
        summary: `${cwd} is on ${g.detached ? 'a detached HEAD' : `branch '${g.branch}'`} — standing rule is main only`,
        detail: { branch: g.branch, detached: g.detached },
        firstSeenAt: nowIso,
        seenCount: 1,
      })
    }
    if (g.dirtyCount > 0) {
      const k = `dirtySince:${cwd}`
      let since = Number(kvGet(k))
      if (!Number.isFinite(since) || since <= 0) {
        since = started
        kvSet(k, String(started))
      }
      const dirtyMins = Math.round((started - since) / 60_000)
      const allIdle = sess.every((x) => x.quietSecs >= s.idleQuietSecs)
      if (dirtyMins >= s.dirtyMins && allIdle) {
        items.push({
          key: `dirty:${cwd}`,
          kind: 'repo_dirty',
          cwd,
          // Address the nudge to the longest-idle UNHELD session in that cwd — it knows its own
          // diff, and a held thread must not receive prompts even for hygiene.
          peerName: sess.filter((x) => !x.held).sort((a, b) => b.quietSecs - a.quietSecs)[0]
            ?.session.name,
          summary: `${cwd}: ${g.dirtyCount} dirty file(s) for ${dirtyMins}m with all its sessions idle`,
          detail: {
            dirtyCount: g.dirtyCount,
            dirtyMins,
            sample: g.dirtySample,
            branch: g.branch,
            aheadCount: g.aheadCount,
          },
          firstSeenAt: nowIso,
          seenCount: 1,
        })
      }
    } else {
      kvDelete(`dirtySince:${cwd}`)
    }
  }

  // -- usage ------------------------------------------------------------------
  const cache = deps.usage()
  let newestCapture = 0
  for (const snap of Object.values(cache)) {
    const t = Date.parse(snap.capturedAt ?? '')
    if (!Number.isNaN(t) && t > newestCapture) newestCapture = t
  }
  state.usageAgeSecs = newestCapture ? Math.round((started - newestCapture) / 1000) : null
  let prev: Record<string, UsagePrev> = {}
  try {
    prev = JSON.parse(kvGet('usagePrev') ?? '{}')
  } catch {
    prev = {}
  }
  const usage = computeUsageItems(cache, prev, s, started, nowIso)
  kvSet('usagePrev', JSON.stringify(usage.next))
  items.push(...usage.items)

  // -- the desktop fleet as a routing table -----------------------------------
  try {
    state.instances = buildInstanceRows(await deps.desktopInstances(), cache, s, started)
  } catch (err) {
    console.error('[agenthydra] orchestrator instance listing failed:', err)
    state.instances = []
  }

  // -- the concurrency cap (round-robin rotation) -----------------------------
  // maxActiveChats caps how many chats may WORK at once, fleet-wide (0 = unlimited, the
  // default). Busy chats hold the slots; free slots are offered to idle chats LONGEST-IDLE
  // FIRST, and that ordering IS the round-robin: a nudged chat goes busy, and when it next
  // idles it re-enters at the back of the line (freshest mtime), so every waiting chat cycles
  // through fairly with no extra bookkeeping. The overflow is marked waiting-for-slot; the
  // reviewer skips those WITHOUT acking, so they resurface the moment a slot frees. Handoffs,
  // answers, and orphan revives are never gated here — only resume nudges are, since those are
  // what actually multiply concurrent work.
  state.runningChats = runningChats
  state.slotsFree = s.maxActiveChats > 0 ? Math.max(0, s.maxActiveChats - runningChats) : null
  if (s.maxActiveChats > 0) {
    const resumable = items
      .filter((i) => i.kind === 'idle_pending')
      .sort(
        (a, b) =>
          (((b.detail?.quietSecs as number) ?? 0) as number) -
          (((a.detail?.quietSecs as number) ?? 0) as number),
      )
    for (const [idx, item] of resumable.entries()) {
      if (idx < (state.slotsFree ?? 0)) continue
      item.detail = { ...item.detail, waitingForSlot: true }
      item.summary += ` — WAITING FOR A SLOT (${runningChats}/${s.maxActiveChats} running); do not nudge`
    }
  }

  // Every orphaned item is an ACTION WANTED (a revive). Captured BEFORE ack suppression — an
  // ack shapes the reviewer's reading list, never the action ledger (found live 2026-08-25:
  // an acked orphan blindfolded the old reviver for exactly the chat that most needed it) —
  // and written as a PROPOSAL, never acted on here (owner law 2026-08-26: the AI checks every
  // action first; the reviewer decides these and executes the approved ones itself).
  maintainProposals(started)
  for (const item of items) {
    if (item.kind !== 'orphaned' || !item.sessionId) continue
    const quiet = typeof item.detail?.quietSecs === 'number' ? item.detail.quietSecs : 0
    proposeAction({
      kind: 'revive',
      sessionId: item.sessionId,
      instanceRef: item.instanceRef ?? null,
      title: scannerTitleFor(item.sessionId),
      summary: item.summary,
      evidence: {
        flavor: item.detail?.deaf ? 'deaf' : item.detail?.stranded ? 'stranded' : 'crash',
        ...item.detail,
        // Carried for EVERY flavor, not just the idle-derived ones: the reviewer needs it to
        // pick a revive that can actually run. Anything other than 'bypassPermissions' prompts
        // for shell commands, and a revive prompt that sends such a chat straight at `git` or
        // `cargo` just re-freezes it at an approval nobody can click.
        permissionMode: metaMap.get(item.sessionId)?.permissionMode ?? null,
        cwd: item.cwd ?? null,
        peerName: item.peerName ?? null,
        tailSnippet: item.tailSnippet?.slice(0, 600) ?? null,
      },
      evidenceAt: new Date(started - quiet * 1000).toISOString(),
    })
  }

  // -- ack suppression --------------------------------------------------------
  const acks = activeAcks(started)
  const visible = items.filter((i) => {
    const ack = acks.get(i.key)
    if (!ack) return true
    // A session item whose transcript moved after the ack is a NEW situation — re-arm it.
    if (i.sessionId) {
      const sess = sessions.find((x) => x.sessionId === i.sessionId)
      const mtime = sess?.transcriptPath ? deps.mtimeMs(sess.transcriptPath) : null
      if (mtime !== null && mtime > Date.parse(ack.acked_at)) return true
    }
    return false
  })

  state.attention = withContinuity(visible)
  state.lastTickAt = nowIso
  state.lastTickMs = deps.nowMs() - started

  // -- the title janitor (every ~10 min) --------------------------------------
  // Plumbing-created desktop chats (imports, migrations) land "Untitled" or with a generic AI
  // name; the owner's requirement is standing name management, not one-time fixes. The scanner
  // already derives real titles for every transcript — hand them to any desktop entry that has
  // none. Only in the real pass (default deps), never in tests driving injected deps.
  if (deps === defaultDeps && started - lastTitleSweepMs > 10 * 60_000) {
    lastTitleSweepMs = started
    try {
      const titled = sweepUntitledDesktopChats(scannerTitleFor)
      if (titled.fixed > 0) {
        console.log(`[agenthydra] title janitor named ${titled.fixed} desktop chat(s)`)
        // New names must APPEAR, not wait for some future restart (owner rule) — same
        // sidebar-visibility restart the archive flow uses.
        for (const p of titled.profiles) noteArchiveVisibilityPending(p)
      }
    } catch (err) {
      console.error('[agenthydra] title janitor failed:', err)
    }
    try {
      const asks = await proposeArchivesForDoneSessions()
      if (asks > 0)
        console.log(`[agenthydra] archive janitor proposed retiring ${asks} finished chat(s)`)
    } catch (err) {
      console.error('[agenthydra] archive janitor failed:', err)
    }
    try {
      const asks = await proposeInvisibleChats()
      if (asks > 0)
        console.log(`[agenthydra] visibility sweep proposed importing ${asks} invisible chat(s)`)
    } catch (err) {
      console.error('[agenthydra] visibility sweep failed:', err)
    }
    try {
      await restartAppsForArchiveVisibility()
    } catch (err) {
      console.error('[agenthydra] archive-visibility restart failed:', err)
    }
  }
}

// The headless auto-revive driver that used to live here (v0.35: a one-turn `--resume`
// through the queue, imported back into the app) is deliberately GONE, not disabled. It
// continued desktop threads headlessly, which the owner banned outright (2026-08-26: desktop
// stays desktop; nothing about his threads ever runs headless), and it acted with no AI
// judgment, which the same day's action-gate law forbids. Revives are now PROPOSALS; the
// reviewer decides them and delivers the revive turn through the desktop app's own native
// message channel (proven 2026-08-26: the app boots a dormant chat's engine and runs the turn
// visibly, zero clicks, zero headless processes — see docs/orchestrate-command.md).

/** Strip the queue's nesting prefixes off a title ("Migrated resume: Auto-resume: X" -> "X").
 *  'Revive' is in the list because the retired auto-revive era stamped it, and one of those
 *  titles re-imported UNpeeled is exactly how a chat wore "Revive: ..." in the owner's sidebar
 *  (found live 2026-08-26 on the architect chat). */
function peelQueueTitle(title: string): string {
  let t = title
  for (;;) {
    const m = t.match(/^(Auto-resume|Migrated resume|Migrate|Handoff|Revive):\s*/i)
    if (!m) return t.trim()
    t = t.slice(m[0].length)
  }
}

/**
 * The visibility sweep (owner rule: NO chat is ever allowed to be invisible). Any chat WE
 * started — a completed queue run from the last 48h — whose session has no desktop entry
 * anywhere is PROPOSED for import into its owning instance's app (action-gate law: the
 * reviewer approves, then calls the import endpoint itself). Running instances only (never
 * boot an account); done-marked lineages stay retired.
 */
export async function proposeInvisibleChats(): Promise<number> {
  const since = Date.now() - 48 * 3600 * 1000
  const rows = db
    .query<
      { session_id: string; instance_ref: string | null; title: string; cwd: string | null },
      [number]
    >(
      "select session_id, instance_ref, title, cwd from queue_items where status = 'completed' and created_at > ? order by created_at desc",
    )
    .all(since)
    // Scratchpad/temp runs are working files, not owner-facing threads — importing one puts a
    // meaningless chat in a sidebar and then auto-revive dutifully wakes it (happened live on
    // the first night). Skip them.
    .filter((r) => !/[\\/](temp|tmp)[\\/]/i.test(r.cwd ?? ''))
  let metaMap: Map<string, { instance: string; archived: boolean }>
  try {
    metaMap = sessionMetaMap()
  } catch {
    return 0
  }
  const doneSet = new Set(
    db
      .query<{ session_id: string }, []>('select session_id from session_marks where done = 1')
      .all()
      .map((r) => r.session_id),
  )
  const seenSessions = new Set<string>()
  let proposed = 0
  const { findDesktopEntryFile, liveSessionEntry } = await import('./session-launch')
  for (const r of rows) {
    if (!r.session_id || seenSessions.has(r.session_id)) continue
    seenSessions.add(r.session_id)
    if (metaMap.has(r.session_id) || doneSet.has(r.session_id)) continue
    // A live session is already somewhere the owner can see (or deliberately opened); and the
    // FILE-level check is the roll-proof one — a continued chat rolls onto a new cliSessionId,
    // making cliSessionId-keyed maps report the original id as invisible forever.
    if (liveSessionEntry(r.session_id)) continue
    if (await findDesktopEntryFile(r.session_id)) continue
    const ref = r.instance_ref ?? instanceRefForSession(r.session_id)
    if (!ref?.startsWith('desktop:')) continue
    const title = peelQueueTitle(r.title ?? '') || null
    const id = proposeAction({
      kind: 'import',
      sessionId: r.session_id,
      instanceRef: ref,
      title,
      summary: `finished session "${title ?? r.session_id.slice(0, 8)}" is visible in no desktop sidebar — import it into ${ref}`,
      evidence: { cwd: r.cwd ?? null, queueTitle: r.title ?? null },
    })
    if (id) proposed++
  }
  return proposed
}

/**
 * The archive janitor: any session the flow marked done (session_marks — handed off, migrated
 * onward, closed out) whose desktop entries are still visible is PROPOSED for archiving
 * (action-gate law: even though the done-mark was itself an AI's call, the owner's ruling is
 * "checked before an archive", so the reviewer confirms and executes — natively in its own
 * instance, or via the desktop-archive endpoint elsewhere). Keyed on the done-mark and
 * nothing else: prose-reading guesses, and archiving wrongly hides live work.
 */
export async function proposeArchivesForDoneSessions(roots?: string[]): Promise<number> {
  const rows = db
    .query<{ session_id: string; updated_at: number }, []>(
      'select session_id, updated_at from session_marks where done = 1',
    )
    .all()
  let proposed = 0
  for (const r of rows) {
    try {
      const state = desktopChatArchiveState(r.session_id, roots)
      if (!state.found || state.archived) continue
      const id = proposeAction({
        kind: 'archive',
        sessionId: r.session_id,
        title: scannerTitleFor(r.session_id),
        summary: `done-marked chat ${scannerTitleFor(r.session_id) ?? r.session_id.slice(0, 8)} still sits un-archived in a desktop sidebar — retire its entries`,
        evidence: { doneMarkedAt: new Date(r.updated_at).toISOString() },
        evidenceAt: new Date(r.updated_at).toISOString(),
      })
      if (id) proposed++
    } catch {
      // one broken store must not stop the sweep
    }
  }
  return proposed
}

/**
 * "Archive immediately, not at some future restart" (owner ask, 2026-08-25). A RUNNING app
 * repaints its sidebar only at startup, so an archive flag written from outside stays
 * invisible until that app restarts. This records which instances carry invisible flags, and
 * the janitor restarts each one — ONLY while it has zero live sessions (nothing to
 * interrupt; the default non-isolated profile is refused by quitInstance itself), at most
 * once an hour per instance. The restart is exactly the "later" the flag was waiting for,
 * brought forward to now.
 */
export function noteArchiveVisibilityPending(profileDir: string): void {
  kvSet(`archPending:${profileDir.toLowerCase()}`, new Date().toISOString())
}

/** Case/slash-insensitive path identity — the comparison bug that killed a live chat (below).
 *  Exported for the regression test that pins the exact incident shape. */
export function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

async function restartAppsForArchiveVisibility(): Promise<void> {
  const pending = db
    .query<{ key: string }, []>("select key from orchestrator_kv where key like 'archPending:%'")
    .all()
  if (pending.length === 0) return
  const live = readLiveRegistry(join(homedir(), '.claude'))
  // GUARD HISTORY (2026-08-26, the self-kill): the old ownership test compared
  // instanceRefForSession's real-cased ref against the marker's LOWERCASED dir with `===`,
  // which matched NOTHING — so "zero live sessions" was always true and the restart quit the
  // work app under a LIVE chat mid-turn (the owner had to hand-resume it). Three layers now,
  // each sufficient to stop that class alone:
  //   1. every path comparison is case/slash-insensitive (samePath);
  //   2. any live session the metadata CANNOT map might be hosted by any app — restart
  //      nothing while one exists (those are the "unknown account" rows, already flagged in
  //      the feed);
  //   3. direct process evidence outranks metadata: a live session whose process ANCESTRY
  //      carries this instance's --user-data-dir is hosted by this app, mapped or not, and
  //      an ancestry read that fails proves nothing and therefore blocks the restart.
  const unmapped = live.filter((s) => instanceRefForSession(s.sessionId) === null)
  if (unmapped.length > 0) {
    console.log(
      `[agenthydra] archive-visibility restart deferred: ${unmapped.length} live session(s) with no mapped instance — cannot prove any app is empty`,
    )
    return
  }
  for (const row of pending) {
    const dir = row.key.slice('archPending:'.length)
    const cooldownKey = `archRestart:${desktopKey(dir)}`
    const last = kvGet(cooldownKey)
    if (last && Date.now() - Date.parse(last) < 3600_000) continue
    const owned = live.filter((s) => {
      const r = instanceRefForSession(s.sessionId)
      return r !== null && samePath(r.slice('desktop:'.length), dir)
    })
    if (owned.length > 0) continue // someone is working in there — the flag waits
    // Layer 3: ask the processes themselves. Any live pid whose ancestor chain carries this
    // instance's --user-data-dir is hosted here regardless of what the metadata said.
    let hostedHere = false
    for (const s of live) {
      const { extractUserDataDir, processAncestry } = await import('./core/process')
      const chain = await processAncestry(s.pid)
      if (chain === null) {
        hostedHere = true // could not enumerate — refuse rather than guess
        break
      }
      if (
        chain.some((a) => {
          const udd = a.commandLine ? extractUserDataDir(a.commandLine) : null
          return udd !== null && samePath(udd, dir)
        })
      ) {
        hostedHere = true
        break
      }
    }
    if (hostedHere) continue
    try {
      const { openInstance, quitInstance } = await import('./core/instances')
      const q = await quitInstance(dir)
      if (!q.ok) {
        console.log(`[agenthydra] archive-visibility restart refused for ${dir}: ${q.message}`)
        kvDelete(row.key) // a structural refusal (e.g. the default profile) refuses forever
        continue
      }
      await new Promise((r) => setTimeout(r, 2500))
      const o = await openInstance(dir)
      kvSet(cooldownKey, new Date().toISOString())
      kvDelete(row.key)
      console.log(
        `[agenthydra] archive-visibility restart: ${dir} (quit ok, reopen ${o.ok ? 'ok' : `failed: ${o.message}`}) — archived chats now show`,
      )
    } catch (err) {
      console.error('[agenthydra] archive-visibility restart failed:', err)
    }
  }
}

let lastTitleSweepMs = 0

/** The scanner's best title for a transcript (session_scan_cache), or null. */
function scannerTitleFor(cliSessionId: string): string | null {
  const row = db
    .query<{ title: string }, [string]>(
      "select title from session_scan_cache where cache_key like 'claude:' || ? || ':%' order by mtime_ms desc limit 1",
    )
    .get(cliSessionId)
  return row?.title ?? null
}

function fmtQuiet(secs: number): string {
  if (secs < 90) return `${secs}s`
  if (secs < 90 * 60) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

export function orchestratorView(): OrchestratorView {
  const proposals = listProposalsForView(Date.now())
  return {
    settings: getOrchestratorSettings(),
    prompts: getOrchestratorPrompts(),
    promptDefaults: ORCHESTRATOR_PROMPT_DEFAULTS,
    proposals,
    attention: state.attention,
    instances: state.instances,
    holds: listSessionHolds().map((h) => ({
      ...h,
      peerName: lastNames.get(h.sessionId)?.name,
      cwd: lastNames.get(h.sessionId)?.cwd,
    })),
    meta: {
      lastTickAt: state.lastTickAt,
      lastTickMs: state.lastTickMs,
      liveSessions: state.liveSessions,
      usageAgeSecs: state.usageAgeSecs,
      runningChats: state.runningChats,
      slotsFree: state.slotsFree,
      proposalsPending: proposals.filter((p) => p.status === 'proposed' || p.status === 'approved')
        .length,
    },
  }
}

// --- the loop ---------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false
let lastRunMs = 0

async function tick(): Promise<void> {
  const s = getOrchestratorSettings()
  if (!s.enabled) return
  const now = Date.now()
  if (now - lastRunMs < s.tickSecs * 1000) return
  if (ticking) return
  ticking = true
  lastRunMs = now
  try {
    await runOrchestratorOnce()
  } catch (err) {
    console.error('[agenthydra] orchestrator tick error:', err)
  } finally {
    ticking = false
  }
}

export function startOrchestrator(): void {
  if (timer) return
  // A fast heartbeat with a due-check inside, so tickSecs edits apply without a daemon restart.
  timer = setInterval(() => void tick(), 15_000)
}

export function stopOrchestrator(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// --- shipping the /orchestrate command --------------------------------------
// The reviewer half is a Claude command file, and a feature the user has to go find a file for
// is not shipped. The daemon carries the command's text (see the top-of-file text import) and
// writes it into ~/.claude/commands itself: on first enable when it is absent, or on the
// explicit install endpoint. A copy the user has edited is never overwritten without force —
// their edits are the newer intent, not drift to correct.

export type CommandInstallOutcome = 'installed' | 'up-to-date' | 'differs' | 'updated'

/** Pure decision: what should happen given what is on disk. Exported for tests. */
export function commandInstallOutcome(
  existing: string | null,
  shipped: string,
  force: boolean,
): CommandInstallOutcome {
  if (existing === null) return 'installed'
  if (existing === shipped) return 'up-to-date'
  return force ? 'updated' : 'differs'
}

/** Everything the orchestrator ships as a user-typeable command: the reviewer loop plus the
 *  per-thread park/unpark pair (/delayo marks a thread "not now", /resumeo lifts it). */
const SHIPPED_COMMANDS: Array<{ file: string; text: string }> = [
  { file: 'orchestrate.md', text: ORCHESTRATE_COMMAND },
  { file: 'delayo.md', text: DELAYO_COMMAND },
  { file: 'resumeo.md', text: RESUMEO_COMMAND },
]

export function installOrchestratorCommands(
  force = false,
  commandsDir: string = join(homedir(), '.claude', 'commands'),
): Array<{ file: string; outcome: CommandInstallOutcome; path: string }> {
  return SHIPPED_COMMANDS.map(({ file, text }) => {
    const path = join(commandsDir, file)
    let existing: string | null = null
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = null
    }
    const outcome = commandInstallOutcome(existing, text, force)
    if (outcome === 'installed' || outcome === 'updated') {
      mkdirSync(commandsDir, { recursive: true })
      writeFileSync(path, text)
    }
    return { file, outcome, path }
  })
}

/** The opt-out mirror of installOrchestratorCommands: remove the shipped /orchestrate, /delayo
 *  and /resumeo files from the user's commands directory. Removes edited copies too — "remove
 *  the orchestrator and its commands" means gone, and the shipped texts are always one
 *  reinstall away. A file that is not there reports 'missing' rather than erroring. */
export function uninstallOrchestratorCommands(
  commandsDir: string = join(homedir(), '.claude', 'commands'),
): Array<{ file: string; outcome: 'removed' | 'missing'; path: string }> {
  return SHIPPED_COMMANDS.map(({ file }) => {
    const path = join(commandsDir, file)
    if (!existsSync(path)) return { file, outcome: 'missing' as const, path }
    rmSync(path, { force: true })
    return { file, outcome: 'removed' as const, path }
  })
}
