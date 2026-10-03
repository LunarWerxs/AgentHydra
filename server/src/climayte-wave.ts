// server/src/climayte-wave.ts — CliMayte waves: the orchestrator breaks work into tasks,
// the manager dispatches them, and the daemon records proof that each one passed.
// The wave record persists in corch/waves/<waveId>.json so a restarted daemon and a fresh
// manager session read the same truth. This file holds the store helpers and the pure
// functions waveStateText and waveDone.

import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { CliMayteWave, CliMayteWorker } from './climayte-lib'
import { readJsonStore, mutateJsonStore, type JsonStoreSpec } from './core/json-store'

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
    const worker = task.workerId ? workers.get(task.workerId) : null
    const workerStatus = worker ? `${worker.id.slice(0, 10)} (${worker.status})` : 'none'
    let line = `- ${task.key}: ${task.state}`
    if (worker) {
      line += ` → ${workerStatus}`
    }
    if (task.proof) {
      const parts: string[] = []
      if (task.proof.check !== null) {
        parts.push(`check: ${task.proof.check ? 'pass' : 'fail'}`)
      }
      if (task.proof.commits.length > 0) {
        parts.push(`commits: ${task.proof.commits.join(', ')}`)
      }
      if (task.proof.paths !== null) {
        parts.push(`paths: ${task.proof.paths ? 'ok' : 'mismatch'}`)
      }
      if (task.proof.note) {
        parts.push(task.proof.note)
      }
      if (parts.length > 0) {
        line += ` {${parts.join('; ')}}`
      }
    }
    lines.push(line)
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
