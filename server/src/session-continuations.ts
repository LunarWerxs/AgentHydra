// server/src/session-continuations.ts — one conversation, however many files Claude Code split it into.
//
// THE PROBLEM, in the user's words: "multiple of the same things showing up in the chat". Three rows
// titled "rQubit T10-M06 v1 piece hash parity", 823, 1071 and 3179 messages, all in the same project.
// They are not three conversations and they are not subagents. They are ONE conversation that ran out
// of context twice.
//
// When Claude Code compacts a session it does not keep writing to the same transcript. It opens a NEW
// file with a NEW session id, writes a summary of what came before, and carries on. Resuming a
// compacted session does it again. Each file is a legitimate transcript with its own id, so an index
// keyed on session id — which is the only key the store gives you — sees three separate conversations
// and lists three rows. Measured on the three files above: 881 message uuids appear in more than one
// of them, 96.4% of the smallest. They are the same chat.
//
// WHAT LINKS THEM. The continuation's first record is a `system` record carrying `logicalParentUuid`,
// which is the uuid of the message in the PARENT conversation that it was compacted from. That gives
// us a link, but the target is an ordinary message uuid sitting anywhere in the parent (measured: 82%
// of the way through), not a header we could read cheaply. So resolving "which session owns this
// uuid" means looking inside candidate transcripts.
//
// WHY THAT IS AFFORDABLE ANYWAY. Continuations are rare — 94 of 1,208 conversations on the machine
// this was written against, about 8% — and the answer is IMMUTABLE, because a transcript's history
// never changes once written. So each link is resolved at most once, ever, and remembered on disk.
// The search is ordered by how close the candidate's mtime is to the continuation's, because a
// compaction is immediately followed by its continuation, so the parent is nearly always the first
// file tried.
//
// EVERYTHING HERE IS ASYNC AND CHUNKED, AND THAT IS NOT DECORATION. This daemon was just rescued from
// a bug where a synchronous whole-store scan held Bun's single event loop for seconds at a time, so
// that a route reading nothing answered in 6.6 s. Reading candidate transcripts is the same shape of
// work: this module's first draft did it with readFileSync over files up to 64 MB, twelve in a row,
// with no yield between them, and review caught it before it shipped. Every read below is a bounded
// slice with a yield after it.
//
// A FAILED SEARCH IS ONLY REMEMBERED WHEN IT WAS EXHAUSTIVE. "I looked everywhere and it is not
// there" is a permanent fact worth caching. "I ran out of candidates" or "that file was too big to
// scan" is not, and caching it would silently un-fix the very duplicate this file exists to remove.

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config'

/** How much of a transcript's head to read looking for the continuation marker. */
const HEAD_BYTES = 256 * 1024

/** How many records into a transcript the continuation marker can be before we stop looking. It is
 *  written among the first few (title, mode, then the compact record); this is slack, not a guess.
 *  A record COUNT rather than a match on some other record's text, because the latter would depend
 *  on how the writer spaces its JSON — true of this store today, and the kind of thing that changes
 *  silently. */
const MARKER_WITHIN_RECORDS = 40

/** Read size when hunting a uuid inside a candidate. Bounded so memory stays flat on a 59 MB
 *  transcript (they exist on this machine) and so there is somewhere to yield. */
const SCAN_CHUNK = 4 * 1024 * 1024

/** Candidates tried per continuation. Hitting this is recorded as a NON-exhaustive search, so the
 *  link is retried later rather than written off. */
const MAX_CANDIDATES = 24

/** Links resolved per background pass, so a store meeting this feature for the first time spreads
 *  its reads over several sweeps instead of doing them all at once. */
const RESOLVE_BUDGET = 8

