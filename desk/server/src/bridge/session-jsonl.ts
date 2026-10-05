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
import { type HistoryFold, historyFold, parseJsonl } from '../engine/normalize'

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

/** Bytes [from, to) of a file. */
function readRange(path: string, from: number, to: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, to - from))
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

/** The last `max` bytes of a file as text (the first line may be cut; parseJsonl skips it). */
export function readTail(path: string, max = TAIL_BYTES): string {
  const size = statSync(path).size
  return readRange(path, Math.max(0, size - max), size).toString('utf8')
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
  for (const raw of readRange(path, offset, Math.min(size, offset + 256 * 1024)).toString('utf8').split('\n')) {
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
/** How far past where its read began a followed file may grow before its tail is read afresh: bounds what one file holds. */
const REFOLD_BYTES = TAIL_BYTES + TAIL_BYTES / 2

interface Followed {
  sig: string
  /** The byte its read began at, and the byte after the last whole line taken in. */
  start: number
  offset: number
  fold: HistoryFold
  items: TranscriptItem[]
}
const memo = new Map<string, Followed>()

/** Takes the whole lines of `buf` (read from byte `at`) into the fold; a last line still being written waits for the next read. */
function takeLines(f: Followed, buf: Buffer, at: number): void {
  let used = buf.lastIndexOf(10) + 1
  const records = used ? parseJsonl(buf.toString('utf8', 0, used)) : []
  const rest = buf.toString('utf8', used).trim()
  if (rest.startsWith('{')) {
    try {
      records.push(JSON.parse(rest))
      used = buf.length
    } catch {
      // still being written
    }
  }
  f.fold.add(records)
  f.offset = at + used
}

/**
 * A session file's items: the last TAIL_BYTES when first read, then only what was appended since. A
 * working session's .jsonl grows every few seconds, and a read of its whole tail at each poll was 8 MB
 * re-read and re-parsed per working chat every 3 s. A file that shrank was rewritten and is read again.
 */
export function sessionJsonlItems(path: string, cwd?: string | null): TranscriptItem[] {
  const st = statSync(path)
  const sig = `${st.size}:${st.mtimeMs}`
  const key = `${path}\n${cwd ?? ''}`
  let f = memo.get(key)
  if (f && f.sig === sig) return f.items
  if (!f || st.size < f.offset || st.size - f.start > REFOLD_BYTES) {
    const start = Math.max(0, st.size - TAIL_BYTES)
    f = { sig, start, offset: start, fold: historyFold({ cwd: cwd ?? null }), items: [] }
  }
  takeLines(f, readRange(path, f.offset, st.size), f.offset)
  f.sig = sig
  f.items = f.fold.items()
  memo.delete(key)
  memo.set(key, f)
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!)
  return f.items
}
