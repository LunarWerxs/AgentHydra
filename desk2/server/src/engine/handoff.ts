// The condensed handoff (SPEC "Account failover"): a session too big to carry to another account moves as a
// FRESH session whose first message is built here from the Desk chat file (the chat's full record), in the
// shape of AgentHydra's CliMayte continuation (server/src/climayte-lib.ts continuationPrompt): the goal, the
// owner's later instructions, what is done, what was in progress, the open to-dos, the last exchanges
// verbatim, and where the full history is. A copied session would be re-read uncached on the new account,
// and its thinking from another organization cannot be used there.

import { statSync } from 'node:fs'
import type { TranscriptItem } from '@shared/protocol'
import { readTail } from '../bridge/session-jsonl'

/** Above this many tokens of context a move starts a fresh session from a handoff (HYDRA_DESK_HANDOFF_TOKENS overrides). */
export const HANDOFF_TOKENS = 150_000
/** The handoff's hard cap, in characters (about 4k tokens). */
export const MAX_HANDOFF_CHARS = 16_000

/** What a turn cut short by the move is told, once per move, when it resumes on the new account. */
export const CONTINUE_TEXT =
  'You were moved to another account mid-task because the previous one hit its usage limit or was signed out. Continue exactly where you left off; do not redo finished steps.'

/**
 * How many tokens a resume of this session would read: the context of its newest main-thread assistant
 * line (input plus both cache counts plus output), which follows a compaction down. Falls back to the
 * file's size / 4 when no line carries usage. Null when the file cannot be read.
 */
export function sessionTokens(file: string): number | null {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return null
  }
  for (const max of [512 * 1024, 4 * 1024 * 1024]) {
    let lines: string[]
    try {
      lines = readTail(file, max).split('\n')
    } catch {
      return null
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line.includes('"usage"')) continue
      try {
        const rec = JSON.parse(line) as { type?: string; isSidechain?: boolean; message?: { usage?: Record<string, unknown> } }
        const u = rec.message?.usage
        if (rec.type !== 'assistant' || rec.isSidechain || !u) continue
        const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
        const total = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens')
        if (total > 0) return total
      } catch {
        // the tail's first line may be cut
      }
    }
    if (size <= max) break
  }
  return Math.round(size / 4)
}

