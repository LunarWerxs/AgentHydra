// Copies a SMALL working set of provider keys from HSwarm's key store into ReDesign's key pools, value-blind: the key
// values are read and posted inside this process only. Nothing here logs one, returns one, or puts one in an error;
// the answer is counts plus 8-character fingerprints (the same sha256 prefix HSwarm shows).
//
// HSwarm: <HSWARM_HOME or ~/.hswarm>/secrets/<provider>_api_keys (one key per line, # comments) is the live list;
//   <home>/keys.sqlite holds each key's state by fingerprint (disabled, broke, strikes, rest_until). A key is "ok"
//   when none of those is set and it is not resting.
// ReDesign: POST /api/keys/save { pool, key } adds one key to a pool (409 when it is already there); GET /api/keys
//   lists the pools with counts. Gemini Flash is what its image/HTML models use first, then Gemini Pro and Anthropic.

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** HSwarm list -> the ReDesign pools it feeds, and how many keys each pool is topped up to. */
export const KEY_PLAN: readonly { list: string; pools: readonly string[]; want: number }[] = [
  { list: 'gemini', pools: ['GEMINI_FLASH_API_KEYS', 'GEMINI_PRO_API_KEYS'], want: 5 },
  { list: 'anthropic', pools: ['ANTHROPIC_API_KEYS'], want: 3 },
  { list: 'mistral', pools: ['MISTRAL_API_KEYS'], want: 5 }
]

export interface PoolResult {
  pool: string
  /** Keys already in the pool before this run. */
  before: number
  /** Keys this run added. */
  added: number
  /** Fingerprints of the keys this run added. */
  fingerprints: string[]
}

export interface CopyResult {
  ok: boolean
  pools: PoolResult[]
  /** HSwarm keys that were ok and not resting, per list (counts only). */
  okInHswarm: Record<string, number>
  error?: string
}

export interface CopyOptions {
  redesignUrl: string
  /** HSwarm's home; default HSWARM_HOME or ~/.hswarm. */
  hswarmHome?: string
  fetchImpl?: typeof fetch
}

export const fingerprint = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 8)

/** The keys of one list, in a fixed order (by fingerprint) so a re-run picks the same ones. */
function readList(file: string): string[] {
  if (!existsSync(file)) return []
  const keys = new Set<string>()
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line && !line.startsWith('#') && !/[\s,]/.test(line)) keys.add(line)
  }
  return [...keys].sort((a, b) => fingerprint(a).localeCompare(fingerprint(b)))
}

/** Fingerprints HSwarm has parked: disabled, out of credit, struck, or resting. */
function parked(home: string): Set<string> {
  const out = new Set<string>()
  const file = join(home, 'keys.sqlite')
  if (!existsSync(file)) return out
  const db = new Database(file, { readonly: true })
  try {
    const now = Date.now() / 1000
    for (const row of db.query('SELECT fp, entry FROM keys').all() as { fp: string; entry: string }[]) {
      let e: Record<string, unknown>
      try {
        e = JSON.parse(row.entry) as Record<string, unknown>
      } catch {
        out.add(row.fp)
        continue
      }
      if (e.disabled || e.broke || e.strikes || Number(e.rest_until || 0) >= now) out.add(row.fp)
    }
  } finally {
    db.close()
  }
  return out
}

export async function copyHswarmKeys(opts: CopyOptions): Promise<CopyResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const base = opts.redesignUrl.replace(/\/+$/, '')
  const home = opts.hswarmHome || process.env.HSWARM_HOME?.trim() || join(homedir(), '.hswarm')
  const result: CopyResult = { ok: true, pools: [], okInHswarm: {} }
  const fail = (error: string): CopyResult => ({ ...result, ok: false, error })

  let poolTotals: Map<string, number>
  try {
    const res = await doFetch(`${base}/api/keys`)
    if (!res.ok) return fail(`ReDesign answered ${res.status} for its key pools`)
    const body = (await res.json()) as { pools?: { pool: string; total: number }[] }
    poolTotals = new Map((body.pools ?? []).map((p) => [p.pool, Number(p.total) || 0]))
  } catch {
    return fail('ReDesign is not answering')
  }

  let skip: Set<string>
  try {
    skip = parked(home)
  } catch {
    return fail("HSwarm's key state could not be read")
  }

  for (const plan of KEY_PLAN) {
    const ok = readList(join(home, 'secrets', `${plan.list}_api_keys`)).filter((k) => !skip.has(fingerprint(k)))
    result.okInHswarm[plan.list] = ok.length
    for (const pool of plan.pools) {
      if (!poolTotals.has(pool)) continue
      const before = poolTotals.get(pool) ?? 0
      const row: PoolResult = { pool, before, added: 0, fingerprints: [] }
      result.pools.push(row)
      for (const key of ok) {
        if (before + row.added >= plan.want) break
        let res: Response
        try {
          res = await doFetch(`${base}/api/keys/save`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pool, key })
          })
        } catch {
          return fail('ReDesign stopped answering while keys were added')
        }
        if (res.status === 409) continue // already in the pool
        if (!res.ok) break // this pool refuses keys; do not hammer it
        row.added++
        row.fingerprints.push(fingerprint(key))
      }
    }
  }
  return result
}
