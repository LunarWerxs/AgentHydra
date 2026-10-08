// The orchestrator's planner: each open chat's one next move, read from its summary and its transcript. A chat is a
// Desk chat or an outside session (a Claude Desktop, CLI, CliMayte or Codex session AgentHydra knows): both become a
// Subject first. Pure: the plugin (plugins/70-orchestrator.ts) fetches, this decides, and only the armed
// orchestrator (act.ts) sends anything.

import type { ChatStatus, ChatSummary, ExternalSession, TranscriptItem } from '@shared/protocol'
import { ORCHESTRATOR_FROM, ORCHESTRATOR_MOVES, type OrchestratorRow } from '@shared/orchestrator'

/** A person wrote in the chat this recently: it is theirs, and the orchestrator leaves it alone. */
export const PERSON_QUIET_MS = 10 * 60_000

const NEED = /🔴\s*NEED:\s*/
/** A reply that hands the next step back: "Want me to ...?", "Should I ...?". Only its last 600 characters are read. */
const ASKS_BACK = /\b(want me to|shall I|should I|do you want me to|would you like me to)\b[^?]{0,300}\?/i

/** What the planner reads of a chat, whichever app runs it. */
export interface Subject {
  id: string
  /** Its Claude session id, when known: a CreAitor ask carries it so the answer can be graded against the owner's reply there. */
  session: string | null
  title: string
  cwd: string
  account: string
  source: OrchestratorRow['source']
  status: ChatStatus
  updatedAt: number
  activity: string | null
  queuedCount: number
  accountAuto: boolean
  limitResetsAt: number | null
  lastError: string | null
}

export function fromChat(c: ChatSummary): Subject {
  return {
    id: c.id, session: c.sessionId, title: c.title, cwd: c.cwd, account: c.account.label, source: 'desk', status: c.status, updatedAt: c.updatedAt,
    activity: c.activity, queuedCount: c.queuedCount, accountAuto: c.accountAuto, limitResetsAt: c.limitResetsAt, lastError: c.lastError
  }
}

/** An outside session reports only working, needs you, idle or stale; stale reads as closed. */
export function fromExternal(s: ExternalSession): Subject {
  return {
    id: s.id, session: s.id, title: s.title, cwd: s.cwd ?? '', account: s.instance ?? '', source: s.source, status: s.status === 'stale' ? 'closed' : s.status,
    updatedAt: s.lastActivityAt ?? 0, activity: s.activity, queuedCount: 0, accountAuto: false, limitResetsAt: null, lastError: null
  }
}

/** The question a finished reply leaves, and its lettered choices ("A) x ★ B) y"), or null when it asks nothing. */
export function askedIn(text: string): { question: string; options: string[] } | null {
  const at = text.search(NEED)
  if (at >= 0) {
    const line = text.slice(at).replace(NEED, '').split('\n')[0]
    const parts = line.split(/\s+([A-H])\)\s+/)
    const options: string[] = []
    for (let i = 2; i < parts.length; i += 2) options.push(parts[i].replace(/\s*★\s*$/, '').trim())
    return { question: (parts[0] || line).trim(), options }
  }
  const tail = text.slice(-600)
  const m = ASKS_BACK.exec(tail)
  if (!m) return null
  const start = Math.max(tail.lastIndexOf('\n', m.index), tail.lastIndexOf('. ', m.index) + 1, 0)
  return { question: tail.slice(start, m.index + m[0].length).trim(), options: [] }
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function last<K extends TranscriptItem['kind']>(items: readonly TranscriptItem[], kind: K): Extract<TranscriptItem, { kind: K }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === kind) return items[i] as Extract<TranscriptItem, { kind: K }>
  return undefined
}

type Asked = { question?: unknown; options?: unknown }

const unquote = (s: string): string => {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s
  }
}

/** An AskUserQuestion call's questions. AgentHydra cuts a call's input at 1200 characters and hands a cut one over
 *  as { raw } (bridge/external.ts parseInput); its questions and the labels that survived the cut are read out of it. */
