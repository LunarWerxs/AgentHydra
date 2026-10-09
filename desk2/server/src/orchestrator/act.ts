// The orchestrator, phase B (armed): what it does on its own once the owner has armed it. Only Desk chats, and only
// the move a person makes without having to think: a chat whose last turn failed gets one "continue" through Desk's
// send queue (its hold is released so the message goes). A chat that stops again is continued at most RETRIES times
// before a turn ends well; then it is left to a person. A chat a usage limit stopped is the babysitter's, which
// continues it once the limit resets whether or not the orchestrator is armed (plugins/72-babysitter.ts): the plan
// shows it and the orchestrator sends it nothing. Everything else stays a plan: a question waits for the CreAitor's
// promotion (phase C), an outside session is only shown, and a chat a person wrote in is theirs (plan.ts).
// Pure: the plugin (plugins/70-orchestrator.ts) reads, this decides, the plugin sends.

import { ORCHESTRATOR_FROM, type OrchestratorRow } from '@shared/orchestrator'

/** Continues sent to one chat since its last good turn before the orchestrator leaves it to a person. */
export const RETRIES = 2

/** One act, and `count`: the continues its chat has had once this act is carried out. */
export type Act =
  | { row: OrchestratorRow; kind: 'continue'; text: string; release: boolean; count: number }
  | { row: OrchestratorRow; kind: 'give-up'; count: number }

/** The message that continues a chat an error stopped; Desk shows it as a note from the orchestrator. */
export function continueText(row: OrchestratorRow): string {
  return `[${ORCHESTRATOR_FROM}] Not from the user.\nYour last turn stopped on an error: ${row.reason} Continue the task exactly where you left off. Do not redo steps that are already finished.`
}

/** This look's acts. `tries` (chat id -> continues since its last good turn) carries across looks; a chat that is
 *  neither stopped nor being watched ended a turn well (or a person took it) and is forgotten here, while an act's
 *  own count is recorded by whoever carries it out, so a disarm part-way through counts only what was sent. `skip`
 *  holds the chats this look must not touch: one whose transcript could not be read (a person may have just written
 *  in it), and one a message already waits for in the send queue (the queue holds it through a reset, and the
 *  chat's own queuedCount does not show it). */
export function decide(rows: readonly OrchestratorRow[], tries: Map<string, number>, skip: ReadonlySet<string>): Act[] {
  const acts: Act[] = []
  for (const row of rows) {
    if (row.source !== 'desk' || skip.has(row.id)) continue
    if (row.move !== 'retry-error') {
      // A limit stop is the babysitter's: it neither counts here nor ends a run of continues.
      if (row.move !== 'watch' && row.move !== 'resume-after-limit') tries.delete(row.id)
      continue
    }
    const n = tries.get(row.id) ?? 0
    if (n > RETRIES) continue
    acts.push(n === RETRIES ? { row, kind: 'give-up', count: n + 1 } : { row, kind: 'continue', text: continueText(row), release: true, count: n + 1 })
  }
  return acts
}

/** A row as the plan shows it once the orchestrator gave up on its chat: left to a person. */
export function afterGivingUp(row: OrchestratorRow, tries: ReadonlyMap<string, number>): OrchestratorRow {
  if ((tries.get(row.id) ?? 0) <= RETRIES || row.move !== 'retry-error') return row
  return { ...row, move: 'leave', reason: `the orchestrator continued it ${RETRIES} times and it stopped again: ${row.reason}` }
}
