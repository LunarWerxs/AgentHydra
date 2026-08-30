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
}

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
    })
  }
  return out
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

  if (live) {
    return {
      sessionId,
      state: 'running',
      cause: `process ${live.pid} is alive (quiet ${tailMeta.quietSecs}s - a long quiet can be background work, not a stall)`,
      transcriptPath,
      quietSecs: tailMeta.quietSecs,
      live: { pid: live.pid, name: live.name },
      crashed: null,
      finished: null,
    }
  }

  // Adaptive read, same growth discipline as fleet's classifier: a single closing record can
  // exceed the starting window, and a truncated tail must widen rather than let 'no records'
  // masquerade as a mid-turn death (review-confirmed misclassification in the first cut).
  let records: TailRecord[] = []
  for (let window = 64 * 1024; ; window *= 4) {
    const raw = readTranscriptTailText(transcriptPath, window)
    if (!raw) break
    records = parseTailRecords(raw.text, raw.wholeFile)
    if (records.length > 0 || raw.wholeFile || window >= 4 * 1024 * 1024) break
  }
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
