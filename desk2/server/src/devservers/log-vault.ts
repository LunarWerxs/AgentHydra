// The log vault: each server's output lines appended to <home>/devservers/logs/<server id>.log (ported from DevWebUI's
// log-vault.ts), so history survives a restart. One JSON line per log line carrying its `seq`, which counts up across
// runs (the next seq is read back from the newest file the first time a server logs). The file rotates by size, keeping
// two older ones. Writes are coalesced for a moment so a noisy server does not cost a stat and an append per chunk.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DevWebLogLine } from '@shared/devwebui'

const MAX_BYTES = 1_000_000
const KEEP_ROTATIONS = 2
const FLUSH_MS = 75
const MAX_PENDING = 10_000
export const PAGE_DEFAULT = 200
export const PAGE_MAX = 2000

interface Stored {
  s: number
  t: number
  k: 'stdout' | 'stderr'
  l: string
}

export class LogVault {
  private pending = new Map<string, string[]>()
  private pendingCount = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private seqs = new Map<string, number>()

  constructor(private readonly dir: string) {}

  private file(id: string, rotation = 0): string {
    const base = path.join(this.dir, `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`)
    return rotation === 0 ? base : `${base}.${rotation}`
  }

  private parse(text: string): Stored[] {
    const out: Stored[] = []
    for (const raw of text.split('\n')) {
      if (!raw) continue
      try {
        const r = JSON.parse(raw) as Stored
        if (typeof r.s === 'number' && typeof r.l === 'string') out.push(r)
      } catch {
        // a torn last line (a crash mid-write) is skipped
      }
    }
    return out
  }

  /** The highest seq on disk for `id` (0 when it never logged). */
  private lastSeq(id: string): number {
    for (let r = 0; r <= KEEP_ROTATIONS; r++) {
      try {
        const rows = this.parse(readFileSync(this.file(id, r), 'utf8'))
        if (rows.length) return rows[rows.length - 1]!.s
      } catch {
        // missing: try the older one
      }
    }
    return 0
  }

  /** Queues a line and answers its seq. */
  add(id: string, stream: DevWebLogLine['stream'], line: string, ts: number): number {
    let seq = this.seqs.get(id)
    if (seq === undefined) seq = this.lastSeq(id)
    seq += 1
    this.seqs.set(id, seq)
    const row = `${JSON.stringify({ s: seq, t: ts, k: stream, l: line } satisfies Stored)}\n`
    const bucket = this.pending.get(id)
    if (bucket) bucket.push(row)
    else this.pending.set(id, [row])
    if (++this.pendingCount >= MAX_PENDING) this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS)
      this.timer.unref?.()
    }
    return seq
  }

  private rotate(id: string): void {
    try {
      rmSync(this.file(id, KEEP_ROTATIONS), { force: true })
      for (let i = KEEP_ROTATIONS - 1; i >= 0; i--) if (existsSync(this.file(id, i))) renameSync(this.file(id, i), this.file(id, i + 1))
    } catch {
      // a failed rotation only lets the current file keep growing
    }
  }

  /** Writes everything queued (the timer, a read, and the service's stop). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending.size) return
    const batches = this.pending
    this.pending = new Map()
    this.pendingCount = 0
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      return
    }
    for (const [id, rows] of batches) {
      try {
        const f = this.file(id)
        if (existsSync(f) && statSync(f).size >= MAX_BYTES) this.rotate(id)
        appendFileSync(f, rows.join(''))
      } catch {
        // a disk error must never take down the server being logged
      }
    }
  }

  /** The newest `limit` lines with a seq below `before` (none: the newest), oldest first; `more` when older ones exist. */
  page(id: string, opts: { before?: number; limit?: number }): { lines: DevWebLogLine[]; more: boolean } {
    this.flush()
    const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(opts.limit ?? PAGE_DEFAULT)))
    const before = opts.before ?? Number.POSITIVE_INFINITY
    const picked: Stored[] = [] // newest first, up to limit + 1 (the extra one says `more`)
    for (let r = 0; r <= KEEP_ROTATIONS && picked.length <= limit; r++) {
      let rows: Stored[]
      try {
        rows = this.parse(readFileSync(this.file(id, r), 'utf8'))
      } catch {
        continue
      }
      for (let i = rows.length - 1; i >= 0 && picked.length <= limit; i--) if (rows[i]!.s < before) picked.push(rows[i]!)
    }
    const more = picked.length > limit
    const lines = picked
      .slice(0, limit)
      .reverse()
      .map((r): DevWebLogLine => ({ stream: r.k, line: r.l, ts: r.t, seq: r.s }))
    return { lines, more }
  }

  /** A removed server's files. */
  delete(id: string): void {
    this.pending.delete(id)
    this.seqs.delete(id)
    for (let r = 0; r <= KEEP_ROTATIONS; r++) rmSync(this.file(id, r), { force: true })
  }
}
