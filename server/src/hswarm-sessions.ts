// server/src/hswarm-sessions.ts - reader for HSwarm's job records (the hswarm/ package here).
//
// ONE HOME, NOT ONE PER ACCOUNT. Unlike DeepSeek Harness (server/src/dsh-sessions.ts), HSwarm is
// not a login product with its own per-account state - its home (hswarm.ts hswarmHome():
// HSWARM_HOME, default `~/.hswarm`) is the one root, same posture as OPENCODE_DB_PATH, so there is
// no dsh-instances.ts-style store list to walk and no InstanceKind to add.
//
// ZSWARM'S JOBS LIVE HERE TOO (2026-10-03): ZSwarm is retired and HSwarm replaces it. `hswarm
// import-zswarm` copied ZSwarm's job records into HSwarm's home, so this one root holds both. The
// session source keeps its id `'zswarm'` (types.ts SessionSource): it is a frozen MCP API value
// (server/mcp-api-levels/). Each row's tool id stays `'zswarm'` too (transcript.ts hswarmRow): it is
// half of a job's done-mark key and locator. Only what a person reads says HSwarm.
//
// A JOB IS THE SESSION, A TASK IS A TURN. HSwarm has no back-and-forth conversation: one call
// dispatches N independent tasks (each its own prompt) and collects N independent results. This
// reader treats one job (`~/.hswarm/jobs/<id>/job.json`) as one session and synthesizes a transcript
// out of it - one user turn per task's prompt, one assistant turn per its result - so a swarm run
// reads the same way every other source's transcript does, even though nothing on disk is actually
// a dialogue. See `hswarm/job.py` for the shapes read here; nothing is inferred.
//
// job.json IS PLAIN JSON (not zstd, not sqlite), so unlike dsh this store is real TEXT: an editor can
// open it.
//
// READONLY, ALWAYS. HSwarm owns these files; this reader opens them for reading and never writes,
// moves or repairs one - same contract as every other store AgentHydra reads.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, type Stats, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { timeSlice } from './core/loop-yield'
import { type StatStamp, stampOf, unchangedSince } from './core/stat-stamp'
import { hswarmHome } from './hswarm'
import type { TailEvent } from './types'

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
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

// --- job.json's own shape, read defensively - a summary field HSwarm adds later must not throw
// for a job written by an older version. ----------------------------------------------------------

interface HSwarmTask {
  id: string
  prompt: string
  cwd?: string
}

interface HSwarmResult {
  id: string
  status: string
  answer?: string | null
  data?: unknown
  error?: string | null
  started?: string
  finished?: string
}

interface HSwarmJobFile {
  summary?: {
    job_id?: string
    label?: string | null
    state?: string
    created?: string
    finished?: string
  }
  tasks?: HSwarmTask[]
  results?: Record<string, HSwarmResult>
}

// --- session listing ---------------------------------------------------------------------------

export interface HSwarmSessionRecord {
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

/** One job's session record, from its parsed job.json and the stat it was read at. */
function hswarmSessionRecord(
  path: string,
  jobId: string,
  job: HSwarmJobFile,
  st: Stats,
): HSwarmSessionRecord {
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
    last_activity_at: Math.max(st.mtimeMs, finished ?? 0),
    archived: false, // HSwarm has no archive concept; every job stays where it finished
    size_bytes: st.size,
    path,
  }
}

/**
 * Each home's job records as last read, re-validated by stat on every listing.
 *
 * ⛔ WHY (2026-09-27). The whole-store sweep re-read and re-parsed EVERY job.json on every pass:
 * 625 jobs, 279 MB of JSON, 1.2 s on the daemon's one thread, several times a minute while anything
 * polled the session list, and at boot on top of the OpenCode listing. A finished job never changes,
 * so after the first pass a sweep is one stat per job. Each listing replaces its home's map, so a
 * deleted job leaves the cache with its directory.
 */
const jobCache = new Map<string, Map<string, { stamp: StatStamp; record: HSwarmSessionRecord }>>()

/** The job ids under a home, directory-first: a job mid-run already has a directory and a partial
 *  job.json, and is found exactly like a finished one - see listDshSessions for the same rule. */
