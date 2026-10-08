// server/src/climayte-effort.ts — the effort CliMayte launched each session at, for the Sessions list.
//
// CliMayte sets `--effort` per attempt and records it on the attempt (`requested.effort`) next to the
// session the attempt ran in (`sessionId`): in `corch/workers.json` for work in flight and
// `corch/done/<id>.json` for finished work. That is the one place the effort of a session CliMayte
// started was written down by the thing that chose it, so the list asks it before any guess.
//
// The same files say which chat dispatched each task (`origin`), so the list's offload counts come
// from here too.
//
// Read-only and cheap: a finished worker's file never changes, so each is parsed once and re-read
// only when its mtime or size moves, and done/ is looked through again only when its own mtime
// moves; the whole map is rebuilt at most every TTL_MS.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { POINTER_DIR } from './instance'

const TTL_MS = 5_000

interface FileRecord {
  mtimeMs: number
  size: number
  efforts: Array<[sessionId: string, effort: string]>
  /** (worker id, the chat session that dispatched it), for every worker a chat sent. */
  origins: Array<[workerId: string, sessionId: string]>
}

const files = new Map<string, FileRecord>()
/** done/'s mtime when its names were last listed and its files last checked, and those paths. */
const done: { at: number; paths: string[] } = { at: Number.NaN, paths: [] }
let built: { at: number; map: Map<string, string>; dispatched: Map<string, number> } | null = null

/** (session id, effort) for every attempt of these workers that was launched with an effort. A null
 *  `requested.effort` is "the CLI's default", which is not a recorded effort, so it adds nothing. */
function effortsOf(workers: unknown): FileRecord['efforts'] {
  const out: FileRecord['efforts'] = []
  if (!Array.isArray(workers)) return out
  for (const w of workers) {
    const attempts = (w as { attempts?: unknown })?.attempts
    if (!Array.isArray(attempts)) continue
    for (const a of attempts) {
      const sid = a?.sessionId
      const effort = a?.requested?.effort
      if (typeof sid === 'string' && sid && typeof effort === 'string' && effort)
        out.push([sid, effort])
    }
  }
  return out
}

function originsOf(workers: unknown): FileRecord['origins'] {
  const out: FileRecord['origins'] = []
  if (!Array.isArray(workers)) return out
  for (const w of workers) {
    const id = (w as { id?: unknown })?.id
    const o = (w as { origin?: { kind?: unknown; sessionId?: unknown } })?.origin
    if (
      typeof id === 'string' &&
      o?.kind === 'chat' &&
      typeof o.sessionId === 'string' &&
      o.sessionId
    )
      out.push([id, o.sessionId])
  }
  return out
}

function readRecord(path: string): FileRecord | null {
  try {
    const st = statSync(path)
    const have = files.get(path)
    if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return have
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    // workers.json holds `{workers: [...]}`; a finished worker's file is the worker itself.
    const workers = Array.isArray(parsed?.workers) ? parsed.workers : [parsed]
    const rec = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      efforts: effortsOf(workers),
      origins: originsOf(workers),
    }
    files.set(path, rec)
    return rec
  } catch {
    return null // unreadable or half-written: skip it, the next scan reads it again
  }
}

/** Session id -> the effort CliMayte launched it at. Empty when CliMayte has never run here. */
export function climayteEffortBySession(): Map<string, string> {
  return build().map
}

/** Chat session id -> how many CliMayte tasks that chat dispatched. */
export function climayteTasksBySession(): Map<string, number> {
  return build().dispatched
}

function build(): NonNullable<typeof built> {
  const now = Date.now()
  if (built && now - built.at < TTL_MS) return built
  const root = join(POINTER_DIR, 'corch')
  const live = join(root, 'workers.json')
  const doneDir = join(root, 'done')
  let doneAt = Number.NaN
  try {
    doneAt = statSync(doneDir).mtimeMs
  } catch {
    // no finished work yet
  }
  // A finished worker's file is written by renaming a temporary file over it, and filed or removed
  // the same way, so the folder's own mtime moves with every change in it. While it stands still,
  // the names and parses from the last build stand too: 3,800 files were a statSync each, every
  // build (2026-10-08, 13% of a 5.7 s daemon stall).
  const recheck = doneAt !== done.at
  if (recheck) {
    done.paths = []
    try {
      for (const name of readdirSync(doneDir))
        if (name.endsWith('.json')) done.paths.push(join(doneDir, name))
    } catch {
      // gone meanwhile
    }
  }
  const paths = [live, ...done.paths]
  const map = new Map<string, string>()
  // By worker: a task finishing moves from workers.json to done/, and one read can catch it in both.
  const senders = new Map<string, string>()
  const seen = new Set<string>()
  for (const path of paths) {
    seen.add(path)
    const rec = path === live || recheck ? readRecord(path) : (files.get(path) ?? readRecord(path))
    if (!rec) continue
    for (const [sid, effort] of rec.efforts) map.set(sid, effort)
    for (const [workerId, sid] of rec.origins) senders.set(workerId, sid)
  }
  for (const path of files.keys()) if (!seen.has(path)) files.delete(path)
  done.at = doneAt
  const dispatched = new Map<string, number>()
  for (const sid of senders.values()) dispatched.set(sid, (dispatched.get(sid) ?? 0) + 1)
  built = { at: now, map, dispatched }
  return built
}

/** Drop the cached map and the done/ folder's stamp (not the per-file parses, which re-validate on
 *  stat). For tests that write a worker record and then ask about it. */
export function invalidateClimayteEffortCache(): void {
  built = null
  done.at = Number.NaN
}
