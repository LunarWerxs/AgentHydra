// HSwarm jobs through AgentHydra (GET /api/hswarm/api/jobs, and the other PCs' in GET /api/corch/remote), mapped to
// the protocol's SwarmJob so the sidebar can list each under the chat that called HSwarm (owner, 2026-10-05: "ZSwarm
// threads should also be displayed on the HydroDesk 2 sidebar").

import type { SwarmJob } from '@shared/protocol'
import type { AhHswarmJob, AhHswarmJobs, AhRemoteJob, AhRemoteQueues } from './client'
import { RECENT_FINISHED } from './climayte'

/** How long one read of HSwarm's jobs serves every window: the poller asks this often (its timer is faster). */
export const SWARM_FRESH_MS = 10_000
/** The most jobs asked of HSwarm in one read: its own default is 20, which a busy day fills with finished ones. */
export const JOBS_ASKED = 60
/** How long AgentHydra's chat list (chat id -> session id and title) serves the caller lookups. */
export const CHATS_FRESH_MS = 60_000

/** A Claude Desktop chat as /api/chats names it: what a job that only has a chat id is placed by. */
export type ChatIndex = ReadonlyMap<string, { sessionId: string; title: string | null }>

export interface Caller {
  session: string | null
  host: string | null
  title: string | null
}

/**
 * The caller of a job. `caller_ids` has the full ids: a Desktop chat has no session id there, only a chat id
 * ('local_...'), which `chats` resolves to the chat's session and title. Only an answer without caller_ids falls
 * back to the old key ('<instance> / <8 chars> / <folder>'), whose prefix the window matches by prefix.
 */
export function callerOf(j: Pick<AhHswarmJob, 'caller' | 'caller_ids'>, chats: ChatIndex = new Map()): Caller {
  const ids = j.caller_ids ?? (j.caller && typeof j.caller === 'object' ? j.caller : null)
  if (ids) return callerFromIds(ids.session_id, ids.chat_id, chats)
  const part = typeof j.caller === 'string' ? j.caller.split(' / ')[1]?.trim() : ''
  return { session: part && part !== '-' ? part : null, host: null, title: null }
}

function callerFromIds(sessionId: string | null | undefined, chatId: string | null | undefined, chats: ChatIndex): Caller {
  const chat = chatId ? chats.get(chatId) : undefined
  return { session: sessionId || chat?.sessionId || null, host: chatId || null, title: chat?.title || null }
}

const when = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? t : null
}

interface JobParts {
  id: string
  label?: string | null
  state?: string
  tasks?: number
  counts?: Record<string, number>
  created?: string | null
  finished?: string | boolean | null
}

function jobOf(j: JobParts, caller: Caller, pc: string | null): SwarmJob {
  const status = j.state ?? 'running'
  const active = status === 'running'
  const counts = j.counts ?? {}
  return {
    id: j.id,
    title: j.label?.trim() || j.id,
    status,
    active,
    startedAt: when(j.created),
    endedAt: active ? null : when(typeof j.finished === 'string' ? j.finished : null),
    tasks: {
      total: j.tasks ?? 0,
      done: (counts.ok ?? 0) + (counts.done ?? 0),
      failed: (counts.failed ?? 0) + (counts.error ?? 0) + (counts.timeout ?? 0),
      cancelled: counts.cancelled ?? 0,
    },
    callerSessionId: caller.session,
    callerHostSessionId: caller.host,
    callerTitle: caller.title,
    pc,
  }
}

export function mapSwarmJob(j: AhHswarmJob, chats: ChatIndex = new Map()): SwarmJob {
  return jobOf({ ...j, id: j.job_id }, callerOf(j, chats), null)
}

/** One PC's jobs: every running one and the RECENT_FINISHED newest finished ones, newest first within each. */
function pick(list: SwarmJob[]): SwarmJob[] {
  const newest = (a: SwarmJob, b: SwarmJob) => (b.startedAt ?? 0) - (a.startedAt ?? 0)
  return [...list.filter((j) => j.active).sort(newest), ...list.filter((j) => !j.active).sort(newest).slice(0, RECENT_FINISHED)]
}

/** This PC's jobs from HSwarm's list. */
export function mapSwarmJobs(answer: AhHswarmJobs | null | undefined, chats: ChatIndex = new Map()): SwarmJob[] {
  if (!Array.isArray(answer?.jobs)) return []
  return pick(answer.jobs.filter((j) => j?.job_id).map((j) => mapSwarmJob(j, chats)))
}

export function mapRemoteJob(j: AhRemoteJob, pc: string, chats: ChatIndex = new Map()): SwarmJob {
  return { ...jobOf(j, callerFromIds(j.callerSessionId, j.callerChatId, chats), pc), folder: j.folder ?? null }
}

/** The other PCs' jobs (`pc` set), each PC cut as this one's is. Sharing off, a stale PC or an older AgentHydra is none. */
export function mapRemoteJobs(answer: AhRemoteQueues | null | undefined, chats: ChatIndex = new Map()): SwarmJob[] {
  if (!answer?.enabled || !Array.isArray(answer.pcs)) return []
  return answer.pcs.flatMap((p) =>
    p.stale || !Array.isArray(p.jobs) ? [] : pick(p.jobs.filter((j) => j?.id).map((j) => mapRemoteJob(j, p.name || 'another PC', chats)))
  )
}
