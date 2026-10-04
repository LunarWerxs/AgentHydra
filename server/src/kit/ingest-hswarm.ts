// Analytics toolkit ingest for HSwarm (docs/ANALYTICS-PLAN.md §4.6, piece 10). The daemon tails
// `<HSwarm home>/ledger.jsonl` by byte offset (ingest_cursor) and writes one usage_event per ledger task
// line. HSwarm itself never writes the kit.
//
//  * id `hswarm:<job>/<task>/<attempt>`. Ledger lines carry no attempt number, so it is the line's ordinal
//    among the lines of the same job/task (0 for the first): a retried task is a second call, as it is in
//    HSwarm's own stats, and re-reading a line writes the same id.
//  * `cached` lines (a resume reusing an answer: no call, no spend) are skipped, as model_stats.compute does.
//  * billed_usd is what was actually paid: the line's cost_usd when `billed` is true, 0 when it is false
//    (a free or trial key), null when the line never said. list_usd is cost_usd, its value at list price.
//  * A file smaller than the saved offset was rotated: the cursor starts again from byte 0.
//  * HSwarm moves finished months into ledger-YYYYMM.jsonl.gz beside it; each archive is read once (cursor per
//    archive path, skipped while its size+mtime are unchanged), so nothing appended before a rotation is lost.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { hswarmHome } from '../hswarm'
import type { KitStore, UsageEventInput } from './store'

/** Bump to make the cursor read the ledger again (a parser fix that changes what is extracted). */
export const HSWARM_INGEST_VERSION = 1
const BATCH = 5000
const CHUNK = 16 * 1024 * 1024

export const hswarmLedgerPath = (): string => join(hswarmHome(), 'ledger.jsonl')

interface LedgerLine {
  ts?: string
  job?: string
  task?: string
  attempt?: number
  model?: string
  provider?: string
  status?: string
  cached?: unknown
  cost_usd?: number | null
  billed?: boolean
  seconds?: number | null
  in_miss?: number
  in_hit?: number
  in_write?: number
  out?: number
  reasoning?: number
  caller_account?: string
  caller_instance?: string
  caller_session?: string
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** One ledger line as a usage_event; null for a line that is not a counted call. */
export function ledgerEvent(
  r: LedgerLine,
  attempt: number,
  pc: string | null,
  priceVer: string | null = null,
): UsageEventInput | null {
  const ts = typeof r.ts === 'string' ? Date.parse(r.ts) : Number.NaN
  if (!Number.isFinite(ts) || r.job == null || r.task == null) return null
  const cost = typeof r.cost_usd === 'number' ? r.cost_usd : null
  const ref = `${r.job}/${r.task}`
  return {
    id: `hswarm:${ref}/${attempt}`,
    ts,
    pc,
    account: str(r.caller_account),
    instance: str(r.caller_instance),
    session: str(r.caller_session),
    source: 'hswarm',
    model: str(r.model) ?? 'other',
    provider: str(r.provider),
    input: int(r.in_miss),
    output: int(r.out),
    cache_read: int(r.in_hit),
    cache_write_5m: int(r.in_write),
    reasoning: int(r.reasoning),
    list_usd: cost,
    billed_usd: r.billed === true ? cost : r.billed === false ? 0 : null,
    price_ver: priceVer,
    ok: r.status === 'ok',
    seconds: typeof r.seconds === 'number' ? r.seconds : null,
    ref,
  }
}

const ARCHIVE = /^(.+)-(\d{6})\.jsonl\.gz$/

/** The month archives beside the live ledger (hswarm/ledgerstore.py), oldest month first. */
export function hswarmArchivePaths(path: string = hswarmLedgerPath()): string[] {
  const live = basename(path)
  const stem = live.replace(/\.jsonl$/, '')
  let names: string[]
  try {
    names = readdirSync(dirname(path))
  } catch {
    return []
  }
  return names
    .map((n) => ARCHIVE.exec(n))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === stem)
    .sort((x, y) => (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0))
    .map((m) => join(dirname(path), m[0]))
}

/**
 * Reads the ledger's new bytes, and each month archive (ledger-YYYYMM.jsonl.gz) once: HSwarm rotates a finished
 * month out of the live file, and lines appended since the last sweep would otherwise vanish with it. An archive
 * has a cursor of its own (its path) and a fully read one is skipped by size+mtime. Reading an archive sends the
 * live file back to byte 0 (its cursor may point into a file that has since been replaced by a shorter one that
 * grew past it); ids are deterministic, so every re-read writes the same events. A task retried across a month
 * boundary gets its ordinals in order when all archives are read in one sweep (the first one after the upgrade);
 * a later single archive restarts them at 0. Returns events written, or null when nothing changed.
 */
