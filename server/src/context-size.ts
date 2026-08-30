// server/src/context-size.ts - HOW FULL IS THIS CHAT'S CONTEXT, and should it be handed off
// to a fresh thread BEFORE it hits the wall?
//
// WHY (the biggest capability the rebuild was missing, gap analysis 2026-08-30): v1 rotated a
// long chat into a fresh thread proactively (`ctxHandoffTokens`). The rebuild had nothing
// keyed off context size at all - a long chat was only helped AFTER it crashed, which is the
// worst moment: the work is already interrupted and the thread that knew the plan is the one
// that died.
//
// THE MEASUREMENT, and it is not a guess: every assistant turn records the token usage of the
// request that produced it, and the context a request carried is
// `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. The cache_read term
// is the bulk of it and is exactly the point - it is the conversation being re-sent. The
// NEWEST such record is the chat's current context. (Same arithmetic as the ctxsize tool this
// repo's owner already uses, so the two cannot disagree about what "context" means.)
//
// ⛔ REPORT-ONLY, deliberately. This module says "this chat is getting full"; it never rotates
// anything on its own. Auto-rotating a live thread mid-thought is drastic, and the rebuild's
// doctrine is deterministic detection plus a narrow human/AI judgment - the handoff itself is
// already expressible with the existing surface+deliver machinery once someone decides to.

import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** How much transcript tail to read. The newest usage record is at the end by construction. */
const TAIL_BYTES = 1024 * 1024

/**
 * Default warn threshold, in context tokens. Claude's largest window here is 1M, and a chat
 * past ~70% is where a handoff stops being premature and starts being overdue: enough room
 * left to summarise the thread into its successor, not so much that we nag from the start.
 */
export const HANDOFF_WARN_TOKENS = 700_000

export interface ContextReading {
  /** Context the newest request carried, in tokens; null when the transcript says nothing. */
  tokens: number | null
  /** ISO timestamp of the record that produced it. */
  at: string | null
}

/**
 * The context the chat's most recent request carried. Null when no usage record exists (a
 * brand-new or fabricated transcript), which callers must treat as "unknown", never as zero.
 */
export function readContextSize(transcriptPath: string): ContextReading {
  let fd: number
  let size: number
  try {
    size = statSync(transcriptPath).size
    fd = openSync(transcriptPath, 'r')
  } catch {
    return { tokens: null, at: null }
  }
  try {
    const want = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(want)
    readSync(fd, buf, 0, want, size - want)
    let best: ContextReading = { tokens: null, at: null }
    for (const line of buf.toString('utf8').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{') || !t.includes('"usage"')) continue
      try {
        const rec = JSON.parse(t) as {
          timestamp?: string
          isSidechain?: boolean
          message?: {
            usage?: {
              input_tokens?: number
              cache_read_input_tokens?: number
              cache_creation_input_tokens?: number
            }
          }
        }
        // A SIDECHAIN turn is a subagent's, and a subagent's context is not this thread's -
        // counting it would report someone else's fullness as this chat's. Measured on a real
        // 3348-record transcript here: subagents write separate files and none appeared
        // inline, so this is cheap insurance against a format that does inline them, not a
        // fix for an observed bug.
        if (rec.isSidechain === true) continue
        const u = rec.message?.usage
        if (!u) continue
        const ctx =
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0)
        if (ctx <= 0) continue
        // Last one wins: later in the file is later in the conversation.
        best = { tokens: ctx, at: rec.timestamp ?? best.at }
      } catch {
        // A line cut by the tail window or written mid-flush - skip it, never guess.
      }
    }
    return best
  } catch {
    return { tokens: null, at: null }
  } finally {
    closeSync(fd)
  }
}

export interface HandoffAdvice {
  sessionId: string
  tokens: number
  at: string | null
  why: string
}

/**
 * Which of these chats are full enough to deserve a fresh thread. Chats with no reading are
 * silently skipped rather than reported as 0 - "unknown" is not "empty".
 */
export function handoffCandidates(
  sessions: Array<{ sessionId: string; transcriptPath: string | null }>,
  warnAt = HANDOFF_WARN_TOKENS,
  read = readContextSize,
): HandoffAdvice[] {
  const out: HandoffAdvice[] = []
  for (const s of sessions) {
    if (!s.transcriptPath) continue
    const r = read(s.transcriptPath)
    if (r.tokens === null || r.tokens < warnAt) continue
    out.push({
      sessionId: s.sessionId,
      tokens: r.tokens,
      at: r.at,
      why:
        `this chat's last request carried ~${Math.round(r.tokens / 1000)}k tokens of context ` +
        `(warn at ${Math.round(warnAt / 1000)}k) - hand the thread off to a fresh chat while ` +
        'it can still summarise itself, rather than waiting for it to hit the wall mid-task',
    })
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}
