// server/src/zswarm-cost.ts - the DeepSeek zswarm's spend, read out of its own ledger, plus its live
// account balance.
//
// The zswarm (`Lunarwerx/zswarm`, cloned at D:/NEWProjects/shared/zswarm; MCP server `zswarm`) is the
// fleet's DeepSeek fan-out tier. It journals one JSON line per TASK to `~/.zswarm/ledger.jsonl`
// (zswarm's `config.py` LEDGER) and one directory per JOB under `~/.zswarm/jobs/<id>/` (the session
// side of this is server/src/zswarm-sessions.ts). Nothing here writes either file - this is a reader,
// same posture as every other store AgentHydra reads.
//
// THE BALANCE CALL, AND WHY IT NEVER THROWS. `GET https://api.deepseek.com/user/balance` needs the
// same key the zswarm itself resolves - env `DEEPSEEK_API_KEY` first, else `refs.DEEPSEEK_API_KEY` in
// `~/.dsh/.credentials.yaml` (zswarm's own `config.py` `_read_yaml_key`, same file and same field).
// list_usage calls deepseekBalance() on every survey, right beside the per-account Claude quota
// checks, so a slow or unreachable DeepSeek endpoint must never slow or fail a Claude quota read:
// short timeout, cached, and any failure degrades to `status: 'unknown'` - this function does not
// throw. ⛔ The key itself is read by this code at runtime and is never logged, printed, or returned.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ZSWARM_HOME } from './config'

/** One line of `~/.zswarm/ledger.jsonl` - one entry per TASK (a job is usually several). `cost_usd`,
 *  `in_hit`/`in_miss`/`out` and `reasoning` are null when the backend reports no accounting at all
 *  (the `dsh` backend: DeepSeek Harness headless keeps no cost data of its own). Narrowed to the
 *  fields this module actually aggregates; the ledger carries more (see the TODO this landed from). */
export interface ZswarmLedgerEntry {
  ts: string
  job: string
  task: string
  backend: string
  model: string
  status: string
  cost_usd: number | null
}

/**
 * Read every ledger line, skipping a torn or unparsable one rather than failing the whole file.
 *
 * The ledger is appended to live by every running zswarm job, so the last line can be mid-write at
 * the moment we read it - the same reason dsh-sessions.ts's readDshLog and every other JSONL reader
 * in this codebase treats one bad line as a skip, not a throw.
 */
export function readZswarmLedger(root: string = ZSWARM_HOME): ZswarmLedgerEntry[] {
  let text: string
  try {
    text = readFileSync(join(root, 'ledger.jsonl'), 'utf8')
  } catch {
    return []
  }
  const out: ZswarmLedgerEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)
      if (rec && typeof rec === 'object' && typeof rec.ts === 'string')
        out.push(rec as ZswarmLedgerEntry)
    } catch {
      // a torn final line, or a record from a newer zswarm we cannot parse: skip it
    }
  }
  return out
}

/** One day/model/backend bucket's total spend. */
export interface ZswarmCostRow {
  /** UTC calendar day, taken straight off `ts` (`2026-09-15`) - the ledger already writes UTC. */
  day: string
  model: string
  backend: string
  cost_usd: number
  tasks: number
}

export interface ZswarmCostSummary {
  rows: ZswarmCostRow[]
  total_usd: number
  /** Tasks whose backend keeps no cost data (`dsh`) or that errored before anything priced - counted
   *  so `total_usd` never LOOKS complete when part of the ledger is genuinely unpriced. */
  unpriced_tasks: number
}

/**
 * Sum `cost_usd` from the ledger by day/model/backend.
 *
 * A `null` cost contributes zero dollars but is still counted in `unpriced_tasks`, so "the zswarm
 * spent nothing today" and "the zswarm spent an amount we cannot see" stay distinguishable - folding
 * null into 0 silently would report the second as the first.
 */
