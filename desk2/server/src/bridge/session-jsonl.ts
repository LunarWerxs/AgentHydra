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
}
const memo = new Map<string, Memo>()

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
 * those. A file that shrank or was replaced starts over; one that did not change costs a stat.
 */
export function sessionJsonlItems(path: string, cwd?: string | null): TranscriptItem[] {
  const st = statSync(path)
  let m = memo.get(path)
  if (m && m.size === st.size && m.mtimeMs === st.mtimeMs && m.ino === st.ino) return m.items
  if (m && (st.size < m.size || st.ino !== m.ino || st.mtimeMs < m.mtimeMs)) m = undefined
  let from = m?.offset ?? Math.max(0, st.size - TAIL_BYTES)
  const buf = readFrom(path, from, st.size)
  let text = buf.toString('utf8')
  if (!m && from > 0) {
    // The read starts mid-file: its first line may be cut, so it is left out.
    const nl = buf.indexOf(10)
    from += nl < 0 ? buf.length : nl + 1
    text = nl < 0 ? '' : buf.subarray(nl + 1).toString('utf8')
  }
  const end = text.lastIndexOf('\n') + 1
  const fresh = m ?? { ino: st.ino, size: 0, mtimeMs: 0, offset: from, recs: [], bytes: 0, items: [] }
  const done = text.slice(0, end).split('\n')
  done.pop()
  for (const line of done) {
    const bytes = Buffer.byteLength(line) + 1
    fresh.offset += bytes
    const recs = parseJsonl(line)
    if (!recs.length) continue
    fresh.recs.push({ rec: recs[0], bytes })
    fresh.bytes += bytes
  }
  // The last line may still be being written: it counts when it already parses, but is read again next time.
  const unfinished = parseJsonl(text.slice(end))
  while (fresh.bytes > TAIL_BYTES && fresh.recs.length > 1) fresh.bytes -= fresh.recs.shift()!.bytes
  fresh.size = st.size
  fresh.mtimeMs = st.mtimeMs
  fresh.ino = st.ino
  fresh.items = historyToItems([...fresh.recs.map((r) => r.rec), ...unfinished], { cwd: cwd ?? null })
  memo.delete(path)
  memo.set(path, fresh)
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!)
  return fresh.items
}