export interface HandoffInput {
  chatId: string
  title: string
  cwd: string
  /** The chat's items, oldest first (ChatStore.loadItems). */
  items: TranscriptItem[]
  /** The session being left, then the ones before it, newest first. */
  sessions: string[]
  /** About how big the old session had grown. */
  tokens: number
  /** Why it moved: '5-hour limit', 'signed out', ... */
  why: string
  /** Hydra Desk's own address, for the transcript route. */
  deskUrl: string
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`)

/** One line for a tool call: its name and what it touched. */
function toolLine(i: Extract<TranscriptItem, { kind: 'tool_use' }>, max: number): string {
  const x = i.input
  const pick = ['command', 'file_path', 'path', 'pattern', 'description', 'url', 'prompt'].map((k) => x[k]).find((v) => typeof v === 'string' && v.trim())
  const what = typeof pick === 'string' ? squash(pick.split('\n')[0]!) : ''
  return cut(`${i.name}${what ? `: ${what}` : ''}${i.status === 'error' ? ' (failed)' : ''}`, max)
}

/** The handoff text, built from the chat's own record and kept under MAX_HANDOFF_CHARS. */
export function buildHandoff(h: HandoffInput): string {
  for (let scale = 1; scale > 0.05; scale *= 0.7) {
    const text = render(h, scale)
    if (text.length <= MAX_HANDOFF_CHARS) return text
  }
  return cut(render(h, 0.05), MAX_HANDOFF_CHARS)
}

function render(h: HandoffInput, scale: number): string {
  const n = (x: number): number => Math.max(40, Math.round(x * scale))
  const count = (x: number): number => Math.max(1, Math.round(x * scale))
  // The main thread only: a sub-agent's lines are its own business.
  const items = h.items.filter((i) => !i.parentToolUseId)
  const users = items.filter((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user' && !i.queued && !!i.text.trim())
  const texts = (i: TranscriptItem): i is Extract<TranscriptItem, { kind: 'assistant_text' }> => i.kind === 'assistant_text' && !!i.text.trim()

  // The last exchanges, verbatim.
  const tail = items.filter((i) => (i.kind === 'user' && !i.queued && i.text.trim()) || texts(i)).slice(-count(4))
  const inTail = new Set(tail.map((i) => i.id))

  // Each finished turn's last words: what it did.
  const done: string[] = []
  let lastText: Extract<TranscriptItem, { kind: 'assistant_text' }> | null = null
  let lastResult = -1
  items.forEach((i, at) => {
    if (texts(i)) lastText = i
    if (i.kind === 'result') {
      if (lastText && !inTail.has(lastText.id)) done.push(cut(squash(lastText.text), n(700)))
      lastText = null
      lastResult = at
    }
  })

  // What ran after the last finished turn: the cut one.
  const after = items.slice(lastResult + 1)
  const said = after.filter(texts).at(-1)
  const tools = after.filter((i): i is Extract<TranscriptItem, { kind: 'tool_use' }> => i.kind === 'tool_use').slice(-count(10))

  const todos = items.filter((i): i is Extract<TranscriptItem, { kind: 'todos' }> => i.kind === 'todos').at(-1)?.todos.filter((t) => t.status !== 'completed') ?? []

  const [current, ...older] = h.sessions
  const out: string[] = []
  out.push(
    `You were moved to another account mid-task because the previous one ${h.why === 'signed out' ? 'was signed out' : `hit its ${h.why}`}. This is a fresh session: the old one had grown to about ${Math.round(h.tokens / 1000)}k tokens, so instead of re-reading it you start from this condensed handoff, which Hydra Desk built from the chat's full record. Continue exactly where it left off; do not redo finished steps. Check its claims with cheap commands (git status, git log -3, reading a file); do not re-run a test suite or build it reports passing unless you change what it covers.`,
  )
  out.push(
    [
      '## Where the full history is',
      `Hydra Desk chat "${h.title}" (id ${h.chatId}), folder ${h.cwd}. If you need a detail left out here:`,
      `- GET ${h.deskUrl}/api/chats/${h.chatId}/transcript (the whole chat as JSON items, oldest first; add ?format=jsonl for one item per line)`,
      ...(current ? [`- the agenthydra MCP's history_search / history_read tools with session_id ${current}${older.length ? ` (earlier sessions of this chat: ${older.join(', ')})` : ''}`] : []),
    ].join('\n'),
  )
  if (users[0]) out.push(`## The goal (the owner's first message)\n${cut(users[0].text.trim(), n(2000))}`)
  const later = users.slice(1).filter((u) => !inTail.has(u.id))
  if (later.length) {
    const shown = later.slice(-count(30))
    const skipped = later.length - shown.length
    out.push(`## The owner's later instructions, oldest first\n${skipped ? `(${skipped} earlier ones left out)\n` : ''}${shown.map((u) => `- ${cut(squash(u.text), n(240))}`).join('\n')}`)
  }
  if (done.length) out.push(`## Done so far (how earlier turns ended, oldest first)\n${done.slice(-count(6)).map((d) => `- ${d}`).join('\n')}`)
  if (said || tools.length) {
    const lines = ['## In progress when the session was cut']
    if (said && !inTail.has(said.id)) lines.push(cut(said.text.trim(), n(800)))
    if (tools.length) lines.push(`Its last tool calls:\n${tools.map((t) => `- ${toolLine(t, n(160))}`).join('\n')}`)
    out.push(lines.join('\n'))
  }
  if (todos.length) out.push(`## Open to-dos\n${todos.map((t) => `- [${t.status}] ${cut(squash(t.content), n(200))}`).join('\n')}`)
  if (tail.length) {
    out.push(`## The last exchanges, verbatim\n${tail.map((i) => `${i.kind === 'user' ? '**Owner:**' : '**You:**'} ${cut((i as { text: string }).text.trim(), n(1200))}`).join('\n\n')}`)
  }
  return out.join('\n\n')
}
