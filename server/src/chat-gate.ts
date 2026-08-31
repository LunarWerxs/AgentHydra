// server/src/chat-gate.ts - PIECE 8 of the orchestrator rebuild (owner-picked, 2026-08-29):
// THE GATE. Before anything acts on a chat, this call determines what state it is in. The
// owner's rule set, verbatim in spirit:
//
//   running  - the process is alive. Leave it alone (a long quiet spell can just be background
//              work; quietSecs is reported so a watcher can keep an eye, never a guess here).
//   crashed  - it was working and died without finishing (mid-turn death, kill, PC restart,
//              usage wall, overload, API error). These are the resume candidates.
//   finished - it ended on a completed turn. Three lanes, decided by STATED rules:
//                archive-candidate  - recap says done and nothing is being asked -> archive.
//                needs-input-review - it is waiting on an answer; an AI judges whether the
//                                     answer can be determined autonomously (the owner's
//                                     preference) or must go to a human. That judgment is the
//                                     ONE piece of AI residue in this design, and the gate
//                                     packages the exact evidence for it (lastAssistantText,
//                                     recap verdict, trailing question) so nothing re-derives
//                                     facts from the transcript.
//                human              - a person deliberately interrupted it; their move.
//
// Everything else here is deterministic code over transcript bytes and the live registry.
// Error/limit vocabulary is reused from session-ending/rate-limit-signal - no new taxonomy.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { classifyTranscriptTail, readTranscriptTailText } from './fleet'
import { findTranscriptById, readLiveRegistry, readOrphanedRegistry } from './live-registry'
import { classifyLimit, isApiErrorEvent } from './rate-limit-signal'
import { endingEventText } from './session-ending'

export type ChatGateState = 'running' | 'crashed' | 'finished'
export type CrashKind = 'mid-turn' | 'usage-limit' | 'overload' | 'refused' | 'error'
export type FinishedLane = 'archive-candidate' | 'needs-input-review' | 'human'

export interface ChatGateFinished {
  lane: FinishedLane
  /** The house recap block ("## Am I 100% done?") was present in the last assistant turn. */
  recapPresent: boolean
  doneClaim: 'yes' | 'no' | 'unknown'
  /** The last assistant text ends on a question. */
  endsWithQuestion: boolean
  /** A person pressed stop - deliberately theirs to pick back up. */
  interrupted: boolean
  /** Bounded evidence for the autonomy judgment - the last thing the chat said. */
  lastAssistantText: string
}

export interface ChatGate {
  sessionId: string
  state: ChatGateState
  /** The deterministic reason, in one human-readable line. */
  cause: string
  transcriptPath: string
  quietSecs: number
  live: { pid: number; name: string } | null
  crashed: { kind: CrashKind } | null
  finished: ChatGateFinished | null
  /** A LIVE chat that looks stuck rather than busy: its newest record is a SHELL tool call
   *  with no result after it, and it has been quiet a long time. The state stays 'running' -
   *  this is extra evidence, never a reclassification, because acting on a live chat is
   *  exactly what the gate law forbids. Null when the chat is not live or looks fine. */
  stalled?: {
    tool: string
    quietSecs: number
    why: string
  } | null
  /**
   * A LIVE chat that has FINISHED ITS TURN and gone quiet - the fleet's most common state, and
   * the one this gate used to have no word for.
   *
   * 'running' meant nothing more than "a process is alive", so a chat that answered two hours
   * ago and has been sitting there ever since was classified identically to one mid-build. The
   * sweep leaves 'running' alone, so those chats were never anybody's work: an orchestrator
   * would gate the whole fleet, find every chat either alive-therefore-running or already
   * archived, and have nothing left to do but recite a status - which is precisely the
   * complaint that a fleet full of idle chats produces.
   *
   * The state stays 'running' on purpose: nothing may archive a chat that still has a writer.
   * This is the evidence that it is WAITING for its next instruction rather than working, and
   * the sweep routes it to the judgment lane on the strength of it. Null when the chat is not
   * live, is still inside the quiet window, or its tail shows a turn genuinely in flight.
   */
  idle?: {
    quietSecs: number
    doneClaim: 'yes' | 'no' | 'unknown'
    endsWithQuestion: boolean
    recapPresent: boolean
    lastAssistantText: string
  } | null
}

/** How long a live chat must be quiet AFTER a completed turn before it counts as idle rather
 *  than thinking. Three minutes: long enough that a model pausing between tool calls is never
 *  mistaken for an idle chat, short enough that the fleet is worked while the owner watches. */
export const IDLE_AFTER_SECS = 180

