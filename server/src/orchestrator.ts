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

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
// Text imports: bundled into compiled builds, so a packaged AgentHydra can still install the
// commands on a machine that has no checkout and no docs/ directory.
import ORCHESTRATE_COMMAND from '../../docs/orchestrate-command.md' with { type: 'text' }
import ORCSTART_COMMAND from '../../docs/orcstart-command.md' with { type: 'text' }
import ORCSTOP_COMMAND from '../../docs/orcstop-command.md' with { type: 'text' }
import {
  type CodexTail,
  type CodexThread,
  listRecentCodexThreads,
  readCodexTail,
} from './codex-orchestration'
import { listInstances } from './core/instances'
import { db, getSetting, setSetting } from './db'
import { isSessionActive } from './dispatch'
import { findDesktopChat, instanceRefForSession, sessionMetaMap } from './instance-sessions'
import { NEW_CHAT_ULTRACODE_KEY, newChatUltracodeEnabled } from './new-chat-opening'
import {
  type ChipInTail,
  isInjectedUserText,
  parseTranscriptTail,
  readTailInfo,
  type TailInfo,
} from './orchestrator-transcript-tail'
import { listRecentPlacements, normalizeRef, prunePlacements, recentPlacements } from './placements'
import {
  listProposalsForView,
  maintainProposals,
  proposeAction,
  retireProposalsForSessions,
} from './proposals'
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
    newChatUltracode: newChatUltracodeEnabled(),
    migrateOnLimit: getSetting('orch_migrate_on_limit') === '1',
    maxActiveChats: num('orch_max_active_chats', 0, 0, 500),
    watchCodex: getSetting('orch_watch_codex') !== '0',
    loadBalance: getSetting('orch_load_balance') !== '0',
    balanceWindowMins: num('orch_balance_window_mins', 90, 5, 24 * 60),
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
    setSetting(NEW_CHAT_ULTRACODE_KEY, patch.newChatUltracode ? '1' : '0')
  if (typeof patch.migrateOnLimit === 'boolean')
    setSetting('orch_migrate_on_limit', patch.migrateOnLimit ? '1' : '0')
  clamp('orch_max_active_chats', patch.maxActiveChats, 0, 500)
  if (typeof patch.watchCodex === 'boolean')
    setSetting('orch_watch_codex', patch.watchCodex ? '1' : '0')
  if (typeof patch.loadBalance === 'boolean')
    setSetting('orch_load_balance', patch.loadBalance ? '1' : '0')
  clamp('orch_balance_window_mins', patch.balanceWindowMins, 5, 24 * 60)
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

// --- is anyone actually reviewing? ------------------------------------------
// The watcher cannot detect its own uselessness. It keeps ticking, keeps writing proposals,
// and the feed keeps looking healthy, whether or not anything is reading it. This session
// began with the owner discovering 19 proposals queued and nobody deciding them, and it
// happened a second time the same night: a reviewer worked one shift and its window went
// away, after which everything still LOOKED fine for five hours.
//
// Liveness is measured by WORK DONE, not by a process existing. Every ruling, execution
// report and ack stamps this. That needs no cooperation from the reviewer, and it cannot be
// satisfied by a reviewer that booted and then froze at an approval prompt, which is the
// exact failure most worth catching.

const REVIEWER_KV = 'lastReviewerAt'

export function noteReviewerActivity(nowMs: number = Date.now()): void {
  kvSet(REVIEWER_KV, new Date(nowMs).toISOString())
}

/**
 * `waiting` is EVERYTHING the reviewer owes an action on, not just proposals.
 *
 * It used to be the proposal count alone, and that made the whole check blind in the one case it
 * exists for. Measured 2026-08-27: the reviewer had been dead for six hours (its process gone from
 * the live registry, its transcript's last line written at 07:50), a rename had been sitting in the
 * feed's `renames` list that entire time waiting for it, and because no PROPOSAL happened to be
 * open this function reported "nothing is waiting to be decided, so silence here means idle rather
 * than absent". The owner spotted it from the outside and asked the right question: the reviewer
 * should have said something about a live chat by now, so it is probably broken.
 *
 * A rename is work only a reviewer can do (the app overwrites a title written to disk, so the
 * rename has to go through the app itself). Counting it makes an idle reviewer and an absent one
 * distinguishable again, which is the entire point of this function.
 *
 * The "only a backlog makes silence meaningful" rule below is still right and still load-bearing:
 * a check that fires on healthy input stops being read. The bug was never that rule, it was
 * measuring the backlog with too narrow a ruler.
 */
export function reviewerHealth(
  nowMs: number,
  waiting: number,
): { lastSeenAt: string | null; quietMins: number | null; stalled: boolean; why: string } {
  const raw = kvGet(REVIEWER_KV)
  const at = raw ? Date.parse(raw) : Number.NaN
  const quietMins = Number.isNaN(at) ? null : Math.round((nowMs - at) / 60_000)
  const stalled = waiting > 0 && (quietMins === null || quietMins >= 30)
  const why = !waiting
    ? 'nothing is waiting to be acted on, so silence here means idle rather than absent'
    : quietMins === null
      ? `${waiting} item(s) waiting and NO reviewer has ever acted on this machine`
      : stalled
        ? `${waiting} item(s) waiting and no reviewer has acted for ${quietMins}m - start one`
        : `${waiting} item(s) waiting, a reviewer acted ${quietMins}m ago`
  return {
    lastSeenAt: Number.isNaN(at) ? null : new Date(at).toISOString(),
    quietMins,
    stalled,
    why,
  }
}

// --- pending native renames -------------------------------------------------
// A title written to disk is DURABLE for a closed instance and futile for a running one: the
// app holds its chat list in memory and re-saves the file when the chat next boots, so the
// sidebar keeps the old name until that app restarts (measured 2026-08-26: five chats imported
// with correct titles, all five wiped seconds after they were first messaged). Restarting the
// owner's app to fix a NAME is a heavy way to do something the app does instantly on request.
//
// So the janitor now parks those chats here and the reviewer renames them through the app's own
// rename tool, which the app cannot overwrite. The list is persisted rather than recomputed
// because the sweep only reports what it CHANGED: once the title is on disk the next sweep
// correctly skips that chat, so a recomputed list would empty itself within one cycle and the
// reviewer would miss the window. Entries clear when the reviewer reports the rename done, when
// the owning instance is no longer running (a restart made the disk title stick by itself), or
// after a week.

export interface PendingRename {
  ref: string
  sessionId: string
  title: string
  at: string
}

const RENAME_KV = 'pendingRenames'

export function listPendingRenames(): PendingRename[] {
  try {
    const raw = JSON.parse(kvGet(RENAME_KV) ?? '[]')
    return Array.isArray(raw) ? (raw as PendingRename[]) : []
  } catch {
    return []
  }
}

/** Park one chat for a native rename, keeping any entry already there. Used by the seed path,
 *  which knows the title that was ASKED for and should not let the janitor guess a worse one
 *  from a transcript that is barely more than plumbing. */
export function addPendingRename(ref: string, sessionId: string, title: string): void {
  const t = title.trim()
  if (!t) return
  const kept = listPendingRenames().filter((r) => r.sessionId !== sessionId)
  kept.push({ ref, sessionId, title: t, at: new Date().toISOString() })
  kvSet(RENAME_KV, JSON.stringify(kept))
}

/** The reviewer reports a native rename done (or the owner renamed it by hand). */
export function clearPendingRename(sessionId: string): number {
  const before = listPendingRenames()
  const after = before.filter((r) => r.sessionId !== sessionId)
  kvSet(RENAME_KV, JSON.stringify(after))
  return before.length - after.length
}

/** Add this sweep's renames, then drop everything that no longer needs a native rename:
 *  instances that are not running (the disk title will simply be read at their next start,
 *  or already was) and anything older than a week. */
