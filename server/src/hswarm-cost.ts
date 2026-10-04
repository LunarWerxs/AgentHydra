// server/src/hswarm-cost.ts - HSwarm's spend, read out of its own ledger, plus the live balance of
// the DeepSeek account its key pays from.
//
// HSwarm (the hswarm/ package in this repo; MCP server `hswarm`) is the fleet's cheap fan-out tier.
// It journals one JSON line per TASK to `~/.hswarm/ledger.jsonl` (hswarm/config.py LEDGER) and one
// directory per JOB under `~/.hswarm/jobs/<id>/` (the session side of this is
// server/src/hswarm-sessions.ts). Nothing here writes either file - this is a reader, same posture
// as every other store AgentHydra reads. 2026-10-03: ZSwarm is retired and HSwarm replaces it; `hswarm
// import-zswarm` merged ZSwarm's ledger into HSwarm's, so its spend history reads from here too.
//
// THE BALANCE CALL, AND WHY IT NEVER THROWS. `GET https://api.deepseek.com/user/balance` needs a
// key, found in the order HSwarm itself finds its DeepSeek keys (readDeepSeekKey). list_usage calls
// deepseekBalance() on every survey, right beside the per-account Claude quota checks, so a slow or
// unreachable DeepSeek endpoint must never slow or fail a Claude quota read: short timeout, cached,
// and any failure degrades to `status: 'unknown'` - this function does not throw. ⛔ The key itself
// is read by this code at runtime and is never logged, printed, or returned.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { hswarmHome } from './hswarm'
import { hswarmArchivePaths } from './kit/ingest-hswarm'

/** One line of `~/.hswarm/ledger.jsonl` - one entry per TASK (a job is usually several). `cost_usd`,
 *  `in_hit`/`in_miss`/`out` and `reasoning` are null when the backend reports no accounting at all
 *  (the `dsh` backend: DeepSeek Harness headless keeps no cost data of its own). Narrowed to the
 *  fields this module actually aggregates; the ledger carries more (see the TODO this landed from). */
export interface HSwarmLedgerEntry {
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
 * The ledger is appended to live by every running HSwarm job, so the last line can be mid-write at
 * the moment we read it - the same reason dsh-sessions.ts's readDshLog and every other JSONL reader
 * in this codebase treats one bad line as a skip, not a throw.
 */
export function readHSwarmLedger(root: string = hswarmHome()): HSwarmLedgerEntry[] {
  const out: HSwarmLedgerEntry[] = []
  const add = (text: string) => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed)
        if (rec && typeof rec === 'object' && typeof rec.ts === 'string')
          out.push(rec as HSwarmLedgerEntry)
      } catch {
        // a torn final line, or a record from a newer HSwarm we cannot parse: skip it
      }
    }
  }
  // HSwarm moves each finished month into ledger-YYYYMM.jsonl.gz (hswarm/ledgerstore.py); this sums all time,
  // so every archive is read, oldest first, before the live file.
  for (const ap of hswarmArchivePaths(join(root, 'ledger.jsonl'))) {
    try {
      add(gunzipSync(readFileSync(ap)).toString('utf8'))
    } catch {
      // an archive being replaced right now: skipped for this read
    }
  }
  try {
    add(readFileSync(join(root, 'ledger.jsonl'), 'utf8'))
  } catch {
    // no live ledger yet
  }
  return out
}

// --- the DeepSeek account balance, cached and never throwing ------------------------------------

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** Hard cap on the request. list_usage runs this on every survey; a Claude quota check must not
 *  wait on a slow DeepSeek endpoint to answer. */
const BALANCE_TIMEOUT_MS = 3_000
/** How long a reading is trusted before the next survey re-checks. The balance moves only as fast as
 *  the swarm spends it, so re-reading every survey call would be a network round trip for a number
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

/** HSwarm's `DEEPSEEK_API_KEYS` form: several keys split on commas, semicolons or whitespace
 *  (hswarm/config.py _split_keys). */
const splitKeys = (value: string | undefined): string[] =>
  (value ?? '').split(/[,;\s]+/).filter(Boolean)

/** HSwarm's key files: one key per line, blank lines and `#` comments skipped (hswarm/config.py
 *  _read_key_lines). A missing or unreadable file is no keys. */
function keyLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * The DeepSeek API key, found where HSwarm finds its own (hswarm/config.py key_sources), so the
 * balance list_usage reports is the account the swarm spends from: the first of env
 * `DEEPSEEK_API_KEYS`, else env `DEEPSEEK_API_KEY`, else the first line of
 * `<HSwarm home>/secrets/deepseek_api_keys` (a key typed into HSwarm's own provider file is not read
 * here). Last, `refs.DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml`, DeepSeek Harness's file, which
 * this read before HSwarm replaced ZSwarm (2026-10-03).
 *
 * ⛔ NOT A GENERAL YAML PARSER. The file is a flat `key: value` list under one `refs:` section - this
 * looks for exactly that line rather than pulling in a YAML dependency for one field. The value is
 * returned to the caller (the fetch below) and is NEVER logged, printed, or included in any error.
 */
export function readDeepSeekKey(
  credentialsPath: string = join(homedir(), '.dsh', '.credentials.yaml'),
): string | null {
  const listed = splitKeys(process.env.DEEPSEEK_API_KEYS)[0]
  if (listed) return listed
  const envKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (envKey) return envKey
  const swarmKey = keyLines(join(hswarmHome(), 'secrets', 'deepseek_api_keys'))[0]
  if (swarmKey) return swarmKey
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
      reason:
        'no DeepSeek API key found (env DEEPSEEK_API_KEYS or DEEPSEEK_API_KEY, HSwarm secrets/deepseek_api_keys, or ~/.dsh/.credentials.yaml)',
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
export function resetHSwarmBalanceCache(): void {
  cached = null
  cachedAt = 0
}
