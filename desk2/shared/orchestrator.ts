// The orchestrator's plan: for each open chat, the one move the orchestrator would make next and why, and, when
// asked, what the CreAitor says the owner would answer. The server computes it (server/src/orchestrator/plan.ts,
// GET /api/diagnostics/orchestrator); Settings > Diagnostics > Orchestrator draws it. Phase A, shadow: the plan is
// only what it WOULD do. Phase B, armed by the owner (Settings > General > Orchestrator, the `orchestrator` setting, or
// POST the same path { armed }): it also continues a Desk chat an error stopped (server/src/orchestrator/act.ts), and its
// foreman peeks at running chats and sends a note to one that keeps failing the same step or hangs on a call
// (server/src/orchestrator/foreman.ts); a chat a usage limit stopped is the babysitter's (shared/babysitter.ts).
// Since 2026-10-09 a model judges each chat it looks at (server/src/orchestrator/judge.ts): the rules above are its
// inputs and its safety rails, and each judgment is shown on the chat's row. Plain types and pure checks only.

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
  /** The model's latest judgment of this chat, when it has judged it (the armed orchestrator). */
  judgment?: OrchestratorJudgment
}

/** What the judge decided for one chat: fine (send nothing), nudge (a check-in), continue (carry on after an error),
 *  leave (only a person can move it). Anything else in the model's answer is an error, never a guess. */
export const ORCHESTRATOR_VERDICTS = ['fine', 'nudge', 'continue', 'leave'] as const
export type OrchestratorVerdict = (typeof ORCHESTRATOR_VERDICTS)[number]

/** The model the judge asks: Claude Code's alias for the newest model of that family (`opus` is the newest Opus), or a
 *  full model id such as `claude-opus-5-5`. */
export const ORCHESTRATOR_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const

/** A valid `orchestratorModel`: one of the aliases, or a full `claude-...` model id. */
export function isOrchestratorModel(v: unknown): v is string {
  return typeof v === 'string' && ((ORCHESTRATOR_MODEL_ALIASES as readonly string[]).includes(v) || /^claude-[a-z0-9][a-z0-9.-]{0,63}$/.test(v))
}

/** GET /api/orchestrator/model: the `orchestratorModel` setting, and the model id the SDK reported for it (null until the
 *  judge has asked the model once; then Settings shows what the alias resolves to). */
export interface OrchestratorModelStatus {
  setting: string
  resolved: string | null
}

/** One judgment of one chat, shown on its row. `verdict` is null and `error` set when the model call failed; nothing
 *  was sent then. `resolved` is the model id the SDK reported for the call (null when it did not say). `message` is what
 *  the judge wrote to send ('' for fine or leave); `held` says why a nudge or continue the judge asked for was not sent,
 *  the hard limits (server/src/orchestrator/judge.ts, plugins/70-orchestrator.ts) holding it. */
export interface OrchestratorJudgment {
  at: number
  model: string // the `orchestratorModel` setting the call used
  resolved: string | null
  verdict: OrchestratorVerdict | null
  why: string // one sentence for the owner, or the error
  message: string
  held: string | null
  error: string | null
}

/** The name on every message the armed orchestrator sends: Desk shows it as a note from it, never as the person's
 *  (`[<from>] Not from the user.`, server/src/engine/system-text.ts noteOf). */
export const ORCHESTRATOR_FROM = "Desk 2's orchestrator"

/** One thing the armed orchestrator did on its own, newest first in the plan. */
export interface OrchestratorAct {
  at: number
  id: string // the Desk chat, or for the foreman an outside session's id too
  title: string
  move: OrchestratorMove
  /** What it did: queued "continue", stopped continuing a chat that keeps stopping, sent a running chat the foreman's
   *  check-in note, or flagged a running chat that stopped writing (shown only). */
  did: 'continued' | 'gave-up' | 'nudged' | 'flagged'
  /** The foreman's acts: which app runs the chat, and what it saw. */
  source?: OrchestratorRow['source']
  /** The judge's one-sentence reason for the act. */
  detail?: string
  /** Why the send failed, when it did. */
  error?: string
}

export interface OrchestratorPlan {
  at: number
  /** shadow: it plans only. armed: the owner turned it on; it continues Desk chats an error stopped and its foreman
   *  peeks at running chats. */
  mode: 'shadow' | 'armed'
  days: number // chats and outside sessions active in the last `days` days
  creaitor: boolean // this machine has the CreAitor
  rows: OrchestratorRow[]
  counts: Partial<Record<OrchestratorMove, number>>
  /** What it did on its own since Desk started, newest first (the last 50). */
  acts: OrchestratorAct[]
}

/** POST /api/diagnostics/orchestrator: arm or disarm it. Armed is the `orchestrator` setting (off by default): it lasts
 *  until it is turned off (owner, 2026-10-09: a switch beside the babysitter's, "easy to turn on"). */
export interface OrchestratorArm {
  armed: boolean
}
