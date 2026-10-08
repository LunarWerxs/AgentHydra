// server/src/climayte-wave.ts — CliMayte waves: the orchestrator breaks work into tasks,
// the manager dispatches them, and the daemon records proof that each one passed.
// The wave record persists in corch/waves/<waveId>.json so a restarted daemon and a fresh
// manager session read the same truth. This file holds the store helpers and the pure
// functions waveStateText and waveDone.

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CliMayteWave, CliMayteWorker } from './climayte-lib'
import { type JsonStoreSpec, mutateJsonStore, readJsonStore } from './core/json-store'

type CliMayteTask = CliMayteWave['tasks'][0]

// The store path for a wave record.
export function waveStorePath(configDir: string, waveId: string): string {
  return join(configDir, 'corch', 'waves', `${waveId}.json`)
}

// Create a store spec for a wave record.
function waveStoreSpec(configDir: string, waveId: string): JsonStoreSpec<CliMayteWave> {
  return {
    path: waveStorePath(configDir, waveId),
    decode: (parsed): CliMayteWave | null => {
      if (!parsed || typeof parsed !== 'object') return null
      const wave = parsed as any
      if (
        typeof wave.id !== 'string' ||
        typeof wave.group !== 'string' ||
        typeof wave.managerId !== 'string' ||
        !Array.isArray(wave.tasks)
      ) {
        return null
      }
      return wave
    },
    empty: (): CliMayteWave => ({
      id: waveId,
      group: '',
      managerId: '',
      plan: '',
      cwd: '',
      branch: 'main',
      verify: null,
      tasks: [],
      escalations: [],
      notes: '',
      rounds: 0,
      maxRounds: 3,
      batch: { size: 1, settleS: 600, held: [], since: null },
      status: 'running',
      report: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  }
}

// Read a wave record from disk, or null if missing. A read creates no folder: a missing folder is a
// missing wave (ENOENT), and a mkdir per read was most of the daemon's blocked time on 2026-10-08,
// when the tick looked for 51 deleted waves in 41 account folders every 5 s.
export function readWave(configDir: string, waveId: string): CliMayteWave | null {
  const spec = waveStoreSpec(configDir, waveId)
  const result = readJsonStore<CliMayteWave>(spec)
  return result.status === 'ok' ? result.value : null
}

// Write or update a wave record.
export function writeWave(configDir: string, wave: CliMayteWave): void {
  mkdirSync(join(configDir, 'corch', 'waves'), { recursive: true })
  const spec = waveStoreSpec(configDir, wave.id)
  const result = mutateJsonStore<CliMayteWave, void>(spec, (current) => {
    // Update all fields from the new wave
    Object.assign(current, wave)
    return {
      result: undefined,
      changed: true,
    }
  })
  if (!result.ok) {
    throw new Error(`Failed to write wave ${wave.id}: ${result.reason}`)
  }
}

function formatTaskProofParts(proof: NonNullable<CliMayteTask['proof']>): string[] {
  const parts: string[] = []
  if (proof.check !== null) {
    parts.push(`check: ${proof.check ? 'pass' : 'fail'}`)
  }
  if (proof.commits.length > 0) {
    parts.push(`commits: ${proof.commits.join(', ')}`)
  }
  if (proof.paths !== null) {
    parts.push(`paths: ${proof.paths ? 'ok' : 'mismatch'}`)
  }
  if (proof.note) {
    parts.push(proof.note)
  }
  return parts
}

function formatTaskLine(
  task: CliMayteTask,
  worker: CliMayteWorker | null,
  allTasks: CliMayteTask[],
): string {
  const workerStatus = worker ? `${worker.id.slice(0, 10)} (${worker.status})` : 'none'
  let line = `- ${task.key}: ${task.state}`

  // Add ready marker for pending tasks whose after-keys have all passed
  if (task.state === 'pending') {
    const afterPassed = task.after.every((key) => {
      const afterTask = allTasks.find((t) => t.key === key)
      return afterTask?.state === 'passed'
    })
    if (afterPassed) {
      line += ' (ready)'
    }
  }

  // Add title
  line += ` "${task.title}"`

  // Add after-keys
  if (task.after.length > 0) {
    line += ` after: ${task.after.join(', ')}`
  }

  if (worker) {
    line += ` → ${workerStatus}`
  }
  if (task.proof) {
    const parts = formatTaskProofParts(task.proof)
    if (parts.length > 0) {
      line += ` {${parts.join('; ')}}`
    }
  }
  return line
}

// Pure: render the wave state as human-readable text. One line per task with its state, worker,
// proof and rounds. Escalations and notes follow. Used to brief the manager at the start and
// when it wakes. About 2-4k tokens for 20 tasks.
export function waveStateText(wave: CliMayteWave, workers: Map<string, CliMayteWorker>): string {
  const lines: string[] = [
    `# Wave ${wave.id}`,
    `Group: ${wave.group}`,
    `Plan: ${wave.plan}`,
    `Branch: ${wave.branch}`,
    `Dispatch rounds: ${wave.rounds}/${wave.maxRounds}`,
    ``,
    `## Tasks`,
  ]

  for (const task of wave.tasks) {
    const worker = task.workerId ? (workers.get(task.workerId) ?? null) : null
    lines.push(formatTaskLine(task, worker, wave.tasks))
  }

  if (wave.escalations.length > 0) {
    lines.push('')
    lines.push('## Escalations')
    for (const esc of wave.escalations) {
      lines.push(`- ${esc.key}: ${esc.reason}`)
    }
  }

  if (wave.notes) {
    lines.push('')
    lines.push('## Notes')
    lines.push(wave.notes)
  }

  return lines.join('\n')
}

// Pure: true when every key in the wave is passed, failed or escalated.
export function waveDone(wave: CliMayteWave): boolean {
  return wave.tasks.every(
    (t) => t.state === 'passed' || t.state === 'failed' || t.state === 'escalated',
  )
}

/** The most a manager's report or notes keep, in characters. */
export const WAVE_TEXT_CAP = 2000

/** The table a report starts with: one line per key, then the branch head (git, hidden). */
export function reportTable(wave: CliMayteWave): string {
  const head = spawnSync('git', ['rev-parse', wave.branch], {
    cwd: wave.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  const sha = head.status === 0 ? (head.stdout ?? '').trim() : 'unknown'
  const lines = wave.tasks.map((t) => {
    const p = t.proof
    const proof = p
      ? [
          p.check === null ? '' : `check ${p.check ? 'pass' : 'fail'}`,
          p.paths === null ? '' : `paths ${p.paths ? 'ok' : 'mismatch'}`,
          p.note,
        ]
          .filter(Boolean)
          .join('; ')
      : 'none'
    return `${t.key} | ${t.state} | ${proof} | ${p?.commits.length ? p.commits.join(' ') : 'none'}`
  })
  return [`key | state | proof | commits`, ...lines, `branch ${wave.branch} head ${sha}`].join('\n')
}

/** The wave is reported: the table, then `text` (the manager's wave_report, or the daemon's stand-in for a
 *  manager that ended without calling it). Only now can climayte_wait --wave wake and the wave be verified. */
export function reportWave(wave: CliMayteWave, text: string, now = Date.now()): void {
  wave.report = `${reportTable(wave)}\n\n${text.slice(0, WAVE_TEXT_CAP)}`
  wave.status = 'reported'
  wave.updatedAt = now
}

// Pure: the changed task ids since the last batch wake, or null to keep holding.
// The daemon calls this when wave tasks change (their state, or a task's workerId) to decide whether
// to wake the manager. Rules from climayte_wait.py:
// - Wake at once if a failure or the wave is done.
// - Otherwise, hold until batch.size tasks have changed, batch.settleS has run since the first
//   change, or nothing is live (no running tasks in the wave's group).
// This function is pure; the caller updates wave.batch.held and wave.batch.since.
export function waveBatch(
  wave: CliMayteWave,
  workers: Map<string, CliMayteWorker>,
  now: number,
): string[] | null {
  const { batch } = wave
  const taskIds = new Set<string>(batch.held)

  // Wake at once on failure or done.
  if (wave.tasks.some((t) => t.state === 'failed')) {
    return Array.from(taskIds)
  }
  if (waveDone(wave)) {
    return Array.from(taskIds)
  }

  // Otherwise, check batch limits.
  const size = taskIds.size
  if (size >= batch.size) {
    return Array.from(taskIds)
  }

  if (batch.since !== null) {
    const settleElapsed = (now - batch.since) / 1000
    if (settleElapsed >= batch.settleS) {
      return Array.from(taskIds)
    }
  }

  // Check if anything in the wave is running or queued (living).
  for (const task of wave.tasks) {
    if (task.state === 'running' || task.state === 'pending') {
      const worker = task.workerId ? workers.get(task.workerId) : null
      if (worker && (worker.status === 'running' || worker.status === 'queued')) {
        // Something is still running, hold the batch.
        return null
      }
    }
  }

  // Nothing is running and we have changes; wake with what we have.
  return size > 0 ? Array.from(taskIds) : null
}

/** The shas on the last `Commits:` line of a worker's report; [] for `Commits: none` or no such line. */
export function commitsOf(report: string | null): string[] {
  const lines = [...(report ?? '').matchAll(/^[ >*_-]*Commits:[ ]*(.+)$/gim)]
  const last = lines.at(-1)?.[1]?.trim()
  if (!last || /^none\b/i.test(last)) return []
  return last.split(/[\s,;]+/).filter(Boolean)
}

/** A git command in `cwd`, hidden: its exit code and output. */
function git(cwd: string, args: string[]): { code: number | null; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  return { code: r.status, out: (r.stdout ?? '').trim() }
}

/** How many of the branch's newest commits are searched for a rebased copy of a task's commit. */
const PATCH_ID_SEARCH = 500

/** The commit among the branch's newest PATCH_ID_SEARCH with the same stable patch-id as `sha`, or null. */
export function findByPatchId(cwd: string, sha: string, branch: string): string | null {
  const run = (args: string[], input?: string) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 512 * 1024 * 1024,
      input,
    })
    return r.status === 0 ? (r.stdout ?? '') : ''
  }
  const mine = run(['diff-tree', '-p', '--root', sha])
  const wanted = run(['patch-id', '--stable'], mine).split(/\s+/)[0]
  if (!wanted) return null
  const log = run(['log', '-p', '--format=%H', '-n', String(PATCH_ID_SEARCH), branch])
  for (const line of run(['patch-id', '--stable'], log).split('\n')) {
    const [pid, commit] = line.trim().split(/\s+/)
    if (pid === wanted && commit) return commit
  }
  return null
}

/** Files the commits change taken together: a file restored to its original content does not count.
 *  Judged against `globs`; returns the files outside them. */
function netOutside(cwd: string, shas: string[], globs: Bun.Glob[]): string[] {
  const count = (s: string) => Number(git(cwd, ['rev-list', '--count', s]).out) || 0
  const ordered = [...new Set(shas)].sort((a, b) => count(a) - count(b))
  const first = ordered[0] as string
  const last = ordered[ordered.length - 1] as string
  const touched = new Set<string>()
  for (const s of ordered)
    for (const f of git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', s])
      .out.split('\n')
      .map((x) => x.trim())
      .filter(Boolean))
      touched.add(f)
  const hasParent = git(cwd, ['rev-parse', '--verify', '-q', `${first}^`]).code === 0
  const blob = (rev: string, f: string) => {
    const r = git(cwd, ['rev-parse', '--verify', '-q', `${rev}:${f}`])
    return r.code === 0 ? r.out : ''
  }
  return [...touched].filter(
    (f) =>
      !globs.some((g) => g.match(f)) && (hasParent ? blob(`${first}^`, f) : '') !== blob(last, f),
  )
}

export interface WaveJudgement {
  /** `unproven`: nothing a command could check (no check, no commits): no verdict is recorded. */
  verdict: 'pass' | 'fail' | 'unproven'
  note: string
  proof: NonNullable<CliMayteTask['proof']>
}

/** The daemon judges a wave task by command, never by the manager's word (piece 5): the task's check
 *  (`checkPassed`: null when it has none), and for each sha on the report's `Commits:` line that the
 *  commit exists, is on the wave's branch, and its diff stays inside the brief's `paths` (globs;
 *  [] = the task must not commit). A pass is only ever provisional until the orchestrator accepts
 *  the wave; a failed proof says what to fix. */
export function judgeWaveTask(
  task: CliMayteTask,
  wave: Pick<CliMayteWave, 'cwd' | 'branch'>,
  report: string | null,
  checkPassed: boolean | null,
): WaveJudgement {
  const commits = commitsOf(report)
  const proof: WaveJudgement['proof'] = { check: checkPassed, commits, paths: null, note: '' }
  const fail = (note: string): WaveJudgement => {
    proof.note = note
    return { verdict: 'fail', note, proof }
  }
  const globs = task.paths.map((p) => new Bun.Glob(p))
  const resolved: string[] = []
  const notes: string[] = []
  for (const sha of commits) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha))
      return fail(`\`${sha}\` on the Commits line is not a commit sha.`)
    if (git(wave.cwd, ['cat-file', '-e', `${sha}^{commit}`]).code !== 0)
      return fail(`Commit ${sha} does not exist in ${wave.cwd}.`)
    if (git(wave.cwd, ['merge-base', '--is-ancestor', sha, wave.branch]).code !== 0) {
      // Another session's landing tool may have rebased the commit onto the branch: look for it by content.
      const moved = findByPatchId(wave.cwd, sha, wave.branch)
      if (!moved) return fail(`Commit ${sha} is not on the branch ${wave.branch}.`)
      resolved.push(moved)
      notes.push(`${sha} found on ${wave.branch} as ${moved.slice(0, 10)} after a rebase`)
      continue
    }
    resolved.push(sha)
  }
  if (resolved.length) {
    const outside = netOutside(wave.cwd, resolved, globs)
    if (outside.length) {
      proof.paths = false
      return fail(
        task.paths.length
          ? `The task's commits change ${outside.slice(0, 5).join(', ')} net, outside the brief's paths (${task.paths.join(', ')}).`
          : `The task's commits change ${outside.slice(0, 5).join(', ')} net, but this task must not commit.`,
      )
    }
    proof.paths = true
  }
  if (checkPassed === null && commits.length === 0) {
    proof.note = 'Nothing a command could check: no check and no commits.'
    return { verdict: 'unproven', note: proof.note, proof }
  }
  const parts = [
    checkPassed ? 'the check passed' : '',
    commits.length ? `${commits.length} commit(s) on ${wave.branch} inside the brief's paths` : '',
    ...notes,
  ]
  proof.note = `Provisional pass: ${parts.filter(Boolean).join('; ')}.`
  return { verdict: 'pass', note: proof.note, proof }
}
