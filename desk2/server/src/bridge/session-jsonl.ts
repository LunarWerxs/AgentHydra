// An outside Claude Code session's transcript read from its own .jsonl, in full fidelity. AgentHydra's
// tail endpoint flattens every text to one line (newlines, lists, headings and code fences gone), so for
// a Claude Code session Hydra Desk reads the file itself: read-only, only the tail, parsed by the same
// normalizer the live stream and history use. The tail endpoint stays the fallback when no file is found.
//
// WHERE THE FILES ARE (as AgentHydra's transcript index finds them, server/src/transcript.ts
// claudeStores): <config dir>/projects/<encoded cwd>/<session id>.jsonl, for the default login
// (~/.claude), every Claude Desktop instance (~/.claude-instances/<name>) and every CLI instance
// config folder AgentHydra lists. The encoded cwd is the folder with every character that is not a
// letter or digit turned into '-'.

import { existsSync, openSync, readdirSync, readSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { historyToItems, parseJsonl } from '../engine/normalize'

/** How much of a transcript's end is read: enough for a long session's recent turns. */
export const TAIL_BYTES = 8 * 1024 * 1024

/** A session id that can only name a file in a projects folder: no dots, no separators. */
const SESSION_ID = /^[A-Za-z0-9_-]{6,80}$/

/** Claude Code's project folder name for a cwd. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Every Claude-format projects folder on this machine that exists: the default login, Desktop instances, the given config dirs. */
export function claudeProjectRoots(configDirs: Iterable<string> = [], home = homedir()): string[] {
  const dirs = [join(home, '.claude')]
  const instances = join(home, '.claude-instances')
  try {
    for (const name of readdirSync(instances)) dirs.push(join(instances, name))
  } catch {
    // no Desktop instances on this machine
  }
  for (const d of configDirs) if (d) dirs.push(d)
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    const root = join(d, 'projects')
    const key = root.toLowerCase()
    if (seen.has(key) || !existsSync(root)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/** The session's .jsonl (the newest when it is in several folders), or null. Looks in the cwd's folder first. */
export function findSessionJsonl(sessionId: string, roots: string[], cwd?: string | null): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  const file = `${sessionId}.jsonl`
  const hits: { path: string; mtime: number }[] = []
  const consider = (path: string) => {
    try {
      const st = statSync(path)
      if (st.isFile()) hits.push({ path, mtime: st.mtimeMs })
    } catch {
      // not here
    }
  }
  if (cwd) for (const root of roots) consider(join(root, encodeProjectDir(cwd), file))
  if (!hits.length) {
    for (const root of roots) {
      let projects: string[] = []
      try {
        projects = readdirSync(root)
      } catch {
        continue
      }
      for (const p of projects) consider(join(root, p, file))
    }
  }
  if (!hits.length) return null
  return hits.reduce((a, b) => (b.mtime > a.mtime ? b : a)).path
}

/** The last `max` bytes of a file as text (the first line may be cut; parseJsonl skips it). */
export function readTail(path: string, max = TAIL_BYTES): string {
  const size = statSync(path).size
  const start = Math.max(0, size - max)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * The folder Claude Code says the session is in now: the `cwd` of the newest line that has one (every
 * transcript line carries it, and it follows the Bash tool's `cd`). Reads the file's end only; null when
 * no line in it has one.
 */
export function lastCwd(path: string): string | null {
  const size = statSync(path).size
  for (const max of [64 * 1024, TAIL_BYTES]) {
    const lines = readTail(path, max).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line) as { cwd?: unknown }
        if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd
      } catch {
        // the tail's first line may be cut
      }
    }
    if (size <= max) break
  }
  return null
}

/**
 * The `cwd` of the first whole line written at or after byte `offset` that has one (reads at most 256 KB
 * from there): the folder the session was in when its next turn began. Null when no such line exists yet.
 */
export function firstCwdFrom(path: string, offset: number): string | null {
  const size = statSync(path).size
  if (offset >= size) return null
  const len = Math.min(size - offset, 256 * 1024)
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, offset + read)
      if (n <= 0) break
      read += n
    }
  } finally {
    closeSync(fd)
  }
  for (const raw of buf.subarray(0, read).toString('utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const rec = JSON.parse(line) as { cwd?: unknown }
      if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd
    } catch {
      // a line still being written, or the offset fell mid-line
    }
  }
  return null
}