const EVIDENCE_CAP = 2000
const RECAP_HEADER = /##\s*Am I 100% done\?/i

/** The recap-bearing view of an assistant message: fenced code blocks and quoted (>) lines
 *  removed, so a recap merely QUOTED or shown as an example cannot fake a live self-report
 *  (review-confirmed misroute to archive-candidate in the first cut). */
export function recapView(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
}
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/

interface TailRecord {
  type: string
  interrupted: boolean
  apiError: boolean
  text: string
  hasText: boolean
  /** The record carries a tool_use block: an answer that is still mid-action. A transcript
   *  ENDING on one means the tool's result never landed - a mid-turn death even when the
   *  record also carries prefacing text (review-confirmed hole in the first cut). */
  hasToolUse: boolean
  /** Names of the tool_use blocks on this record, so a stalled chat can say WHAT it is stuck
   *  on - the difference between "waiting on a shell command nobody can approve" and "running
   *  a long build" is the tool, and a stall report without it is unactionable. */
  toolNames: string[]
  /** The record carries a tool_result: the answer to a previous tool_use landed. */
  hasToolResult: boolean
}

function parseTailRecords(text: string, wholeFile: boolean): TailRecord[] {
  const lines = text.split('\n')
  if (!wholeFile && lines.length > 0) lines.shift()
  const out: TailRecord[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let ev: unknown
    try {
      ev = JSON.parse(t)
    } catch {
      continue
    }
    const e = ev as { type?: string; isSidechain?: boolean; message?: { content?: unknown } }
    if (e.type !== 'user' && e.type !== 'assistant' && e.type !== 'result') continue
    // Sidechain records (compaction side-branches) are not the conversation's own tail - a
    // sidechain appended after the real last turn must not hijack the verdict.
    if (e.isSidechain === true) continue
    const txt = endingEventText(ev)
    const content = e.message?.content
    out.push({
      type: e.type,
      interrupted: e.type === 'user' && INTERRUPTED.test(txt.trim()),
      apiError:
        isApiErrorEvent(ev) ||
        (e.type === 'result' && (ev as { is_error?: boolean }).is_error === true),
      text: txt,
      hasText: txt.trim().length > 0,
      hasToolUse:
        Array.isArray(content) &&
        content.some((b) => (b as { type?: string })?.type === 'tool_use'),
      toolNames: Array.isArray(content)
        ? content
            .filter((b) => (b as { type?: string })?.type === 'tool_use')
            .map((b) => String((b as { name?: string }).name ?? ''))
            .filter(Boolean)
        : [],
      hasToolResult:
        Array.isArray(content) &&
        content.some((b) => (b as { type?: string })?.type === 'tool_result'),
    })
  }
  return out
}

/**
 * IS THIS LIVE CHAT STUCK, or just busy? The banked tell (measured 2026-08-26, five imported
 * chats froze exactly this way and looked identical to "thinking"): the newest record is an
 * assistant tool_use with NO tool_result after it, while the process is alive and idle.
 *
 * ⛔ NARROW TO SHELL TOOLS ON PURPOSE. File edits are auto-approved under `acceptEdits`, so
 * including them would flag every slow Write, and a detector that cries wolf gets ignored -
 * which is worse than not having one. A shell command is the one that sits on an approval
 * prompt nobody is present to click, or on a build that died.
 */
const SHELL_TOOLS = /^(bash|powershell|shell|run|terminal|npx|exec)/i
/**
 * Below this a quiet tool call is just a command running.
 *
 * HALF AN HOUR, not the fifteen minutes this started at, and the reason is a measurement: run
 * over 1,504 real transcripts with every one forced to look live and an hour quiet, the SHAPE
 * (ends on an unanswered shell call) matched 11 of them - 0.7%, narrow enough. But one of the
 * eleven was the session doing the measuring, which was mid-`bun` at that instant and perfectly
 * healthy. So the shape alone proves nothing and this threshold is the ENTIRE discriminator
 * between busy and stuck. Thirty minutes clears the long real commands in these repos (Rust
 * release builds, container CI legs) at no cost, because a genuinely stuck chat stays stuck -
 * waiting longer to speak loses nothing, and a detector that cries wolf gets ignored.
 */
const STALL_QUIET_SECS = 30 * 60

