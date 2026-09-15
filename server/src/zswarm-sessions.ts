// server/src/zswarm-sessions.ts - reader for the DeepSeek zswarm's job records (`Lunarwerx/zswarm`).
//
// ONE HOME, NOT ONE PER ACCOUNT. Unlike DeepSeek Harness (server/src/dsh-sessions.ts), the zswarm is
// not a login product with its own per-account state - ZSWARM_HOME (default `~/.zswarm`) is the one
// root, same posture as OPENCODE_DB_PATH, so there is no dsh-instances.ts-style store list to walk
// and no InstanceKind to add.
//
// A JOB IS THE SESSION, A TASK IS A TURN. The zswarm has no back-and-forth conversation: one call
// dispatches N independent tasks (each its own prompt) and collects N independent results. This
// reader treats one job (`~/.zswarm/jobs/<id>/job.json`) as one session and synthesizes a transcript
// out of it - one user turn per task's prompt, one assistant turn per its result - so a zswarm run
// reads the same way every other source's transcript does, even though nothing on disk is actually
// a dialogue. See zswarm's own `zswarm/jobstore.py` for the shapes read here; nothing is inferred.
//
// job.json IS PLAIN JSON (not zstd, not sqlite), so unlike dsh this store is real TEXT: an editor can
// open it, and SOURCE_FILE_IS_TEXT (web/src/lib/session-labels.ts) says so.
//
// READONLY, ALWAYS. The zswarm owns these files; this reader opens them for reading and never writes,
// moves or repairs one - same contract as every other store AgentHydra reads.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TailEvent } from './types'

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

const compact = (value: string): string => value.replace(/\s+/g, ' ').trim()

const truncate = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value

function iso(ts: unknown): string | null {
  if (typeof ts !== 'string' || !ts) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function epochMs(ts: unknown): number | null {
  if (typeof ts !== 'string' || !ts) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

// --- job.json's own shape, read defensively - a summary field the zswarm adds later must not throw
// for a job written by an older version. ----------------------------------------------------------

interface ZswarmTask {
  id: string
  prompt: string
  cwd?: string
}

interface ZswarmResult {
  id: string
  status: string
  answer?: string | null
  data?: unknown
  error?: string | null
  started?: string
  finished?: string
}

interface ZswarmJobFile {
  summary?: {
    job_id?: string
    label?: string | null
    state?: string
    created?: string
    finished?: string
  }
  tasks?: ZswarmTask[]
  results?: Record<string, ZswarmResult>
}

// --- session listing ---------------------------------------------------------------------------

export interface ZswarmSessionRecord {
  session_id: string
  project: string
  cwd: string
  title: string
  created_at: number | null
  last_activity_at: number
  archived: boolean
  size_bytes: number
  /** Absolute path to job.json itself - this store's per-session identity, same role dsh's log path
   *  plays for it. */
  path: string
}

/** One job dir's session record, or `null` when its job.json is missing or unreadable - a job
 *  directory can exist a moment before job.json is written, and that job simply does not list yet. */
function buildZswarmSessionRecord(root: string, jobId: string): ZswarmSessionRecord | null {
  const path = join(root, 'jobs', jobId, 'job.json')
  let size = 0
  let mtime = 0
  try {
    const st = statSync(path)
    size = st.size
    mtime = st.mtimeMs
  } catch {
    return null
  }
  const job = readJson<ZswarmJobFile>(path)
  if (!job) return null
  const summary = job.summary ?? {}
  const firstCwd = job.tasks?.find((t) => typeof t.cwd === 'string' && t.cwd)?.cwd ?? ''
  const created = epochMs(summary.created)
  const finished = epochMs(summary.finished)
  return {
    session_id: summary.job_id || jobId,
    project:
      summary.label ||
      (firstCwd ? firstCwd.split(/[\\/]/).filter(Boolean).pop() || firstCwd : jobId),
    cwd: firstCwd,
    title: compact(summary.label || jobId),
    created_at: created,
    // The file's own mtime is kept as a floor: a job still running has no `finished` yet, and the
    // file on disk is still the freshest honest signal, same rule dsh-sessions.ts's mtime floor uses.
    last_activity_at: Math.max(mtime, finished ?? 0),
    archived: false, // the zswarm has no archive concept; every job stays where it finished
    size_bytes: size,
    path,
  }
}

/** Every job under one zswarm home.
 *
 * The job DIRECTORY is the source of truth for what exists, not job.json's own `state` field: a job
 * mid-run already has a directory and a partial job.json, and the walk finds it exactly like a
 * finished one - see listDshSessions for the same directory-first rule. */
export function listZswarmSessions(root: string): ZswarmSessionRecord[] {
  const jobsRoot = join(root, 'jobs')
  if (!existsSync(jobsRoot)) return []
  let ids: string[]
  try {
    ids = readdirSync(jobsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  const out: ZswarmSessionRecord[] = []
  for (const id of ids) {
    const record = buildZswarmSessionRecord(root, id)
    if (record) out.push(record)
  }
  return out
}

// --- transcript ----------------------------------------------------------------------------------

export interface ZswarmSessionContent {
  events: TailEvent[]
  messageCount: number
}

/** One task's prompt and its result, as the two-turn shape every session's transcript is drawn in -
 *  a SYNTHESIZED conversation (see the file docstring for why this is honest, not a decoration: the
 *  zswarm records a prompt and an answer, never a back-and-forth, so that is what is shown). */
function taskEvents(task: ZswarmTask, result: ZswarmResult | undefined): TailEvent[] {
  const out: TailEvent[] = []
  const promptText = compact(task.prompt ?? '')
  if (promptText)
    out.push({
      role: 'user',
      kind: 'text',
      text: truncate(promptText, 6000),
      tool_name: null,
      timestamp: iso(result?.started),
    })
  if (!result) return out
  const answerText =
    result.status === 'ok'
      ? compact(result.answer || (result.data != null ? JSON.stringify(result.data) : ''))
      : compact(`[${result.status}] ${result.error ?? 'no answer'}`)
  if (answerText)
    out.push({
      role: 'assistant',
      kind: 'text',
      text: truncate(answerText, 6000),
      tool_name: null,
      timestamp: iso(result.finished),
    })
  return out
}

/** One job's "conversation": one task's prompt + result per turn, in the job's own task order.
 *  `path` is job.json itself - the zswarm equivalent of dsh's one-file-per-session log path, so there
 *  is no id lookup to do here either. */
export function readZswarmSession(path: string): ZswarmSessionContent | null {
  const job = readJson<ZswarmJobFile>(path)
  if (!job || !Array.isArray(job.tasks)) return null
  const events: TailEvent[] = []
  let messageCount = 0
  for (const task of job.tasks) {
    const result = job.results?.[task.id]
    for (const event of taskEvents(task, result)) {
      events.push(event)
      if (event.kind === 'text') messageCount++
    }
  }
  return { events, messageCount }
}