export interface ContinuationLink {
  /** The continuation's own session id. */
  sessionId: string
  /** The uuid, in some earlier transcript, that this one was compacted from. */
  logicalParentUuid: string
  /** Absolute path of the continuation transcript. */
  path: string
  mtimeMs: number
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// --- head read ----------------------------------------------------------------------------------

const headCache = new Map<string, { stamp: string; link: string | null }>()

/**
 * The uuid this transcript was continued from, or null if it is not a continuation.
 *
 * Async and bounded: this runs for every top-level Claude transcript on every sweep (~1,200 of them
 * here), inside the async index build, so it must not hold the loop. Cached against mtime+size like
 * every other per-file read in this codebase — a transcript that has not moved cannot have started
 * being a continuation.
 */
export async function readContinuationLink(
  path: string,
  mtimeMs: number,
  size: number,
): Promise<string | null> {
  const stamp = `${mtimeMs}:${size}`
  const hit = headCache.get(path)
  if (hit?.stamp === stamp) return hit.link

  let link: string | null = null
  try {
    const file = Bun.file(path)
    const head = await (size > HEAD_BYTES ? file.slice(0, HEAD_BYTES) : file).text()
    let examined = 0
    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      if (++examined > MARKER_WITHIN_RECORDS) break
      // A cheap reject before parsing: most transcripts never contain this key at all.
      if (!line.includes('"logicalParentUuid"')) continue
      try {
        const r = JSON.parse(line)
        if (typeof r?.logicalParentUuid === 'string' && r.logicalParentUuid)
          link = r.logicalParentUuid
      } catch {
        // A truncated final line in a file being written is not worth failing a sweep over.
      }
      break
    }
  } catch {
    link = null
  }
  headCache.set(path, { stamp, link })
  return link
}

/** Forget head reads for transcripts that are no longer in the store, so the cache tracks the store
 *  rather than everything ever seen. Called with the paths of the sweep that just finished. */
export function pruneContinuationHeadCache(livePaths: Set<string>): void {
  if (headCache.size <= livePaths.size) return
  for (const path of headCache.keys()) if (!livePaths.has(path)) headCache.delete(path)
}

// --- resolved links, remembered across restarts ---------------------------------------------------

const MEMO_PATH = join(CONFIG_DIR, 'session-continuations.json')

/**
 * continuation session id -> the session id it continues, or '' for "searched everywhere, not here".
 *
 * The empty string is a real, permanent answer: a parent that was deleted is not coming back, and
 * re-searching for it on every restart is the cost this file exists to avoid. It is ONLY written for
 * an exhaustive search — see resolveOne. A search that ran out of candidates, or skipped a file for
 * being too large, leaves no entry at all and is tried again on a later pass.
 */
let memo: Map<string, string> | null = null

function loadMemo(): Map<string, string> {
  if (memo) return memo
  memo = new Map()
  try {
    const raw = JSON.parse(readFileSync(MEMO_PATH, 'utf8'))
    if (raw && typeof raw === 'object')
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') memo.set(k, v)
  } catch {
    // No memo yet, or one written by a version that wrote something else. Either way start empty:
    // every entry is re-derivable by reading the transcripts again.
  }
  return memo
}