/** Source bytes of the lines parsed so far, by every reader (a test counts what a read did by the difference). */
export const sessionJsonlWork = { parsedBytes: 0 }

/** One session file as last read: the records of its complete lines, and where the next read starts. */
interface Memo {
  ino: number
  size: number
  mtimeMs: number
  /** Where the first unconsumed byte is: just after the last complete line read. */
  offset: number
  recs: { rec: unknown; bytes: number; uses?: string[]; mid?: string }[]
  /** Bytes the kept records took in the file. */
  bytes: number
  items: TranscriptItem[]
  /** The file's last FINGERPRINT bytes before `offset`: a file rewritten in place no longer has them there. */
  tail: Buffer
}
type Settled = Pick<Memo, 'ino' | 'size' | 'mtimeMs' | 'items' | 'bytes'>
const FINGERPRINT = 64

const unchanged = (m: Pick<Memo, 'ino' | 'size' | 'mtimeMs'>, st: { ino: number; size: number; mtimeMs: number }) =>
  m.size === st.size && m.mtimeMs === st.mtimeMs && m.ino === st.ino

/** Reads [from, size) of a file. */
function readFrom(path: string, from: number, size: number): Buffer {
  const buf = Buffer.alloc(size - from)
  const fd = openSync(path, 'r')
  try {
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

export interface JsonlReaderOptions {
  /** How much of a file's end a first read takes. */
  tailBytes: number
  /** Source bytes of records kept per file between reads. Below `tailBytes` the reader is windowed (see createJsonlReader). */
  keepBytes: number
  /** A windowed reader may keep this much to hold the launch of a tool or task still running. */
  pinBytes?: number
  /** Files kept incremental, and the source bytes of their kept records. */
  maxFiles: number
  maxBytes: number
  /** Files pushed out of that: their stat and answer only, so an unchanged one costs a stat. */
  settledFiles: number
  settledBytes: number
}

/** The ids of the tool_use blocks a record holds and the API message it belongs to: what a window must not cut apart. */
function marks(rec: unknown): { uses?: string[]; mid?: string } {
  const msg = (rec as { type?: unknown; message?: { id?: unknown; content?: unknown } } | null)?.message
  if (!msg || (rec as { type?: unknown }).type !== 'assistant') return {}
  const out: { uses?: string[]; mid?: string } = {}
  if (typeof msg.id === 'string') out.mid = msg.id
  if (Array.isArray(msg.content)) {
    for (const b of msg.content as { type?: unknown; id?: unknown }[]) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') (out.uses ??= []).push(b.id)
    }
  }
  return out
}

/**
 * Drops the oldest records past `keep` bytes, and returns the bytes dropped. A cut falls where an API message
 * begins (its blocks are separate records and number their items by arrival), and not past the launch of a tool
 * or task the items show still running, since a result whose tool is gone is skipped by the normalizer and the
 * item would stay running; that holds only while the window is within `cap`, so a tool that never answers cannot
 * keep a file's whole history in memory.
 */
function trimWindow(m: Memo, items: TranscriptItem[], keep: number, cap: number): number {
  const open = new Set<string>()
  for (const it of items) {
    if (it.kind === 'tool_use' && it.status === 'running') open.add(it.id)
    else if (it.kind === 'task' && it.status === 'running' && it.toolUseId) open.add(it.toolUseId)
  }
  let pin = open.size ? m.recs.findIndex((r) => r.uses?.some((id) => open.has(id))) : -1
  if (pin < 0) pin = m.recs.length
  let dropped = 0
  while (m.recs.length > 1 && m.bytes > keep) {
    let j = 1
    while (j < m.recs.length && m.recs[j]!.mid !== undefined && m.recs[j]!.mid === m.recs[j - 1]!.mid) j++
    if (j >= m.recs.length) break
    if (j > pin && m.bytes <= cap) break
    for (const r of m.recs.splice(0, j)) {
      m.bytes -= r.bytes
      dropped += r.bytes
    }
    pin -= j
  }
  return dropped
}

/**
 * A session file's items, read for as long as the file is polled. An open chat is polled every few seconds and a
 * running one grows all the time, so the file is read once and then only from where the last read stopped: the new
 * complete lines are parsed and added to the records kept, and the items are made from those. A file that shrank,
 * was replaced or was rewritten in place starts over; one that did not change costs a stat.
 *
 * With `keepBytes` below `tailBytes` the reader is WINDOWED: the first read still takes the whole tail and answers
 * every item in it, once; afterwards only the newest `keepBytes` of records stay in memory, and what a later read
 * answers is the items of that window. That is for a caller that only adds what is new or changed to a store that
 * already holds the rest (the CliMayte chats' workers); an item that fell out of the window is simply not answered
 * again. A window never starts inside an API message, and keeps back to the launch of a tool or task still running
 * (up to `pinBytes`; a tool that long without an answer loses it, and its result is then skipped).
 */
export interface JsonlReader {
  (path: string, cwd?: string | null): TranscriptItem[]
  /** The same answer, parsed in slices that let the event loop run between them. */
  readAsync(path: string, cwd?: string | null): Promise<TranscriptItem[]>
}

/** Lines parsed between two slices of an async read: about a few milliseconds of JSON.parse. */
const LINES_PER_SLICE = 100

export function createJsonlReader(o: JsonlReaderOptions): JsonlReader {
  const memo = new Map<string, Memo>()
  let memoBytes = 0
  const settled = new Map<string, Settled>()
  let settledBytes = 0
  const windowed = o.keepBytes < o.tailBytes
  const pinCap = o.pinBytes ?? o.keepBytes
  const reading = new Map<string, Promise<unknown>>()

  function unsettle(path: string): void {
    const kept = settled.get(path)
    if (!kept) return
    settled.delete(path)
    settledBytes -= kept.bytes
  }

  function* step(path: string, cwd?: string | null): Generator<void, TranscriptItem[]> {
    const st = statSync(path)
    let m = memo.get(path)
    if (m && unchanged(m, st)) return m.items
    const kept = settled.get(path)
    if (kept && unchanged(kept, st)) {
      settled.delete(path)
      settled.set(path, kept)
      return kept.items
    }
    const counted = m?.bytes ?? 0
    if (m && (st.size < m.size || st.ino !== m.ino || st.mtimeMs < m.mtimeMs)) m = undefined
    let from = 0
    let buf: Buffer | null = null
    if (m) {
      // The bytes just before where the last read stopped are read again and must still be the same: a file
      // rewritten in place to the same size or more is read from the start, not continued.
      const back = m.tail.length
      const read = readFrom(path, m.offset - back, st.size)
      if (read.length >= back && read.subarray(0, back).equals(m.tail)) {
        buf = read.subarray(back)
        from = m.offset
      } else m = undefined
    }
    if (!buf) {
      from = Math.max(0, st.size - o.tailBytes)
      buf = readFrom(path, from, st.size)
    }
    const prevTail = m?.tail ?? Buffer.alloc(0)
    let start = 0
    if (!m && from > 0) {
      // The read starts mid-file: its first line may be cut, so it is left out.
      const nl = buf.indexOf(10)
      start = nl < 0 ? buf.length : nl + 1
      from += start
    }
    const fresh: Memo = m ?? { ino: st.ino, size: 0, mtimeMs: 0, offset: from, recs: [], bytes: 0, items: [], tail: prevTail }
    // Lines are cut on the bytes themselves, so the offset counts what the file holds even where a line is
    // not valid UTF-8 (decoded, such a byte would count as three).
    let parsed = 0
    for (let nl = buf.indexOf(10, start); nl >= 0; start = nl + 1, nl = buf.indexOf(10, start)) {
      if (++parsed % LINES_PER_SLICE === 0) yield
      const bytes = nl + 1 - start
      fresh.offset += bytes
      sessionJsonlWork.parsedBytes += bytes
      const recs = parseJsonl(buf.subarray(start, nl).toString('utf8'))
      if (!recs.length) continue
      fresh.recs.push({ rec: recs[0], bytes, ...(windowed ? marks(recs[0]) : {}) })
      fresh.bytes += bytes
    }
    // The last line may still be being written: it counts when it already parses, but is read again next time.
    const unfinished = parseJsonl(buf.subarray(start).toString('utf8'))
    // buf[0, start) is what the file holds just before the new offset; a short one goes on from the old tail.
    const seg = buf.subarray(Math.max(0, start - FINGERPRINT), start)
    const joined = seg.length >= FINGERPRINT ? seg : Buffer.concat([prevTail, seg])
    fresh.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - FINGERPRINT)))
    fresh.size = st.size
    fresh.mtimeMs = st.mtimeMs
    fresh.ino = st.ino
    if (!windowed) while (fresh.bytes > o.tailBytes && fresh.recs.length > 1) fresh.bytes -= fresh.recs.shift()!.bytes
    yield
    const answer = historyToItems([...fresh.recs.map((r) => r.rec), ...unfinished], { cwd: cwd ?? null })
    fresh.items = answer
    if (windowed) {
      const dropped = trimWindow(fresh, answer, o.keepBytes, pinCap)
      // A first read dropped most of the tail: what is kept answers for the window alone, not the whole tail again.
      if (dropped > o.keepBytes) fresh.items = historyToItems([...fresh.recs.map((r) => r.rec), ...unfinished], { cwd: cwd ?? null })
    }
    memo.delete(path)
    memo.set(path, fresh)
    memoBytes += fresh.bytes - counted
    unsettle(path)
    while (memo.size > 1 && (memo.size > o.maxFiles || memoBytes > o.maxBytes)) {
      const [old, out] = memo.entries().next().value!
      memo.delete(old)
      memoBytes -= out.bytes
      settled.set(old, { ino: out.ino, size: out.size, mtimeMs: out.mtimeMs, items: out.items, bytes: out.bytes })
      settledBytes += out.bytes
      while (settled.size > o.settledFiles || settledBytes > o.settledBytes) unsettle(settled.keys().next().value!)
    }
    return answer
  }

  const drive = (path: string, cwd?: string | null): TranscriptItem[] => {
    const g = step(path, cwd)
    let r = g.next()
    while (!r.done) r = g.next()
    return r.value
  }

  const readAsync = async (path: string, cwd?: string | null): Promise<TranscriptItem[]> => {
    for (let prev = reading.get(path); prev; prev = reading.get(path)) await prev.catch(() => undefined)
    const run = (async () => {
      const g = step(path, cwd)
      let r = g.next()
      while (!r.done) {
        await new Promise((done) => setImmediate(done))
        r = g.next()
      }
      return r.value
    })()
    reading.set(path, run)
    try {
      return await run
    } finally {
      if (reading.get(path) === run) reading.delete(path)
    }
  }

  return Object.assign(drive, { readAsync })
}

