// server/src/orchestrator-transcript-tail.ts — reading a transcript's tail into a TailInfo.
//
// Split out of orchestrator.ts (2026-08-27): that file is already over the oversized-file gate,
// and parseTranscriptTail/readTailInfo are self-contained (nothing outside this pair needs
// tailOfFile/TAIL_WINDOWS/textOf), so this is a real sibling module rather than a same-file
// helper that would only have grown the file it was meant to shrink. Nothing here talks to the
// registry, proposals, or any live state — it only turns raw transcript bytes into TailInfo.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { classifyEnding, type SessionEnding } from './session-ending'

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

type TailEvent = {
  type?: string
  timestamp?: string
  message?: { content?: unknown; usage?: Record<string, number> }
}

// One transcript record's worth of parseTranscriptTail's backward walk. Pulled out so this
// branching scores against this small function instead of parseTranscriptTail's.
function applyTailRecord(info: TailInfo, ev: TailEvent, i: number, newest: boolean): void {
  info.unreadable = false
  if (newest && typeof ev.timestamp === 'string') info.lastEventAt = ev.timestamp
  const text = textOf(ev.message?.content)
  if (info.ending === null) {
    const e = classifyEnding(ev, text)
    if (e !== null) info.ending = e
  }
  if (ev.type === 'assistant' && ev.message) {
    applyAssistantTailRecord(info, ev.message, i, newest, text)
    return
  }
  if (
    newest &&
    ev.type === 'user' &&
    Array.isArray(ev.message?.content) &&
    (ev.message.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result')
  ) {
    // The newest record is a tool result with no assistant turn after it yet: the runtime is
    // between a tool finishing and the model's next step — also mid-turn.
    info.midTurn = true
  }
  if (ev.type === 'user' && info.lastHumanText === null) {
    const t = text.trim()
    if (t && !isInjectedUserText(t)) {
      info.lastHumanText = t.slice(0, 400)
      info.lastHumanAt = typeof ev.timestamp === 'string' ? ev.timestamp : null
    }
  }
}

// The assistant-record half of applyTailRecord: context tokens, spawn_task chips, the dangling
// tool_use that means mid-turn, and the recap text. Pulled out, see applyTailRecord above.
function applyAssistantTailRecord(
  info: TailInfo,
  message: NonNullable<TailEvent['message']>,
  i: number,
  newest: boolean,
  text: string,
): void {
  const usage = message.usage
  if (info.ctxTokens === null && usage) {
    info.ctxTokens =
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0)
  }
  const content = message.content
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
    let ev: TailEvent
    try {
      ev = JSON.parse(lines[i])
    } catch {
      continue
    }
    const type = ev?.type
    if (type !== 'user' && type !== 'assistant' && type !== 'result') continue
    const newest = isNewestMeaningful
    isNewestMeaningful = false
    applyTailRecord(info, ev, i, newest)
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

export function readTailInfo(path: string): TailInfo {
  let info: TailInfo | null = null
  const size = statSync(path).size
  for (const w of TAIL_WINDOWS) {
    info = parseTranscriptTail(tailOfFile(path, w))
    if (!info.unreadable || w >= size) return info
  }
  return info as TailInfo
}
