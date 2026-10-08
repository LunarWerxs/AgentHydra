// server/src/climayte-wave-ops.ts — waves on the live workers: a wave's record found across
// accounts (liveWave), listed and edited, a manager held while its wave runs and reported when it
// ends, task results batched for the manager, and the verify and resolve steps. The wave store and
// its pure helpers are climayte-wave.ts; starting a wave and the periodic reconcile stay in
// climayte.ts. Split from climayte.ts on 2026-10-08; nothing here imports it.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { accountsProvider, changed, journal, load, workers } from './climayte-core'
import { firstLine } from './climayte-journal'
import type { CliMayteWave, CliMayteWorker } from './climayte-lib'
import { verdictNoteTooLong, verdictRecord } from './climayte-steer'
import { readWave, reportWave, waveDone, writeWave } from './climayte-wave'

// Waves modified during this tick: waveId -> { wave, configDir }. Cleared at the end of the tick.
export const modifiedWaves = new Map<string, { wave: CliMayteWave; configDir: string }>()

/** A manager whose turn ended done on wave `waveId` (settleWorker): held while the wave has live
 *  tasks and no report, nudged once to report or dispatch, failed after that; a finished wave with
 *  no report takes the manager's answer as one (reportForManager). */
export function holdManagerForWave(w: CliMayteWorker, waveId: string, now: number): void {
  try {
    const found = liveWave(waveId)
    const wave = found?.wave
    if (found && wave && wave.status === 'running' && !wave.report && !waveDone(wave)) {
      const running = wave.tasks.filter((t) => t.state === 'running').length
      const queued = wave.tasks.filter((t) => t.state === 'pending').length
      if (running || w.status !== 'done') {
        w.waveNudged = false
        w.status = 'waiting'
        w.hold = 'wave'
        w.error = `Managing wave ${w.wave}: ${running} running, ${queued} queued`
      } else if (w.waveNudged) {
        // Nothing runs, so no task's end will wake it: held, the wave would wait forever.
        w.status = 'failed'
        w.error = `Wave ${w.wave} has ${queued} pending task(s), none running and no report after "report or dispatch": it needs the orchestrator.`
      } else {
        w.waveNudged = true
        w.pending.push(REPORT_OR_DISPATCH)
        w.status = 'queued'
        w.revived = true
      }
    } else if (found) reportForManager(w, found, now)
  } catch {
    // If we can't read the wave, proceed normally (status is already set by settleWorker).
  }
}

/** The one message a manager gets when its turn ends with nothing of its wave running and no report. */
const REPORT_OR_DISPATCH =
  'Report or dispatch: nothing in your wave is running and it has no report. Dispatch the next ready keys (wave_dispatch), escalate a key that cannot run (wave_escalate), or call wave_report if every key is passed, failed or escalated. Another turn like this one fails you.'

/** A manager that ended `done` on its finished wave without calling wave_report: its last answer is the
 *  report, so climayte_wait --wave wakes and climayte_wave_verify takes the wave. RustTor, 2026-10-05:
 *  wv-42c178 (13 tasks) and wv-5a5bbc (12) sat `running` for hours with every task passed, nothing
 *  held, and each manager's report written as its answer instead. Nothing happens while a change the
 *  manager has not seen is held for it, or a message waits for its next turn. */
function reportForManager(
  w: CliMayteWorker,
  found: { wave: CliMayteWave; configDir: string },
  now: number,
): void {
  const { wave } = found
  if (w.status !== 'done' || wave.managerId !== w.id || wave.status !== 'running' || wave.report)
    return
  if (!waveDone(wave) || wave.batch.held.length) return
  const said = w.results?.at(-1) ?? w.result ?? ''
  reportWave(
    wave,
    `The manager ended without wave_report; its last answer:\n\n${said || '(none)'}`,
    now,
  )
  modifiedWaves.set(wave.id, found)
}

export function addToWaveBatch(w: CliMayteWorker, now: number, judged = false): void {
  // Piece 3: The daemon's batch wake. When a wave task finishes, add it to the wave's batch.held
  // so waveBatch can decide when to wake the manager.
  if (w.wave && (judged || w.status !== 'failed')) {
    try {
      const found = liveWave(w.wave)
      const wave = found?.wave
      if (found && wave && wave.status === 'running' && !wave.report) {
        // Find the task in the wave that this worker belongs to.
        const task = wave.tasks.find((t) => t.workerId === w.id)
        if (task && !wave.batch.held.includes(task.key)) {
          wave.batch.held.push(task.key)
          if (wave.batch.since === null) {
            wave.batch.since = now
          }
          wave.updatedAt = now
          modifiedWaves.set(w.wave, { wave, configDir: found.configDir })
        }
      }
    } catch {
      // If we can't update the wave, the batch will be updated on the next tick.
    }
  }
}