export function ingestHswarm(
  store: KitStore,
  path: string = hswarmLedgerPath(),
  opts: { pc?: string | null } = {},
): number | null {
  const seen = new Map<string, number>()
  let written = 0
  let changed = false
  let archivesRead = false
  for (const ap of hswarmArchivePaths(path)) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(ap)
    } catch {
      continue
    }
    const mtime = Math.floor(st.mtimeMs)
    const cur = store.getCursor(ap)
    if (cur && cur.version === HSWARM_INGEST_VERSION && cur.size === st.size && cur.mtime === mtime)
      continue
    let data: Buffer
    try {
      data = gunzipSync(readFileSync(ap))
    } catch {
      continue // unreadable now (being replaced); the cursor is not set, so the next sweep reads it
    }
    const r = consume(store, data, 0, seen, opts.pc ?? null)
    written += r.written
    store.setCursor({
      path: ap,
      size: st.size,
      mtime,
      offset: st.size,
      version: HSWARM_INGEST_VERSION,
    })
    changed = true
    archivesRead = true
  }

  let size: number
  let mtime: number
  try {
    const s = statSync(path)
    size = s.size
    mtime = Math.floor(s.mtimeMs)
  } catch {
    return changed ? written : null
  }
  const cur = store.getCursor(path)
  if (
    !archivesRead &&
    cur &&
    cur.version === HSWARM_INGEST_VERSION &&
    cur.size === size &&
    cur.mtime === mtime
  )
    return changed ? written : null
  let offset = cur && cur.version === HSWARM_INGEST_VERSION ? cur.offset : 0
  if (offset > size || archivesRead) offset = 0 // shrank (rotated), or an archive just changed

  let end = offset
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let carry: Buffer = Buffer.alloc(0)
    let pos = offset
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos)
      if (n === 0) break
      pos += n
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      const r = consume(store, data, offset, seen, opts.pc ?? null)
      written += r.written
      end += r.consumed
      carry = Buffer.from(data.subarray(r.consumed)) // a line still being written waits for the next sweep
    }
  } finally {
    closeSync(fd)
  }
  store.setCursor({ path, size, mtime, offset: end, version: HSWARM_INGEST_VERSION })
  return written
}

/** Parses the whole lines of `data` into usage events. `consumed` is the bytes up to the last newline. */
function consume(
  store: KitStore,
  data: Buffer,
  offset: number,
  seen: Map<string, number>,
  pc: string | null,
): { written: number; consumed: number } {
  const lastAttempt = store.db.prepare(
    'select count(*) as n from usage_event where id >= $lo and id < $hi',
  )
  const nextAttempt = (r: LedgerLine): number => {
    if (typeof r.attempt === 'number') return r.attempt
    const ref = `${r.job}/${r.task}`
    let n = seen.get(ref)
    if (n === undefined && offset === 0) n = 0 // reading from the start: the same ids are rewritten, not added to
    if (n === undefined) {
      const prefix = `hswarm:${ref}/`
      n = (lastAttempt.get({ $lo: prefix, $hi: `${prefix.slice(0, -1)}0` }) as { n: number }).n
    }
    seen.set(ref, n + 1)
    return n
  }
  let written = 0
  let batch: UsageEventInput[] = []
  const flush = () => {
    if (batch.length === 0) return
    store.upsertEvents(batch)
    written += batch.length
    batch = []
  }
  let from = 0
  let nl = data.indexOf(0x0a, from)
  while (nl >= 0) {
    const text = data.toString('utf8', from, nl).trim()
    from = nl + 1
    nl = data.indexOf(0x0a, from)
    if (!text) continue
    let r: LedgerLine
    try {
      r = JSON.parse(text) as LedgerLine
    } catch {
      continue
    }
    if (!r || typeof r !== 'object' || r.cached) continue
    if (r.job == null || r.task == null) continue
    const ev = ledgerEvent(r, nextAttempt(r), pc)
    if (ev) batch.push(ev)
    if (batch.length >= BATCH) flush()
  }
  flush()
  return { written, consumed: from }
}
