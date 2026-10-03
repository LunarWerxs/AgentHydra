// server/src/climayte-wave.ts — CliMayte waves: the orchestrator breaks work into tasks,
// the manager dispatches them, and the daemon records proof that each one passed.
// The wave record persists in corch/waves/<waveId>.json so a restarted daemon and a fresh
// manager session read the same truth. This file holds the store helpers and the pure
// functions waveStateText and waveDone.

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

// Read a wave record from disk, or null if missing.
export function readWave(configDir: string, waveId: string): CliMayteWave | null {
  mkdirSync(join(configDir, 'corch', 'waves'), { recursive: true })
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

function formatTaskLine(task: CliMayteTask, worker: CliMayteWorker | null): string {
  const workerStatus = worker ? `${worker.id.slice(0, 10)} (${worker.status})` : 'none'
  let line = `- ${task.key}: ${task.state}`
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
    lines.push(formatTaskLine(task, worker))
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

// Judge a wave task's proof: all present proofs pass. A proof is:
// - The check command passed (if check is not null)
// - Each commit exists in the repo
// - Each commit is an ancestor of the branch
// - The diff of each commit touches only allowed paths
//
// Returns { pass: boolean; note: string | null; provisional: boolean }. If pass is true and
// at least one proof was present (check passed or commits exist), the verdict is provisional
// (piece 5: orchestrator confirms with climayte_wave_verify).
//
// This is called after the task's check runs. The proof object holds check (boolean | null),
// commits (string[]), paths (boolean | null), and note from the judgment.
export function judgeWaveTask(
  task: CliMayteTask,
  proof: CliMayteTask['proof'],
): {
  pass: boolean
  note: string | null
  provisional: boolean
} {
  if (!proof) {
    // No proof yet (task not judged): not a pass.
    return { pass: false, note: null, provisional: false }
  }

  // If the check failed, proof fails.
  if (proof.check === false) {
    return { pass: false, note: proof.note || 'The check failed', provisional: false }
  }

  // If paths proof failed, proof fails.
  if (proof.paths === false) {
    return {
      pass: false,
      note: proof.note || 'Diff touches paths outside the brief',
      provisional: false,
    }
  }

  // All present proofs passed (check !== false and paths !== false).
  // If at least one proof exists (check passed or commits), it's provisional.
  if (proof.check === true || proof.commits.length > 0) {
    return { pass: true, note: null, provisional: true }
  }

  // No provable proof (no check, no commits): unproven.
  return { pass: false, note: null, provisional: false }
}