export function reconcilePendingRenames(
  added: Array<{ ref: string; sessionId: string; title: string }>,
  runningRefs: Set<string>,
  nowMs: number,
): PendingRename[] {
  const byId = new Map<string, PendingRename>()
  for (const r of listPendingRenames()) byId.set(r.sessionId, r)
  const nowIso = new Date(nowMs).toISOString()
  for (const a of added) {
    // Keep the ORIGINAL timestamp when a chat is re-swept, so the week-long expiry measures
    // how long the rename has been outstanding rather than resetting on every pass.
    const prev = byId.get(a.sessionId)
    byId.set(a.sessionId, { ...a, at: prev?.at ?? nowIso })
  }
  const kept = [...byId.values()].filter((r) => {
    if (!runningRefs.has(normalizeRef(r.ref) ?? '')) return false
    const age = nowMs - Date.parse(r.at)
    return !Number.isNaN(age) && age < 7 * 24 * 3600 * 1000
  })
  kvSet(RENAME_KV, JSON.stringify(kept))
  return kept
}

// --- holds (/orcstop and /orcstart) -------------------------------------------
// A held thread is one the owner has parked: lower priority right now, too much else running.
// The watcher drops every session-scoped item for it, so the reviewer never sees it to nudge.
// No expiry — a hold stands until /orcstart lifts it (parking for days is a legitimate use).

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
// Moved to ./orchestrator-transcript-tail — this file was already over the oversized-file gate.
// Re-exported here so existing importers of these four names from './orchestrator' keep working.
export { type ChipInTail, isInjectedUserText, parseTranscriptTail, readTailInfo, type TailInfo }

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
/**
 * The usage-alert items (spike / band-escalation) for one cache key, plus the `next` entry to
 * carry forward for it — or `next: null` for every early-exit the original inline `continue`s
 * covered (codex key, no weekly reading, stale capture, already-reset window). Pure — no I/O, no
 * awaits — split out of computeUsageItems' per-key loop where it was inline before.
 */
function usageItemsForKey(
  key: string,
  snap: UsageSnapshot,
  p: UsagePrev | undefined,
  s: OrchestratorSettings,
  nowMs: number,
  nowIso: string,
): { items: AttentionItem[]; next: UsagePrev | null } {
  const none = { items: [] as AttentionItem[], next: null }
  if (key.startsWith('codex:')) return none // Claude quota only; Codex pacing is not this feature
  const wk = snap.weekAll
  if (!wk || typeof wk.pct !== 'number') return none
  // A reading captured before its own weekly reset describes LAST week — alerting on it is a
  // zombie ("100% critical" from a month-old snapshot of an instance nobody runs anymore).
  // Same for a reading nothing has refreshed in a day: absence of data, not data.
  const capturedMs = Date.parse(snap.capturedAt ?? '')
  if (!Number.isNaN(capturedMs) && nowMs - capturedMs > 24 * 3600 * 1000) return none
  if (wk.resetsAt) {
    const resetMs = Date.parse(wk.resetsAt)
    if (!Number.isNaN(resetMs) && resetMs < nowMs) return none
  }
  const band = bandForPct(wk.pct, s)
  const soon = resetsSoon(wk.resetsAt ?? null, nowMs, s)
  const next: UsagePrev = { pct: wk.pct, atMs: nowMs, band }
  const detail: Record<string, unknown> = {
    account: snap.account,
    weeklyPct: wk.pct,
    weeklyResetsAt: wk.resetsAt ?? null,
    sessionPct: snap.session?.pct ?? null,
    band,
    resetsSoon: soon,
    capturedAt: snap.capturedAt,
  }
  const items: AttentionItem[] = []
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
  return { items, next }
}

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
    const r = usageItemsForKey(key, snap, prev[key], s, nowMs, nowIso)
    if (r.next) next[key] = r.next
    items.push(...r.items)
  }
  return { items, next }
}

// --- the desktop fleet as a routing table (pure; exported for tests) ---------

/** "Max 20×" out of "tobix <a@b> · Max 20×". Null when the label has no plan suffix. */
export function planOfAccountLabel(account: string | null | undefined): string | null {
  const m = account?.match(/·\s*([^·]+)$/)
  return m ? m[1].trim() : null
}

// Why (if any) an instance is blocked from placement — checked in priority order. Pulled out
// of buildInstanceRow's ternary chain, see buildInstanceRow below for why.
function instanceBlockedWhy(
  isRunning: boolean,
  stale: boolean,
  band: OrchestratorInstance['band'],
  wk: { pct: number } | null,
  effective: number,
  sessionPct: number | null,
  sessionHighPct: number,
): string | null {
  if (!isRunning) return 'not running'
  if (stale) return 'usage reading is stale (older than a day)'
  if (band === 'critical') return `weekly at ${wk?.pct ?? '?'}% (critical)`
  if (effective >= sessionHighPct) return `5-hour window at ${sessionPct ?? '?'}%`
  return null
}

// One instance's row: usage staleness, band, and why (if any) it is blocked from placement.
// Pulled out of buildInstanceRows's .map() callback — a nested closure's branches roll up into
// the enclosing function no matter what it's named, so this had to become a true module-level
// function to actually leave buildInstanceRows's score.
function buildInstanceRow(
  i: { dir: string; name: string; isRunning: boolean },
  cache: Record<string, UsageSnapshot>,
  s: OrchestratorSettings,
  nowMs: number,
  placements: Record<string, number>,
): OrchestratorInstance {
  const ref = desktopKey(i.dir)
  const snap = cache[ref]
  const capturedMs = Date.parse(snap?.capturedAt ?? '')
  const stale = !snap || Number.isNaN(capturedMs) || nowMs - capturedMs > 24 * 3600 * 1000
  const wk = stale ? null : (snap?.weekAll ?? null)
  const sess = stale ? null : (snap?.session ?? null)
  const sessionPct = sess?.pct ?? null
  const sessionResetsSoon = sess ? resetsSoon(sess.resetsAt ?? null, nowMs, s) : false
  const band: OrchestratorInstance['band'] =
    wk && typeof wk.pct === 'number' ? bandForPct(wk.pct, s) : 'unknown'
  // The figure the ROUTER reasons with. A 5-hour window minutes from its reset is capacity,
  // not load, exactly as a weekly one is: whatever it reads now is about to be wiped. The
  // row still reports the true reading in sessionPct, so the feed never restates a
  // measurement it did not take. Gated on loadBalance so switching balancing off restores
  // the previous ranking exactly.
  const effective = s.loadBalance && sessionResetsSoon ? 0 : (sessionPct ?? 101)
  const blockedWhy = instanceBlockedWhy(
    i.isRunning,
    stale,
    band,
    wk,
    effective,
    sessionPct,
    s.sessionHighPct,
  )
  return {
    ref,
    name: i.name,
    isRunning: i.isRunning,
    account: snap?.account ?? null,
    plan: planOfAccountLabel(snap?.account),
    weeklyPct: wk?.pct ?? null,
    weeklyResetsAt: wk?.resetsAt ?? null,
    sessionPct: stale ? null : sessionPct,
    sessionResetsAt: sess?.resetsAt ?? null,
    sessionResetsSoon,
    recentPlacements: placements[normalizeRef(ref) ?? ''] ?? 0,
    eligible: blockedWhy === null,
    blockedWhy,
    band,
    resetsSoon: wk ? resetsSoon(wk.resetsAt ?? null, nowMs, s) : false,
    stale,
  }
}

// Running first, then the router's preference order. The 5-HOUR window is the tiebreak inside
// a weekly band (owner rule 2026-08-25: with several accounts open, spread work so no one
// account's 5-hour window gets hammered): the weekly band decides who is ELIGIBLE, the session
// pct decides who is NEXT, and weekly pct settles the rest. An account resetting soon ranks
// with the healthy ones — its week is about to wipe, the standing dump-target exemption.
//
// BALANCING ONLY EVER BREAKS TIES. Load is bucketed into coarse 20-point tiers, and the ledger
// reorders inside a tier and nowhere else. An account at 12% and one at 25% are not peers, so
// the colder one still wins outright no matter who was used last; 12% and 19% are peers, and
// there the account that has not just been handed work goes first. That is the whole mechanism,
// and its narrowness is the point: spreading work must never outrank having headroom, or
// balancing would cheerfully feed an account toward its own wall.
//
// Pulled out of buildInstanceRows's .sort() comparator, see buildInstanceRow above for why.
function compareInstanceRows(
  a: OrchestratorInstance,
  b: OrchestratorInstance,
  s: OrchestratorSettings,
): number {
  const bandRank = (r: OrchestratorInstance): number =>
    r.resetsSoon ? 0 : { ok: 0, elevated: 1, high: 2, critical: 3, unknown: 4 }[r.band]
  const eff = (r: OrchestratorInstance): number =>
    s.loadBalance && r.sessionResetsSoon ? 0 : (r.sessionPct ?? 101)
  const tier = (r: OrchestratorInstance): number => Math.floor(Math.min(100, eff(r)) / 20)
  if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1
  const br = bandRank(a) - bandRank(b)
  if (br !== 0) return br
  if (s.loadBalance) {
    const t = tier(a) - tier(b)
    if (t !== 0) return t
    const rp = a.recentPlacements - b.recentPlacements
    if (rp !== 0) return rp
  }
  const sp = eff(a) - eff(b)
  if (sp !== 0) return sp
  return (a.weeklyPct ?? 101) - (b.weeklyPct ?? 101)
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
  placements: Record<string, number> = {},
): OrchestratorInstance[] {
  const rows = instances.map((i) => buildInstanceRow(i, cache, s, nowMs, placements))
  return rows.sort((a, b) => compareInstanceRows(a, b, s))
}

