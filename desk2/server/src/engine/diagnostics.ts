// What every Diagnostics feature shares (SPEC "Diagnostics"): the failure ledger and the timing log both use
// these. Email masking, a JSON-lines log that rolls monthly or at a size cap and never throws on write, and the
// route prefix: every diagnostics route is GET /api/diagnostics/<name>, behind the server's loopback guard.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Hono } from 'hono'

export const DIAGNOSTICS_API = '/api/diagnostics'

/** How many files' parsed rows a JsonlLog keeps; the current file is read last, so it is never the one dropped. */
const PARSED_FILES_MAX = 6

/** Real addresses never reach a log: they read '<email>'. */
export function maskEmails(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
}

/** A time's month, UTC: YYYY-MM. */
function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7)
}

/** `text` masked and cut to `max` characters. */
export function safeText(text: string, max: number): string {
  return maskEmails(text).slice(0, max)
}

/** A day's key, local time: YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * <home>/<name>.jsonl, append-only. At a new month, or past `maxBytes`, the file is renamed
 * <name>-YYYY-MM[-n].jsonl and a fresh one starts. A write that fails is logged, never thrown: a log that cannot
 * be written must not break the work it records.
 */
export class JsonlLog {
  /** The folder exists: made once, and again after a write fails. */
  private homeMade = false
  /** The current file's size and last-write month as this process knows them; null until the first append looks. */
  private known: { size: number; month: string } | null = null
  /** Per file: its rows as parsed when it stood at this size and mtime. */
  private readonly parsed = new Map<string, ParsedFile>()

  constructor(
    readonly home: string,
    readonly name: string,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = 5_000_000,
  ) {}

  get file(): string {
    return join(this.home, `${this.name}.jsonl`)
  }

  append(line: object): void {
    try {
      if (!this.homeMade) {
        mkdirSync(this.home, { recursive: true })
        this.homeMade = true
      }
      this.roll()
      const text = JSON.stringify(line) + '\n'
      appendFileSync(this.file, text)
      this.known = { size: (this.known?.size ?? 0) + Buffer.byteLength(text), month: monthOf(this.now()) }
    } catch (err) {
      this.homeMade = false
      this.known = null
      console.warn(`[desk] ${this.name}.jsonl could not be written: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private roll(): void {
    if (!this.known) {
      if (!existsSync(this.file)) return
      const st = statSync(this.file)
      this.known = { size: st.size, month: monthOf(st.mtimeMs) }
    }
    if (this.known.month === monthOf(this.now()) && this.known.size < this.maxBytes) return
    let name = `${this.name}-${this.known.month}.jsonl`
    for (let n = 2; existsSync(join(this.home, name)); n++) name = `${this.name}-${this.known.month}-${n}.jsonl`
    renameSync(this.file, join(this.home, name))
    this.known = null
  }

  /** Every parsable line, the current file (and with `rolled` the rolled ones, oldest first); a torn line is skipped. */
  read(rolled = false): unknown[] {
    const files: string[] = []
    if (rolled) {
      try {
        const re = new RegExp(`^${this.name}-\\d{4}-\\d{2}(-\\d+)?\\.jsonl$`)
        files.push(...readdirSync(this.home).filter((f) => re.test(f)).sort().map((f) => join(this.home, f)))
      } catch {
        // no home yet
      }
    }
    files.push(this.file)
    const out: unknown[] = []
    for (const f of files) {
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(f)
      } catch {
        this.parsed.delete(f)
        continue
      }
      const hit = parseFile(f, st, this.parsed.get(f))
      if (!hit) continue
      this.parsed.set(f, hit)
      for (const row of hit.rows) out.push(row)
      for (const row of hit.tail) out.push(row)
    }
    // Only the newest files stay parsed: past the cap the oldest rolled ones are parsed afresh on each read that
    // asks for them, so what a read returns is the same. Dropping by age, not by last read, keeps a read that walks
    // every file oldest first from evicting each one just before the next read needs it.
    if (rolled) {
      const keep = new Set(files.slice(-PARSED_FILES_MAX))
      for (const f of [...this.parsed.keys()]) if (!keep.has(f)) this.parsed.delete(f)
    }
    return out
  }
}

interface ParsedFile {
  size: number
  mtimeMs: number
  offset: number
  rows: unknown[]
  tail: unknown[]
}

/** `f`'s rows at its size and mtime `st`: `hit` itself when unchanged, null when the file cannot be read. */
function parseFile(f: string, st: { size: number; mtimeMs: number }, hit: ParsedFile | undefined): ParsedFile | null {
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit
  // An append only grows the file: read from where the last read stopped. Anything else reads it whole.
  const from = hit && st.size > hit.size ? hit.offset : 0
  let chunk: Buffer
  try {
    chunk = readFrom(f, from, st.size)
  } catch {
    return null
  }
  const end = chunk.lastIndexOf(0x0a) + 1
  const rows = from > 0 && hit ? hit.rows : []
  parseLines(rows, chunk.toString('utf8', 0, end))
  // A last line with no newline yet may be a write in progress: shown if it parses, read again from its start next time.
  const tail: unknown[] = []
  parseLines(tail, chunk.toString('utf8', end))
  return { size: st.size, mtimeMs: st.mtimeMs, offset: from + end, rows, tail }
}

/** The file's bytes from `from` to `to`. */
function readFrom(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, to - from))
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got)
      if (n === 0) break
      got += n
    }
    return got === buf.length ? buf : buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/** Pushes every parsable JSON line of `text` onto `rows`; a torn line is skipped. */
function parseLines(rows: unknown[], text: string): void {
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      rows.push(JSON.parse(raw))
    } catch {
      // a torn line
    }
  }
}

/** Registers GET /api/diagnostics/<name>. The server's loopback guard covers every route, this prefix included. */
export function diagnosticsRoute(app: Hono, name: string, handler: (c: Context) => unknown | Promise<unknown>): void {
  app.get(`${DIAGNOSTICS_API}/${name}`, async (c) => c.json((await handler(c)) as object))
}

/** `?since=` as epoch ms: a number, or an ISO date; undefined when absent or unreadable. */
export function sinceParam(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  if (Number.isFinite(n)) return n
  const t = Date.parse(raw)
  return Number.isNaN(t) ? undefined : t
}
