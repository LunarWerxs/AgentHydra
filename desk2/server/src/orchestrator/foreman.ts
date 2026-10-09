// The orchestrator's foreman: while the orchestrator is on, it peeks at each running chat every PEEK_MS (a Desk chat,
// or a Claude Desktop session AgentHydra knows) and judges from its transcript alone whether the work is moving
// (owner, 2026-10-09: "keeps an eye on actively running threads, and just once in a while peeks its nose in and sees
// what's happening, kind of like a foreman whose job is to make sure his employees aren't fucking around"). No model
// is asked. Pure: the plugin (plugins/70-orchestrator.ts) reads, this judges, the plugin sends the note.
//
// spinning: the same tool call failed SAME_FAILS times among the last RECENT_TOOLS calls, or the last ALL_FAILED calls
//   all failed. It gets one note to stop repeating it.
// hung: a tool call has run HUNG_MS and is still running. It gets one note asking whether it is stuck.
// stalled: a Desk chat that says it is working wrote nothing for STALL_MS and is not inside a tool call. Only shown: a
//   note queues behind the turn and cannot help an engine that stopped answering.

import type { TranscriptItem } from '@shared/protocol'
import { ORCHESTRATOR_FROM } from '@shared/orchestrator'

/** How often one running chat is peeked at. */
export const PEEK_MS = 10 * 60_000
/** Notes one chat gets in an hour at most. */
export const NOTES_PER_HOUR = 2
/** A person wrote in the chat this recently: the foreman stays out. */
export const PERSON_QUIET_MS = 10 * 60_000
const RECENT_TOOLS = 8
const SAME_FAILS = 3
const ALL_FAILED = 5
export const HUNG_MS = 45 * 60_000
export const STALL_MS = 20 * 60_000

/** `key` names the episode (the newest call it is about): one note per episode. */
interface Finding {
  key: string
  detail: string
}
export type Peek = { kind: 'ok' } | (Finding & { kind: 'spinning' }) | (Finding & { kind: 'hung' }) | (Finding & { kind: 'stalled' })

type ToolUse = Extract<TranscriptItem, { kind: 'tool_use' }>

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))
const failed = (t: ToolUse): boolean => t.status === 'error'
const callKey = (t: ToolUse): string => `${t.name} ${JSON.stringify(t.input)}`

/** What the foreman sees in a running chat's transcript. `desk`: a Desk chat, whose working status is the engine's
 *  own (an outside session's is read from how recently its transcript was written, so it never reads as stalled). */
export function peek(items: readonly TranscriptItem[], now: number, desk: boolean): Peek {
  const tools = items.filter((i): i is ToolUse => i.kind === 'tool_use')
  const last = tools.at(-1)
  if (last?.status === 'running' && now - last.startedAt >= HUNG_MS)
    return { kind: 'hung', key: last.id, detail: `its ${last.name} call has run for ${minutes(now - last.startedAt)} min` }
  const recent = tools.slice(-RECENT_TOOLS)
  const fails = new Map<string, ToolUse[]>()
  for (const t of recent.filter(failed)) fails.set(callKey(t), [...(fails.get(callKey(t)) ?? []), t])
  const same = [...fails.values()].find((ts) => ts.length >= SAME_FAILS)
  if (same) return { kind: 'spinning', key: same.at(-1)!.id, detail: `the same ${same[0].name} call failed ${same.length} times` }
  const tail = tools.slice(-ALL_FAILED)
  if (tail.length === ALL_FAILED && tail.every(failed)) return { kind: 'spinning', key: tail.at(-1)!.id, detail: `its last ${ALL_FAILED} tool calls all failed` }
  const newest = items.at(-1)
  if (desk && newest && last?.status !== 'running' && now - newest.ts >= STALL_MS)
    return { kind: 'stalled', key: newest.id, detail: `nothing new for ${minutes(now - newest.ts)} min while it says it is working` }
  return { kind: 'ok' }
}

/** A person wrote in the chat within PERSON_QUIET_MS. */
export function personRecent(items: readonly TranscriptItem[], now: number): boolean {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return now - items[i].ts < PERSON_QUIET_MS
  return false
}

/** The note for a spinning or hung chat; Desk shows it as a note from the orchestrator, never as the person's. */
export function noteText(p: Extract<Peek, { kind: 'spinning' } | { kind: 'hung' }>): string {
  const lead = `[${ORCHESTRATOR_FROM}] Not from the user.\n`
  return p.kind === 'spinning'
    ? `${lead}A check-in: ${p.detail}. Stop repeating it. Read the error, change the approach, and if something outside your reach blocks you, say what in one line.`
    : `${lead}A check-in: ${p.detail}. If it is stuck, stop it and find another way; if it is meant to take this long, carry on.`
}