/** Every directory a wave record may sit in: each account's config dir (readWave's `configDir`). */
export function waveDirs(): string[] {
  const dirs: string[] = []
  try {
    for (const a of accountsProvider()) if (!dirs.includes(a.configDir)) dirs.push(a.configDir)
  } catch {
    // no accounts: no waves
  }
  return dirs
}

/** A wave by id, with the directory it is stored in, or null. */
function findWave(id: string): { wave: CliMayteWave; configDir: string } | null {
  for (const configDir of waveDirs()) {
    const wave = readWave(configDir, id)
    if (wave) return { wave, configDir }
  }
  return null
}

/** A wave by id for a change on the tick: the copy the tick already holds (modifiedWaves), else the
 *  one on disk, with the directory it lives in. A wave is stored under the account it was started
 *  on, which is not the account every one of its tasks runs on. */
export function liveWave(id: string): { wave: CliMayteWave; configDir: string } | null {
  return modifiedWaves.get(id) ?? findWave(id)
}

/** Waves seen reported, decided, failed or cancelled: reconcileWaves reads their files no more. */
export const settledWaves = new Set<string>()

/** How long reconcileWaves waits before looking again for a wave no account folder holds. */
const WAVE_MISSING_RETRY_MS = 10 * 60_000

/** Waves reconcileWaves found in no account folder, with when it may look again. A finished worker
 *  can name a wave whose record is gone (deleted, or under an account since removed); looking for
 *  each one in every account folder every 5 s blocked the daemon most of the time (2026-10-08: 51
 *  missing waves x 41 folders, about 2,100 file probes a pass). */
const missingWaves = new Map<string, number>()

/** liveWave for reconcileWaves: null without touching the disk while a wave is known missing. */
export function reconcilableWave(
  id: string,
  now: number,
): { wave: CliMayteWave; configDir: string } | null {
  if ((missingWaves.get(id) ?? 0) > now) return null
  const found = liveWave(id)
  if (found) missingWaves.delete(id)
  else missingWaves.set(id, now + WAVE_MISSING_RETRY_MS)
  return found
}

/** A worker of a wave not yet seen settled that has ended: done, failed or cancelled. */
export function endedInWave(w: CliMayteWorker): boolean {
  if (!w.wave || settledWaves.has(w.wave)) return false
  return w.status === 'done' || w.status === 'failed' || w.status === 'cancelled'
}

/** Report a `done` manager's wave (reportForManager), or settle it once it is past `running`. */
export function reconcileManager(m: CliMayteWorker, now: number): void {
  if (m.kind !== 'manage' || m.status !== 'done') return
  const found = reconcilableWave(m.wave as string, now)
  if (!found) return
  if (found.wave.status !== 'running') settledWaves.add(found.wave.id)
  else reportForManager(m, found, now)
}

