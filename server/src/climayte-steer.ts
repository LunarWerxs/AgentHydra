// server/src/climayte-steer.ts — what reaches a worker from outside, and how it is checked: a
// message's model, effort and folder (climayteSend in climayte.ts acts on them), the question a
// worker asks (climayteAsk) and its stop hook, and a verdict's note, severity and record (sendBack
// and climayteVerdict in climayte.ts act on those). Split from climayte.ts on 2026-10-08; nothing
// here imports it.

import { changed, journal, load, workers } from './climayte-core'
import { validateCwd } from './climayte-cwd'
import { etaTookSeconds, stopDecision } from './climayte-eta'
import { appendEtaRow, settledRow } from './climayte-eta-ledger'
import { firstLine } from './climayte-journal'
import { type CliMayteWorker, climayteEffort, climayteModel } from './climayte-lib'
import {
  attemptUnits,
  bestRungPastHaiku,
  type CliMayteVerdict,
  climayteKind,
  HAIKU,
  ladderModel,
  rereadUnits,
  scoreRows,
} from './climayte-scorecard'

/** What a message to a running worker waits for: a `-p` session takes no input mid-run, so it is
 *  delivered only when the whole current task ends. Field note 10 (2026-09-30): only this answer
 *  said so, and a "fix the build first" message could not reach a worker that was breaking it. */
export const HELD_MESSAGE =
  'Held until this worker finishes its WHOLE current task: a running CLI session takes no input mid-run, so it gets this only after it ends (that can be many minutes). If it must act on it now, send it again with urgent: true, which stops the running work and continues the same session with your message first.'

/** Preface of an urgent message, so the session knows why its turn ended mid-step. */
export const URGENT_PREFIX =
  'AgentHydra stopped your previous turn mid-step to deliver this message from the orchestrator. Act on it first; then continue the task only if it still applies, checking the state of anything you were in the middle of.'

/** The model, effort and folder a message names, applied from the next launch on. */
export interface SendSetting {
  model: string | null
  effort: string | null
  cwd: string | undefined
}