export function summarizeZswarmCost(root: string = ZSWARM_HOME): ZswarmCostSummary {
  const buckets = new Map<string, ZswarmCostRow>()
  let total = 0
  let unpriced = 0
  for (const entry of readZswarmLedger(root)) {
    const day = (entry.ts || '').slice(0, 10) || 'unknown'
    const model = entry.model || 'unknown'
    const backend = entry.backend || 'unknown'
    const key = `${day}\u0001${model}\u0001${backend}`
    let row = buckets.get(key)
    if (!row) {
      row = { day, model, backend, cost_usd: 0, tasks: 0 }
      buckets.set(key, row)
    }
    row.tasks++
    if (typeof entry.cost_usd === 'number' && Number.isFinite(entry.cost_usd)) {
      row.cost_usd += entry.cost_usd
      total += entry.cost_usd
    } else {
      unpriced++
    }
  }
  // Newest day first, matching how every other spend list in this codebase orders its rows.
  const rows = [...buckets.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
  return { rows, total_usd: total, unpriced_tasks: unpriced }
}

// --- the DeepSeek account balance, cached and never throwing ------------------------------------

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** Hard cap on the request. list_usage runs this on every survey; a Claude quota check must not
 *  wait on a slow DeepSeek endpoint to answer. */
const BALANCE_TIMEOUT_MS = 3_000
/** How long a reading is trusted before the next survey re-checks. The balance moves only as fast as
 *  the zswarm spends it, so re-reading every survey call would be a network round trip for a number
 *  that is still correct to the cent. */
const BALANCE_CACHE_MS = 5 * 60_000

export interface DeepSeekBalance {
  status: 'ok' | 'unknown'
  balance_usd: number | null
  currency: string | null
  checked_at: string
  /** Why `status` is 'unknown' - a reason for a human to read, never the key itself. */
  reason?: string
}

let cached: DeepSeekBalance | null = null
let cachedAt = 0

/**
 * The DeepSeek API key, read the same way the zswarm itself resolves it: env `DEEPSEEK_API_KEY`
 * first, else `refs.DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml` (zswarm's `config.py`
 * `_read_yaml_key`, same file and field DSH itself writes into).
 *
 * ⛔ NOT A GENERAL YAML PARSER. The file is a flat `key: value` list under one `refs:` section - this
 * looks for exactly that line rather than pulling in a YAML dependency for one field. The value is
 * returned to the caller (the fetch below) and is NEVER logged, printed, or included in any error.
 */
export function readDeepSeekKey(
  credentialsPath: string = join(homedir(), '.dsh', '.credentials.yaml'),
): string | null {
  const envKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (envKey) return envKey
  let text: string
  try {
    text = readFileSync(credentialsPath, 'utf8')
  } catch {
    return null
  }
  let inRefs = false
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inRefs = line.trimEnd() === 'refs:'
    else if (inRefs) {
      const m = /^\s+DEEPSEEK_API_KEY:\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^['"]|['"]$/g, '')
    }
  }
  return null
}

/**
 * The account's live DeepSeek balance, cached for {@link BALANCE_CACHE_MS} and bounded to
 * {@link BALANCE_TIMEOUT_MS}. Every exit is `status: 'ok'` or `status: 'unknown'` - no key found, a
 * timeout, a non-200, or a body this cannot parse all degrade the same way. This function does not
 * throw and must never be the reason list_usage fails.
 */
export async function deepseekBalance(
  opts: { now?: number; credentialsPath?: string } = {},
): Promise<DeepSeekBalance> {
  const now = opts.now ?? Date.now()
  if (cached && now - cachedAt < BALANCE_CACHE_MS) return cached
  const key = readDeepSeekKey(opts.credentialsPath)
  if (!key) {
    const result: DeepSeekBalance = {
      status: 'unknown',
      balance_usd: null,
      currency: null,
      checked_at: new Date(now).toISOString(),
      reason: 'no DeepSeek API key found (env DEEPSEEK_API_KEY or ~/.dsh/.credentials.yaml)',
    }
    cached = result
    cachedAt = now
    return result
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
  let result: DeepSeekBalance
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`balance endpoint returned HTTP ${res.status}`)
    const body = (await res.json()) as {
      balance_infos?: Array<{ currency?: string; total_balance?: string }>
    }
    const info = body.balance_infos?.[0]
    const amount = info?.total_balance != null ? Number(info.total_balance) : Number.NaN
    result = Number.isFinite(amount)
      ? {
          status: 'ok',
          balance_usd: amount,
          currency: info?.currency ?? 'USD',
          checked_at: new Date(now).toISOString(),
        }
      : {
          status: 'unknown',
          balance_usd: null,
          currency: null,
          checked_at: new Date(now).toISOString(),
          reason: 'balance endpoint returned no usable figure',
        }
  } catch (err) {
    result = {
      status: 'unknown',
      balance_usd: null,
      currency: null,
      checked_at: new Date(now).toISOString(),
      reason: err instanceof Error ? err.message : 'balance check failed',
    }
  } finally {
    clearTimeout(timer)
  }
  cached = result
  cachedAt = now
  return result
}

/** Test-only: drop the cached balance so a test can force a fresh check instead of reading whatever
 *  an earlier test in the same process left behind. */
export function resetZswarmBalanceCache(): void {
  cached = null
  cachedAt = 0
}
