// Which ReDesign models a design_options run should ask, and how to replace a job that failed. Pure functions plus a tiny
// health file; redesign-mcp.ts does the HTTP. ReDesign itself allows several jobs per model: POST /api/run takes
// modelQuantities { model: n } (n variants of that model) and one custom prompt per run, so a second instance of a model
// with a different style hint goes into a second run.
//
// Why a plan at all: one job per distinct model made a run return fewer options than asked as soon as one provider failed
// (Anthropic replies cut off after ~70-90 s because ReDesign does not stream, Gemini keys hit the per-minute limit, Gemini
// Pro answers RECITATION sometimes). Models are ranked by what their key pool and our own recent results say, and the
// run takes the best ones, repeating a model (with another style hint) when fewer than `count` distinct ones work.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { KEY_PLAN } from './redesign-keys'

export interface KeyEntry {
  cooldownUntil?: number | null
  lastError?: string | null
  lastUsedAt?: number | null
  lastSuccessAt?: number | null
  availableNow?: boolean
}

export interface KeyPool {
  pool: string
  available: number
  entries?: KeyEntry[]
}

export interface ModelInfo {
  id: string
  label?: string
  keyEnv?: string
  vision?: boolean
  enabled?: boolean
  starred?: boolean
}

/** What we remember of a model between runs: when it last made an option and when it last failed (with the reason). */
export type Health = Record<string, { okAt?: number; failAt?: number; why?: string }>

export interface Ranked {
  model: ModelInfo
  pool: string
  /** Keys in the pool that are not cooling down and whose last word was not an error. */
  working: number
  /** 0 recent success, 1 untried, 2 failed lately, 3 pool failing or cut off (last resort). */
  tier: 0 | 1 | 2 | 3
}

const HOUR = 3_600_000
/** A success this recent makes a model "known good"; a failure this recent (and no later success) parks it. */
export const GOOD_WINDOW_MS = 6 * HOUR
export const BAD_WINDOW_MS = 20 * 60_000
/** Working keys a pool we rely on should hold before a run; fewer triggers the HSwarm top-up. */
export const MIN_WORKING_KEYS = 6

const goodEntry = (e: KeyEntry) => !e.lastError || (e.lastSuccessAt != null && e.lastSuccessAt >= (e.lastUsedAt ?? 0))

export function workingNow(p: KeyPool | undefined, now = Date.now()): number {
  const entries = p?.entries
  if (!entries) return p?.available ?? 0
  return entries.filter((e) => goodEntry(e) && !((e.cooldownUntil ?? 0) > now)).length
}

const CUT_OFF = /socket connection was closed|connection (was )?(closed|reset)|terminated/i

/** The provider cut the connection off (ReDesign does not stream, so a long reply is dropped): a key's error says so and no key has worked since. */
export function poolCutOff(p: KeyPool | undefined, now = Date.now()): boolean {
  const entries = p?.entries ?? []
  const cuts = entries.filter((e) => CUT_OFF.test(e.lastError ?? ''))
  if (!cuts.length) return false
  const at = Math.max(...cuts.map((e) => e.lastUsedAt ?? 0))
  if (at && now - at > GOOD_WINDOW_MS) return false
  return !entries.some((e) => (e.lastSuccessAt ?? 0) > at)
}

/** Models a run may use, best first. `blocked` (failed in this very call) is dropped; models of a pool with no key are not candidates at all. */
export function rankModels(models: ModelInfo[], pools: KeyPool[], health: Health = {}, blocked: ReadonlySet<string> = new Set(), now = Date.now()): Ranked[] {
  const byPool = new Map(pools.map((p) => [p.pool, p]))
  const out: Ranked[] = []
  for (const m of models) {
    if (m.enabled === false || m.vision === false || !m.keyEnv || blocked.has(m.id)) continue
    const p = byPool.get(m.keyEnv)
    if ((p?.available ?? 0) <= 0) continue
    const working = workingNow(p, now)
    const mem = health[m.id]
    const failedLately = mem?.failAt != null && now - mem.failAt < BAD_WINDOW_MS && (mem.okAt ?? 0) < mem.failAt
    const poolOk = (p?.entries ?? []).some((e) => (e.lastSuccessAt ?? 0) > now - GOOD_WINDOW_MS)
    const okLately = mem?.okAt != null && now - mem.okAt < GOOD_WINDOW_MS
    let tier: Ranked['tier']
    const cutBefore = mem?.why === 'cutoff' && mem.failAt != null && now - mem.failAt < GOOD_WINDOW_MS && (mem.okAt ?? 0) < mem.failAt
    if (working <= 0 || poolCutOff(p, now) || cutBefore) tier = 3
    else if (failedLately) tier = 2
    else if (okLately || poolOk) tier = 0
    else tier = 1
    out.push({ model: m, pool: m.keyEnv, working, tier })
  }
  const rank = (r: Ranked) => [r.tier, -(health[r.model.id]?.okAt ?? 0), -r.working, r.model.starred ? 0 : 1]
  return out.sort((a, b) => {
    const x = rank(a)
    const y = rank(b)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
    return 0
  })
}

