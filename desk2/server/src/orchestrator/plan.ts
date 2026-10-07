// The orchestrator's planner (phase A, shadow): each open chat's one next move, read from its summary and its
// transcript. Pure: the plugin (plugins/70-orchestrator.ts) fetches, this decides, nothing is sent.

import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { ORCHESTRATOR_MOVES, type OrchestratorRow } from '@shared/orchestrator'

/** A person wrote in the chat this recently: it is theirs, and the orchestrator leaves it alone. */
export const PERSON_QUIET_MS = 10 * 60_000

const NEED = /🔴\s*NEED:\s*/
/** A reply that hands the next step back: "Want me to ...?", "Should I ...?". Only its last 600 characters are read. */
const ASKS_BACK = /\b(want me to|shall I|should I|do you want me to|would you like me to)\b[^?]{0,300}\?/i

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

/** The move for one chat. `items` is its transcript, or null when it was not read (a working chat needs none). */
export function classify(chat: ChatSummary, items: readonly TranscriptItem[] | null, now: number): OrchestratorRow {
  const row = { id: chat.id, title: chat.title, cwd: chat.cwd, account: chat.account.label, status: chat.status, updatedAt: chat.updatedAt }
  if (chat.status === 'working' || chat.status === 'starting') return { ...row, move: 'watch', reason: chat.activity ? `working: ${chat.activity}` : chat.status }
  if (chat.queuedCount > 0) return { ...row, move: 'watch', reason: `${chat.queuedCount} message(s) queued; the engine takes them up` }
  const all = items ?? []
  const person = last(all, 'user')
  if (person && now - person.ts < PERSON_QUIET_MS)
    return { ...row, move: 'leave', reason: `a person wrote in it ${Math.max(1, Math.round((now - person.ts) / 60_000))} min ago` }
  if (chat.status === 'limited') {
    if (chat.accountAuto) return { ...row, move: 'watch', reason: 'placed on auto: the engine moves it to another account itself' }
    const at = chat.limitResetsAt ? ` at ${new Date(chat.limitResetsAt).toISOString()}` : ''
    return { ...row, move: 'resume-after-limit', reason: `its account hit the usage limit; resume when it resets${at}` }
  }
  if (chat.status === 'error') return { ...row, move: 'retry-error', reason: short(chat.lastError || 'the last turn failed', 200) }
  const pending = all.filter((i) => 'state' in i && i.state === 'pending')
  const q = pending.find((i) => i.kind === 'question')
  if (q && q.kind === 'question' && q.questions.length) {
    const first = q.questions[0]
    return { ...row, move: 'answer-question', reason: 'a question card waits', question: q.questions.map((x) => x.question).join(' / '), options: first.options.map((o) => o.label) }
  }
  if (pending.length) return { ...row, move: 'leave', reason: `a ${pending[0].kind} waits; only a person grants one` }
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
