// server/src/climayte-eta-ledger.ts — the durable record of what CliMayte workers said a message
// would take and what it took (docs/CLIMAYTE.md "Time estimates").
//
// WHY (owner, 2026-10-06): "we need to be actively tracking all estimations and the time it actually
// took ... and then asking the AI at the end, why did you think it would take two hours and it only
// took 30 minutes ... if you track it, it will get better." The samples used to live on the worker
// records, so removing or archiving a worker lost them, and only the minutes were kept.
//
// `eta.jsonl`, next to workers.json and journal.jsonl, append-only, one JSON object per line:
//   said     a worker's estimate, when it was first recorded (its exact words and the message)
//   settled  the estimate against the working time and the wall time, when its turn ended or the
//            Stop hook asked about it
//   review   the worker's own answer to why it missed (ETA-REVIEW and CAUSE)
// Reads take the file's tail only and are cached on its size and time: briefArgs reads it at every
// launch.

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './climayte-core'
import {
  type CliMayteEta,
  ETA_LEDGER_FILE,
  type EtaBucket,
  type EtaReview,
  type EtaSample,
  etaBucket,
  etaRatio,
  etaSamples,
  mergeSamples,
} from './climayte-eta'

export const ETA_LEDGER_PATH = join(ROOT, ETA_LEDGER_FILE)
/** A read looks at this much of the file's end. */
export const LEDGER_TAIL_BYTES = 1_000_000
/** The scorecard lists this many settled samples and reads this many reviews. */
export const RECENT_SAMPLES = 20
export const CAUSE_REVIEWS = 100

export type EtaRow =
  | {
      t: 'said'
      id: string
      kind: string | null
      model: string | null
      effort: string | null
      account: string | null
      title: string
      message: string
      minutes: number
      line: string
      text: string
      at: number
    }
  | {
      t: 'settled'
      id: string
      /** When the estimate was said. */
      saidAt: number
      /** When it settled. */
      at: number
      kind: string | null
      model: string | null
      effort: string | null
      title: string
      line: string
      minutes: number
      tookS: number
      wallS: number
      attempts: number
      moves: number
      ratio: number
      bucket: EtaBucket
    }
  | ({ t: 'review'; id: string; saidAt: number; at: number } & EtaReview)

let cache: { path: string; size: number; mtime: number; rows: EtaRow[] } | null = null

/** Append one row. Never throws: the ledger is a record, not a dependency. */
export function appendEtaRow(row: EtaRow, path = ETA_LEDGER_PATH): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(path, `${JSON.stringify(row)}\n`)
  } catch {
    // a full disk or a locked file loses one row, never a worker
  }
}

/** The rows in the last `bytes` of the file, oldest first. */
export function readEtaRows(path = ETA_LEDGER_PATH, bytes = LEDGER_TAIL_BYTES): EtaRow[] {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch {
    return []
  }
  if (cache && cache.path === path && cache.size === st.size && cache.mtime === st.mtimeMs)
    return cache.rows
  const start = Math.max(0, st.size - bytes)
  const buf = Buffer.alloc(st.size - start)
  let fd = -1
  try {
    fd = openSync(path, 'r')
    readSync(fd, buf, 0, buf.length, start)
  } catch {
    return []
  } finally {
    if (fd >= 0) closeSync(fd)
  }
  const lines = buf.toString('utf8').split(/\r?\n/)
  if (start > 0) lines.shift() // the first line of a tail is cut in the middle
  const rows: EtaRow[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as EtaRow
      if (row && typeof row === 'object' && typeof row.id === 'string') rows.push(row)
    } catch {
      // a half-written last line
    }
  }
  cache = { path, size: st.size, mtime: st.mtimeMs, rows }
  return rows
}

/** The settled estimates in `rows`, each with its review when one was written, newest first. */
export function samplesOfRows(rows: EtaRow[]): EtaSample[] {
  const reviews = new Map<string, EtaReview>()
  for (const r of rows)
    if (r.t === 'review')
      reviews.set(`${r.id}|${r.saidAt}`, {
        why: r.why,
        cause: r.cause,
        ...(r.raw ? { raw: r.raw } : {}),
      })
  const out = new Map<string, EtaSample>()
  for (const r of rows) {
    if (r.t !== 'settled' || !(r.minutes > 0)) continue
    const key = `${r.id}|${r.saidAt}`
    const review = reviews.get(key)
    out.set(key, {
      id: r.id,
      kind: r.kind,
      minutes: r.minutes,
      tookS: r.tookS,
      doneAt: r.at,
      at: r.saidAt,
      title: r.title,
      model: r.model,
      effort: r.effort,
      line: r.line,
      wallS: r.wallS,
      bucket: r.bucket,
      ...(review ? { review } : {}),
    })
  }
  return [...out.values()].sort((a, b) => b.doneAt - a.doneAt)
}

