// HSwarm jobs through AgentHydra (GET /api/hswarm/api/jobs), mapped to the protocol's SwarmJob so the
// sidebar can list each under the chat that called HSwarm (owner, 2026-10-05: "ZSwarm threads should also be
// displayed on the HydroDesk 2 sidebar").

import type { SwarmJob } from '@shared/protocol'
import type { AhHswarmJob, AhHswarmJobs } from './client'

/** How many finished jobs the list keeps beside every running one (as the CliMayte workers' RECENT_FINISHED). */
export const RECENT_FINISHED_JOBS = 20
/** How long one read of HSwarm's jobs serves every window: never more often than this. */
export const SWARM_FRESH_MS = 10_000
/** The most jobs asked of HSwarm in one read: its own default is 20, which a busy day fills with finished ones. */
export const JOBS_ASKED = 60

/** The caller of a job: its jobs list stamps a key ('<instance> / <8 chars> / <folder>'), a whole stamp has the ids. */
export function callerOf(caller: AhHswarmJob['caller']): { session: string | null; host: string | null } {
  if (caller && typeof caller === 'object') return { session: caller.session_id || null, host: caller.chat_id || null }
  const part = typeof caller === 'string' ? caller.split(' / ')[1]?.trim() : ''
  return { session: part && part !== '-' ? part : null, host: null }
}

const when = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? t : null
}

export function mapSwarmJob(j: AhHswarmJob): SwarmJob {
  const status = j.state ?? 'running'
  const active = status === 'running'
  const counts = j.counts ?? {}
  const caller = callerOf(j.caller)
  const failed = (counts.failed ?? 0) + (counts.error ?? 0) + (counts.timeout ?? 0)
  return {
    id: j.job_id,
    title: j.label?.trim() || j.job_id,
    status,
    active,
    startedAt: when(j.created),
    endedAt: active ? null : when(typeof j.finished === 'string' ? j.finished : null),
    tasks: { total: j.tasks ?? 0, done: (counts.ok ?? 0) + (counts.done ?? 0), failed },
    model: j.model || null,
    callerSessionId: caller.session,
    callerHostSessionId: caller.host,
  }
}

/** Every running job and the RECENT_FINISHED_JOBS newest finished ones, newest first within each. */
export function mapSwarmJobs(answer: AhHswarmJobs | null | undefined): SwarmJob[] {
  if (!Array.isArray(answer?.jobs)) return []
  const list = answer.jobs.filter((j) => j?.job_id).map(mapSwarmJob)
  const newest = (a: SwarmJob, b: SwarmJob) => (b.startedAt ?? 0) - (a.startedAt ?? 0)
  return [...list.filter((j) => j.active).sort(newest), ...list.filter((j) => !j.active).sort(newest).slice(0, RECENT_FINISHED_JOBS)]
}