/**
 * THE ONE PLACEMENT DECISION. Every question of the form "which account should this land on"
 * resolves here: migrate-on-limit, a handoff continuation, a chip, a fresh chat the reviewer
 * starts. Before this existed the monitor carried its own copy of the eligibility filter and
 * the reviewer carried a prose description of it in its rubric, which is two places for one
 * policy to drift.
 *
 * Returns the reason as well as the target, because a placement the reviewer cannot explain
 * is a placement the owner cannot audit.
 */
export function pickPlacement(
  rows: OrchestratorInstance[],
  opts: { excludeRef?: string | null } = {},
): { ref: string; name: string; why: string } | null {
  const exclude = normalizeRef(opts.excludeRef ?? null)
  const hit = rows.find((r) => r.eligible && normalizeRef(r.ref) !== exclude)
  if (!hit) return null
  const why = [
    hit.weeklyPct === null ? 'weekly unknown' : `weekly ${hit.weeklyPct}%`,
    hit.sessionPct === null
      ? '5-hour unknown'
      : `5-hour ${hit.sessionPct}%${hit.sessionResetsSoon ? ' (resets soon, so it is a dump target)' : ''}`,
    `${hit.recentPlacements} placement(s) in the balancing window`,
  ].join(', ')
  return { ref: hit.ref, name: hit.name, why }
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
    {
      instance: string
      archived: boolean
      permissionMode?: string | null
      chatId?: string | null
    }
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
  renames: PendingRename[]
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
  renames: [],
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

/**
 * The bracketed detail appended to an idle session's headline in runOrchestratorOnce.
 *
 * Same four-way precedence as before (recap tag, then approval-stall / stale-tasks / mid-tool,
 * then a trailing handoff note), pulled out as its own scope so the nested ternary chain adds its
 * nesting here rather than to the already-enormous per-session loop.
 */
function idleSummarySuffix(opts: {
  recapDetected: boolean
  approvalStall: boolean
  pendingTool: string | null
  permissionMode: string | null
  quietSecs: number
  staleTasks: boolean
  taskAgeSec: number | null
  midTurn: boolean
  handoffDue: boolean
  ctxTokens: number | null
}): string {
  const {
    recapDetected,
    approvalStall,
    pendingTool,
    permissionMode,
    quietSecs,
    staleTasks,
    taskAgeSec,
    midTurn,
    handoffDue,
    ctxTokens,
  } = opts
  let suffix = recapDetected ? ' with a recap' : ''
  suffix += approvalStall
    ? ` — FROZEN AT A PERMISSION PROMPT: sitting on ${pendingTool} for ${fmtQuiet(
        quietSecs,
      )} while running in '${permissionMode}' mode, which asks approval for that tool and nobody can click it. Not dead tasks; it needs reviving without shell commands (or the owner's chat set to bypass)`
    : staleTasks
      ? ` — WAITING ON DEAD BACKGROUND TASKS (task output silent ${
          taskAgeSec === null ? fmtQuiet(quietSecs) : fmtQuiet(taskAgeSec)
        }); intervene`
      : midTurn
        ? ' (tail ends mid-tool: likely a background task)'
        : ''
  suffix += handoffDue ? ` at ${Math.round((ctxTokens ?? 0) / 1000)}k context — hand off` : ''
  return suffix
}

/**
 * One orphaned live-session record, judged: cleaned up as residue, skipped (parked/unreadable/too
 * fresh), or turned into the 'orphaned' attention item. Pulled out of runOrchestratorOnce's orphan
 * loop as its own function — every `continue` in the original loop body becomes a `return null`
 * here, in the same order, with the same cleanOrphanFiles side effects before returning.
 */
function classifyOrphanSession(
  orphan: OrphanSession,
  ctx: {
    deps: OrchestratorDeps
    liveIds: Set<string>
    doneSet: Set<string>
    holdSet: Set<string>
    metaMap: Map<
      string,
      {
        instance: string
        archived: boolean
        permissionMode?: string | null
        chatId?: string | null
      }
    >
    started: number
    nowIso: string
    idleQuietSecs: number
  },
): AttentionItem | null {
  const { deps, liveIds, doneSet, holdSet, metaMap, started, nowIso, idleQuietSecs } = ctx
  if (liveIds.has(orphan.sessionId)) {
    cleanOrphanFiles(orphan) // superseded: the session lives again under a new pid
    return null
  }
  if (doneSet.has(orphan.sessionId) || metaMap.get(orphan.sessionId)?.archived) {
    cleanOrphanFiles(orphan) // finished or owner-closed: residue, not resumable work
    return null
  }
  if (holdSet.has(orphan.sessionId)) return null // parked stays parked, even dead
  if (!orphan.transcriptPath) return null
  const mtime = deps.mtimeMs(orphan.transcriptPath)
  if (mtime === null) return null
  const quietSecs = Math.max(0, Math.round((started - mtime) / 1000))
  if (quietSecs < idleQuietSecs) return null // could still be relaunching — let it settle
  let tail: TailInfo
  try {
    tail = deps.tailInfo(orphan.transcriptPath)
  } catch {
    return null
  }
  const iref = deps.instanceRef(orphan.sessionId)
  return {
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
  }
}

/**
 * The final `else` branch of classifyLiveSession — a session that isn't unreadable, held,
 * unmapped, live-but-deaf, interrupted, limit-stopped, or errored, so its only remaining question
 * is whether it is genuinely idle. Split out because this one branch carried its own cluster of
 * decisions (background-task staleness, an approval-stall diagnosis, and the mid-turn grace
 * window) that don't touch any of classifyLiveSession's other tail.ending cases.
 *
 * Mutates `detail` in place — the same object the caller pushes — exactly as the inline code did.
 * Returns null when the session is still inside its mid-turn grace window: the caller must return
 * early WITHOUT pushing anything, matching the original inline `return { items, cwdEntry }`.
 */
function buildIdleClassification(
  sess: LiveSession,
  s: OrchestratorSettings,
  deps: OrchestratorDeps,
  tail: TailInfo,
  detail: Record<string, unknown>,
  quietSecs: number,
  started: number,
  metaMap: Map<
    string,
    { instance: string; archived: boolean; permissionMode?: string | null; chatId?: string | null }
  >,
): { kind: 'handoff_due' | 'idle_pending'; summary: string } | null {
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
  // A TOOL IN FLIGHT IS WORK, NOT SILENCE. `midTurn` means the transcript ends on a tool
  // call with no result yet, so the session is inside something right now. Quiet time
  // measures the transcript, and a test suite that prints nothing for two minutes looks
  // identical to a chat waiting for input - which is how the reviewer came to be told a
  // session mid-commit-and-push was idle (field report 2026-08-27; that repo's own test
  // run is ~130s against a 150s idle threshold, so it would have happened on every run).
  // Nudging there interrupts real work, and 'resume working on whatever you recommend
  // next' is a genuinely damaging thing to say to a session halfway through a push.
  //
  // So a tool in flight buys GRACE, not silence forever: four idle windows, floor ten
  // minutes. Under that a mid-tool session is simply working and is not raised at all.
  // Over it, it is worth a look even if something is still alive, and past the stale
  // threshold the same evidence means the opposite again (nothing ever came back). A
  // blanket suppression up to the stale threshold was tried first and was wrong: it also
  // hid a session quiet for three hours whose task was still writing, which is exactly
  // the kind of thing the feed exists to show. A crashed session also ends mid-tool and
  // is NOT lost here: the orphan and stranded detectors own that case, keyed on a dead
  // or absent process rather than on silence.
  const midTurnGraceSecs = Math.max(s.idleQuietSecs * 4, 600)
  if (tail.midTurn && !staleTasks && quietSecs < midTurnGraceSecs) return null
  return {
    kind: handoffDue ? 'handoff_due' : 'idle_pending',
    summary: `${sess.name} idle ${fmtQuiet(quietSecs)}${idleSummarySuffix({
      recapDetected: tail.recapDetected,
      approvalStall,
      pendingTool: tail.pendingTool,
      permissionMode: perm,
      quietSecs,
      staleTasks,
      taskAgeSec,
      midTurn: tail.midTurn,
      handoffDue,
      ctxTokens: tail.ctxTokens,
    })}`,
  }
}

/**
 * Classify one live session into the attention items it produces, plus the byCwd/runningChats
 * bookkeeping the caller folds in. Pure aside from calling `deps`' read-only accessors (mtimeMs,
 * instanceRef, tailInfo, usage, taskActivity) — no writes, no awaits — split out of
 * runOrchestratorOnce's per-session loop where it was inline before. Every `continue` in the
 * original loop became an early `return` here at the same point, so the decision order and the
 * items produced are unchanged; the caller still does exactly `items.push(...result.items)` and
 * the same byCwd/runningChats update in the same iteration order.
 */
function classifyLiveSession(
  sess: LiveSession,
  ctx: {
    deps: OrchestratorDeps
    s: OrchestratorSettings
    started: number
    nowIso: string
    holdSet: Set<string>
    doneSet: Set<string>
    metaMap: Map<
      string,
      {
        instance: string
        archived: boolean
        permissionMode?: string | null
        chatId?: string | null
      }
    >
  },
): {
  items: AttentionItem[]
  cwdEntry: { quietSecs: number; held: boolean; running: boolean } | null
} {
  const { deps, s, started, nowIso, holdSet, doneSet, metaMap } = ctx
  const items: AttentionItem[] = []
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
    return { items, cwdEntry: null }
  }
  const mtime = deps.mtimeMs(sess.transcriptPath)
  if (mtime === null) return { items, cwdEntry: null }
  const quietSecs = Math.max(0, Math.round((started - mtime) / 1000))
  const running = quietSecs < s.idleQuietSecs
  // A done-marked session is treated like a held one from here down: it still anchors its
  // repo for git grouping, but must never be nudged or chosen as a hygiene addressee — its
  // successor owns the work (see doneSet above).
  const held = holdSet.has(sess.sessionId) || doneSet.has(sess.sessionId)
  const cwdEntry = { quietSecs, held, running }
  if (held) return { items, cwdEntry }
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
  if (quietSecs < s.idleQuietSecs) return { items, cwdEntry }

  let tail: TailInfo
  try {
    tail = deps.tailInfo(sess.transcriptPath)
  } catch {
    return { items, cwdEntry }
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
    const idle = buildIdleClassification(sess, s, deps, tail, detail, quietSecs, started, metaMap)
    // null means the session is still inside its mid-turn grace window: the ORIGINAL inline code
    // returned right there without pushing anything, and this preserves that exact early exit.
    if (idle === null) return { items, cwdEntry }
    items.push({
      ...base,
      key: `idle:${sess.sessionId}`,
      kind: idle.kind,
      summary: idle.summary,
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
  return { items, cwdEntry }
}

/** Everything the phases of one orchestrator tick read or accumulate into, bundled so each phase
 *  takes one parameter instead of a growing list of locals. Mutated in place by design - `items`,
 *  `byCwd` and `runningChats` are written by several phases in sequence, the same way the single
 *  function used to thread them through one shared scope. */
interface OnceCtx {
  deps: OrchestratorDeps
  started: number
  s: OrchestratorSettings
  nowIso: string
  items: AttentionItem[]
  sessions: LiveSession[]
  holdSet: Set<string>
  doneSet: Set<string>
  metaMap: Map<
    string,
    {
      instance: string
      archived: boolean
      permissionMode?: string | null
      chatId?: string | null
    }
  >
  byCwd: Map<string, { session: LiveSession; quietSecs: number; held: boolean }[]>
  runningChats: number
  liveIds: Set<string>
  cache: Record<string, UsageSnapshot>
}

/** Everything a tick needs before any phase can run: settings, the live registry, the hold/done
 *  sets a session-scoped item must respect, and desktop metadata (which sidebar, archived, its
 *  automation posture) read once because the per-session loop needs it too. */
function initOnceCtx(deps: OrchestratorDeps): OnceCtx {
  const started = deps.nowMs()
  const s = getOrchestratorSettings()
  const nowIso = new Date(started).toISOString()
  const sessions = deps.registry(deps.claudeHome())
  state.liveSessions = sessions.length

  // Held threads (/orcstop): no session-scoped item may be generated for them at all — the
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

  let metaMap: OnceCtx['metaMap'] = new Map()
  try {
    metaMap = deps.sessionMeta()
  } catch {
    // No desktop metadata just means the owner-archived and stranded checks skip this tick.
  }

  return {
    deps,
    started,
    s,
    nowIso,
    items: [],
    sessions,
    holdSet,
    doneSet,
    metaMap,
    byCwd: new Map(),
    runningChats: 0,
    liveIds: new Set(sessions.map((x) => x.sessionId)),
    cache: {},
  }
}

/** Chats actively WORKING right now (transcript fresher than the idle threshold). Held and
 *  done-marked ones included: a busy chat holds a concurrency slot no matter its bookkeeping. */
function classifySessions(ctx: OnceCtx): void {
  for (const sess of ctx.sessions) {
    const result = classifyLiveSession(sess, {
      deps: ctx.deps,
      s: ctx.s,
      started: ctx.started,
      nowIso: ctx.nowIso,
      holdSet: ctx.holdSet,
      doneSet: ctx.doneSet,
      metaMap: ctx.metaMap,
    })
    ctx.items.push(...result.items)
    if (result.cwdEntry) {
      if (result.cwdEntry.running) ctx.runningChats++
      const list = ctx.byCwd.get(sess.cwd) ?? []
      list.push({ session: sess, quietSecs: result.cwdEntry.quietSecs, held: result.cwdEntry.held })
      ctx.byCwd.set(sess.cwd, list)
    }
  }
}

/** Sessions that died mid-process (computer restart, crash, kill). A graceful CLI exit deletes
 *  its own ~/.claude/sessions/<pid>.json; a registry file whose pid is dead means the session
 *  was killed with its thread unfinished — the owner's restart scenario (2026-08-25). Mid-process
 *  death is a RESUMABLE scenario, so each one gets an attention item; superseded/finished residue
 *  is cleaned instead, so a revived chat's stale file never shadows its live successor
 *  (self-healing once the owner clicks the chat back to life or a resume lands). */
function classifyOrphans(ctx: OnceCtx): void {
  const newestOrphan = new Map<string, OrphanSession>()
  for (const o of ctx.deps.orphans(ctx.deps.claudeHome())) {
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
    const item = classifyOrphanSession(orphan, {
      deps: ctx.deps,
      liveIds: ctx.liveIds,
      doneSet: ctx.doneSet,
      holdSet: ctx.holdSet,
      metaMap: ctx.metaMap,
      started: ctx.started,
      nowIso: ctx.nowIso,
      idleQuietSecs: ctx.s.idleQuietSecs,
    })
    if (item) ctx.items.push(item)
  }
}

/** Desktop chats killed GRACEFULLY mid-work, so no residue. A PC restart shuts sessions down
 *  cleanly, and a clean exit deletes its own registry file — the orphan pass above then has
 *  nothing to read, while the chat still sits un-archived in a desktop sidebar with a transcript
 *  that ends mid-turn. Found live 2026-08-25: the owner's "CLICK TO RESUME" architect chat sat
 *  pending through a restart precisely this way. Scan recent transcripts (48h window; the store
 *  scan is ~60ms) and surface any non-live, non-done, non-held, non-archived DESKTOP chat whose
 *  tail is mid-work as the same 'orphaned' scenario. midTurn-only keeps precision: a finished
 *  chat idling in a sidebar is the sidebar's normal state, not a stranding. Must run AFTER
 *  classifyOrphans, whose flagged sessions this deliberately does not duplicate. */
function classifyStrandedDesktopChats(ctx: OnceCtx): void {
  const orphanFlagged = new Set(
    ctx.items.filter((i) => i.kind === 'orphaned').map((i) => i.sessionId as string),
  )
  for (const t of ctx.deps.recentTranscripts(ctx.deps.claudeHome(), ctx.started)) {
    if (ctx.liveIds.has(t.sessionId) || orphanFlagged.has(t.sessionId)) continue
    if (ctx.doneSet.has(t.sessionId) || ctx.holdSet.has(t.sessionId)) continue
    const meta = ctx.metaMap.get(t.sessionId)
    if (!meta || meta.archived) continue // only chats that live in a desktop sidebar
    if (ctx.deps.dispatchActive(t.sessionId)) continue // an in-flight headless run is not stranded
    const quietSecs = Math.max(0, Math.round((ctx.started - t.mtimeMs) / 1000))
    if (quietSecs < ctx.s.idleQuietSecs) continue
    let tail: TailInfo
    try {
      tail = ctx.deps.tailInfo(t.path)
    } catch {
      continue
    }
    if (!tail.midTurn) continue
    const title = scannerTitleFor(t.sessionId)
    ctx.items.push({
      key: `orphan:${t.sessionId}`,
      kind: 'orphaned',
      sessionId: t.sessionId,
      instanceRef: ctx.deps.instanceRef(t.sessionId) ?? undefined,
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
      firstSeenAt: ctx.nowIso,
      seenCount: 1,
    })
  }
}

/** Build the attention item for one Codex thread already past the idle threshold and readable.
 *  Split out of classifyCodexThreads so the nested ending->text ternary and the item literal
 *  don't roll their weight into the scanning loop that calls this. */
function codexItemFor(
  t: CodexThread,
  tail: CodexTail,
  quietSecs: number,
  nowIso: string,
): AttentionItem {
  const kind: AttentionItem['kind'] = tail.ending === 'interrupted' ? 'interrupted' : 'idle_pending'
  const endingText =
    tail.ending === 'interrupted'
      ? 'was interrupted'
      : tail.ending === 'mid-turn'
        ? 'stopped mid-turn'
        : 'finished'
  return {
    key: `codex:${t.sessionId}`,
    kind,
    sessionId: t.sessionId,
    cwd: t.cwd ?? undefined,
    tailSnippet: tail.lastAgentText ?? undefined,
    summary: `[codex] ${t.sessionId.slice(0, 8)} ${endingText} ${fmtQuiet(quietSecs)} ago${tail.recapDetected ? ' with a recap' : ''} - Codex cannot be messaged, so this is for the owner to pick up`,
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
  }
}

/** Codex threads (the other half of a unified manager). Observe-only by construction: Codex
 *  exposes no live-process registry and no message channel, so these items tell the owner what
 *  is waiting without pretending the reviewer can drive it. Every one carries source:'codex' and
 *  deliverable:false for exactly that reason - a reviewer that nudged one would be talking into
 *  a void, the same failure the deaf-chat rail exists to stop. */
function classifyCodexThreads(ctx: OnceCtx): void {
  if (!ctx.s.watchCodex) return
  try {
    for (const t of ctx.deps.codexThreads(ctx.started)) {
      if (ctx.doneSet.has(t.sessionId) || ctx.holdSet.has(t.sessionId)) continue
      const quietSecs = Math.max(0, Math.round((ctx.started - t.mtimeMs) / 1000))
      if (quietSecs < ctx.s.idleQuietSecs) continue
      const tail = ctx.deps.codexTail(t.path)
      if (tail.unreadable) continue
      if (t.cwd) {
        const list = ctx.byCwd.get(t.cwd) ?? []
        ctx.byCwd.set(t.cwd, list) // its repo still counts for git hygiene, even unmessageable
      }
      ctx.items.push(codexItemFor(t, tail, quietSecs, ctx.nowIso))
    }
  } catch (err) {
    console.error('[agenthydra] codex scan failed:', err)
  }
}

/** Git hygiene, one look per distinct cwd: flag a repo off main, and one dirty for long enough
 *  with every session in it idle. */
async function applyGitHygiene(ctx: OnceCtx): Promise<void> {
  for (const [cwd, sess] of ctx.byCwd) {
    let g: GitInfo | null = null
    try {
      g = await ctx.deps.git(cwd)
    } catch {
      g = null
    }
    if (!g?.isRepo) {
      kvDelete(`dirtySince:${cwd}`)
      continue
    }
    if (g.detached || (g.branch && g.branch !== 'main' && g.branch !== 'master')) {
      ctx.items.push({
        key: `branch:${cwd}`,
        kind: 'branch_off_main',
        cwd,
        summary: `${cwd} is on ${g.detached ? 'a detached HEAD' : `branch '${g.branch}'`} — standing rule is main only`,
        detail: { branch: g.branch, detached: g.detached },
        firstSeenAt: ctx.nowIso,
        seenCount: 1,
      })
    }
    if (g.dirtyCount > 0) {
      const k = `dirtySince:${cwd}`
      let since = Number(kvGet(k))
      if (!Number.isFinite(since) || since <= 0) {
        since = ctx.started
        kvSet(k, String(ctx.started))
      }
      const dirtyMins = Math.round((ctx.started - since) / 60_000)
      const allIdle = sess.every((x) => x.quietSecs >= ctx.s.idleQuietSecs)
      if (dirtyMins >= ctx.s.dirtyMins && allIdle) {
        ctx.items.push({
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
          firstSeenAt: ctx.nowIso,
          seenCount: 1,
        })
      }
    } else {
      kvDelete(`dirtySince:${cwd}`)
    }
  }
}

/** Usage snapshots: stamp their age, diff against the previous pass for threshold items, and
 *  stash the cache on ctx - the fleet-routing phase right after this one needs it too. */
function applyUsage(ctx: OnceCtx): void {
  const cache = ctx.deps.usage()
  ctx.cache = cache
  let newestCapture = 0
  for (const snap of Object.values(cache)) {
    const t = Date.parse(snap.capturedAt ?? '')
    if (!Number.isNaN(t) && t > newestCapture) newestCapture = t
  }
  state.usageAgeSecs = newestCapture ? Math.round((ctx.started - newestCapture) / 1000) : null
  let prev: Record<string, UsagePrev> = {}
  try {
    prev = JSON.parse(kvGet('usagePrev') ?? '{}')
  } catch {
    prev = {}
  }
  const usage = computeUsageItems(cache, prev, ctx.s, ctx.started, ctx.nowIso)
  kvSet('usagePrev', JSON.stringify(usage.next))
  ctx.items.push(...usage.items)
}

/** The desktop fleet as a routing table. */
async function applyFleetInstances(ctx: OnceCtx): Promise<void> {
  try {
    state.instances = buildInstanceRows(
      await ctx.deps.desktopInstances(),
      ctx.cache,
      ctx.s,
      ctx.started,
      recentPlacements(ctx.s.balanceWindowMins, ctx.started),
    )
  } catch (err) {
    console.error('[agenthydra] orchestrator instance listing failed:', err)
    state.instances = []
  }
}

/** The concurrency cap (round-robin rotation). maxActiveChats caps how many chats may WORK at
 *  once, fleet-wide (0 = unlimited, the default). Busy chats hold the slots; free slots are
 *  offered to idle chats LONGEST-IDLE FIRST, and that ordering IS the round-robin: a nudged chat
 *  goes busy, and when it next idles it re-enters at the back of the line (freshest mtime), so
 *  every waiting chat cycles through fairly with no extra bookkeeping. The overflow is marked
 *  waiting-for-slot; the reviewer skips those WITHOUT acking, so they resurface the moment a
 *  slot frees. Handoffs, answers, and orphan revives are never gated here — only resume nudges
 *  are, since those are what actually multiply concurrent work. */
function applyConcurrencyCap(ctx: OnceCtx): void {
  state.runningChats = ctx.runningChats
  state.slotsFree =
    ctx.s.maxActiveChats > 0 ? Math.max(0, ctx.s.maxActiveChats - ctx.runningChats) : null
  if (ctx.s.maxActiveChats > 0) {
    const resumable = ctx.items
      .filter((i) => i.kind === 'idle_pending')
      .sort(
        (a, b) =>
          (((b.detail?.quietSecs as number) ?? 0) as number) -
          (((a.detail?.quietSecs as number) ?? 0) as number),
      )
    for (const [idx, item] of resumable.entries()) {
      if (idx < (state.slotsFree ?? 0)) continue
      item.detail = { ...item.detail, waitingForSlot: true }
      item.summary += ` — WAITING FOR A SLOT (${ctx.runningChats}/${ctx.s.maxActiveChats} running); do not nudge`
    }
  }
}

/** Every orphaned item is an ACTION WANTED (a revive). Captured BEFORE ack suppression — an ack
 *  shapes the reviewer's reading list, never the action ledger (found live 2026-08-25: an acked
 *  orphan blindfolded the old reviver for exactly the chat that most needed it) — and written as
 *  a PROPOSAL, never acted on here (owner law 2026-08-26: the AI checks every action first; the
 *  reviewer decides these and executes the approved ones itself). Also retires proposals whose
 *  target was archived out from under them: open rows stand for up to 48 hours, and the chat
 *  underneath can be archived in that time - which is exactly what happened on 2026-08-27, when
 *  four approved revives pointed at retired threads and the reviewer spent a relay round finding
 *  out. The detectors already refuse to propose for an archived chat; this applies the same test
 *  to rows already on the books. */
function maintainOrphanProposals(ctx: OnceCtx): void {
  maintainProposals(ctx.started)
  {
    const archivedNow: string[] = []
    for (const [id, meta] of ctx.metaMap) if (meta.archived) archivedNow.push(id)
    const retired = retireProposalsForSessions(
      archivedNow,
      ctx.started,
      'target was archived after this was proposed; retired rather than offered as work',
    )
    if (retired > 0)
      console.log(`[agenthydra] retired ${retired} proposal(s) whose chat has been archived`)
  }
  for (const item of ctx.items) {
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
        permissionMode: ctx.metaMap.get(item.sessionId)?.permissionMode ?? null,
        // THE ID THE APP'S TOOLS TAKE. Not `local_<sessionId>`: that form is correct only
        // for imported chats, and 98.7% of this fleet was created IN the app and is filed
        // under a different id. The reviewer had no way to know that and addressed four
        // deliveries at chats that do not exist (2026-08-27). Use this verbatim for
        // send_message, rename, archive, and for any relay request.
        chatId: ctx.metaMap.get(item.sessionId)?.chatId ?? null,
        cwd: item.cwd ?? null,
        peerName: item.peerName ?? null,
        tailSnippet: item.tailSnippet?.slice(0, 600) ?? null,
      },
      evidenceAt: new Date(ctx.started - quiet * 1000).toISOString(),
    })
  }
}

