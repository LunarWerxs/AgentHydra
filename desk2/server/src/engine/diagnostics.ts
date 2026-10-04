// What every Diagnostics feature shares (SPEC "Diagnostics"): the failure ledger and the timing log both use
// these. Email masking, a JSON-lines log that rolls monthly or at a size cap and never throws on write, and the
// route prefix: every diagnostics route is GET /api/diagnostics/<name>, behind the server's loopback guard.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Hono } from 'hono'

export const DIAGNOSTICS_API = '/api/diagnostics'

/** Real addresses never reach a log: they read '<email>'. */
export function maskEmails(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
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
      mkdirSync(this.home, { recursive: true })
      this.roll()
      appendFileSync(this.file, JSON.stringify(line) + '\n')
    } catch (err) {
      console.warn(`[desk] ${this.name}.jsonl could not be written: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private roll(): void {
    if (!existsSync(this.file)) return
    const st = statSync(this.file)
    const month = (ms: number): string => new Date(ms).toISOString().slice(0, 7)
    if (month(st.mtimeMs) === month(this.now()) && st.size < this.maxBytes) return
    let name = `${this.name}-${month(st.mtimeMs)}.jsonl`
    for (let n = 2; existsSync(join(this.home, name)); n++) name = `${this.name}-${month(st.mtimeMs)}-${n}.jsonl`
    renameSync(this.file, join(this.home, name))
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
      let text: string
      try {
        text = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue
        try {
          out.push(JSON.parse(raw))
        } catch {
          // a torn line
        }
      }
    }
    return out
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