const SETTLED = { settledFiles: 1024, settledBytes: 64 * 1024 * 1024 }

/**
 * The outside-session views' reader: the whole tail, kept in full, 8 files incremental. A CliMayte chat reads every
 * session it has had at each poll (one had 94, ten chats 136 files): with only 8 remembered, each poll re-parsed
 * them all, 0.6 to 1.6 s on the server's one thread, so those that settled keep their stat and answer.
 */
const readSession = createJsonlReader({ tailBytes: TAIL_BYTES, keepBytes: TAIL_BYTES, maxFiles: 8, maxBytes: Infinity, ...SETTLED })

export function sessionJsonlItems(path: string, cwd?: string | null): TranscriptItem[] {
  return readSession(path, cwd)
}

/**
 * The CliMayte workers' reader: a running worker grows its file between two polls and every running worker is
 * polled, so with 8 files remembered each poll of 10 to 30 workers parsed an 8 MiB tail apiece in one stretch,
 * while keeping 8 MiB of parsed records for each would take gigabytes of heap. The window is 1 MiB of records.
 */
export const workerJsonlItems = createJsonlReader({
  tailBytes: TAIL_BYTES,
  keepBytes: 1024 * 1024,
  pinBytes: 4 * 1024 * 1024,
  maxFiles: 128,
  maxBytes: 64 * 1024 * 1024,
  ...SETTLED,
})