function questionsOf(input: Record<string, unknown>): Asked[] {
  if (Array.isArray(input.questions)) return input.questions.filter((q): q is Asked => q !== null && typeof q === 'object')
  if (typeof input.raw !== 'string') return []
  return input.raw.split(/(?="question"\s*:)/).flatMap((part) => {
    const q = /^"question"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(part)
    if (!q) return []
    return [{ question: unquote(q[1]), options: [...part.matchAll(/"label"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => ({ label: unquote(m[1]) })) }]
  })
}

/** A question waiting for an answer: Desk's question card, or, in an outside session's transcript, an
 *  AskUserQuestion call still running. */
function waitingQuestion(items: readonly TranscriptItem[]): { question: string; options: string[] } | null {
  const card = items.find((i) => i.kind === 'question' && i.state === 'pending')
  const call = card ? undefined : [...items].reverse().find((i) => i.kind === 'tool_use' && i.name === 'AskUserQuestion' && i.status === 'running')
  const asks: Asked[] = card?.kind === 'question' ? card.questions : call?.kind === 'tool_use' ? questionsOf(call.input) : []
  if (!asks.length) return null
  const first = Array.isArray(asks[0].options) ? (asks[0].options as unknown[]) : []
  const labels = first.map((o) => (o !== null && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string' ? (o as { label: string }).label : '')).filter(Boolean)
  return { question: asks.map((x) => (typeof x.question === 'string' ? x.question : '')).filter(Boolean).join(' / '), options: labels }
}

/** The move for one chat. `items` is its transcript, or null when it was not read (a working chat needs none). */
export function classify(chat: Subject, items: readonly TranscriptItem[] | null, now: number): OrchestratorRow {
  const row = { id: chat.id, title: chat.title, cwd: chat.cwd, account: chat.account, source: chat.source, status: chat.status, updatedAt: chat.updatedAt }
  if (chat.status === 'working' || chat.status === 'starting') return { ...row, move: 'watch', reason: chat.activity ? `working: ${chat.activity}` : chat.status }
  if (chat.queuedCount > 0) return { ...row, move: 'watch', reason: `${chat.queuedCount} message(s) queued; the engine takes them up` }
  const all = items ?? []
  const person = last(all, 'user')
  if (person && now - person.ts < PERSON_QUIET_MS) {
    const who = chat.source === 'climayte' ? 'its dispatcher' : 'a person' // a CliMayte worker's messages come from the chat that runs it
    return { ...row, move: 'leave', reason: `${who} wrote in it ${Math.max(1, Math.round((now - person.ts) / 60_000))} min ago` }
  }
  // The armed orchestrator's own "continue" (act.ts) is a note, never the person's; it waits as long before another.
  const sent = last(all, 'note')
  if (sent?.from === ORCHESTRATOR_FROM && now - sent.ts < PERSON_QUIET_MS)
    return { ...row, move: 'watch', reason: `the orchestrator continued it ${Math.max(1, Math.round((now - sent.ts) / 60_000))} min ago` }
  if (chat.status === 'limited') {
    if (chat.accountAuto) return { ...row, move: 'watch', reason: 'placed on auto: the engine moves it to another account itself' }
    const at = chat.limitResetsAt ? ` at ${new Date(chat.limitResetsAt).toISOString()}` : ''
    return { ...row, move: 'resume-after-limit', reason: `its account hit the usage limit; resume when it resets${at}` }
  }
  if (chat.status === 'error') return { ...row, move: 'retry-error', reason: short(chat.lastError || 'the last turn failed', 200) }
  const asking = waitingQuestion(all)
  if (asking) return { ...row, move: 'answer-question', reason: 'a question waits for an answer', ...asking }
  const pending = all.find((i) => 'state' in i && i.state === 'pending')
  if (pending) return { ...row, move: 'leave', reason: `a ${pending.kind} waits; only a person grants one` }
  if (chat.status === 'needs_you') return { ...row, move: 'leave', reason: 'it waits on a person in its own window' }
  const reply = last(all, 'assistant_text')
  const asked = reply && askedIn(reply.text)
  if (asked) return { ...row, move: 'answer-need', reason: NEED.test(reply.text) ? 'the last reply ended on a NEED line' : 'the last reply asks what to do next', ...asked }
  if (chat.status === 'stopped') return { ...row, move: 'leave', reason: 'a person stopped it' }
  return { ...row, move: 'done', reason: 'finished; nothing asked' }
}

/** Most urgent first, then the most recently active. */
export function rank(rows: OrchestratorRow[]): OrchestratorRow[] {
  return [...rows].sort((a, b) => ORCHESTRATOR_MOVES.indexOf(a.move) - ORCHESTRATOR_MOVES.indexOf(b.move) || b.updatedAt - a.updatedAt)
}
