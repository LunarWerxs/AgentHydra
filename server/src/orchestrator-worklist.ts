// server/src/orchestrator-worklist.ts — the EXECUTION ENGINE of the orchestration layer.
//
// WHY THIS EXISTS (owner directive, Michael, 2026-08-28, ground-up reorganization): the reviewer
// used to be handed a 560-line prose rubric and a raw feed, and was trusted to compose every
// message, pick the right delivery rung, remember the closeout-before-archive ordering, record
// placements, ack cooldowns, and then SELF-REPORT that it had done all of it. Every one of those
// is mechanical, every one drifted in practice ("you're just sending the AI instructions and
// hoping it follows"), and the server verified none of it.
//
// THE SHAPE NOW. The server computes EVERYTHING mechanical and the reviewer keeps exactly one
// job: judgment. A wake is:
//
//     GET  /api/orchestrator/worklist?reviewer=<sessionId>   -> typed WorkItems
//     POST /api/orchestrator/items/:id/resolve               -> approve/reject + note
//     POST /api/orchestrator/items/:id/verify                -> server CHECKS the outcome itself
//
// On approve the server executes every step it can reach (archive flags, imports, seeds,
// done-marks) and returns at most a tiny list of REVIEWER STEPS - exact tool calls with exact
// arguments, composed here, to be sent VERBATIM. The reviewer never writes a message, never
// picks a route, never does bookkeeping. And "executed" is no longer a self-report: verify()
// re-reads the world (did the transcript move? is the flag set? does the title match?) and only
// then closes the ledger row.
//
// WHAT STAYS WITH THE REVIEWER, by physical necessity, measured 2026-08-28: only a session
// running INSIDE a desktop app can boot that app's dormant chats (its session tool), and only a
// live session can receive a peer message (the machine-wide cc-msg pipes). The daemon has
// neither actuator. So delivery into chats is a reviewer step with server-composed args; every
// other side effect runs here.
//
// SURFACE PURITY (owner law, restated 2026-08-28: desktop stays desktop, console stays console;
// never cross-contaminate): threadSurfaceOf() derives a thread's surface from where it LIVES,
// and every plan in this file routes by that - never by the global handoffSurface preference,
// which describes new work, not existing threads.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { collectChats, type DossierChat } from './chat-dossier'
import { defaultClaudeUserDataDir, instancesRoot } from './core/paths'
import { db } from './db'
import {
  findDesktopChat,
  instanceDirForLabel,
  instanceRefForSession,
  invalidateSessionMetaCache,
} from './instance-sessions'
import {
  agentChatKvKey,
  composeAgentDelivery,
  isOrchAgentTitle,
  ORCH_AGENT_BOOT,
  ORCH_AGENT_TITLE,
} from './orch-agent'
import {
  ackAttention,
  bandForPct,
  clearPendingRename,
  getOrchestratorPrompts,
  getOrchestratorSettings,
  instanceHasOtherOpenChats,
  isDeafPassiveSession,
  type LiveSession,
  listPendingRenames,
  noteArchiveVisibilityPending,
  orchestratorView,
  readLiveRegistry,
  repoRootForCwd,
  samePath,
} from './orchestrator'
import { readTailInfo } from './orchestrator-transcript-tail'
import { decideProposal, getProposal, reportProposalExecuted } from './proposals'
import {
  applyDesktopChatAutomation,
  archiveDesktopChat,
  importSessionToDesktop,
  launchTerminalSession,
  liveSessionEntry,
  seedDesktopSession,
} from './session-launch'
import { sessionMarkKey } from './sessions'
import { findTranscript } from './transcript'
import type {
  AttentionItem,
  OrchestratorProposal,
  OrchestratorSettings,
  OrchestratorView,
} from './types'
import { desktopKey } from './usage-service'

// --- the contract -------------------------------------------------------------------------------

/** One exact tool call the reviewer makes VERBATIM. Args are complete; nothing is composed or
 *  decided on the reviewer's side. `send_message`/`set_session_title` are the app session tools
 *  (own instance only - the server has already checked that); `SendMessage` is the cross-session
 *  peer tool and `args.to` is the live peer name from the registry, never constructed. */
export interface ReviewerStep {
  tool: 'send_message' | 'SendMessage' | 'set_session_title'
  args: Record<string, string>
  why: string
}

export interface WorkItem {
  /** Proposal id, `att:<key>` for attention-derived items, or `rename:<sessionId>`. */
  id: string
  kind:
    | 'revive'
    | 'archive'
    | 'import'
    | 'work'
    | 'seed-agent'
    | 'nudge'
    | 'answer'
    | 'stale'
    | 'hard-cutoff'
    | 'commit-nudge'
    | 'branch-nudge'
    | 'errored'
    | 'rename'
    | 'handoff'
  title: string
  /** The ONE judgment call. Everything mechanical is already decided and listed below. */
  question: string
  evidence: Record<string, unknown>
  /** What the server already handled, so the reviewer knows not to re-derive it. */
  constraintsApplied: string[]
  /** True when approving can complete entirely server-side (no reviewer step). */
  serverOnly: boolean
  /** Present when delivery is impossible right now - approving parks the item. */
  unreachable?: string
}

export interface ResolveResult {
  ok: boolean
  reason?: string
  /** Steps the reviewer must now perform verbatim, then call verify. Empty = all done. */
  reviewerSteps?: ReviewerStep[]
  /** Set when the server finished everything during resolve (serverOnly items). */
  completed?: boolean
  result?: string
}

export interface VerifyResult {
  ok: boolean
  state: 'verified' | 'pending' | 'failed' | 'not-found'
  detail: string
}

// --- kv state for multi-wake items --------------------------------------------------------------

interface ItemState {
  phase: 'delivered' | 'closeout-delivered' | 'renamed' | 'handoff-continued'
  at: string
  targetSessionId: string
  instanceRef?: string | null
  expectTitle?: string
  /** Handoff continuations: the predecessor to archive once the successor's engine is verified. */
  oldSessionId?: string
  /** The reviewer steps handed out when this state was saved, so a re-resolve of an in-flight
   *  item can RE-RETURN them instead of stranding a reviewer whose first read was lost (found
   *  live: a truncated read left the exact verbatim message unrecoverable). */
  steps?: ReviewerStep[]
}

