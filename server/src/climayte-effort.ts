// server/src/climayte-effort.ts — the effort CliMayte launched each session at, for the Sessions list.
//
// CliMayte sets `--effort` per attempt and records it on the attempt (`requested.effort`) next to the
// session the attempt ran in (`sessionId`): in `corch/workers.json` for work in flight and
// `corch/done/<id>.json` for finished work. That is the one place the effort of a session CliMayte
// started was written down by the thing that chose it, so the list asks it before any guess.
//
// Read-only and cheap: a finished worker's file never changes, so each is parsed once and re-read
// only when its mtime or size moves; the whole map is rebuilt at most every TTL_MS.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { POINTER_DIR } from './instance'

const TTL_MS = 5_000

interface FileRecord {
  mtimeMs: number
  size: number
  efforts: Array<[sessionId: string, effort: string]>
}

const files = new Map<string, FileRecord>()
let built: { at: number; map: Map<string, string> } | null = null

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

function readRecord(path: string): FileRecord | null {
  try {
    const st = statSync(path)
    const have = files.get(path)
    if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return have
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    // workers.json holds `{workers: [...]}`; a finished worker's file is the worker itself.
    const efforts = effortsOf(Array.isArray(parsed?.workers) ? parsed.workers : [parsed])
    const rec = { mtimeMs: st.mtimeMs, size: st.size, efforts }
    files.set(path, rec)
    return rec
  } catch {
    return null // unreadable or half-written: skip it, the next scan reads it again
  }
}

/** Session id -> the effort CliMayte launched it at. Empty when CliMayte has never run here. */
export function climayteEffortBySession(): Map<string, string> {
  const now = Date.now()
  if (built && now - built.at < TTL_MS) return built.map
  const root = join(POINTER_DIR, 'corch')
  const paths = [join(root, 'workers.json')]
  try {
    for (const name of readdirSync(join(root, 'done')))
      if (name.endsWith('.json')) paths.push(join(root, 'done', name))
  } catch {
    // no finished work yet
  }
  const map = new Map<string, string>()
  const seen = new Set<string>()
  for (const path of paths) {
    seen.add(path)
    const rec = readRecord(path)
    if (rec) for (const [sid, effort] of rec.efforts) map.set(sid, effort)
  }
  for (const path of files.keys()) if (!seen.has(path)) files.delete(path)
  built = { at: now, map }
  return map
}

/** Drop the cached map (not the per-file parses, which re-validate on stat). For tests that write a
 *  worker record and then ask about it. */
export function invalidateClimayteEffortCache(): void {
  built = null
}