/** A message's model, effort and folder, checked; a refusal's text when one is not valid. */
export function sendSetting(
  w: CliMayteWorker,
  opts: { model?: string; effort?: string; cwd?: string },
): SendSetting | string {
  // A new model or effort applies from the next launch on: the turn that delivers this message
  // (or one queued before it) and every later one, in the same session (`--resume` takes both).
  let model: string | null
  let effort: string | null
  try {
    model = climayteModel(opts.model)
    // A move to Haiku with no effort runs at medium, not at the effort the old model had.
    effort = climayteEffort(opts.effort) ?? (model === HAIKU && w.model !== HAIKU ? 'medium' : null)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  // Another folder applies from the next launch on (climayte-cwd.ts carries the session there).
  let cwd: string | undefined
  if (opts.cwd !== undefined) {
    try {
      cwd = validateCwd(opts.cwd)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  return { model, effort, cwd }
}

/** Put a message's setting on its worker (another folder as pendingCwd, for the next launch). */
export function applySendSetting(w: CliMayteWorker, { model, effort, cwd }: SendSetting): void {
  if (model) w.model = model
  if (effort) w.effort = effort
  if (cwd && cwd !== w.cwd) {
    w.pendingCwd = cwd
    journal(w, 'cwd-changed', { cwd, from: w.cwd, pending: 1 })
  } else if (cwd) delete w.pendingCwd // back to the folder it is in
}

/** Queue a message after the ones held before it, for the worker's next turn. */
export function queueFollowUp(
  w: CliMayteWorker,
  text: string,
  { model, effort }: SendSetting,
): void {
  w.pending.push(text)
  journal(w, 'follow-up-queued', {
    pending: w.pending.length,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  })
}

/** Preface of a held message the person sent now (Hydra Desk 2's Send now), so the session knows why
 *  its turn ended mid-step. Desk shows the person's bubble without it. */
export const SENT_NOW_PREFIX =
  '[Sent now: the user stopped your previous turn mid-step to send this message. Act on it first; then continue the task only if it still applies, checking the state of anything you were in the middle of.]'

const QUESTION_MAX = 2000

const OPTION_MAX = 200

const OPTIONS_MAX = 8

/** The Stop hook a worker's CLI calls when its turn is about to end (climayte-signal.ts workerHooks),
 *  answered by the daemon: `{}` lets it stop; `{decision: 'block', reason}` makes it answer, in the
 *  same turn and with its context warm, why its estimate missed (climayte-eta.ts stopDecision). The
 *  estimate settles here, at the moment the work was done, not after the review turn. A worker
 *  that is not running, a chat and a sealed worker are never asked. */
export function climayteStopHook(
  id: string,
  input: { stop_hook_active?: unknown } | null,
): { decision: 'block'; reason: string } | Record<string, never> {
  load()
  const w = workers.get(id)
  if (!w || w.chat || w.sealed || w.status !== 'running' || !w.eta) return {}
  const now = Date.now()
  const tookS = etaTookSeconds(w.eta, w.attempts, now)
  const reason = stopDecision({
    eta: w.eta,
    stopHookActive: input?.stop_hook_active === true,
    asking: !!w.question,
    tookS,
  })
  if (!reason) return {}
  w.eta.tookS = tookS
  w.eta.doneAt = now
  w.eta.reviewAskedAt = now
  appendEtaRow(settledRow(w, w.eta as typeof w.eta & { tookS: number; doneAt: number }))
  changed(w)
  return { decision: 'block', reason }
}

/** A worker's question (the climayte_ask tool, climayte-ask-mcp.ts): recorded on it, journaled and
 *  pinged to whoever started it (climayte-ping.ts 'asking'). The worker ends its turn after asking;
 *  the answer is climayteSend, which resumes the same session and clears the question. Nothing
 *  waits inside the call. Only a running worker can ask. */
export function climayteAsk(
  id: string,
  input: { question?: unknown; options?: unknown; context?: unknown },
): { ok: boolean; message: string } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  if (w.status !== 'running')
    return { ok: false, message: `This worker is ${w.status}, not running: it cannot ask.` }
  const text = typeof input.question === 'string' ? input.question.trim() : ''
  if (!text) return { ok: false, message: 'The question is empty.' }
  const options = Array.isArray(input.options)
    ? input.options
        .filter((o): o is string => typeof o === 'string' && !!o.trim())
        .slice(0, OPTIONS_MAX)
        .map((o) => o.trim().slice(0, OPTION_MAX))
    : []
  const context = typeof input.context === 'string' ? input.context.trim() : ''
  w.question = {
    text: text.slice(0, QUESTION_MAX),
    ...(options.length ? { options } : {}),
    ...(context ? { context: context.slice(0, QUESTION_MAX) } : {}),
    at: Date.now(),
  }
  journal(w, 'asked', { said: firstLine(text).slice(0, 160) })
  changed(w)
  return {
    ok: true,
    message:
      'Your question is recorded and sent to whoever started you. End your turn now with one line saying what you asked and what you did so far (do not wait inside this call); the answer arrives as a message that resumes this same session. Until then, do only work that does not depend on the answer.',
  }
}

export const SENT_BACK = 'The orchestrator checked your result and it did not pass. What was wrong:'

export const configLabel = (c: { model: string | null; effort: string | null }): string => {
  const m = c.model
  const name = m?.includes('haiku-5-5')
    ? 'Haiku 5.5'
    : m?.includes('haiku')
      ? 'Haiku 4.5'
      : m?.includes('sonnet')
        ? 'Sonnet 5.5'
        : m?.includes('opus')
          ? 'Opus 5.5'
          : (m ?? 'the default model')
  return `${name} · ${c.effort ?? 'default effort'}`
}

/** Tag an untagged task's kind from the verdict. The reason it is not a kind, or null. */
export function tagKind(w: CliMayteWorker, kind: unknown): string | null {
  try {
    const k = climayteKind(kind)
    if (k) w.kind = k
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** A verdict's record: the setting that produced the result, and what that work cost. */
export function verdictRecord(
  w: CliMayteWorker,
  passed: 'pass' | 'fail',
  note: string | null,
  by: unknown,
  provisional = false,
  severity?: 0 | 1 | 2 | 3,
): CliMayteVerdict {
  // The work this verdict judges: every attempt since the previous verdict.
  const previous = w.verdicts?.at(-1)
  const since = previous?.at ?? 0
  const ran = w.attempts.filter((a) => a.startedAt >= since)
  const reported = [...ran].reverse().find((a) => a.model)?.model ?? null
  // No attempt since the previous verdict: this one judges the same work and replaces it in the
  // scorecard (scoreRows), so it keeps what that work cost.
  const span = w.attempts.at(-1)?.startedAt
  const same = !ran.length && previous?.span !== undefined && previous.span === span
  return {
    at: Date.now(),
    verdict: passed,
    note,
    model: ladderModel(w.model ?? reported),
    effort: w.effort,
    units: same
      ? previous.units
      : ran.reduce((sum, a) => sum + attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl), 0),
    reread: same
      ? (previous.reread ?? 0)
      : ran.reduce((sum, a) => sum + rereadUnits(a, w.model), 0),
    by: by === 'check' || by === 'owner' || by === 'wave' ? by : 'orchestrator',
    ...(provisional ? { provisional: true } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(span !== undefined ? { span } : {}),
  }
}

/** The ladder index a failed Haiku result climbs to at least: the rung its kind would run without
 *  the Haiku trial (bestRungPastHaiku), so a task Haiku cannot do goes straight to the setting that
 *  would have run it. Undefined for any other result, or a worker with no kind on the list. */
export function haikuFailFloor(
  w: CliMayteWorker | undefined,
  verdict: CliMayteVerdict,
): number | undefined {
  if (!w?.auto || !w.kind || verdict.model !== HAIKU) return undefined
  try {
    const k = climayteKind(w.kind)
    return k ? bestRungPastHaiku(k, scoreRows(workers.values())) : undefined
  } catch {
    return undefined // a kind no longer on the list: one rung up
  }
}

/** Judge a finished task's result (owner, 2026-09-30: "if it works, it gives it a thumbs up ... if
 *  it does not, it reports the failure, and what model it tries next"). The verdict is kept with the
 *  setting that produced the result and what that work cost, and the scorecard learns from it. A
 *  fail (with `note`, required: the worker gets it) sends the task back to the same session one
 *  rung up the ladder unless `retry` is false or the task is sealed. `kind` tags a task dispatched
 *  without one. */
/** The longest verdict note kept. The note is the fix instruction a worker receives with a fail, so a
 *  longer one is refused, never cut (three fail notes reached their workers cut mid-word, 2026-10-04). */
export const VERDICT_NOTE_MAX = 8000

/** The refusal for a note over the limit (its length and the limit), else null. */
export function verdictNoteTooLong(note: unknown): string | null {
  const n = typeof note === 'string' ? note.trim().length : 0
  return n > VERDICT_NOTE_MAX
    ? `The note is ${n} characters; the limit is ${VERDICT_NOTE_MAX}. Shorten it: it is not cut.`
    : null
}

/** A fail's severity when it is one of 0-3, else undefined. */
export function verdictSeverity(sev: unknown): 0 | 1 | 2 | 3 | undefined {
  return sev === 0 || sev === 1 || sev === 2 || sev === 3 ? sev : undefined
}

/** Why a verdict is refused on its note or severity, else null: a fail says what was wrong, and
 *  only a fail has a severity (0-3). */
export function verdictProblem(
  verdict: 'pass' | 'fail',
  note: string | null,
  sev: unknown,
): string | null {
  if (verdict === 'fail' && !note)
    return 'Say what was wrong (note): the worker gets it with the retry.'
  if (sev != null) {
    if (verdict === 'pass') return 'A pass has no severity: it is for a fail (0-3).'
    if (verdictSeverity(sev) === undefined)
      return "severity must be an integer 0-3 (0 not the model's, 1 slip, 2 rework, 3 failed)."
  }
  return null
}