function stateKey(itemId: string): string {
  return `wl:${itemId}`
}
function loadState(itemId: string): ItemState | null {
  const row = db
    .query<{ value: string }, [string]>('select value from orchestrator_kv where key = ?')
    .get(stateKey(itemId))
  if (!row) return null
  try {
    return JSON.parse(row.value) as ItemState
  } catch {
    return null
  }
}
function saveState(itemId: string, s: ItemState): void {
  db.query(
    `insert into orchestrator_kv (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(stateKey(itemId), JSON.stringify(s), new Date().toISOString())
}
function clearState(itemId: string): void {
  db.query('delete from orchestrator_kv where key = ?').run(stateKey(itemId))
}

// --- surface purity ------------------------------------------------------------------------------

/** Where a thread LIVES, derived from evidence rather than stored preference. 'desktop' when any
 *  desktop app carries it; 'terminal' otherwise (a bare CLI/terminal transcript). The global
 *  handoffSurface setting is a preference about NEW work and must never move an existing thread
 *  across surfaces - that is the cross-contamination the owner banned. */
export function threadSurfaceOf(sessionId: string): 'desktop' | 'terminal' {
  return findDesktopChat(sessionId) ? 'desktop' : 'terminal'
}

// --- message composition -------------------------------------------------------------------------

const FILE_TOOLS_LINE =
  'Your permission mode prompts for shell commands and nobody is at the keyboard to approve one, ' +
  'so use FILE TOOLS ONLY (Read/Write/Edit/Grep) and run no shell commands. If the work genuinely ' +
  'needs a shell, say so plainly and stop rather than starting something that will hang.'

function collisionLineFor(sessionId: string, view: OrchestratorView): string | null {
  for (const c of view.collisions) {
    const involved = c.chats.some((ch) => ch.sessionId === sessionId)
    const others = c.chats.filter((ch) => ch.sessionId !== sessionId)
    if (involved && others.length > 0)
      return `Heads up: other live chats are working in ${c.where} right now (${others
        .map((o) => o.name)
        .join(', ')}). If you see an unexpected change, say so before overwriting it.`
  }
  return null
}

/** The revive message, fully composed. The reviewer sends this verbatim. */
export function composeRevive(opts: {
  prompts: Record<string, string>
  flavor: string | undefined
  resumePrompt?: string | null
  permissionMode?: string | null
  collisionLine?: string | null
}): string {
  const base =
    opts.flavor === 'limit-reset' && opts.resumePrompt?.trim()
      ? opts.resumePrompt.trim()
      : opts.prompts.orphanRevive
  const parts = [base]
  if (opts.permissionMode && opts.permissionMode !== 'bypassPermissions')
    parts.push(FILE_TOOLS_LINE)
  if (opts.collisionLine) parts.push(opts.collisionLine)
  return parts.join('\n\n')
}

// --- routing -------------------------------------------------------------------------------------

export interface Route {
  mode: 'direct-live' | 'own-instance' | 'agent-chat' | 'none'
  step?: ReviewerStep
  whyNone?: string
}

/** The metadata slice routing reads per session, injectable for tests. */
export interface RouteLookup {
  findChat?: (sessionId: string) => { chatId?: string | null; title?: string | null } | null
  instanceRef?: (sessionId: string) => string | null
}

/**
 * The one live session allowed to courier into `instanceRef`'s dormant chats: that instance's
 * ORCHESTRATOR AGENT CHAT (orch-agent.ts), live and awake. Admission is the TITLE MARKER and
 * nothing else - a heuristic ("any awake chat there") is the banned relay rung back under a
 * new name, so a live working chat in the right instance is never a candidate no matter how
 * convenient. A deaf agent chat (seeded, never booted) cannot run its tool yet and is skipped.
 */
export function findLiveOrchAgent(
  instanceRef: string,
  live: LiveSession[],
  now: number,
  lookup: Required<RouteLookup>,
): LiveSession | null {
  for (const s of live) {
    if (!isOrchAgentTitle(lookup.findChat(s.sessionId)?.title)) continue
    const r = lookup.instanceRef(s.sessionId)
    if (!r || !samePath(r.slice('desktop:'.length), instanceRef.slice('desktop:'.length))) continue
    if (isDeafPassiveSession(s, now)) continue
    return s
  }
  return null
}

/**
 * The delivery ladder, computed instead of remembered. Given a target session and the reviewer's
 * own session, produce the ONE reviewer step that lands a message - or say honestly that none
 * exists right now. This replaces the four prose rungs and the two measured failure modes that
 * came from hand-picking them (a constructed chat id addressing nothing; rung 1 booting another
 * instance's chat on the wrong account).
 */
export function computeRoute(opts: {
  targetSessionId: string
  reviewerSessionId: string
  message: string
  live: LiveSession[]
  now?: number
  /** Seams for tests; the defaults read the real cached metadata index. */
  lookup?: RouteLookup
}): Route {
  const now = opts.now ?? Date.now()
  const findChat = opts.lookup?.findChat ?? findDesktopChat
  const instanceRef = opts.lookup?.instanceRef ?? instanceRefForSession
  const liveEntry = opts.live.find((s) => s.sessionId === opts.targetSessionId)
  if (liveEntry && !isDeafPassiveSession(liveEntry, now)) {
    return {
      mode: 'direct-live',
      step: {
        tool: 'SendMessage',
        args: { to: liveEntry.name, message: opts.message },
        why: 'target is a live, awake session - peer pipes are machine-wide',
      },
    }
  }
  const meta = findChat(opts.targetSessionId)
  if (!meta?.chatId)
    return { mode: 'none', whyNone: 'no desktop entry and no live process - nothing to address' }
  const targetInstance = instanceRef(opts.targetSessionId)
  const reviewerInstance = instanceRef(opts.reviewerSessionId)
  if (
    targetInstance &&
    reviewerInstance &&
    samePath(targetInstance.slice('desktop:'.length), reviewerInstance.slice('desktop:'.length))
  ) {
    return {
      mode: 'own-instance',
      step: {
        tool: 'send_message',
        args: { session_id: meta.chatId, message: opts.message },
        why: 'dormant chat in YOUR instance - your session tool boots it on the right account',
      },
    }
  }
  // Another instance. The relay rung - commandeering an awake WORKING chat there as a courier -
  // existed here until 2026-08-28 and is BANNED by owner directive (Michael, verbatim: "REMOVE
  // THE RELAY TASK FUNCTIONALITY... Don't just message other chats"). A working chat is
  // someone's thread of work, not the orchestrator's errand runner. The sanctioned courier is
  // the instance's own ORCHESTRATOR AGENT CHAT (orch-agent.ts): system-owned, marker-titled,
  // whose whole job is performing composed delivery steps inside its instance. Only that chat -
  // by marker, never by heuristic - is ever addressed.
  if (targetInstance) {
    const agent = findLiveOrchAgent(targetInstance, opts.live, now, { findChat, instanceRef })
    if (agent)
      return {
        mode: 'agent-chat',
        step: {
          tool: 'SendMessage',
          args: { to: agent.name, message: composeAgentDelivery(meta.chatId, opts.message) },
          why: `courier: ${agent.name} is ${targetInstance}'s orchestrator agent chat - it delivers into its own instance's dormant chat and reports`,
        },
      }
  }
  return {
    mode: 'none',
    whyNone: `dormant in ${targetInstance ?? 'an unknown instance'} with no live orchestrator agent chat there - deliverable once its agent chat is live (the seed-agent item), or by a reviewer inside that instance; relaying through its working chats is banned by owner directive (2026-08-28)`,
  }
}

// --- verification --------------------------------------------------------------------------------

/** The last assistant TEXT in a transcript - the handoff prompt lives here when the predecessor
 *  has written it. Reads the file tail directly (the TailInfo parser deliberately carries flags,
 *  not text). Returns null rather than guessing when nothing parses. */
export function lastAssistantText(path: string): string | null {
  try {
    const { readFileSync, statSync } = require('node:fs') as typeof import('node:fs')
    const size = statSync(path).size
    const WINDOW = 256 * 1024
    const buf = readFileSync(path)
    const text = buf.subarray(Math.max(0, size - WINDOW)).toString('utf8')
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line) as {
          type?: string
          message?: { role?: string; content?: unknown }
        }
        if (rec.type !== 'assistant') continue
        const content = rec.message?.content
        const parts = Array.isArray(content)
          ? content
              .filter((b) => (b as { type?: string }).type === 'text')
              .map((b) => (b as { text?: string }).text ?? '')
          : typeof content === 'string'
            ? [content]
            : []
        const joined = parts.join('\n').trim()
        if (joined) return joined
      } catch {
        // a partial first line of the window, or a non-JSON line - keep walking
      }
    }
  } catch {
    // unreadable transcript: the caller falls back honestly
  }
  return null
}

/**
 * ANCHOR GUARD: never retire the last awake chat of a running instance while other work is
 * still aimed there - that is how an account goes dark for delivery (measured: Martin,
 * 2026-08-28). Returns the refusal reason, or null when the retirement is safe. Called at
 * RESOLVE and again at VERIFY, because the instance's population can change between the two
 * (found by review: a resolve-only guard re-opened the exact measured failure).
 */
function anchorRefusal(
  sessionId: string,
  excludeProposalId: string,
  live: LiveSession[],
  view: OrchestratorView,
): string | null {
  const targetInstance = instanceRefForSession(sessionId)
  if (!targetInstance) return null
  const targetIsAwake = live.some((s) => s.sessionId === sessionId && !isDeafPassiveSession(s))
  if (!targetIsAwake) return null
  const awakeHere = live.filter((s) => {
    if (s.sessionId === sessionId) return false
    if (isDeafPassiveSession(s)) return false
    const r = instanceRefForSession(s.sessionId)
    return !!r && samePath(r.slice('desktop:'.length), targetInstance.slice('desktop:'.length))
  })
  if (awakeHere.length > 0) return null
  const workAimedHere = view.proposals.filter(
    (q) =>
      q.id !== excludeProposalId &&
      (q.status === 'proposed' || q.status === 'approved') &&
      !!q.instanceRef &&
      samePath(q.instanceRef.slice('desktop:'.length), targetInstance.slice('desktop:'.length)),
  ).length
  if (workAimedHere === 0) return null
  return (
    `anchor: this is the last awake chat in ${targetInstance} and ${workAimedHere} item(s) ` +
    'still aim there - land the replacement first, then retire this one'
  )
}

/**
 * ONE CHAT PER REPO, checked against the LIVE registry at execution time. The collisions feed
 * only lists repos that ALREADY have two chats, so it cannot veto adding the second one - the
 * exact clobber the rule exists to prevent (found by review). Root-folded so a chat working in
 * a subdirectory or linked worktree still counts as occupying the repo.
 */
export function repoOccupied(
  cwd: string,
  live: LiveSession[],
  titleOf: (sessionId: string) => string | null | undefined = (id) => findDesktopChat(id)?.title,
): string | null {
  const targetRoot = repoRootForCwd(cwd) ?? cwd
  for (const s of live) {
    if (!s.cwd) continue
    if (isDeafPassiveSession(s)) continue
    // The orchestrator agent chat is a courier, not an occupant - it never works in a repo, so
    // it must never veto placing real work (its cwd is its instance's own profile dir, but the
    // marker is the rule; the cwd shape is not).
    if (isOrchAgentTitle(titleOf(s.sessionId))) continue
    const root = repoRootForCwd(s.cwd) ?? s.cwd
    if (samePath(root, targetRoot)) return s.name
  }
  return null
}

/** The done-mark, written the same way the /done endpoint writes it: the lineage ledger entry
 *  that says a successor owns this thread. Done-marking BEFORE the successor starts is the
 *  one-lineage-one-continuation law; the server does it so it cannot be forgotten. */
function markSessionDone(sessionId: string): void {
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, ?, ?) ' +
      'on conflict(session_id) do update set done = ?, updated_at = ?',
  ).run(sessionMarkKey('claude', sessionId), 1, Date.now(), 1, Date.now())
}

/** The newest event timestamp in a session's transcript, or null. Companion to
 *  transcriptMovedSince for callers that need the quiet test, not just the moved test. */
export function lastEventAtOf(
  sessionId: string,
  readTail: (path: string) => { lastEventAt: string | null } = readTailInfo,
  lookup: (sessionId: string) => { path: string } | null = (id) => findTranscript(id, 'claude'),
): string | null {
  const t = lookup(sessionId)
  if (!t) return null
  try {
    return readTail(t.path).lastEventAt
  } catch {
    return null
  }
}

/** Did the target's transcript gain an event after `afterIso`? The only honest meaning of "the
 *  delivery ran": a process existing proves nothing, and a reviewer's DONE is a claim. Seam for
 *  tests. */
export function transcriptMovedSince(
  sessionId: string,
  afterIso: string,
  readTail: (path: string) => { lastEventAt: string | null } = readTailInfo,
  lookup: (sessionId: string) => { path: string } | null = (id) => findTranscript(id, 'claude'),
): boolean {
  const t = lookup(sessionId)
  if (!t) return false
  try {
    const last = readTail(t.path).lastEventAt
    if (!last) return false
    return Date.parse(last) > Date.parse(afterIso)
  } catch {
    return false
  }
}

// --- the worklist --------------------------------------------------------------------------------

/** Attention kinds that never need reviewer judgment: the server acks them itself with the same
 *  action/cooldown the rubric used to ask the reviewer to type. This is half the old chore list
 *  gone - the reviewer only ever SEES actionable items. */
function autoAckIfNoAction(
  a: AttentionItem,
  reviewerSessionId: string,
  live: LiveSession[],
): string | null {
  const c = classifyAutoAck(a, reviewerSessionId, live)
  return c ? ack(a, c.action, c.cooldownMins) : null
}

/** The CLASSIFICATION half of auto-acking, split out so the dry run can ask "what would you
 *  handle yourself?" without writing a single ack row. Returns null for items needing judgment. */
export function classifyAutoAck(
  a: AttentionItem,
  reviewerSessionId: string,
  live: LiveSession[],
): { action: string; cooldownMins: number } | null {
  const d = (a.detail ?? {}) as Record<string, unknown>
  if (a.sessionId === reviewerSessionId) return { action: 'auto:self-reviewer', cooldownMins: 720 }
  switch (a.kind) {
    case 'orphaned':
      // the revive proposal is where action happens
      return { action: 'auto:see-proposal', cooldownMins: 60 }
    case 'interrupted':
      // never auto-resume a human stop
      return { action: 'auto:human-interrupted', cooldownMins: 360 }
    case 'limit_stopped':
      return { action: 'auto:monitor-jurisdiction', cooldownMins: 120 }
    case 'usage_alert': {
      // placement already excludes it
      if (!d.hardCutoff) return { action: 'auto:routing-away', cooldownMins: 60 }
      // A hard cutoff is only actionable while chats are LIVE on that account - "tell its chats
      // to wrap up" with zero chats there is noise (measured on the first live worklist: four
      // cutoff items for four closed apps). Placement already refuses the account either way.
      const anyLiveThere =
        !!a.instanceRef &&
        live.some((s) => {
          const r = instanceRefForSession(s.sessionId)
          return (
            !!r &&
            samePath(r.slice('desktop:'.length), (a.instanceRef ?? '').slice('desktop:'.length))
          )
        })
      if (!anyLiveThere) return { action: 'auto:no-live-chats-there', cooldownMins: 60 }
      return null
    }
    case 'errored': {
      // Only an OVERLOAD gets a nudge ("continue where you left off"); an error/refused ending
      // is the owner's to see, and sending ANY proceed-style message into it is the one thing
      // you must not do. The ack action string is how it reaches the recap.
      if (d.ending !== 'overload') return { action: 'auto:needs-owner', cooldownMins: 360 }
      return null
    }
    case 'idle_pending': {
      const lastHuman = typeof d.lastHumanAt === 'string' ? Date.parse(d.lastHumanAt) : Number.NaN
      if (Number.isFinite(lastHuman) && Date.now() - lastHuman < 30 * 60_000)
        return { action: 'auto:human-active', cooldownMins: 30 }
      if (d.midTurn && !d.staleTasks) return { action: 'auto:waiting-on-task', cooldownMins: 30 }
      if (d.waitingForSlot) return null // skip WITHOUT acking - the cap's rotation handles it
      return null
    }
    default:
      return null
  }
}
function ack(a: AttentionItem, action: string, cooldownMins: number): string {
  ackAttention(a.key, action, cooldownMins)
  return `${a.key} -> ${action}`
}

function proposalToItem(
  p: OrchestratorProposal,
  view: OrchestratorView,
  reviewerSessionId: string,
  live: LiveSession[],
): WorkItem {
  const ev = p.evidence as Record<string, unknown>
  const constraints: string[] = []
  let unreachable: string | undefined
  let serverOnly = false
  let question = ''
  switch (p.kind) {
    case 'revive': {
      const msg = composeRevive({
        prompts: getOrchestratorPrompts(),
        flavor: typeof ev.flavor === 'string' ? ev.flavor : undefined,
        resumePrompt: typeof ev.resumePrompt === 'string' ? ev.resumePrompt : null,
        permissionMode: typeof ev.permissionMode === 'string' ? ev.permissionMode : null,
        collisionLine: collisionLineFor(p.sessionId, view),
      })
      const route = computeRoute({
        targetSessionId: p.sessionId,
        reviewerSessionId,
        message: msg,
        live,
      })
      constraints.push(
        'message composed server-side (permission-mode and collision handling included)',
        `route computed: ${route.mode}`,
      )
      // A revive is a resume: the same limit-risk flag the attention-derived items carry. The
      // proposal's evidence inherits the account fields from the source item's detail spread.
      const risk = usageRiskFlag(ev, getOrchestratorSettings())
      if (risk) constraints.push(risk)
      if (route.mode === 'none') unreachable = route.whyNone
      question =
        'Is this lineage genuinely unfinished and not superseded, so it should get its next turn?'
      break
    }
    case 'archive': {
      question =
        'Does the done-mark story hold (no live unfinished work under it), so this thread should be retired?'
      constraints.push(
        'closeout-before-archive is enforced by the server: approving delivers the closeout, and the flag is only flipped after the transcript moves (or immediately, recorded as un-closed-out, when the chat is unreachable)',
      )
      break
    }
    case 'import': {
      question = 'Is this finished session worth a sidebar entry (not plumbing residue)?'
      serverOnly = true
      constraints.push('import + rename tracking run server-side on approve')
      break
    }
    case 'work': {
      question = 'Is this backlog item real work worth starting a visible chat for?'
      constraints.push(
        'seeding, placement recording and opening-prompt composition run server-side; the ultracode prefix is applied per settings',
      )
      break
    }
    case 'seed-agent': {
      question =
        'Should this instance get its orchestrator agent chat - the system-owned courier that delivers into its dormant chats?'
      constraints.push(
        'seed, bypass-stamp verification (the app-boot re-save race) and kv tracking run server-side; the chat is excluded from monitor and janitor jurisdiction by its title marker',
      )
      break
    }
    default:
      question = 'Approve this action?'
  }
  return {
    id: p.id,
    kind: p.kind as WorkItem['kind'],
    title: p.title ?? p.kind,
    question,
    evidence: { summary: p.summary, ...ev },
    constraintsApplied: constraints,
    serverOnly,
    unreachable,
  }
}

/**
 * The limit-risk line for a message-sending item, from the account fields its evidence already
 * carries (see accountUsageEvidence in orchestrator.ts). Null when the account is healthy — or
 * unknown: an unmapped instance is its own attention item, and a missing reading must not
 * fabricate a warning.
 *
 * Mirrors instanceBlockedWhy(), the placement blocker: a weekly high/critical band and a 5-hour
 * window at/over sessionHighPct are exactly the states in which placement refuses to hand an
 * account NEW work — so a resume/nudge into its EXISTING chat carries at minimum a flag the
 * reviewer cannot miss. This exists because on 2026-08-29 a reviewer blind-approved a resume
 * whose evidence showed account:null, and 24 minutes later the chat died mid-edit on "You've
 * hit your session limit · resets 10:30pm".
 */
export function usageRiskFlag(ev: Record<string, unknown>, s: OrchestratorSettings): string | null {
  const wkPct = typeof ev.accountWeeklyPct === 'number' ? ev.accountWeeklyPct : null
  const sessPct = typeof ev.accountSessionPct === 'number' ? ev.accountSessionPct : null
  const parts: string[] = []
  if (wkPct !== null) {
    const band = bandForPct(wkPct, s)
    if (band === 'high' || band === 'critical') parts.push(`weekly at ${wkPct}% (${band})`)
  }
  if (sessPct !== null && sessPct >= s.sessionHighPct) {
    const resets =
      typeof ev.accountSessionResetsAt === 'string' && ev.accountSessionResetsAt
        ? `, resets ${ev.accountSessionResetsAt}`
        : ''
    parts.push(`5-hour window at ${sessPct}%${resets}`)
  }
  if (parts.length === 0) return null
  const who = typeof ev.account === 'string' && ev.account ? ev.account : 'target account'
  return `⚠ LIMIT RISK: ${who} ${parts.join(', ')} — a resume/nudge here can die mid-turn at the cap; approve only if it must run now, otherwise reject and let the window reset`
}

function attentionToItem(
  a: AttentionItem,
  view: OrchestratorView,
  opts: { dryRun?: boolean } = {},
): WorkItem | null {
  const item = attentionToItemBase(a, view, opts)
  // Every kind this builder emits sends a proceed-style message INTO the target chat except
  // 'hard-cutoff', whose message IS "wrap up" — there the limit is the point, not a hazard.
  if (item && item.kind !== 'hard-cutoff') {
    const risk = usageRiskFlag(item.evidence, getOrchestratorSettings())
    if (risk) item.constraintsApplied.push(risk)
  }
  return item
}

function attentionToItemBase(
  a: AttentionItem,
  view: OrchestratorView,
  opts: { dryRun?: boolean } = {},
): WorkItem | null {
  const d = (a.detail ?? {}) as Record<string, unknown>
  const prompts = getOrchestratorPrompts()
  const base = {
    id: `att:${a.key}`,
    title: a.summary.slice(0, 120),
    evidence: { ...d, tail: a.tailSnippet ?? null, peerName: a.peerName ?? null },
    serverOnly: false,
  }
  switch (a.kind) {
    case 'idle_pending': {
      if (d.approvalStall)
        return {
          ...base,
          kind: 'revive',
          question:
            'This chat is frozen at a permission prompt nobody can click. Revive it onto file tools only?',
          constraintsApplied: ['file-tools-only line composed into the message'],
        }
      if (d.staleTasks)
        return {
          ...base,
          kind: 'stale',
          question:
            "The daemon's own 120-minute threshold says this chat is waiting on dead background tasks. Nudge it?",
          constraintsApplied: [
            'emitted only past the daemon threshold - the reviewer can no longer fire this early',
          ],
        }
      if (d.recapDetected)
        return {
          ...base,
          kind: 'nudge',
          question:
            'This idle chat ended with a recap. Resume it on its own recommendations (name a safe subset in messageOverride if they are mixed)?',
          constraintsApplied: ['resumeNudge composed server-side; override only narrows scope'],
        }
      return {
        ...base,
        kind: 'answer',
        question:
          'This chat appears to be waiting on input. Send the standing answer (or messageOverride with a specific one)?',
        constraintsApplied: ['standing answer composed server-side'],
      }
    }
    case 'handoff_due':
      if (d.handoffDetected)
        return {
          ...base,
          kind: 'handoff',
          question:
            'The handoff text is present in the tail. Done-mark this chat, seed its continuation on the recommended account, and start it?',
          constraintsApplied: [
            'the server extracts the handoff text, done-marks the predecessor FIRST, seeds at the placement recommendation, records the placement, and archives the predecessor only after the successor engine is verified',
          ],
        }
      return {
        ...base,
        kind: 'handoff',
        question: 'Context is past the threshold. Ask this chat for its handoff now?',
        constraintsApplied: [
          'request message composed server-side; the continue phase appears as its own item once the handoff text lands',
        ],
      }
    case 'usage_alert':
      return {
        ...base,
        kind: 'hard-cutoff',
        question: 'This account hit hard cutoff. Tell its live chats to wrap up?',
        constraintsApplied: [`hardCutoff message composed: ${prompts.hardCutoff.slice(0, 60)}...`],
      }
    case 'repo_dirty': {
      const inCollision = view.collisions.some((c) => samePath(c.where, a.cwd ?? ''))
      if (inCollision) {
        // The prose rule ("never commitNudge into a colliding repo") is now a refusal: the item
        // simply is not offered while a second chat stands in the tree. The dry run reports this
        // suppression itself (buildDryRun repeats the collision test) and must not write the ack.
        if (!opts.dryRun) ackAttention(a.key, 'auto:collision-suppressed', 60)
        return null
      }
      return {
        ...base,
        kind: 'commit-nudge',
        question:
          'Dirty files with all sessions idle. Send the commit nudge (public-repo check included)?',
        constraintsApplied: ['refused automatically while the repo has two live chats'],
      }
    }
    case 'branch_off_main':
      return {
        ...base,
        kind: 'branch-nudge',
        question: 'A chat is off main. Send the branch nudge?',
        constraintsApplied: [],
      }
    case 'errored':
      // Non-overload endings are auto-acked as needs-owner before this point; what remains IS
      // an overload, so the question can promise exactly one message.
      return {
        ...base,
        kind: 'errored',
        question: 'This chat stopped on a server overload. Send the overload nudge to continue?',
        constraintsApplied: [
          'error/refused endings never reach here - they auto-ack as needs-owner',
        ],
      }
    default:
      return null
  }
}

export interface Worklist {
  items: WorkItem[]
  autoAcked: string[]
  renames: Array<{ id: string; sessionId: string; title: string; step: ReviewerStep | null }>
  note: string
}

/**
 * The reviewer's whole wake, computed. Auto-acks the no-action attention kinds as a side effect
 * (they never reach the reviewer), wraps every open proposal and actionable attention item as a
 * typed WorkItem, and pre-routes renames.
 */
export function buildWorklist(reviewerSessionId: string): Worklist {
  const view = orchestratorView()
  const live = readLiveRegistry(join(homedir(), '.claude'))
  const autoAcked: string[] = []
  const items: WorkItem[] = []

  for (const p of view.proposals) {
    if (p.status !== 'proposed' && p.status !== 'approved') continue
    if (p.sessionId === reviewerSessionId) continue
    items.push(proposalToItem(p, view, reviewerSessionId, live))
  }
  for (const a of view.attention) {
    const acked = autoAckIfNoAction(a, reviewerSessionId, live)
    if (acked) {
      autoAcked.push(acked)
      continue
    }
    if (a.kind === 'idle_pending' && (a.detail as Record<string, unknown>)?.waitingForSlot) continue
    const item = attentionToItem(a, view)
    if (item) items.push(item)
  }
  const renames = listPendingRenames().map((r) => {
    const meta = findDesktopChat(r.sessionId)
    const reviewerInstance = instanceRefForSession(reviewerSessionId)
    const own =
      !!meta?.chatId &&
      !!reviewerInstance &&
      samePath(r.ref.slice('desktop:'.length), reviewerInstance.slice('desktop:'.length))
    return {
      id: `rename:${r.sessionId}`,
      sessionId: r.sessionId,
      title: r.title,
      step: own
        ? {
            tool: 'set_session_title' as const,
            args: { session_id: meta?.chatId ?? '', title: r.title },
            why: 'janitor renamed on disk under a running app; only an app rename sticks',
          }
        : null,
    }
  })
  return {
    items,
    autoAcked,
    renames,
    note:
      'Every message and route above is final - send reviewer steps verbatim, then call verify. ' +
      'Judgment (approve/reject + note) is the only input the server wants from you.',
  }
}

// --- resolve + verify ----------------------------------------------------------------------------

const ORCH_PREFIX_RE = /^\[orchestrator\]/

/** Every message the system sends into a chat starts with [orchestrator] - the invariant the
 *  command file promises. Enforced at composition, not remembered per branch (three templates
 *  ship without the prefix; found by review). */
function ensurePrefix(message: string): string {
  return ORCH_PREFIX_RE.test(message) ? message : `[orchestrator] ${message}`
}

function attentionByKey(key: string): AttentionItem | null {
  return orchestratorView().attention.find((a) => a.key === key) ?? null
}

/**
 * The reviewer's ruling, executed. For rejects: ledger updated, nothing acts. For approves: the
 * server runs every step it can reach and hands back the (at most one) delivery step it cannot.
 * Idempotent per item via kv state, so a wake that dies mid-item continues instead of repeating.
 */
export async function resolveWorkItem(opts: {
  itemId: string
  reviewerSessionId: string
  decision: 'approve' | 'reject'
  note: string
  messageOverride?: string
}): Promise<ResolveResult> {
  const { itemId, reviewerSessionId, decision, note } = opts
  const now = new Date().toISOString()
  const live = readLiveRegistry(join(homedir(), '.claude'))
  const view = orchestratorView()
  const prompts = getOrchestratorPrompts()

  // IDEMPOTENCE, enforced rather than claimed (found by adversarial review: without this, a
  // re-approve of a still-approved item re-seeded chats and re-delivered closeouts every wake).
  // An item with pending state is IN FLIGHT: the answer is "call verify", never a re-execution.
  const pending = loadState(itemId)
  if (pending && decision === 'approve') {
    // Re-return the saved steps: the reviewer's first read of them may have been lost, and the
    // step text is the verbatim contract - it must come from here, never be reconstructed.
    if (pending.steps?.length)
      return {
        ok: true,
        reason: `already in flight (phase: ${pending.phase}, since ${pending.at}) - steps re-issued; call verify after performing them`,
        reviewerSteps: pending.steps,
      }
    // States saved before steps were recorded: a plain-delivery revive is safe to recompose
    // (no server side effects), so fall through and let the executor re-issue it. Anything
    // with server side effects (seed, archive, handoff) stays blocked behind verify.
    const pendingProposal = getProposal(itemId)
    if (!(pending.phase === 'delivered' && pendingProposal?.kind === 'revive'))
      return {
        ok: true,
        reason: `already in flight (phase: ${pending.phase}, since ${pending.at}) - call verify`,
        reviewerSteps: [],
      }
  }
  if (pending && decision === 'reject') clearState(itemId)

  // Attention-derived items: the "execution" is one composed live send + the right ack.
  if (itemId.startsWith('att:')) {
    const key = itemId.slice('att:'.length)
    const a = attentionByKey(key)
    if (!a) return { ok: false, reason: 'attention item no longer present' }
    if (decision === 'reject') {
      ackAttention(key, `rejected:${note.slice(0, 60)}`, 120)
      return { ok: true, completed: true, result: 'acked without action' }
    }
    const d = (a.detail ?? {}) as Record<string, unknown>
    // HANDOFF: two phases, both mechanical once approved. Phase 1 asks for the handoff. Phase 2
    // (the tail carries it) extracts the text, DONE-MARKS THE PREDECESSOR FIRST (one lineage,
    // one continuation - enforced here, not remembered), seeds the continuation at the placement
    // recommendation, records the placement, and hands back the one delivery step. The
    // predecessor is archived by verify() only after the successor's engine is proven.
    if (a.kind === 'handoff_due' && a.sessionId) {
      if (!d.handoffDetected) {
        const message = prompts.handoffRequest
        const route = computeRoute({
          targetSessionId: a.sessionId,
          reviewerSessionId,
          message,
          live,
        })
        if (route.mode === 'none' || !route.step)
          return { ok: false, reason: `unreachable: ${route.whyNone}` }
        ackAttention(key, 'handoff-requested', 30)
        saveState(itemId, {
          phase: 'delivered',
          at: now,
          targetSessionId: a.sessionId,
          steps: [route.step],
        })
        return { ok: true, reviewerSteps: [route.step] }
      }
      const t = findTranscript(a.sessionId, 'claude')
      const handoffText = t ? lastAssistantText(t.path) : null
      if (!handoffText)
        return {
          ok: false,
          reason:
            'handoff flagged but no assistant text could be extracted - read the tail manually',
        }
      const target = view.placement.recommended
      if (!target)
        return { ok: false, reason: 'no account has headroom for the continuation - wait' }
      const meta = findDesktopChat(a.sessionId)
      const cwd = live.find((s) => s.sessionId === a.sessionId)?.cwd ?? a.cwd
      if (!cwd) return { ok: false, reason: 'cannot determine the thread cwd for the continuation' }
      markSessionDone(a.sessionId) // BEFORE the successor starts - never two continuations
      const seeded = await seedDesktopSession({
        cwd,
        title: meta?.title ?? a.summary.slice(0, 80),
        instanceRef: target,
      })
      if (!seeded.ok || !seeded.sessionId)
        return {
          ok: false,
          reason: `seed failed: ${seeded.reason ?? 'unknown'} (predecessor done-marked; un-mark via /done if abandoning)`,
        }
      // seedDesktopSession records its own placement; recording again here double-books the
      // account in the balancing ledger (found by review).
      const opening = `${view.newChatPrefix}${handoffText}`
      const route = computeRoute({
        targetSessionId: seeded.sessionId,
        reviewerSessionId,
        message: opening,
        live,
      })
      ackAttention(key, 'handoff-continued', 720)
      // The movement baseline is stamped AFTER the seed, or the seed's own bootstrap records
      // would satisfy verify with the opening never delivered (found by review).
      saveState(itemId, {
        phase: 'handoff-continued',
        at: new Date().toISOString(),
        targetSessionId: seeded.sessionId,
        oldSessionId: a.sessionId,
      })
      if (route.mode === 'none' || !route.step)
        return {
          ok: true,
          reason: `seeded ${seeded.sessionId} but no route to boot it yet: ${route.whyNone}`,
          reviewerSteps: [],
        }
      return { ok: true, reviewerSteps: [route.step] }
    }
    let message: string
    if (opts.messageOverride?.trim()) {
      message = ensurePrefix(opts.messageOverride.trim())
    } else if (a.kind === 'idle_pending' && d.approvalStall) {
      message = ensurePrefix(`${prompts.orphanRevive}\n\n${FILE_TOOLS_LINE}`)
    } else if (a.kind === 'idle_pending' && d.staleTasks) {
      message = ensurePrefix(
        prompts.staleTaskNudge.replace(
          '<duration>',
          `${Math.round((Number(d.quietSecs) || 0) / 60)} minutes`,
        ),
      )
    } else if (a.kind === 'idle_pending' && d.recapDetected) {
      message = ensurePrefix(prompts.resumeNudge)
    } else if (a.kind === 'usage_alert') {
      message = ensurePrefix(prompts.hardCutoff.replace('<n>', String(d.weeklyPct ?? '?')))
    } else if (a.kind === 'repo_dirty') {
      message = ensurePrefix(
        prompts.commitNudge
          .replace('<cwd>', a.cwd ?? 'the repo')
          .replace('<n>', String(d.dirtyCount ?? '?'))
          .replace('<m>', String(d.dirtyMins ?? '?')),
      )
    } else if (a.kind === 'branch_off_main') {
      message = ensurePrefix(prompts.branchNudge.replace('<x>', String(d.branch ?? '?')))
    } else if (a.kind === 'errored' && d.ending === 'overload') {
      // `ending`, not `errorKind` - the detail field the daemon actually writes (found by
      // review: the old key made this branch dead and sent proceed-anyway into overloads).
      message = ensurePrefix(prompts.overloadNudge)
    } else {
      message = ensurePrefix(
        'Standing instruction from the owner: don’t wait for owner input on ' +
          'anything that isn’t a genuine blocker. Make the call yourself - pick whatever is best ' +
          'for this codebase, consistent with its documentation and the owner’s recorded ' +
          'decisions, non-regressive, and reversible. Note the decision in the relevant markdown and ' +
          'proceed. Only stop for true blockers: credentials or access you don’t have, spending ' +
          'money, publishing or pushing a public repo, deleting real data, or anything irreversible.',
      )
    }
    // A HARD CUTOFF addresses an ACCOUNT, not a session (the item carries no sessionId - found
    // by review, which made the old path structurally unapprovable): the wrap-up goes to every
    // awake live chat in that instance, one step each.
    if (a.kind === 'usage_alert') {
      if (!a.instanceRef) return { ok: false, reason: 'usage alert names no instance' }
      const steps: ReviewerStep[] = live
        .filter((s) => {
          if (isDeafPassiveSession(s)) return false
          const r = instanceRefForSession(s.sessionId)
          return (
            !!r &&
            samePath(r.slice('desktop:'.length), (a.instanceRef ?? '').slice('desktop:'.length))
          )
        })
        .map((s) => ({
          tool: 'SendMessage' as const,
          args: { to: s.name, message },
          why: `live chat on the cutoff account ${a.instanceRef}`,
        }))
      if (steps.length === 0)
        return { ok: false, reason: 'no awake chats on that account any more - nothing to tell' }
      ackAttention(key, 'hard-cutoff-broadcast', 60)
      return { ok: true, reviewerSteps: steps }
    }
    // A FROZEN chat (approval stall) cannot read a peer message - it is stuck at a prompt, and
    // a send queues into the void (measured). The unfreeze is the revive machinery: stop the
    // stuck process, then boot the chat fresh through the app with the file-tools-only message.
    if (a.kind === 'idle_pending' && d.approvalStall && a.sessionId) {
      const stuck = liveSessionEntry(a.sessionId)
      if (stuck) {
        try {
          process.kill(stuck.pid)
        } catch {
          // already exiting
        }
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && liveSessionEntry(a.sessionId))
          await new Promise((r) => setTimeout(r, 250))
      }
      const freshLive = readLiveRegistry(join(homedir(), '.claude'))
      const route = computeRoute({
        targetSessionId: a.sessionId,
        reviewerSessionId,
        message,
        live: freshLive,
      })
      if (route.mode === 'none' || !route.step)
        return {
          ok: false,
          reason: `stopped the stuck process but no boot route: ${route.whyNone}`,
        }
      ackAttention(key, 'approval-stall-revived', 60)
      saveState(itemId, {
        phase: 'delivered',
        at: new Date().toISOString(),
        targetSessionId: a.sessionId,
      })
      return { ok: true, reviewerSteps: [route.step] }
    }
    // Everything else here is a LIVE-chat send. The item may name the target by sessionId or
    // only by peerName (repo_dirty and branch_off_main do - found by review).
    const targetLive =
      (a.sessionId ? live.find((s) => s.sessionId === a.sessionId) : undefined) ??
      (a.peerName ? live.find((s) => s.name === a.peerName) : undefined)
    if (!targetLive) return { ok: false, reason: 'target is not a live session any more' }
    ackAttention(key, `resolved:${a.kind}`, 60)
    // No verify state on purpose: a live target's transcript moves from its own work, so
    // "movement after resolve" would verify sends that never happened (found by review). The
    // ack is the bookkeeping; if the condition persists, the item resurfaces after cooldown.
    return {
      ok: true,
      reviewerSteps: [
        {
          tool: 'SendMessage',
          args: { to: targetLive.name, message },
          why: 'live target - direct peer send',
        },
      ],
    }
  }

  // Rename items.
  if (itemId.startsWith('rename:')) {
    const sessionId = itemId.slice('rename:'.length)
    const row = listPendingRenames().find((r) => r.sessionId === sessionId)
    if (!row) return { ok: false, reason: 'rename no longer pending' }
    const meta = findDesktopChat(sessionId)
    if (!meta?.chatId) return { ok: false, reason: 'no desktop entry to rename' }
    // Same own-instance check the worklist applies - the app session tool only reaches the
    // reviewer's own app, and handing the step out anyway pointed a rename at another
    // instance's chat id (found by review). Elsewhere-renames land on that app's next restart.
    const reviewerInstance = instanceRefForSession(reviewerSessionId)
    if (
      !reviewerInstance ||
      !samePath(row.ref.slice('desktop:'.length), reviewerInstance.slice('desktop:'.length))
    )
      return {
        ok: false,
        reason:
          'rename is in another instance - your session tool cannot reach it; the on-disk title lands when that app next restarts',
      }
    saveState(itemId, {
      phase: 'renamed',
      at: now,
      targetSessionId: sessionId,
      expectTitle: row.title,
    })
    return {
      ok: true,
      reviewerSteps: [
        {
          tool: 'set_session_title',
          args: { session_id: meta.chatId, title: row.title },
          why: 'only an app rename survives the app rewriting its own metadata',
        },
      ],
    }
  }

  // Proposal-backed items: the ledger is the action gate, exactly as before.
  const p = getProposal(itemId)
  if (!p) return { ok: false, reason: 'proposal not found' }
  if (p.status === 'proposed') {
    const ruled = decideProposal(itemId, decision === 'approve', reviewerSessionId, note)
    if (!ruled.ok) return { ok: false, reason: ruled.reason }
  } else if (p.status === 'approved') {
    // A previously-approved-but-parked item CAN be retired: the world moved (superseded, human
    // took over) after the approval. Without this the item returned every wake forever (found
    // by review). The ledger records it as failed-with-reason, which is honest: approved,
    // never executed, withdrawn.
    if (decision === 'reject') {
      reportProposalExecuted(itemId, false, `retired after approval: ${note.slice(0, 200)}`)
      clearState(itemId)
      return { ok: true, completed: true, result: 'retired (was approved, never executed)' }
    }
  } else {
    return { ok: false, reason: `already-${p.status}` }
  }
  if (decision === 'reject') return { ok: true, completed: true, result: 'rejected' }

  const ev = p.evidence as Record<string, unknown>
  switch (p.kind) {
    case 'revive': {
      const message =
        opts.messageOverride?.trim() ||
        composeRevive({
          prompts,
          flavor: typeof ev.flavor === 'string' ? ev.flavor : undefined,
          resumePrompt: typeof ev.resumePrompt === 'string' ? ev.resumePrompt : null,
          permissionMode: typeof ev.permissionMode === 'string' ? ev.permissionMode : null,
          collisionLine: collisionLineFor(p.sessionId, view),
        })
      const route = computeRoute({ targetSessionId: p.sessionId, reviewerSessionId, message, live })
      if (route.mode === 'none' || !route.step) {
        // SURFACE PURITY gives the fallback, not a preference: a thread with no desktop home is
        // a TERMINAL thread, and its revive is a visible terminal window the server launches
        // itself - the same no-fallthrough law monitor.ts enforces. Without this every CLI
        // lineage was "approved but parked" forever (found by review).
        if (threadSurfaceOf(p.sessionId) === 'terminal') {
          const cwd = typeof ev.cwd === 'string' && ev.cwd ? ev.cwd : null
          if (!cwd)
            return {
              ok: true,
              reason: `parked: terminal thread with no known cwd`,
              reviewerSteps: [],
            }
          const launched = await launchTerminalSession({
            cwd,
            prompt: message,
            instanceRef: p.instanceRef ?? undefined,
            resumeSessionId: p.sessionId,
            permissionMode: 'bypassPermissions',
          })
          if (!launched.ok)
            return {
              ok: true,
              reason: `parked: terminal launch failed: ${launched.reason}`,
              reviewerSteps: [],
            }
          saveState(itemId, {
            phase: 'delivered',
            at: new Date().toISOString(),
            targetSessionId: p.sessionId,
          })
          return {
            ok: true,
            completed: false,
            result: 'terminal resume launched',
            reviewerSteps: [],
          }
        }
        return { ok: true, reason: `approved but parked: ${route.whyNone}`, reviewerSteps: [] }
      }
      saveState(itemId, {
        phase: 'delivered',
        at: now,
        targetSessionId: p.sessionId,
        steps: [route.step],
      })
      return { ok: true, reviewerSteps: [route.step] }
    }
    case 'archive': {
      const anchor = anchorRefusal(p.sessionId, p.id, live, view)
      if (anchor) return { ok: false, reason: anchor }
      // The courier rail (orch-agent.ts): never retire an instance's agent chat while the
      // instance still has other chats - that strands every dormant chat beside it. Enforced
      // here as well as at proposal time, because a proposal can outlive the emptiness that
      // justified it.
      if (
        isOrchAgentTitle(findDesktopChat(p.sessionId)?.title) &&
        instanceHasOtherOpenChats(p.sessionId)
      )
        return {
          ok: false,
          reason:
            'this is the instance ORCHESTRATOR AGENT CHAT and the instance still has other chats - retiring the courier strands them; retire it only once the instance is otherwise empty',
        }
      // ONE CLOSEOUT PER LINEAGE, EVER. The ledger is the memory: if an archive for this session
      // already EXECUTED once, its closeout landed in that cycle, and delivering another one is
      // what keeps the thread alive - the closeout boots the chat, the boot rewrites its
      // metadata un-archived, the janitor proposes again, forever (measured: three resurrections
      // of the same three finished threads on 2026-08-28). Re-archives flip the flag directly;
      // the entry leaves the sidebar when that app restarts, and nothing re-boots the chat.
      const priorArchive = db
        .query<{ c: number }, [string]>(
          "select count(*) as c from orchestrator_proposals where kind = 'archive' and session_id = ? and status = 'executed'",
        )
        .get(p.sessionId)?.c
      if (priorArchive) {
        const res = await archiveDesktopChat(p.sessionId, true)
        for (const h of res.hits ?? [])
          if (h.changed && h.wasRunning) noteArchiveVisibilityPending(h.profile)
        invalidateSessionMetaCache()
        reportProposalExecuted(
          itemId,
          true,
          're-archived without a new closeout (one landed in a prior cycle); flag on disk, clears at that app restart',
        )
        return { ok: true, completed: true, result: 're-archived; no re-boot' }
      }
      // Closeout-before-archive, enforced: reachable chats get the closeout turn and the flag
      // flips only after verify() sees the transcript move. Unreachable chats are archived now,
      // honestly recorded as un-closed-out.
      const closeout = prompts.closeoutDocs
      const route = computeRoute({
        targetSessionId: p.sessionId,
        reviewerSessionId,
        message: closeout,
        live,
      })
      if (route.mode === 'none' || !route.step) {
        const res = await archiveDesktopChat(p.sessionId, true)
        for (const h of res.hits ?? [])
          if (h.changed && h.wasRunning) noteArchiveVisibilityPending(h.profile)
        invalidateSessionMetaCache()
        reportProposalExecuted(
          itemId,
          true,
          'archived UN-CLOSED-OUT (unreachable); flag on disk, visible until that app restarts',
        )
        return { ok: true, completed: true, result: 'archived un-closed-out (unreachable)' }
      }
      saveState(itemId, {
        phase: 'closeout-delivered',
        at: now,
        targetSessionId: p.sessionId,
        steps: [route.step],
      })
      return { ok: true, reviewerSteps: [route.step] }
    }
    case 'import': {
      const instanceDir = (p.instanceRef ?? '').slice('desktop:'.length)
      if (!instanceDir) return { ok: false, reason: 'proposal carries no instance_ref' }
      const imported = await importSessionToDesktop({
        sessionId: p.sessionId,
        instanceDir,
        title: p.title ?? undefined,
      })
      if (!imported.ok) {
        reportProposalExecuted(itemId, false, imported.reason ?? 'import failed')
        return { ok: false, reason: imported.reason ?? 'import failed' }
      }
      invalidateSessionMetaCache()
      reportProposalExecuted(itemId, true, 'imported; rename tracked by the janitor')
      return { ok: true, completed: true, result: 'imported' }
    }
    case 'work': {
      const cwd = typeof ev.cwd === 'string' ? ev.cwd : null
      // The opening is the fenced workStart template, not a bare summary: it carries the one-item
      // scope, the path-scoped-commit rails, and the gate item's ordered command list - the exact
      // fence whose absence once let a work chat bank a false green.
      const commands = Array.isArray(ev.commands)
        ? (ev.commands as unknown[]).filter((c) => typeof c === 'string').join(' && ')
        : 'none declared - the item text says what to do'
      const promptText = prompts.workStart
        .replace('<cwd>', cwd ?? 'the repo')
        .replace('<summary>', p.summary)
        .replace('<commands>', commands)
      const target = view.placement.recommended
      if (!cwd) return { ok: false, reason: 'work item carries no cwd' }
      if (!target) return { ok: false, reason: 'no account has headroom right now - wait' }
      const occupant = repoOccupied(cwd, live)
      if (occupant)
        return {
          ok: false,
          reason: `a live chat (${occupant}) is already in that repo - one chat per repo`,
        }
      const seeded = await seedDesktopSession({
        cwd,
        title: p.title ?? 'Backlog work',
        instanceRef: target,
      })
      if (!seeded.ok || !seeded.sessionId) {
        reportProposalExecuted(itemId, false, seeded.reason ?? 'seed failed')
        return { ok: false, reason: seeded.reason ?? 'seed failed' }
      }
      // seedDesktopSession records its own placement - a second record here double-books the
      // account (found by review).
      // The gate chat must know how to report its green, or the sweep re-proposes the same
      // gate forever (found by review): the resolveWith contract goes into the opening.
      const resolveWith = ev.resolveWith as { key?: string; sha?: string } | undefined
      const reportLine = resolveWith?.key
        ? `\n\nWhen the item is genuinely done, record it so the sweep stops re-proposing it:\n` +
          `curl -s -X POST http://localhost:7787/api/orchestrator/backlog/resolved -H "Content-Type: application/json" -d '${JSON.stringify(
            { key: resolveWith.key, ok: true, sha: resolveWith.sha ?? null },
          )}'`
        : ''
      const opening = `${view.newChatPrefix}${promptText}${reportLine}`
      const route = computeRoute({
        targetSessionId: seeded.sessionId,
        reviewerSessionId,
        message: opening,
        live,
      })
      // Stamped AFTER the seed, or the seed's own bootstrap records verify the delivery that
      // never happened (found by review - this was a blocker).
      saveState(itemId, {
        phase: 'delivered',
        at: new Date().toISOString(),
        targetSessionId: seeded.sessionId,
      })
      if (route.mode === 'none' || !route.step)
        return {
          ok: true,
          reason: `seeded ${seeded.sessionId} but no route to boot it: ${route.whyNone}`,
          reviewerSteps: [],
        }
      return { ok: true, reviewerSteps: [route.step] }
    }
    case 'seed-agent': {
      const ref = p.instanceRef
      if (!ref?.startsWith('desktop:'))
        return { ok: false, reason: 'proposal carries no instance_ref' }
      const dir = ref.slice('desktop:'.length)
      // Execution-time re-check by the same marker the router uses: the instance may have
      // grown its courier since the sweep proposed this (an owner rename, an earlier wake).
      invalidateSessionMetaCache()
      const existing = collectChats().find(
        (c) =>
          !c.archived &&
          isOrchAgentTitle(c.title) &&
          samePath(instanceDirForLabel(c.instance), dir),
      )
      if (existing) {
        reportProposalExecuted(itemId, true, `agent chat already present (${existing.chatId})`)
        return { ok: true, completed: true, result: 'agent chat already present' }
      }
      // The courier's cwd is the instance's own profile dir: real, unique per instance, and
      // never a repository - so it cannot trip repo collision or occupancy machinery even
      // before its marker-based exclusions apply.
      const seeded = await seedDesktopSession({
        cwd: dir,
        title: ORCH_AGENT_TITLE,
        instanceRef: ref,
      })
      if (!seeded.ok || !seeded.sessionId) {
        reportProposalExecuted(itemId, false, seeded.reason ?? 'seed failed')
        return { ok: false, reason: seeded.reason ?? 'seed failed' }
      }
      // The kv stamp is what lets the sweep recognize this chat even after a running app wipes
      // the seeded title (measured on every seed under a running app): the janitor then parks a
      // rename that restores the marker instead of seeding a duplicate courier.
      db.query(
        `insert into orchestrator_kv (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      ).run(agentChatKvKey(ref), seeded.sessionId, new Date().toISOString())
      // THE SEEDER RACE (fixed-mostly in 4d17558): a running app's boot re-save can overwrite
      // the bypassPermissions stamp. Verify via a fresh metadata read - the dossier's view of
      // the store - and re-stamp BEFORE handing out the boot step, so the courier's first turn
      // cannot deadlock on an approval prompt nobody can click.
      invalidateSessionMetaCache()
      let meta = findDesktopChat(seeded.sessionId)
      if (meta?.permissionMode !== 'bypassPermissions') {
        applyDesktopChatAutomation(dir, seeded.sessionId)
        invalidateSessionMetaCache()
        meta = findDesktopChat(seeded.sessionId)
      }
      const bypassOk = meta?.permissionMode === 'bypassPermissions'
      const route = computeRoute({
        targetSessionId: seeded.sessionId,
        reviewerSessionId,
        message: ORCH_AGENT_BOOT,
        live,
      })
      if (route.mode === 'none' || !route.step) {
        // Seeding another instance's courier is completable from here; BOOTING it is not (the
        // same bootstrap limit the unreachable feed names). Honest completion, stating what
        // remains and for whom - never a silent pass.
        reportProposalExecuted(
          itemId,
          true,
          `seeded ${seeded.sessionId}${
            bypassOk
              ? ''
              : ' - BYPASS STAMP UNVERIFIED: re-stamp via POST /api/sessions/:id/automation and re-check the dossier before booting'
          }; dormant until booted from inside that instance (the owner opens it, or a reviewer there delivers its boot turn)`,
        )
        return {
          ok: true,
          completed: true,
          result: `seeded; boot pending inside that instance (${route.whyNone})`,
        }
      }
      saveState(itemId, {
        phase: 'delivered',
        at: new Date().toISOString(),
        targetSessionId: seeded.sessionId,
        instanceRef: ref,
        steps: [route.step],
      })
      return bypassOk
        ? { ok: true, reviewerSteps: [route.step] }
        : {
            ok: true,
            reason:
              'bypass stamp could not be verified (running-app re-save race) - deliver the boot step, then re-stamp via POST /api/sessions/:id/automation and confirm via the dossier',
            reviewerSteps: [route.step],
          }
    }
    default:
      return { ok: false, reason: `no executor for kind ${p.kind}` }
  }
}

/**
 * The server checks the outcome ITSELF and only then closes the ledger. "Executed" stops being a
 * self-report: a delivery is executed when the target's transcript moved after the step was
 * handed out; an archive when the closeout landed and the flag flipped; a rename when the app's
 * own metadata carries the title.
 */
export async function verifyWorkItem(
  itemId: string,
  readTail: (path: string) => { lastEventAt: string | null } = readTailInfo,
): Promise<VerifyResult> {
  const st = loadState(itemId)
  if (!st) return { ok: false, state: 'not-found', detail: 'no pending state for this item' }
  if (st.phase === 'renamed') {
    invalidateSessionMetaCache()
    const meta = findDesktopChat(st.targetSessionId)
    if (meta?.title === st.expectTitle) {
      clearPendingRename(st.targetSessionId)
      clearState(itemId)
      return { ok: true, state: 'verified', detail: 'app metadata carries the title' }
    }
    return { ok: false, state: 'pending', detail: 'title not visible in app metadata yet' }
  }
  const moved = transcriptMovedSince(st.targetSessionId, st.at, readTail)
  if (!moved)
    return {
      ok: false,
      state: 'pending',
      detail: 'transcript has not moved since delivery - engine not confirmed yet',
    }
  if (st.phase === 'handoff-continued') {
    // The successor's engine is proven; NOW the predecessor leaves the sidebar. Doing this any
    // earlier risks retiring a thread whose continuation never started.
    if (st.oldSessionId) {
      const res = await archiveDesktopChat(st.oldSessionId, true)
      for (const h of res.hits ?? [])
        if (h.changed && h.wasRunning) noteArchiveVisibilityPending(h.profile)
      invalidateSessionMetaCache()
    }
    clearState(itemId)
    return {
      ok: true,
      state: 'verified',
      detail: 'continuation engine ran; predecessor archived (visible until that app restarts)',
    }
  }
  if (st.phase === 'closeout-delivered') {
    // The anchor guard runs AGAIN here: the instance's population can change between resolve
    // and verify, and archiving past it re-opens the exact measured account-goes-dark failure
    // (found by review). A refusal is 'pending', not failure - the world can change back.
    const live = readLiveRegistry(join(homedir(), '.claude'))
    const anchor = anchorRefusal(st.targetSessionId, itemId, live, orchestratorView())
    if (anchor) return { ok: false, state: 'pending', detail: anchor }
    // AND the chat must be QUIET, not merely moved. Flipping the flag while the closeout turn
    // is still finishing loses the archive: the app's end-of-turn metadata save rewrites the
    // entry un-archived, the janitor proposes it again, and the closeout re-boots the chat -
    // a resurrection loop measured live (the same finished thread came back three times on
    // 2026-08-28 before this gate existed; the adversarial review had flagged the ordering).
    const last = lastEventAtOf(st.targetSessionId, readTail)
    if (last && Date.now() - Date.parse(last) < 120_000)
      return {
        ok: false,
        state: 'pending',
        detail:
          'closeout ran but the turn may still be finishing - waiting for 2 quiet minutes so ' +
          "the app's final save cannot overwrite the archive flag",
      }
    const res = await archiveDesktopChat(st.targetSessionId, true)
    for (const h of res.hits ?? [])
      if (h.changed && h.wasRunning) noteArchiveVisibilityPending(h.profile)
    invalidateSessionMetaCache()
    reportProposalExecuted(
      itemId,
      true,
      'closeout landed (transcript moved); archived; visible until that app restarts',
    )
    clearState(itemId)
    return { ok: true, state: 'verified', detail: 'closeout landed; archived' }
  }
  // delivered (revive / work / handoff-request / approval-stall boots)
  if (!itemId.startsWith('att:') && !itemId.startsWith('rename:'))
    reportProposalExecuted(itemId, true, 'delivered; engine verified by transcript movement')
  clearState(itemId)
  return { ok: true, state: 'verified', detail: 'engine ran - transcript moved after delivery' }
}

// --- the dry run ---------------------------------------------------------------------------------
//
// Owner ask (Michael, 2026-08-28): "instead of the orchestrator actually just going and running,
// tell me what it would do with every chat and every open window - an orchestrator dry run - so
// I can tell you no that's wrong before it acts." This is that view: the SAME item builders the
// real wake uses, computed read-only. NOTHING here writes - no acks, no cooldowns, no reviewer
// stamp, no dispatch. A dry run that mutated state would be a probe that lies twice: once to the
// owner (it acted) and once to the next wake (its cooldowns are spent).

export interface DryRunChatRow {
  title: string | null
  chatId: string | null
  sessionId: string | null
  cwd: string | null
  lastActivityAt: string | null
  done: boolean
  live: { pid: number; peerName: string } | null
  permissionMode: string | null
}

export interface DryRun {
  generatedAt: string
  workMode: string
  reviewer: { lastSeenAt: string | null; presentWithin20m: boolean }
  instances: Array<{
    instance: string
    weeklyPct: number | null
    band: string | null
    chats: DryRunChatRow[]
    archivedCount: number
    /** The instance's orchestrator agent chat (orch-agent.ts), or null - the hole the
     *  seed-agent item exists to fill. Deliveries into this instance's dormant chats route
     *  through it and only it. */
    agentChat: { chatId: string | null; sessionId: string | null; live: boolean } | null
  }>
  wouldAsk: WorkItem[]
  wouldAutoHandle: string[]
  wouldSuppress: string[]
  inFlight: Array<{ itemId: string; phase: string; targetSessionId: string }>
  pendingRenames: Array<{ sessionId: string; title: string }>
  placement: unknown
  unreachable: unknown
  note: string
}

function liveByAnyId(live: LiveSession[], c: DossierChat): LiveSession | null {
  const ids = new Set<string>([c.cliSessionId ?? '', ...c.priorCliSessionIds])
  if (c.chatId?.startsWith('local_')) ids.add(c.chatId.slice('local_'.length))
  ids.delete('')
  return live.find((s) => ids.has(s.sessionId)) ?? null
}

/** The dry run's per-instance agent-chat summary: the courier's presence and liveness among an
 *  instance's OPEN chats, or null when it has none. Split out so the tracking is testable
 *  without a real machine store behind collectChats(). */
export function agentChatRowFor(
  open: DossierChat[],
  live: LiveSession[],
): { chatId: string | null; sessionId: string | null; live: boolean } | null {
  const a = open.find((c) => isOrchAgentTitle(c.title))
  if (!a) return null
  return { chatId: a.chatId, sessionId: a.cliSessionId, live: !!liveByAnyId(live, a) }
}

export function buildDryRun(reviewerSessionId = ''): DryRun {
  const view = orchestratorView()
  const live = readLiveRegistry(join(homedir(), '.claude'))

  // The fleet inventory: every open window, its sidebar chats, its weekly band.
  const doneIds = new Set(
    db
      .query<{ session_id: string }, []>('select session_id from session_marks where done = 1')
      .all()
      .map((r) =>
        r.session_id.includes(':')
          ? r.session_id.slice(r.session_id.indexOf(':') + 1)
          : r.session_id,
      ),
  )
  let usage: Record<string, { pct?: number; band?: string }> = {}
  try {
    const row = db
      .query<{ value: string }, []>("select value from orchestrator_kv where key = 'usagePrev'")
      .get()
    if (row) usage = JSON.parse(row.value)
  } catch {
    /* no usage snapshot yet - bands just read unknown */
  }
  const byInstance = new Map<string, DossierChat[]>()
  for (const c of collectChats()) {
    const list = byInstance.get(c.instance) ?? []
    list.push(c)
    byInstance.set(c.instance, list)
  }
  const instances = [...byInstance.entries()]
    .map(([instance, chats]) => {
      // usagePrev is keyed by the usage cache's own keys, which go through desktopKey() —
      // normalized, and 'default' lives at the Claude user-data dir, not under
      // ~/.claude-instances. The old hand-rolled `.toLowerCase()` join missed both.
      const dir =
        instance === 'default' ? defaultClaudeUserDataDir() : join(instancesRoot(), instance)
      const u = usage[desktopKey(dir)] ?? {}
      const open = chats.filter((c) => !c.archived)
      open.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
      return {
        instance,
        weeklyPct: typeof u.pct === 'number' ? u.pct : null,
        band: typeof u.band === 'string' ? u.band : null,
        chats: open.map((c): DryRunChatRow => {
          const l = liveByAnyId(live, c)
          const ids = new Set<string>([c.cliSessionId ?? '', ...c.priorCliSessionIds])
          return {
            title: c.title,
            chatId: c.chatId,
            sessionId: c.cliSessionId,
            cwd: c.cwd,
            lastActivityAt: c.lastActivityAt,
            done: [...ids].some((id) => doneIds.has(id)),
            live: l ? { pid: l.pid, peerName: l.name } : null,
            permissionMode: c.permissionMode,
          }
        }),
        archivedCount: chats.length - open.length,
        agentChat: agentChatRowFor(open, live),
      }
    })
    .sort((a, b) => a.instance.localeCompare(b.instance))

  // The would-be worklist: same builders as buildWorklist, zero writes.
  const wouldAsk: WorkItem[] = []
  const wouldAutoHandle: string[] = []
  const wouldSuppress: string[] = []
  for (const p of view.proposals) {
    if (p.status !== 'proposed' && p.status !== 'approved') continue
    if (reviewerSessionId && p.sessionId === reviewerSessionId) continue
    wouldAsk.push(proposalToItem(p, view, reviewerSessionId, live))
  }
  for (const a of view.attention) {
    const c = classifyAutoAck(a, reviewerSessionId, live)
    if (c) {
      wouldAutoHandle.push(`${a.key} -> ${c.action}`)
      continue
    }
    const d = (a.detail ?? {}) as Record<string, unknown>
    if (a.kind === 'idle_pending' && d.waitingForSlot) {
      wouldSuppress.push(`${a.key} -> waiting for a rotation slot`)
      continue
    }
    // Same test attentionToItem applies before suppressing a commit nudge; repeated here because
    // the dry run must REPORT the suppression, and the builder's contract is to return null.
    if (a.kind === 'repo_dirty' && view.collisions.some((x) => samePath(x.where, a.cwd ?? ''))) {
      wouldSuppress.push(`${a.key} -> collision-suppressed (two live chats in that repo)`)
      continue
    }
    const item = attentionToItem(a, view, { dryRun: true })
    if (item) wouldAsk.push(item)
  }

  const inFlight = db
    .query<{ key: string; value: string }, []>(
      "select key, value from orchestrator_kv where key like 'wl:%'",
    )
    .all()
    .map((r) => {
      try {
        const s = JSON.parse(r.value) as ItemState
        return { itemId: r.key.slice(3), phase: s.phase, targetSessionId: s.targetSessionId }
      } catch {
        return { itemId: r.key.slice(3), phase: 'unreadable', targetSessionId: '' }
      }
    })

  const lastSeen = db
    .query<{ value: string }, []>("select value from orchestrator_kv where key = 'lastReviewerAt'")
    .get()?.value
  return {
    generatedAt: new Date().toISOString(),
    workMode: view.settings.workMode,
    reviewer: {
      lastSeenAt: lastSeen ?? null,
      presentWithin20m: !!lastSeen && Date.now() - Date.parse(lastSeen) < 20 * 60_000,
    },
    instances,
    wouldAsk,
    wouldAutoHandle,
    wouldSuppress,
    inFlight,
    pendingRenames: listPendingRenames().map((r) => ({ sessionId: r.sessionId, title: r.title })),
    placement: view.placement,
    unreachable: view.unreachable,
    note: 'READ-ONLY PLAN. Nothing above ran, no cooldowns were spent, no reviewer stamp was written.',
  }
}

/** The owner-facing layout, rendered ONCE server-side so every surface shows the same picture. */
export function renderDryRunText(d: DryRun): string {
  const L: string[] = []
  const rev = d.reviewer.presentWithin20m
    ? `active (last call ${d.reviewer.lastSeenAt})`
    : `NONE${d.reviewer.lastSeenAt ? ` (last call ${d.reviewer.lastSeenAt})` : ' (never)'}`
  L.push(`ORCHESTRATOR DRY RUN - ${d.generatedAt} - workMode: ${d.workMode} - reviewer: ${rev}`)
  L.push('')
  L.push('OPEN WINDOWS')
  for (const i of d.instances) {
    const pct = i.weeklyPct == null ? '' : ` (${i.weeklyPct}% weekly${i.band ? `, ${i.band}` : ''})`
    L.push(`  ${i.instance}${pct}`)
    for (const c of i.chats) {
      const state = c.live ? `LIVE pid ${c.live.pid}` : 'idle'
      const done = c.done ? ' - done-marked' : ''
      const cwd = c.cwd ? ` - ${c.cwd}` : ''
      const title = c.title ?? c.chatId ?? '(untitled)'
      L.push(`    - ${title} - ${state}${done} - last ${c.lastActivityAt ?? '?'}${cwd}`)
    }
    if (i.archivedCount) L.push(`    (+${i.archivedCount} archived)`)
    // The courier line, always printed: "no agent chat" and "quiet instance" must never look
    // alike - that hole is exactly what the seed-agent item exists to fill.
    L.push(
      i.agentChat === null
        ? '    agent chat: NONE - dormant chats here have no delivery route from outside (see the seed-agent item)'
        : i.agentChat.live
          ? '    agent chat: LIVE - courier available for deliveries into this instance'
          : '    agent chat: seeded but not live - boot it from inside this instance (open it in the app)',
    )
  }
  L.push('')
  L.push(`WOULD ASK THE REVIEWER (${d.wouldAsk.length})`)
  d.wouldAsk.forEach((w, n) => {
    L.push(`  ${n + 1}. [${w.kind}] ${w.title}`)
    L.push(`     ${w.question}`)
    const summary = (w.evidence as Record<string, unknown>)?.summary
    if (typeof summary === 'string') L.push(`     evidence: ${summary}`)
    if (w.unreachable) L.push(`     UNREACHABLE: ${w.unreachable}`)
  })
  L.push('')
  L.push(`WOULD HANDLE ITSELF, NO REVIEWER INVOLVED (${d.wouldAutoHandle.length})`)
  for (const s of d.wouldAutoHandle) L.push(`  - ${s}`)
  if (d.wouldSuppress.length) {
    L.push(`WOULD SUPPRESS (${d.wouldSuppress.length})`)
    for (const s of d.wouldSuppress) L.push(`  - ${s}`)
  }
  if (d.inFlight.length) {
    L.push(`MID-DELIVERY FROM AN EARLIER WAKE (${d.inFlight.length})`)
    for (const f of d.inFlight) L.push(`  - ${f.itemId}: ${f.phase} -> ${f.targetSessionId}`)
  }
  if (d.pendingRenames.length) {
    L.push(`PENDING RENAMES (${d.pendingRenames.length})`)
    for (const r of d.pendingRenames) L.push(`  - ${r.sessionId.slice(0, 8)} -> "${r.title}"`)
  }
  L.push('')
  L.push(d.note)
  return L.join('\n')
}
