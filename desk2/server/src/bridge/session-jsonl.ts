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

const MEMO_MAX = 8

/** One session file as last read: the records of its complete lines, and where the next read starts. */
interface Memo {
  ino: number
  size: number
  mtimeMs: number
  /** Where the first unconsumed byte is: just after the last complete line read. */
  offset: number
  recs: { rec: unknown; bytes: number }[]
  /** Bytes the kept records took in the file. */
  bytes: number
  items: TranscriptItem[]
  /** The file's last FINGERPRINT bytes before `offset`: a file rewritten in place no longer has them there. */
  tail: Buffer
}
const memo = new Map<string, Memo>()
const FINGERPRINT = 64

/**
 * Files pushed out of `memo`: their stat and the items they answered, without the records. A CliMayte chat
 * reads every session it has had at each poll (one had 94, ten chats 136 files): with only MEMO_MAX remembered,
 * each poll re-parsed them all, 0.6 to 1.6 s on the server's one thread, and every click waited behind it. An
 * unchanged one costs a stat; a changed one is read again from its tail.
 */
const settled = new Map<string, Pick<Memo, 'ino' | 'size' | 'mtimeMs' | 'items' | 'bytes'>>()
const SETTLED_MAX = 1024
/** Source bytes the settled items were made from, oldest dropped first past this; the items take a multiple of it. */
const SETTLED_MAX_BYTES = 64 * 1024 * 1024
let settledBytes = 0

function unsettle(path: string): void {
  const kept = settled.get(path)
  if (!kept) return
  settled.delete(path)
  settledBytes -= kept.bytes
}

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

/**
 * A session file's items. An open chat is polled every few seconds and a running one grows all the time,
 * so the file is read once and then only from where the last read stopped: the new complete lines are
 * parsed and added to the records kept (the newest TAIL_BYTES of them), and the items are made from
 * those. A file that shrank, was replaced or was rewritten in place starts over; one that did not change
 * costs a stat.
 */
export function sessionJsonlItems(path: string, cwd?: string | null): TranscriptItem[] {
  const st = statSync(path)
  let m = memo.get(path)
  if (m && unchanged(m, st)) return m.items
  const kept = settled.get(path)
  if (kept && unchanged(kept, st)) {
    settled.delete(path)
    settled.set(path, kept)
    return kept.items
  }
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
    from = Math.max(0, st.size - TAIL_BYTES)
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
  for (let nl = buf.indexOf(10, start); nl >= 0; start = nl + 1, nl = buf.indexOf(10, start)) {
    const bytes = nl + 1 - start
    fresh.offset += bytes
    const recs = parseJsonl(buf.subarray(start, nl).toString('utf8'))
    if (!recs.length) continue
    fresh.recs.push({ rec: recs[0], bytes })
    fresh.bytes += bytes
  }
  // The last line may still be being written: it counts when it already parses, but is read again next time.
  const unfinished = parseJsonl(buf.subarray(start).toString('utf8'))
  // buf[0, start) is what the file holds just before the new offset; a short one goes on from the old tail.
  const seg = buf.subarray(Math.max(0, start - FINGERPRINT), start)
  const joined = seg.length >= FINGERPRINT ? seg : Buffer.concat([prevTail, seg])
  fresh.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - FINGERPRINT)))
  while (fresh.bytes > TAIL_BYTES && fresh.recs.length > 1) fresh.bytes -= fresh.recs.shift()!.bytes
  fresh.size = st.size
  fresh.mtimeMs = st.mtimeMs
  fresh.ino = st.ino
  fresh.items = historyToItems([...fresh.recs.map((r) => r.rec), ...unfinished], { cwd: cwd ?? null })
  memo.delete(path)
  memo.set(path, fresh)
  unsettle(path)
  if (memo.size > MEMO_MAX) {
    const [old, out] = memo.entries().next().value!
    memo.delete(old)
    settled.set(old, { ino: out.ino, size: out.size, mtimeMs: out.mtimeMs, items: out.items, bytes: out.bytes })
    settledBytes += out.bytes
    while (settled.size > SETTLED_MAX || settledBytes > SETTLED_MAX_BYTES) unsettle(settled.keys().next().value!)
  }
  return fresh.items
}