function jobIds(entries: Array<{ name: string; isDirectory(): boolean }>): string[] {
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

/** Every job under one HSwarm home. A job whose job.json is missing or unreadable does not list
 *  yet: its directory can exist a moment before the file is written. */
export function listHSwarmSessions(root: string): HSwarmSessionRecord[] {
  const jobsRoot = join(root, 'jobs')
  if (!existsSync(jobsRoot)) return []
  let ids: string[]
  try {
    ids = jobIds(readdirSync(jobsRoot, { withFileTypes: true }))
  } catch {
    return []
  }
  const previous = jobCache.get(root)
  const current = new Map<string, { stamp: StatStamp; record: HSwarmSessionRecord }>()
  for (const id of ids) {
    const path = join(jobsRoot, id, 'job.json')
    try {
      const st = statSync(path)
      let hit = previous?.get(id)
      if (!unchangedSince(hit?.stamp, st)) {
        const readAt = Date.now()
        const job = readJson<HSwarmJobFile>(path)
        hit = job
          ? { stamp: stampOf(st, readAt), record: hswarmSessionRecord(path, id, job, st) }
          : undefined
      }
      if (hit) current.set(id, hit)
    } catch {
      /* gone between the listing and the stat */
    }
  }
  jobCache.set(root, current)
  return [...current.values()].map((h) => h.record)
}

/**
 * The same listing without holding the event loop, for the whole-store sweep (transcript.ts
 * buildTranscriptIndexAsync). Shares the cache above; only a changed job is read, and the parse
 * of each one is the longest the thread is held.
 */
export async function listHSwarmSessionsAsync(root: string): Promise<HSwarmSessionRecord[]> {
  const jobsRoot = join(root, 'jobs')
  let ids: string[]
  try {
    ids = jobIds(await readdir(jobsRoot, { withFileTypes: true }))
  } catch {
    return []
  }
  const slice = timeSlice()
  const previous = jobCache.get(root)
  const current = new Map<string, { stamp: StatStamp; record: HSwarmSessionRecord }>()
  for (const id of ids) {
    const path = join(jobsRoot, id, 'job.json')
    try {
      const st = await stat(path)
      let hit = previous?.get(id)
      if (!unchangedSince(hit?.stamp, st)) {
        const readAt = Date.now()
        const job = parseJson<HSwarmJobFile>(await readFile(path, 'utf8'))
        hit = job
          ? { stamp: stampOf(st, readAt), record: hswarmSessionRecord(path, id, job, st) }
          : undefined
      }
      if (hit) current.set(id, hit)
    } catch {
      /* gone between the listing and the stat */
    }
    if (slice.due()) await slice.pause()
  }
  jobCache.set(root, current)
  return [...current.values()].map((h) => h.record)
}

const RUNS_TTL_MS = 60_000
let runs: { at: number; db: string; map: Map<string, number> } | null = null

/**
 * How many HSwarm runs each chat started, keyed by the first 8 characters of its session id: HSwarm
 * records only that much of its caller (hswarm/caller.py `caller_session`). Read from HSwarm's own
 * run table, which has every run; a job folder exists for only a few of them. Read-only, at most
 * once a minute; empty when HSwarm has never run here.
 */
export function hswarmRunsBySessionPrefix(home: string = hswarmHome()): Map<string, number> {
  const path = join(home, 'hswarm.sqlite')
  const now = Date.now()
  if (runs && runs.db === path && now - runs.at < RUNS_TTL_MS) return runs.map
  const map = new Map<string, number>()
  if (existsSync(path)) {
    let con: Database | null = null
    try {
      con = new Database(path, { readonly: true })
      const stmt = con.prepare(
        "select caller_session as s, count(*) as n from utilizations where caller_session != '' group by caller_session",
      )
      // Finalized before the close: an open statement keeps the file locked on Windows.
      try {
        for (const r of stmt.all() as Array<{ s: string; n: number }>) map.set(r.s, r.n)
      } finally {
        stmt.finalize()
      }
    } catch {
      // an older HSwarm without the table, or the file mid-write: no counts this minute
    } finally {
      con?.close()
    }
  }
  runs = { at: now, db: path, map }
  return map
}

// --- transcript ----------------------------------------------------------------------------------

export interface HSwarmSessionContent {
  events: TailEvent[]
  messageCount: number
}

/** One task's prompt and its result, as the two-turn shape every session's transcript is drawn in -
 *  a SYNTHESIZED conversation (see the file docstring for why this is honest, not a decoration: the
 *  swarm records a prompt and an answer, never a back-and-forth, so that is what is shown). */
function taskEvents(task: HSwarmTask, result: HSwarmResult | undefined): TailEvent[] {
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
 *  `path` is job.json itself - the swarm's equivalent of dsh's one-file-per-session log path, so
 *  there is no id lookup to do here either. */
export function readHSwarmSession(path: string): HSwarmSessionContent | null {
  const job = readJson<HSwarmJobFile>(path)
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