/** Every settled estimate: the ledger's, and those of the workers still on record, once each,
 *  newest first. This is what the brief and the scorecard calibrate on. */
export function allEtaSamples(
  workers: Parameters<typeof etaSamples>[0],
  path = ETA_LEDGER_PATH,
): EtaSample[] {
  return mergeSamples(samplesOfRows(readEtaRows(path)), etaSamples(workers))
}

/** The pieces of a worker an estimate row names. */
interface EtaWorkerFacts {
  id: string
  kind?: string | null
  model?: string | null
  effort?: string | null
  title: string
  message?: string | null
  prompt: string
  attempts: Array<{ account: { id: string } }>
}

export function saidRow(w: EtaWorkerFacts, eta: CliMayteEta, text: string): EtaRow {
  const message = w.message ?? w.prompt.split(/\r?\n/)[0] ?? ''
  return {
    t: 'said',
    id: w.id,
    kind: w.kind ?? null,
    model: w.model ?? null,
    effort: w.effort ?? null,
    account: w.attempts[eta.attempt]?.account.id ?? null,
    title: w.title,
    message: message.slice(0, 300),
    minutes: eta.minutes,
    line: eta.line ?? `ETA: ${eta.minutes} min`,
    text,
    at: eta.at,
  }
}

/** The settled row for an estimate whose `tookS` and `doneAt` are set. */
export function settledRow(
  w: EtaWorkerFacts,
  eta: CliMayteEta & { tookS: number; doneAt: number },
): EtaRow {
  const since = w.attempts.slice(Math.max(0, eta.attempt))
  let moves = 0
  for (let i = 1; i < since.length; i++)
    if (since[i]!.account.id !== since[i - 1]!.account.id) moves++
  const ratio = etaRatio(eta.minutes, eta.tookS)
  return {
    t: 'settled',
    id: w.id,
    saidAt: eta.at,
    at: eta.doneAt,
    kind: w.kind ?? null,
    model: w.model ?? null,
    effort: w.effort ?? null,
    title: w.title,
    line: eta.line ?? `ETA: ${eta.minutes} min`,
    minutes: eta.minutes,
    tookS: eta.tookS,
    wallS: Math.max(0, Math.round((eta.doneAt - eta.at) / 1000)),
    attempts: since.length,
    moves,
    ratio,
    bucket: etaBucket(ratio),
  }
}

export function reviewRow(id: string, eta: CliMayteEta, review: EtaReview, at: number): EtaRow {
  return { t: 'review', id, saidAt: eta.at, at, ...review }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** The scorecard's part of the ledger: the newest settled samples as rows, and the causes the
 *  newest reviews named with the median ratio of the estimates they belonged to. */
export function etaReport(samples: EtaSample[]): {
  recent: Array<{
    id: string
    title: string | null
    kind: string | null
    model: string | null
    effort: string | null
    line: string | null
    minutes: number
    tookMin: number
    wallMin: number | null
    ratio: number
    bucket: EtaBucket
    why: string | null
    cause: string | null
  }>
  causes: Array<{ cause: string; n: number; medianRatio: number }>
} {
  const min1 = (s: number): number => Math.round(s / 6) / 10
  const recent = samples.slice(0, RECENT_SAMPLES).map((s) => {
    const ratio = etaRatio(s.minutes, s.tookS)
    return {
      id: s.id,
      title: s.title ?? null,
      kind: s.kind,
      model: s.model ?? null,
      effort: s.effort ?? null,
      line: s.line ?? null,
      minutes: s.minutes,
      tookMin: min1(s.tookS),
      wallMin: s.wallS === undefined ? null : min1(s.wallS),
      ratio,
      bucket: s.bucket ?? etaBucket(ratio),
      why: s.review?.why ?? null,
      cause: s.review?.cause ?? null,
    }
  })
  const by = new Map<string, number[]>()
  for (const s of samples.filter((x) => x.review).slice(0, CAUSE_REVIEWS)) {
    const list = by.get(s.review!.cause) ?? []
    list.push(etaRatio(s.minutes, s.tookS))
    by.set(s.review!.cause, list)
  }
  const causes = [...by]
    .map(([cause, rs]) => ({
      cause,
      n: rs.length,
      medianRatio: Math.round(median(rs) * 100) / 100,
    }))
    .sort((a, b) => b.n - a.n || a.cause.localeCompare(b.cause))
  return { recent, causes }
}

/** Forget the cached read (a test that rewrites the file). */
export function resetEtaLedgerCache(): void {
  cache = null
}
