// The orchestrator, phase B (armed): what it does on its own once the owner has armed it. Only Desk chats, and only
// the two moves a person makes without having to think: a chat its account's limit stopped, and a chat whose last
// turn failed, each get one "continue" through Desk's send queue (which waits out a known reset itself; an errored
// chat's hold is released so the message goes). A chat that stops again is continued at most RETRIES times before
// a turn ends well; then it is left to a person. Everything else stays a plan: a question waits for the CreAitor's
// promotion (phase C), an outside session is only shown, and a chat a person wrote in is theirs (plan.ts).
// Pure: the plugin (plugins/70-orchestrator.ts) reads, this decides, the plugin sends.

import { ORCHESTRATOR_FROM, type OrchestratorRow } from '@shared/orchestrator'

/** Continues sent to one chat since its last good turn before the orchestrator leaves it to a person. */
export const RETRIES = 2

export type Act =
  | { row: OrchestratorRow; kind: 'continue'; text: string; release: boolean }
  | { row: OrchestratorRow; kind: 'give-up' }

/** The message that continues a stopped chat; Desk shows it as a note from the orchestrator. */
export function continueText(row: OrchestratorRow): string {
  const why = row.move === 'resume-after-limit' ? "Your account's usage limit stopped the last turn, and it can run again now." : `Your last turn stopped on an error: ${row.reason}`
  return `[${ORCHESTRATOR_FROM}] Not from the user.\n${why} Continue the task exactly where you left off. Do not redo steps that are already finished.`
}

/** This tick's acts. `tries` (chat id -> continues since its last good turn) carries across ticks and is updated:
 *  a chat that is neither stopped nor being watched ended a turn well (or a person took it) and starts again at 0. */
export function decide(rows: readonly OrchestratorRow[], tries: Map<string, number>): Act[] {
  const acts: Act[] = []
  for (const row of rows) {
    if (row.source !== 'desk') continue
    if (row.move !== 'retry-error' && row.move !== 'resume-after-limit') {
      if (row.move !== 'watch') tries.delete(row.id)
      continue
    }
    const n = tries.get(row.id) ?? 0
    if (n > RETRIES) continue
    tries.set(row.id, n + 1)
    acts.push(n === RETRIES ? { row, kind: 'give-up' } : { row, kind: 'continue', text: continueText(row), release: row.move === 'retry-error' })
  }
  return acts
}

/** A row as the plan shows it once the orchestrator gave up on its chat: left to a person. */
export function afterGivingUp(row: OrchestratorRow, tries: ReadonlyMap<string, number>): OrchestratorRow {
  if ((tries.get(row.id) ?? 0) <= RETRIES || (row.move !== 'retry-error' && row.move !== 'resume-after-limit')) return row
  return { ...row, move: 'leave', reason: `the orchestrator continued it ${RETRIES} times and it stopped again: ${row.reason}` }
}