/**
 * `want` model ids for the next jobs. Only the best tier that has anything is used (replacements pass `maxTier` 1 so a
 * failing provider is never retried blindly). Each pick is the model with the fewest jobs so far (`load`), staying under
 * what its pool can serve at once (working keys, at least 2) while another model has room; when every model is full the
 * best ones are repeated, because fewer options than asked is worse than a repeat.
 */
export function planJobs(ranked: Ranked[], want: number, load: ReadonlyMap<string, number> = new Map(), maxTier: 0 | 1 | 2 | 3 = 3): string[] {
  const tier = Math.min(...ranked.filter((r) => r.tier <= maxTier).map((r) => r.tier))
  const pick = ranked.filter((r) => r.tier <= maxTier && (tier <= 1 ? r.tier <= 1 : r.tier === tier))
  if (!pick.length) return []
  const jobs = new Map(load)
  const inPool = (pool: string) => pick.filter((r) => r.pool === pool).reduce((n, r) => n + (jobs.get(r.model.id) ?? 0), 0)
  const out: string[] = []
  for (let i = 0; i < want; i++) {
    const room = pick.filter((r) => inPool(r.pool) < Math.max(2, r.working))
    const from = room.length ? room : pick
    let best = from[0] as Ranked
    for (const r of from) if ((jobs.get(r.model.id) ?? 0) < (jobs.get(best.model.id) ?? 0)) best = r
    out.push(best.model.id)
    jobs.set(best.model.id, (jobs.get(best.model.id) ?? 0) + 1)
  }
  return out
}

/** A different design direction per instance of the same model, so repeats are not near-copies. Instance 0 is the brief as written. */
const STYLE_HINTS = [
  '',
  'Take a clearly different direction from the obvious one: change the layout structure, not only the colours.',
  'Make this one denser and more utilitarian: tighter spacing, compact controls, a strong information hierarchy.',
  'Make this one calmer and more spacious: generous whitespace, soft contrast, fewer visual elements.',
  'Make this one bolder: strong colour accents, a confident type scale, distinctive component shapes.',
  'Make this one editorial: type-led, a restrained palette, a clear grid.'
]

export function styledBrief(brief: string, instance: number): string {
  const hint = STYLE_HINTS[instance % STYLE_HINTS.length] as string
  return hint ? `${brief}\n\nStyle direction for this option: ${hint}` : brief
}

/** Why a job failed, in the one way that decides what to do next. */
export function failureKind(error: string | null | undefined): 'cutoff' | 'stalled' | 'recitation' | 'cooling' | 'quota' | 'other' {
  const e = error ?? ''
  if (/socket connection was closed|connection (was )?(closed|reset)/i.test(e)) return 'cutoff'
  if (/no answer within/i.test(e)) return 'stalled'
  if (/RECITATION|empty response|SAFETY|blocked/i.test(e)) return 'recitation'
  if (/cooling down/i.test(e)) return 'cooling'
  if (/429|quota|rate limit/i.test(e)) return 'quota'
  return 'other'
}

/** The HSwarm lists to top up: pools a planned model reads from that hold fewer than `min` working keys and that HSwarm can feed. */
export function listsToRefill(ranked: Ranked[], planned: readonly string[], pools: KeyPool[], min = MIN_WORKING_KEYS, now = Date.now()): string[] {
  const byPool = new Map(pools.map((p) => [p.pool, p]))
  const used = new Set(ranked.filter((r) => planned.includes(r.model.id)).map((r) => r.pool))
  const lists = new Set<string>()
  for (const plan of KEY_PLAN) {
    for (const pool of plan.pools) {
      if (!used.has(pool)) continue
      const p = byPool.get(pool)
      if (poolCutOff(p, now)) continue
      if (workingNow(p, now) < min) lists.add(plan.list)
    }
  }
  return [...lists]
}

export function loadHealth(file: string): Health {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Health) : {}
  } catch {
    return {}
  }
}

export function saveHealth(file: string, health: Health): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(health))
  } catch {
    // remembering is a nicety; a run never fails over it
  }
}