function detectStall(transcriptPath: string, quietSecs: number): ChatGate['stalled'] {
  if (quietSecs < STALL_QUIET_SECS) return null
  // ONE window, no growth loop, unlike the finished-chat classifier below: there, finding no
  // records changes the verdict, so a truncated read had to widen. Here a short read can only
  // cost us a detection we then do not claim - and a missed stall is a report the human reads
  // themselves, while a false stall is the actuator lying about a healthy chat.
  const raw = readTranscriptTailText(transcriptPath, 64 * 1024)
  if (!raw) return null
  const records = parseTailRecords(raw.text, raw.wholeFile)
  const last = records.at(-1)
  if (!last?.hasToolUse || last.hasToolResult) return null
  const tool = last.toolNames.find((n) => SHELL_TOOLS.test(n))
  if (!tool) return null
  return {
    tool,
    quietSecs,
    why:
      `its newest record is a '${tool}' call with no result after it, and nothing has moved ` +
      `for ${Math.round(quietSecs / 60)}min - the classic shape of a command waiting on an ` +
      'approval nobody is present to click, or a background task that died. Read the chat ' +
      'before acting: a genuinely long command looks the same from outside.',
  }
}

/** The recap's own claim, parsed from the section under "## Am I 100% done?". */
export function parseDoneClaim(assistantText: string): 'yes' | 'no' | 'unknown' {
  const m = RECAP_HEADER.exec(assistantText)
  if (!m) return 'unknown'
  const after = assistantText.slice(m.index + m[0].length)
  const section = after.split(/\n##\s/)[0] ?? ''
  const firstLine = section
    .split('\n')
    .map((l) => l.replace(/^[-*\s]+/, '').trim())
    .find((l) => l.length > 0)
  if (!firstLine) return 'unknown'
  if (/^yes\b/i.test(firstLine)) return 'yes'
  if (/^(no\b|not\b|blocked\b|done except)/i.test(firstLine)) return 'no'
  // "Yes - except X" style: a yes with a tail still counts as yes; anything else is unknown.
  if (/\byes\b/i.test(firstLine) && !/\bno\b/i.test(firstLine)) return 'yes'
  return 'unknown'
}

export interface ChatGateDeps {
  claudeHome?: string
  nowMs?: number
  registry?: typeof readLiveRegistry
  orphans?: typeof readOrphanedRegistry
  findTranscript?: typeof findTranscriptById
  /** Seam for tests; defaults to IDLE_AFTER_SECS. */
  idleAfterSecs?: number
}

/**
 * The gate. Returns null when the session has no transcript anywhere - a thing that cannot be
 * gated cannot be acted on, and the caller must say so rather than guess.
 */
export function chatGate(sessionId: string, deps: ChatGateDeps = {}): ChatGate | null {
  const claudeHome = deps.claudeHome ?? join(homedir(), '.claude')
  const nowMs = deps.nowMs ?? Date.now()
  const registry = deps.registry ?? readLiveRegistry
  const orphans = deps.orphans ?? readOrphanedRegistry
  const findTranscript = deps.findTranscript ?? findTranscriptById

  const live = registry(claudeHome).find((s) => s.sessionId === sessionId) ?? null
  const transcriptPath = live?.transcriptPath ?? findTranscript(claudeHome, sessionId)
  if (!transcriptPath) return null
  const tailMeta = classifyTranscriptTail(transcriptPath, nowMs)

  // Adaptive read, same growth discipline as fleet's classifier: a single closing record can
  // exceed the starting window, and a truncated tail must widen rather than let 'no records'
  // masquerade as a mid-turn death (review-confirmed misclassification in the first cut).
  const readRecords = (): TailRecord[] => {
    let out: TailRecord[] = []
    for (let window = 64 * 1024; ; window *= 4) {
      const raw = readTranscriptTailText(transcriptPath, window)
      if (!raw) break
      out = parseTailRecords(raw.text, raw.wholeFile)
      if (out.length > 0 || raw.wholeFile || window >= 4 * 1024 * 1024) break
    }
    return out
  }

  if (live) {
    const stalled = detectStall(transcriptPath, tailMeta.quietSecs)
    // The tail is only read once the quiet window has passed: a chat quiet for less than that
    // is busy by definition, and this runs over every chat in the fleet on every tick.
    const idleAfter = deps.idleAfterSecs ?? IDLE_AFTER_SECS
    let idle: ChatGate['idle'] = null
    if (!stalled && tailMeta.quietSecs >= idleAfter) {
      const recs = readRecords()
      const tail = recs[recs.length - 1] ?? null
      // The same completed-turn test the finished branch below uses. A turn genuinely in
      // flight - an unanswered user message, a dangling tool call, pure tool traffic - is NOT
      // idle no matter how long it has been quiet; that is a stall or a crash, and those lanes
      // already own it.
      const completed =
        tail && tail.type !== 'user' && tail.hasText && !tail.hasToolUse && !tail.apiError
      if (completed) {
        const evidence = lastAssistantText(recs)
        const view = recapView(evidence)
        idle = {
          quietSecs: tailMeta.quietSecs,
          doneClaim: parseDoneClaim(view),
          endsWithQuestion: /\?\s*$/.test(evidence.trim()),
          recapPresent: RECAP_HEADER.test(view),
          lastAssistantText: evidence,
        }
      }
    }
    return {
      sessionId,
      state: 'running',
      cause: stalled
        ? `process ${live.pid} is alive but looks STUCK: ${stalled.why}`
        : idle
          ? `process ${live.pid} is alive but IDLE - it finished its turn and has been quiet ${idle.quietSecs}s, so it is waiting for its next instruction, not working`
          : `process ${live.pid} is alive (quiet ${tailMeta.quietSecs}s - a long quiet can be background work, not a stall)`,
      transcriptPath,
      quietSecs: tailMeta.quietSecs,
      live: { pid: live.pid, name: live.name },
      crashed: null,
      finished: null,
      stalled,
      idle,
    }
  }

  const records = readRecords()
  const orphaned = orphans(claudeHome).some((o) => o.sessionId === sessionId)
  const orphanNote = orphaned
    ? '; a dead-pid registry file confirms the process died un-gracefully'
    : ''
  const last = records[records.length - 1] ?? null

  const gate = (state: ChatGateState, cause: string, extra: Partial<ChatGate>): ChatGate => ({
    sessionId,
    state,
    cause,
    transcriptPath,
    quietSecs: tailMeta.quietSecs,
    live: null,
    crashed: null,
    finished: null,
    ...extra,
  })

  if (!last) {
    // Records exist upstream but the readable tail holds none that speak - or the file is
    // empty. Nothing completed here; treat as died mid-work rather than inventing a finish.
    return gate('crashed', `no completed turn in the transcript tail${orphanNote}`, {
      crashed: { kind: 'mid-turn' },
    })
  }

  if (last.apiError) {
    const limit = classifyLimit(last.text)
    const kind: CrashKind =
      limit === 'quota'
        ? 'usage-limit'
        : limit === 'transient'
          ? 'overload'
          : /\bsafeguards flagged this message\b/i.test(last.text)
            ? 'refused'
            : 'error'
    return gate('crashed', `stopped by ${kind}${orphanNote}`, { crashed: { kind } })
  }

  if (last.interrupted) {
    return gate('finished', 'a person interrupted it - deliberately theirs to pick back up', {
      finished: {
        lane: 'human',
        recapPresent: false,
        doneClaim: 'unknown',
        endsWithQuestion: false,
        interrupted: true,
        lastAssistantText: lastAssistantText(records),
      },
    })
  }

  if (last.type === 'user' || !last.hasText || last.hasToolUse) {
    // A delivered prompt with no answer, an assistant record that is pure tool traffic, or an
    // assistant record whose tool call never got its result back (prefacing text does not make
    // a dangling tool call a finish): the turn never completed.
    const why =
      last.type === 'user'
        ? 'an unanswered user message'
        : last.hasToolUse
          ? 'a tool call whose result never landed'
          : 'tool traffic with no closing text'
    return gate('crashed', `died mid-turn (last record: ${why})${orphanNote}`, {
      crashed: { kind: 'mid-turn' },
    })
  }

  // Finished on a real assistant turn. The lanes, by stated rule:
  //   done-yes and not asking anything -> archive-candidate
  //   anything else                    -> needs-input-review (the AI's autonomy judgment)
  const evidence = lastAssistantText(records)
  const view = recapView(evidence)
  const recapPresent = RECAP_HEADER.test(view)
  const doneClaim = parseDoneClaim(view)
  const endsWithQuestion = /\?\s*$/.test(evidence.trim())
  const lane: FinishedLane =
    doneClaim === 'yes' && !endsWithQuestion ? 'archive-candidate' : 'needs-input-review'
  return gate(
    'finished',
    lane === 'archive-candidate'
      ? 'completed turn, recap says done, nothing asked'
      : `completed turn but ${doneClaim !== 'yes' ? `the recap does not claim done (${doneClaim})` : 'it ends on a question'}`,
    {
      finished: {
        lane,
        recapPresent,
        doneClaim,
        endsWithQuestion,
        interrupted: false,
        lastAssistantText: evidence,
      },
    },
  )
}

function lastAssistantText(records: TailRecord[]): string {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r && r.type === 'assistant' && r.hasText) {
      return r.text.length > EVIDENCE_CAP ? r.text.slice(-EVIDENCE_CAP) : r.text
    }
  }
  return ''
}