/** Every wave on record, newest first, exactly as stored (GET /api/corch/waves). */
export function climayteWaves(): CliMayteWave[] {
  const out = new Map<string, CliMayteWave>()
  for (const dir of waveDirs()) {
    let names: string[] = []
    try {
      names = readdirSync(join(dir, 'corch', 'waves'))
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.endsWith('.json') || out.has(n.slice(0, -5))) continue
      const wave = readWave(dir, n.slice(0, -5))
      if (wave) out.set(wave.id, wave)
    }
  }
  return [...out.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function climayteWave(id: string): CliMayteWave | null {
  return findWave(id)?.wave ?? null
}

/** Change a wave record and write it: `fn` gets the copy the tick may be holding (modifiedWaves) or
 *  the one on disk, so a write here is not overwritten by a stale copy at the end of the tick.
 *  Null when no such wave exists. */
export function climayteWaveEdit<T>(id: string, fn: (wave: CliMayteWave) => T): T | null {
  load()
  const held = modifiedWaves.get(id)
  const found = held ?? findWave(id)
  if (!found) return null
  const out = fn(found.wave)
  found.wave.updatedAt = Date.now()
  writeWave(found.configDir, found.wave)
  return out
}

/** The wave's own tasks are no `manage` kind, and a wave needs at least this many tasks: smaller jobs
 *  keep climayte_run. */
export const WAVE_MIN_TASKS = 3

/** The note a wave verification records: the orchestrator's own (trimmed; one over VERDICT_NOTE_MAX is refused before this), else
 *  none for an accepted wave and a stock line for a rejected one. */
function waveVerifyNote(note: unknown, accepted: boolean): string | null {
  if (typeof note === 'string' && note.trim()) return note.trim()
  return accepted ? null : 'The orchestrator rejected the wave.'
}

/** Confirm every provisional wave pass on the wave's task workers; returns how many were confirmed. */
function confirmWavePasses(wave: CliMayteWave): number {
  let confirmed = 0
  for (const t of wave.tasks) {
    const w = t.workerId ? workers.get(t.workerId) : undefined
    if (!w) continue
    for (const v of w.verdicts ?? []) {
      if (v.by === 'wave' && v.provisional) {
        delete v.provisional
        confirmed++
      }
    }
    changed(w)
  }
  return confirmed
}

/** Record the orchestrator's pass or fail on the wave's manager, when it still exists. */
function recordManagerVerdict(wave: CliMayteWave, accepted: boolean, note: string | null): void {
  const manager = workers.get(wave.managerId)
  if (!manager) return
  // Recorded directly: the manager may still be ending its turn, which climayteVerdict refuses.
  manager.verdicts = [
    ...(manager.verdicts ?? []),
    verdictRecord(manager, accepted ? 'pass' : 'fail', note, 'orchestrator'),
  ]
  journal(manager, 'verdict', {
    verdict: accepted ? 'pass' : 'fail',
    notice: note ? firstLine(note) : undefined,
    kind: 'manage',
  })
  changed(manager)
}

/** Piece 7: the orchestrator's one verification of a reported wave. `ok` confirms every provisional
 *  pass of its tasks (they count in the scorecard from then on) and records a pass on the manager;
 *  not `ok` confirms none and records a fail on the manager, `retry: false` (the wave is over). */
export function climayteWaveVerify(
  id: string,
  input: { ok: unknown; note?: unknown },
): { ok: boolean; status: number; message: string } {
  load()
  const found = findWave(id)
  if (!found) return { ok: false, status: 404, message: `No such wave: ${id}` }
  const { wave, configDir } = found
  if (wave.status !== 'reported')
    return {
      ok: false,
      status: 409,
      message: `Wave ${id} is ${wave.status}: only a reported wave can be verified.`,
    }
  const tooLong = verdictNoteTooLong(input.note)
  if (tooLong) return { ok: false, status: 400, message: tooLong }
  const accepted = input.ok === true
  const note = waveVerifyNote(input.note, accepted)
  const confirmed = accepted ? confirmWavePasses(wave) : 0
  recordManagerVerdict(wave, accepted, note)
  wave.status = accepted ? 'verified' : 'rejected'
  wave.updatedAt = Date.now()
  writeWave(configDir, wave)
  return {
    ok: true,
    status: 200,
    message: accepted
      ? `Wave ${id} verified: ${confirmed} provisional pass(es) confirmed.`
      : `Wave ${id} rejected: no provisional pass confirmed.`,
  }
}

/** The orchestrator settles one escalated or failed key of a wave: pass -> passed (counts for `after`),
 *  fail -> failed. The key joins the batch so the manager hears it in its next message. */
export function climayteWaveResolve(
  id: string,
  key: string,
  input: { ok: unknown; note?: unknown },
): { ok: boolean; status: number; message: string } {
  load()
  const tooLong = verdictNoteTooLong(input.note)
  if (tooLong) return { ok: false, status: 400, message: tooLong }
  const ok = input.ok === true
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null
  const out = climayteWaveEdit(id, (wave) => {
    const task = wave.tasks.find((t) => t.key === key)
    if (!task) return { ok: false, status: 404, message: `Wave ${id} has no key ${key}.` }
    if (task.state !== 'escalated' && task.state !== 'failed')
      return {
        ok: false,
        status: 409,
        message: `Key ${key} is ${task.state}: only an escalated or failed key can be resolved.`,
      }
    settleWaveTask(wave, task, ok, note ?? 'settled by the orchestrator', Date.now())
    return { ok: true, status: 200, message: `Key ${key} is now ${task.state}.` }
  })
  if (out?.ok) queueWaveForTick(id)
  return out ?? { ok: false, status: 404, message: `No such wave: ${id}` }
}

/** Set a wave key's state by the orchestrator's word, clear its escalation, and queue it for the manager. */
function settleWaveTask(
  wave: CliMayteWave,
  task: CliMayteWave['tasks'][number],
  ok: boolean,
  note: string,
  now: number,
): void {
  task.state = ok ? 'passed' : 'failed'
  task.proof = { ...(task.proof ?? { check: null, commits: [], paths: null }), note }
  wave.escalations = wave.escalations.filter((e) => e.key !== task.key)
  if (!wave.batch.held.includes(task.key)) wave.batch.held.push(task.key)
  if (wave.batch.since === null) wave.batch.since = now
  wave.updatedAt = now
}

/** Hand a just-edited wave to the tick so its batch wakes the manager. */
function queueWaveForTick(id: string): void {
  const held = modifiedWaves.get(id)
  const found = held ?? findWave(id)
  if (found) modifiedWaves.set(id, found)
}

/** An orchestrator verdict on the worker of a wave key settles that key too. */
export function settleKeyOfWorker(w: CliMayteWorker, ok: boolean, note: string | null): void {
  if (!w.wave || w.kind === 'manage') return
  climayteWaveEdit(w.wave, (wave) => {
    const task = wave.tasks.find((t) => t.workerId === w.id)
    if (task && (task.state === 'escalated' || task.state === 'failed'))
      settleWaveTask(wave, task, ok, note ?? 'settled by the orchestrator verdict', Date.now())
  })
  queueWaveForTick(w.wave)
}