/** Ack suppression, then publish this tick's attention list and timing to `state`. */
function applyAckSuppressionAndPublish(ctx: OnceCtx): void {
  const acks = activeAcks(ctx.started)
  const visible = ctx.items.filter((i) => {
    const ack = acks.get(i.key)
    if (!ack) return true
    // A session item whose transcript moved after the ack is a NEW situation — re-arm it.
    if (i.sessionId) {
      const sess = ctx.sessions.find((x) => x.sessionId === i.sessionId)
      const mtime = sess?.transcriptPath ? ctx.deps.mtimeMs(sess.transcriptPath) : null
      if (mtime !== null && mtime > Date.parse(ack.acked_at)) return true
    }
    return false
  })

  state.attention = withContinuity(visible)
  state.lastTickAt = ctx.nowIso
  state.lastTickMs = ctx.deps.nowMs() - ctx.started
}

/** The title janitor (every ~10 min). Plumbing-created desktop chats (imports, migrations) land
 *  "Untitled" or with a generic AI name; the owner's requirement is standing name management,
 *  not one-time fixes. The scanner already derives real titles for every transcript — hand them
 *  to any desktop entry that has none. Only in the real pass (default deps), never in tests
 *  driving injected deps. */
async function runPeriodicTitleJanitor(ctx: OnceCtx): Promise<void> {
  if (ctx.deps !== defaultDeps || ctx.started - lastTitleSweepMs <= 10 * 60_000) return
  lastTitleSweepMs = ctx.started
  try {
    const titled = sweepUntitledDesktopChats(scannerTitleFor)
    if (titled.fixed > 0) {
      console.log(`[agenthydra] title janitor named ${titled.fixed} desktop chat(s)`)
      // New names must APPEAR, not wait for some future restart (owner rule) — same
      // sidebar-visibility restart the archive flow uses. Kept as the FALLBACK: it is what
      // lands the name when no reviewer is running, so removing it would trade a slow rename
      // for no rename at all.
      for (const p of titled.profiles) noteArchiveVisibilityPending(p)
    }
    // Anything renamed inside a RUNNING app is handed to the reviewer, which renames through
    // the app itself: instant, and the app cannot overwrite it. Chats in closed instances are
    // NOT listed, because the disk write is already the durable answer for those.
    const running = new Set(
      state.instances.filter((i) => i.isRunning).map((i) => normalizeRef(i.ref) ?? ''),
    )
    state.renames = reconcilePendingRenames(
      titled.renamed.map((r) => ({
        ref: desktopKey(r.profile),
        sessionId: r.sessionId,
        title: r.title,
      })),
      running,
      ctx.started,
    )
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
  // The placement ledger is pruned on the same 14-day horizon as decided proposals, in the
  // same pass, so neither can grow without bound on a machine that never restarts.
  prunePlacements(ctx.started)
  try {
    await restartAppsForArchiveVisibility()
  } catch (err) {
    console.error('[agenthydra] archive-visibility restart failed:', err)
  }
}

export async function runOrchestratorOnce(deps: OrchestratorDeps = defaultDeps): Promise<void> {
  const ctx = initOnceCtx(deps)

  classifySessions(ctx)
  classifyOrphans(ctx)
  classifyStrandedDesktopChats(ctx)
  classifyCodexThreads(ctx)
  await applyGitHygiene(ctx)
  applyUsage(ctx)
  await applyFleetInstances(ctx)
  applyConcurrencyCap(ctx)
  maintainOrphanProposals(ctx)
  applyAckSuppressionAndPublish(ctx)
  await runPeriodicTitleJanitor(ctx)
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
      // The chat's own metadata title, from the cached index, is both the right name (it is
      // what the sidebar shows) and free. scannerTitleFor is the fallback and is deliberately
      // called AT MOST ONCE: its query cannot use an index, so it scans the whole scan-cache
      // table, and calling it twice per row is what made this sweep 1.6 seconds on its own.
      const title = findDesktopChat(r.session_id)?.title ?? scannerTitleFor(r.session_id)
      const id = proposeAction({
        kind: 'archive',
        sessionId: r.session_id,
        title,
        summary: `done-marked chat ${title ?? r.session_id.slice(0, 8)} still sits un-archived in a desktop sidebar — retire its entries`,
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

/** Layer 3 of the ownership test below: ask the processes themselves. Any live pid whose
 *  ancestor chain carries this instance's --user-data-dir is hosted here regardless of what
 *  the metadata said. Returns true (refuse) when a chain can't be enumerated at all. */
async function isDirHostedByLiveProcess(dir: string, live: LiveSession[]): Promise<boolean> {
  for (const s of live) {
    const { extractUserDataDir, processAncestry } = await import('./core/process')
    const chain = await processAncestry(s.pid)
    if (chain === null) return true // could not enumerate — refuse rather than guess
    if (
      chain.some((a) => {
        const udd = a.commandLine ? extractUserDataDir(a.commandLine) : null
        return udd !== null && samePath(udd, dir)
      })
    ) {
      return true
    }
  }
  return false
}

/** One pending archive-visibility restart, evaluated and (if safe) carried out. Split out of
 *  restartAppsForArchiveVisibility so that function reads as the plan and this reads as the
 *  per-directory ownership test + action. */
async function restartOneArchivePendingDir(
  row: { key: string },
  live: LiveSession[],
): Promise<void> {
  const dir = row.key.slice('archPending:'.length)
  const cooldownKey = `archRestart:${desktopKey(dir)}`
  const last = kvGet(cooldownKey)
  if (last && Date.now() - Date.parse(last) < 3600_000) return
  const owned = live.filter((s) => {
    const r = instanceRefForSession(s.sessionId)
    return r !== null && samePath(r.slice('desktop:'.length), dir)
  })
  if (owned.length > 0) return // someone is working in there — the flag waits
  if (await isDirHostedByLiveProcess(dir, live)) return
  try {
    const { openInstance, quitInstance } = await import('./core/instances')
    const q = await quitInstance(dir)
    if (!q.ok) {
      console.log(`[agenthydra] archive-visibility restart refused for ${dir}: ${q.message}`)
      kvDelete(row.key) // a structural refusal (e.g. the default profile) refuses forever
      return
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
  //   3. direct process evidence outranks metadata (isDirHostedByLiveProcess, above): a live
  //      session whose process ANCESTRY carries this instance's --user-data-dir is hosted by
  //      this app, mapped or not, and an ancestry read that fails proves nothing and therefore
  //      blocks the restart.
  const unmapped = live.filter((s) => instanceRefForSession(s.sessionId) === null)
  if (unmapped.length > 0) {
    console.log(
      `[agenthydra] archive-visibility restart deferred: ${unmapped.length} live session(s) with no mapped instance — cannot prove any app is empty`,
    )
    return
  }
  for (const row of pending) {
    await restartOneArchivePendingDir(row, live)
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

/**
 * The repository a working directory belongs to, or null when it is not in one.
 *
 * Two adjustments make this answer the question the reviewer actually has. A `.git` that is a FILE
 * rather than a directory is a linked worktree, and a worktree of a repo is the same repo for
 * clobbering purposes: two chats editing `repo` and `repo/.claude/worktrees/x` share a history and
 * an origin even though their paths do not overlap. And the walk stops at the first `.git` above
 * the cwd, so a chat working in a subfolder still reports the repo root.
 *
 * Cached for the process lifetime: repo roots do not move, and this runs once per live chat per
 * tick.
 */
const repoRootCache = new Map<string, string | null>()
export function repoRootForCwd(cwd: string): string | null {
  const hit = repoRootCache.get(cwd)
  if (hit !== undefined) return hit
  let dir = cwd
  let out: string | null = null
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) {
      // A linked worktree lives at <repo>/.claude/worktrees/<name>; fold it back onto <repo> so
      // the two do not read as unrelated places.
      const marker = `${sep}.claude${sep}worktrees${sep}`
      const at = dir.toLowerCase().indexOf(marker.toLowerCase())
      out = at >= 0 ? dir.slice(0, at) : dir
      break
    }
    const up = dirname(dir)
    if (!up || up === dir) break
    dir = up
  }
  repoRootCache.set(cwd, out)
  return out
}

/** Live chats that are working in the same repository right now. */
export interface Collision {
  /** The shared repository root, or the shared cwd when neither chat is in a repo. */
  where: string
  chats: Array<{ sessionId: string; name: string; cwd: string; instance: string | null }>
}

/**
 * Which live chats are standing on each other's feet.
 *
 * The orchestrator places work and delivers nudges without any notion of what the OTHER chats are
 * doing, so two threads land in one repo and overwrite each other - the owner has been told by his
 * own chats that "work was overridden by other chats" (2026-08-25), and the commit nudge makes it
 * worse by telling chat A to commit a tree chat B is halfway through editing.
 *
 * This is deliberately the cheap 90% of the answer rather than a file-level dependency graph:
 * group the live registry by repository root. Same repo means they CAN clobber, which is all the
 * reviewer needs to route around it. It costs one existsSync walk per live chat per tick, cached,
 * and it cannot go stale in a harmful direction: a collision that has ended simply stops appearing.
 */
export function collisionsFor(live: LiveSession[]): Collision[] {
  const groups = new Map<string, Collision>()
  for (const s of live) {
    if (!s.cwd) continue
    const where = repoRootForCwd(s.cwd) ?? s.cwd
    const key = where.toLowerCase()
    const g = groups.get(key) ?? { where, chats: [] }
    g.chats.push({
      sessionId: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      instance: instanceRefForSession(s.sessionId),
    })
    groups.set(key, g)
  }
  return [...groups.values()]
    .filter((g) => g.chats.length > 1)
    .sort((a, b) => b.chats.length - a.chats.length || a.where.localeCompare(b.where))
}

function fmtQuiet(secs: number): string {
  if (secs < 90) return `${secs}s`
  if (secs < 90 * 60) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

export function orchestratorView(): OrchestratorView {
  const proposals = listProposalsForView(Date.now())
  // Resolved ONCE and shared with the reviewer-health count below, so the list the reviewer is
  // shown and the backlog it is judged against can never disagree.
  const renames = listPendingRenames()
  return {
    settings: getOrchestratorSettings(),
    prompts: getOrchestratorPrompts(),
    promptDefaults: ORCHESTRATOR_PROMPT_DEFAULTS,
    proposals,
    attention: state.attention,
    instances: state.instances,
    // Chats the janitor renamed ON DISK inside a RUNNING app, where that write does not show
    // until the app restarts. The reviewer renames these natively and reports them done.
    renames,
    // WHAT TO PUT IN FRONT OF A NEW CHAT'S FIRST MESSAGE, already decided. The daemon applies
    // this itself wherever it composes the launch (see new-chat-opening.ts), but the reviewer
    // delivers opening prompts NATIVELY through the app, which no server code can reach. Serving
    // the literal string is the same move `placement` makes: the rubric used to ask the reviewer
    // to read a boolean and remember a rule, and a rule only a reader can apply is a rule that
    // gets forgotten. Concatenate it; when the opt-in is off it is the empty string.
    newChatPrefix: newChatUltracodeEnabled() ? 'ultracode\n\n' : '',
    // WHO IS STANDING WHERE, so work can be routed around a repo someone else is already in.
    // Placement used to consider only account headroom, which is why two chats could be pointed
    // at one repo and overwrite each other. Empty is the normal case and means nothing to avoid.
    collisions: collisionsFor(readLiveRegistry(join(homedir(), '.claude'))),
    // WHERE THE NEXT PIECE OF WORK SHOULD GO, decided once here rather than re-derived from
    // the sort by every reader. `blocked` states why each passed-over account was passed
    // over, so a placement can be argued with instead of merely trusted, and `recent` is the
    // ledger the balancing actually consulted.
    placement: (() => {
      const s = getOrchestratorSettings()
      const pick = pickPlacement(state.instances)
      return {
        balancing: s.loadBalance,
        windowMins: s.balanceWindowMins,
        recommended: pick?.ref ?? null,
        recommendedName: pick?.name ?? null,
        why: pick?.why ?? 'no running instance has headroom right now',
        eligible: state.instances.filter((r) => r.eligible).map((r) => r.ref),
        blocked: state.instances
          .filter((r) => !r.eligible)
          .map((r) => ({ ref: r.ref, name: r.name, why: r.blockedWhy })),
        recent: listRecentPlacements(20, Date.now()),
      }
    })(),
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
      // Proposals AND pending renames: both are work only a reviewer can do, and counting only
      // the first is what let a six-hour-dead reviewer report as merely idle. See reviewerHealth.
      reviewer: reviewerHealth(
        Date.now(),
        proposals.filter((p) => p.status === 'proposed' || p.status === 'approved').length +
          renames.length,
      ),
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
  // Bring OUR OWN installed command copies up to date before anything reads them. A release can
  // change the reviewer's rubric, and until this ran nothing ever carried that change to the only
  // file the reviewer actually opens. Never creates a file and never overwrites an edited one; see
  // refreshShippedCommands.
  try {
    for (const r of refreshShippedCommands())
      if (r.outcome === 'refreshed')
        console.log(`[agenthydra] refreshed the shipped ${r.file} (it was our own older copy)`)
  } catch (err) {
    console.error('[agenthydra] shipped-command refresh failed:', err)
  }
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

export type CommandInstallOutcome = 'installed' | 'up-to-date' | 'differs' | 'updated' | 'refreshed'

/** Fingerprint of a command file's text, so we can recognise our OWN last copy on disk without
 *  keeping a second full transcript of it in the settings table. */
export function commandTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Pure decision: what should happen given what is on disk. Exported for tests.
 *
 * `lastShippedHash` is the fingerprint of the text WE last wrote to that path, or null if we have
 * never written it (or wrote it before this was recorded). It is what separates the two cases the
 * old three-way answer ran together: a file the owner edited, whose edits are the newer intent and
 * must never be overwritten, and a file that is simply OUR OWN previous version, left behind
 * because a release changed the shipped text and nothing ever went back for it.
 *
 * That second case is not hypothetical. Measured 2026-08-27: the installed /orchestrate rubric was
 * a shipped copy from the day before, so the live reviewer was still being told to construct chat
 * ids as `local_<sessionId>` - the exact bug fixed in the repo and documented in this changelog,
 * which had never reached the only file the reviewer actually reads. A fix that lands in git and
 * not on disk is not a fix, and the route's own comment already claimed it covered "after an
 * AgentHydra update changed them" while nothing called it.
 */
export function commandInstallOutcome(
  existing: string | null,
  shipped: string,
  force: boolean,
  lastShippedHash: string | null = null,
): CommandInstallOutcome {
  if (existing === null) return 'installed'
  if (existing === shipped) return 'up-to-date'
  if (force) return 'updated'
  // Ours, unedited, and out of date. Rewriting it corrects our own drift; it takes nothing from
  // the owner, because byte-for-byte this is the file we put there.
  if (lastShippedHash && commandTextHash(existing) === lastShippedHash) return 'refreshed'
  return 'differs'
}

/** Everything the orchestrator ships as a user-typeable command: the reviewer loop plus the
 *  per-thread stop/start pair (/orcstop means "not now", /orcstart lifts it). */
const SHIPPED_COMMANDS: Array<{ file: string; text: string }> = [
  { file: 'orchestrate.md', text: ORCHESTRATE_COMMAND },
  { file: 'orcstop.md', text: ORCSTOP_COMMAND },
  { file: 'orcstart.md', text: ORCSTART_COMMAND },
]

/**
 * Names we used to ship and no longer do (renamed 2026-08-27: /orcstop -> /orcstop, /orcstart ->
 * /orcstart, so the pair says what it does to the orchestrator rather than rhyming).
 *
 * These MUST be cleaned up, because a leftover is not inert: the old file is a complete, working
 * command that still posts a hold, so a machine that kept both would offer four commands for two
 * actions and the retired pair would keep working forever with nothing maintaining it.
 *
 * Only OUR OWN unedited copy is removed, matched by the fingerprint recorded when we wrote it.
 * A copy someone edited is left alone and reported: their edit is the newer intent, and the same
 * rule already governs a refresh. See commandInstallOutcome.
 */
const RETIRED_COMMANDS = ['delayo.md', 'resumeo.md']

/** Remove our own copies of commands we no longer ship. Never touches an edited one. */
function removeRetiredCommands(
  commandsDir: string,
): Array<{ file: string; outcome: 'removed' | 'kept-edited' | 'missing' }> {
  return RETIRED_COMMANDS.map((file) => {
    const path = join(commandsDir, file)
    let existing: string | null = null
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      return { file, outcome: 'missing' as const }
    }
    const known = getSetting(shippedHashKey(file))
    if (!known || commandTextHash(existing) !== known)
      return { file, outcome: 'kept-edited' as const }
    rmSync(path, { force: true })
    setSetting(shippedHashKey(file), '')
    return { file, outcome: 'removed' as const }
  })
}

/** Where we remember the fingerprint of the copy WE wrote, per command file. */
const shippedHashKey = (file: string) => `orch_command_hash_${file.replace(/[^a-z0-9]+/gi, '_')}`

export function installOrchestratorCommands(
  force = false,
  commandsDir: string = join(homedir(), '.claude', 'commands'),
  opts: {
    /** Boot mode: keep an EXISTING install correct, but never put commands on a machine that has
     *  none. Installing on a machine that never enabled the orchestrator would be adding commands
     *  to someone's Claude for a feature they never switched on. */
    existingOnly?: boolean
  } = {},
): Array<{ file: string; outcome: CommandInstallOutcome; path: string }> {
  // Sweep away our own copies of commands we no longer ship, before writing the current set. A
  // retired command file is not inert: it still works, so leaving one behind means the machine
  // offers both the old and the new name for the same action indefinitely.
  const retired = removeRetiredCommands(commandsDir)
  for (const r of retired)
    if (r.outcome === 'removed')
      console.log(`[agenthydra] removed the retired /${r.file.replace(/\.md$/, '')} command`)
    else if (r.outcome === 'kept-edited')
      console.log(
        `[agenthydra] kept /${r.file.replace(/\.md$/, '')}: it is retired but you edited it`,
      )

  /**
   * Does this machine already USE these commands?
   *
   * This is what `existingOnly` is really asking, and reading it per-FILE was wrong in exactly the
   * case a rename creates. Caught live on the /delayo -> /orcstop deploy: the boot pass correctly
   * deleted its own retired copies and then refused to write the successors, because those files
   * did not exist yet, so the upgrade took the pair away and gave nothing back. An upgrade that
   * removes a capability is worse than one that never ran.
   *
   * A retired file we just removed counts as evidence too: it could only have been there because
   * we put it there. A machine with nothing at all still gets nothing, which is the case the flag
   * exists to protect.
   */
  const alreadyInstalled =
    retired.some((r) => r.outcome !== 'missing') ||
    SHIPPED_COMMANDS.some(({ file }) => existsSync(join(commandsDir, file)))

  return SHIPPED_COMMANDS.map(({ file, text }) => {
    const path = join(commandsDir, file)
    let existing: string | null = null
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = null
    }
    const outcome = commandInstallOutcome(existing, text, force, getSetting(shippedHashKey(file)))
    const write =
      outcome === 'updated' ||
      outcome === 'refreshed' ||
      (outcome === 'installed' && (!opts.existingOnly || alreadyInstalled))
    if (write) {
      mkdirSync(commandsDir, { recursive: true })
      writeFileSync(path, text)
      // Recorded AFTER the write, so a failed write cannot leave us believing we own a file we
      // never managed to put there.
      setSetting(shippedHashKey(file), commandTextHash(text))
    } else if (outcome === 'up-to-date' && !getSetting(shippedHashKey(file))) {
      // Adopt a copy that already matches: it IS ours, we just predate the bookkeeping. Without
      // this, every file installed before this change would be read as an owner edit forever.
      setSetting(shippedHashKey(file), commandTextHash(text))
    }
    return { file, outcome, path }
  })
}

/**
 * Boot-time refresh: update the shipped commands we ourselves installed and have since changed.
 *
 * Never creates a file, never touches one the owner edited. This is the step that was missing:
 * the only automatic install ran on first enable with force off, whose own comment reads "an
 * existing copy is never touched here", so a rubric fix shipped in a release could sit in the
 * binary indefinitely while the reviewer kept reading last month's copy.
 */
export function refreshShippedCommands(
  commandsDir?: string,
): Array<{ file: string; outcome: CommandInstallOutcome; path: string }> {
  return installOrchestratorCommands(false, commandsDir, { existingOnly: true })
}

/** The opt-out mirror of installOrchestratorCommands: remove the shipped /orchestrate, /orcstop
 *  and /orcstart files from the user's commands directory, plus any RETIRED name still lying
 *  around (an uninstall that leaves a working /orcstop behind has not uninstalled anything).
 *  Removes edited copies too — "remove the orchestrator and its commands" means gone, and the
 *  shipped texts are always one reinstall away. A file that is not there reports 'missing'
 *  rather than erroring. */
export function uninstallOrchestratorCommands(
  commandsDir: string = join(homedir(), '.claude', 'commands'),
): Array<{ file: string; outcome: 'removed' | 'missing'; path: string }> {
  const all = [...SHIPPED_COMMANDS.map((c) => c.file), ...RETIRED_COMMANDS]
  return all.map((file) => {
    const path = join(commandsDir, file)
    if (!existsSync(path)) return { file, outcome: 'missing' as const, path }
    rmSync(path, { force: true })
    return { file, outcome: 'removed' as const, path }
  })
}