function saveMemo(): void {
  const known = loadMemo()
  try {
    // Written beside the target and renamed, so a process that dies mid-write leaves the previous
    // memo intact rather than a truncated JSON file that will not parse. Losing the memo is only a
    // re-search, but a corrupt one would be silently re-derived on every start forever.
    const tmp = `${MEMO_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(known)))
    renameSync(tmp, MEMO_PATH)
  } catch {
    // A memo that cannot be persisted still works for this process; it just costs the search again
    // next start. Never worth failing anything for.
  }
}

/**
 * What the index acts on: which sessions have been SUPERSEDED, and by which continuation.
 *
 * Keyed the way the caller needs it — parent session id -> the session that continued it — so that
 * applying it is a map lookup per row and nothing else.
 */
export function supersededSessions(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [child, parent] of loadMemo()) if (parent) out.set(parent, child)
  return out
}

// --- resolution ------------------------------------------------------------------------------------

/**
 * Does this transcript contain that message uuid?
 *
 * Chunked and yielding: a candidate can be tens of megabytes, and this runs while the daemon is
 * serving. A plain substring test is enough — uuids are unique enough that a false positive would
 * need the same uuid in an unrelated conversation, which is what "belongs to it" means anyway.
 */
async function fileContains(path: string, uuid: string, size: number): Promise<boolean> {
  const file = Bun.file(path)
  let start = 0
  // Carried between chunks so a uuid straddling a boundary is still found.
  let carry = ''
  while (start < size) {
    const end = Math.min(start + SCAN_CHUNK, size)
    const text = await file.slice(start, end).text()
    if ((carry + text).includes(uuid)) return true
    carry = text.slice(-uuid.length)
    start = end
    await tick()
  }
  return false
}

interface Resolution {
  /** The owning session id, or '' when nothing matched. */
  parent: string
  /** Whether every candidate was actually examined. A partial search must not be remembered. */
  exhaustive: boolean
}

/**
 * Find the transcript that owns `link`, searching the continuation's own project folder.
 *
 * Scoped to that folder because Claude Code keeps a conversation's files under the project key, and
 * ordered by how close each candidate's mtime is to the continuation's, because compaction is
 * immediately followed by the continuation that replaces it. In practice the first candidate is the
 * answer; the ordering is what keeps this from being a folder scan.
 */
async function resolveOne(entry: ContinuationLink): Promise<Resolution> {
  const dir = join(entry.path, '..')
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    // The folder is gone. Nothing to find, and nothing will change that.
    return { parent: '', exhaustive: true }
  }
  const self = entry.path.replace(/\\/g, '/').toLowerCase()
  const candidates: Array<{ path: string; id: string; size: number; distance: number }> = []
  for (const name of names) {
    const path = join(dir, name)
    if (path.replace(/\\/g, '/').toLowerCase() === self) continue
    try {
      const st = statSync(path)
      candidates.push({
        path,
        id: name.replace(/\.jsonl$/i, ''),
        size: st.size,
        distance: Math.abs(st.mtimeMs - entry.mtimeMs),
      })
    } catch {
      // Vanished between the listing and the stat. Not a candidate.
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  const tried = candidates.slice(0, MAX_CANDIDATES)
  for (const c of tried) {
    if (await fileContains(c.path, entry.logicalParentUuid, c.size))
      return { parent: c.id, exhaustive: true }
    await tick()
  }
  // Only a search that reached the end of the list proves absence. Stopping at the cap means the
  // parent may be the candidate we never opened, and writing '' for that would leave this
  // conversation duplicated on screen forever — the exact bug this module exists to remove.
  return { parent: '', exhaustive: tried.length === candidates.length }
}

let resolving = false

/**
 * Resolve links that are not yet known, a few at a time, off the sweep's critical path.
 *
 * Deliberately bounded and deliberately not awaited by the index build. Reading whole transcripts is
 * exactly the kind of work that used to freeze this daemon, so it happens between sweeps and its
 * results are picked up by the next one.
 */
export async function resolveContinuations(entries: ContinuationLink[]): Promise<void> {
  if (resolving) return
  const known = loadMemo()
  const pending = entries.filter((e) => !known.has(e.sessionId))
  if (pending.length === 0) return
  resolving = true
  try {
    let wrote = 0
    let done = 0
    for (const entry of pending) {
      if (done >= RESOLVE_BUDGET) break
      done++
      await tick()
      let result: Resolution
      try {
        result = await resolveOne(entry)
      } catch {
        // An unreadable candidate is not proof of anything; leave the link for a later pass.
        continue
      }
      if (result.parent || result.exhaustive) {
        known.set(entry.sessionId, result.parent)
        wrote++
      }
    }
    if (wrote > 0) saveMemo()
  } finally {
    resolving = false
  }
}

/** Test seam: forget everything learned in this process. */
export function resetContinuationMemoForTests(): void {
  memo = new Map()
  headCache.clear()
}
