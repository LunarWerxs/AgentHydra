// Copies a SMALL working set of provider keys from HSwarm's key store into ReDesign's key pools, value-blind: the key
// values are read and posted inside this process only. Nothing here logs one, returns one, or puts one in an error;
// the answer is counts plus 8-character fingerprints (the same sha256 prefix HSwarm shows).
//
// HSwarm: <HSWARM_HOME or ~/.hswarm>/secrets/<provider>_api_keys (one key per line, # comments) is the live list;
//   <home>/keys.sqlite holds each key's state by fingerprint (disabled, broke, strikes, rest_until). A key is "ok"
//   when none of those is set and it is not resting.
// ReDesign: POST /api/keys/save { pool, key } adds one key to a pool (409 when it is already there); GET /api/keys
//   lists the pools with each key's last result. Only keys that work count toward a pool's target, and a key is copied
//   only after one tiny live request answers 200 (liveCheck): many HSwarm keys that are "ok" there are refused for quota
//   (429 "per minute for a region") on their very first request, and a pool of those makes every ReDesign run fail.

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** HSwarm list -> the ReDesign pools it feeds, and how many keys each pool is topped up to. */
export const KEY_PLAN: readonly { list: string; pools: readonly string[]; want: number }[] = [
  { list: 'gemini', pools: ['GEMINI_FLASH_API_KEYS', 'GEMINI_PRO_API_KEYS'], want: 6 },
  { list: 'anthropic', pools: ['ANTHROPIC_API_KEYS'], want: 3 },
  { list: 'mistral', pools: ['MISTRAL_API_KEYS'], want: 8 }
]

export interface PoolResult {
  pool: string
  /** Working keys already in the pool before this run (keys whose last answer was an error are not counted). */
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
  /** Live checks spent per list. */
  checked?: Record<string, number>
  /** Fingerprints of the keys whose live check failed in this call. */
  failed?: string[]
  error?: string
}

export interface CopyOptions {
  redesignUrl: string
  /** HSwarm's home; default HSWARM_HOME or ~/.hswarm. */
  hswarmHome?: string
  fetchImpl?: typeof fetch
  /** Whether one key of an HSwarm list answers a tiny request; default liveCheck. */
  checkKey?: (list: string, key: string) => Promise<boolean>
  /** Only these HSwarm lists (default: all of KEY_PLAN). */
  lists?: readonly string[]
  /** Fingerprints of keys whose live check failed a while ago: not tried again, so repeated top-ups walk further down a list instead of re-testing the same dead keys. */
  skip?: ReadonlySet<string>
}

/** Live checks spent per HSwarm list at most, so a list of dead keys cannot run on for minutes. */
export const CHECK_LIMIT = 60

/** One tiny request per provider (a few tokens at most); true only on a 200. */
export async function liveCheck(list: string, key: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  const json = { 'content-type': 'application/json' }
  const req: Record<string, [string, RequestInit]> = {
    gemini: ['https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', { method: 'POST', headers: { ...json, 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }) }],
    mistral: ['https://api.mistral.ai/v1/chat/completions', { method: 'POST', headers: { ...json, authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'mistral-small-latest', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) }],
    anthropic: ['https://api.anthropic.com/v1/messages', { method: 'POST', headers: { ...json, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) }]
  }
  const r = req[list]
  if (!r) return true
  try {
    const res = await doFetch(r[0], { ...r[1], signal: AbortSignal.timeout(15_000) })
    await res.body?.cancel()
    return res.status === 200
  } catch {
    return false
  }
}

interface PoolEntry {
  lastError?: string | null
  lastUsedAt?: number | null
  lastSuccessAt?: number | null
}

/** Keys of a pool that work: no error yet, or a success since their last use. A pool listed without entries: all of them. */
function workingKeys(p: { total: number; entries?: PoolEntry[] }): number {
  if (!p.entries) return Number(p.total) || 0
  return p.entries.filter((e) => !e.lastError || (e.lastSuccessAt != null && e.lastSuccessAt >= (e.lastUsedAt ?? 0))).length
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
    const body = (await res.json()) as { pools?: { pool: string; total: number; entries?: PoolEntry[] }[] }
    poolTotals = new Map((body.pools ?? []).map((p) => [p.pool, workingKeys(p)]))
  } catch {
    return fail('ReDesign is not answering')
  }

  let skip: Set<string>
  try {
    skip = parked(home)
  } catch {
    return fail("HSwarm's key state could not be read")
  }

  const check = opts.checkKey ?? ((list: string, key: string) => liveCheck(list, key, doFetch))
  for (const plan of KEY_PLAN) {
    if (opts.lists && !opts.lists.includes(plan.list)) continue
    const ok = readList(join(home, 'secrets', `${plan.list}_api_keys`)).filter((k) => !skip.has(fingerprint(k)) && !opts.skip?.has(fingerprint(k)))
    result.okInHswarm[plan.list] = ok.length
    const rows: PoolResult[] = plan.pools.filter((pool) => poolTotals.has(pool)).map((pool) => ({ pool, before: poolTotals.get(pool) ?? 0, added: 0, fingerprints: [] }))
    result.pools.push(...rows)
    let checks = 0
    for (const key of ok) {
      const open = rows.filter((row) => row.before + row.added < plan.want)
      if (!open.length || checks >= CHECK_LIMIT) break
      checks++
      if (!(await check(plan.list, key))) {
        result.failed = [...(result.failed ?? []), fingerprint(key)]
        continue
      }
      for (const row of open) {
        let res: Response
        try {
          res = await doFetch(`${base}/api/keys/save`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pool: row.pool, key })
          })
        } catch {
          return fail('ReDesign stopped answering while keys were added')
        }
        if (res.status === 409) continue // already in the pool
        if (!res.ok) {
          row.before = plan.want // this pool refuses keys; do not hammer it
          continue
        }
        row.added++
        row.fingerprints.push(fingerprint(key))
      }
    }
    result.checked = { ...result.checked, [plan.list]: checks }
  }
  return result
}
