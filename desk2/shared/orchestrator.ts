// The orchestrator's plan (phase A, shadow): for each open chat, the one move the orchestrator would make next and
// why, and, when asked, what the CreAitor says the owner would answer. The server computes it
// (server/src/orchestrator/plan.ts, GET /api/diagnostics/orchestrator); Settings > Diagnostics > Orchestrator draws
// it. Nothing here dispatches: the plan is what it WOULD do. Plain types only.

/** The one next move for a chat, most urgent first. */
export type OrchestratorMove =
  | 'answer-question' // a question card waits for an answer
  | 'answer-need' // the last reply ended on a NEED line or a "want me to ...?" question
  | 'retry-error' // the last turn failed
  | 'resume-after-limit' // the account hit its limit and the chat stays on it
  | 'watch' // working, starting, queued, or moved by the engine itself
  | 'leave' // a person is in it, or it waits on something only a person grants (a permission, a plan, a form)
  | 'done' // finished, nothing asked

export const ORCHESTRATOR_MOVES: readonly OrchestratorMove[] = ['answer-question', 'answer-need', 'retry-error', 'resume-after-limit', 'watch', 'leave', 'done']

/** What the CreAitor answered: decide (the owner's answer), reversible (take the reversible option), escalate (only the owner). */
export interface CreaitorAnswer {
  verdict: 'decide' | 'reversible' | 'escalate'
  answer: string
  option: string
  confidence: number
  basis: string[]
  needLine: string | null
  mode: string // 'shadow' until a class of question is proven, then 'live'
}

export interface OrchestratorRow {
  id: string // a Desk chat id, or an outside session's id (source other than 'desk')
  title: string
  cwd: string
  account: string
  /** Which app runs it: a Desk chat, or an outside session AgentHydra knows (ExternalSession.source). */
  source: 'desk' | 'desktop' | 'cli' | 'climayte' | 'codex' | 'other'
  status: string // the chat's ChatStatus
  updatedAt: number
  move: OrchestratorMove
  reason: string
  /** answer-question / answer-need: what is asked, and the choices when it gave them. */
  question?: string
  options?: string[]
  /** Present only on ?ask=1, for rows with a question. */
  creaitor?: CreaitorAnswer | { error: string }
}

export interface OrchestratorPlan {
  at: number
  mode: 'shadow'
  days: number // chats and outside sessions active in the last `days` days
  creaitor: boolean // this machine has the CreAitor
  rows: OrchestratorRow[]
  counts: Partial<Record<OrchestratorMove, number>>
}
