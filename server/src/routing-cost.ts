// server/src/routing-cost.ts — where a piece of work is cheapest: an API key (HSwarm) or a Claude
// subscription (CliMayte). The numbers are measured on this install and fall back to the research
// figures of 2026-10-05 (docs/COST-MODEL.md) when there is too little data.

import { climayteTotals } from './climayte-totals'
import { listCliInstances } from './core/cli-instances'
import { db, getSetting } from './db'
import { PLAN_SIZE, PLANS, type Plan, planOf } from './plans'

export { PLAN_SIZE, PLANS, type Plan, planOf }
export const FALLBACK_DOLLARS_PER_PRO_WINDOW = 20.7
export const FALLBACK_WINDOWS_PER_WEEK: Record<Plan, number> = {
  Pro: 11.7,
  'Max 5×': 9.8,
  'Max 20×': 4.1,
}
export const DEFAULT_PLAN_PRICE: Record<Plan, number> = { Pro: 20, 'Max 5×': 100, 'Max 20×': 200 }
export const WEEKS_PER_MONTH = 4.33
export const MIN_MEASURED_PCT = 200
const MEASURE_DAYS = 14
const SAMPLE_DAYS = 21
const MIN_SESSION_POINTS = 40
const MAX_GAP_MS = 30 * 60_000
const RESET_TOLERANCE_MS = 15 * 60_000

// --- measured numbers ---------------------------------------------------------

export interface DollarsPerProWindow {
  value: number
  usedPct: number
  costUsd: number
  fellBack: boolean
}

/** Dollars of list-price work in one full Pro window, from CliMayte's own totals (the figures
 *  GET /api/corch/totals returns: costUsd and usedPct), last 14 days. */
export function measuredDollarsPerProWindow(now = Date.now()): DollarsPerProWindow {
  const t = climayteTotals(now - MEASURE_DAYS * 86_400_000)
  const ok = t.usedPct >= MIN_MEASURED_PCT && t.costUsd > 0
  return {
    value: ok ? t.costUsd / (t.usedPct / 100) : FALLBACK_DOLLARS_PER_PRO_WINDOW,
    usedPct: t.usedPct,
    costUsd: t.costUsd,
    fellBack: !ok,
  }
}

interface SampleRow {
  at_ms: number
  session_pct: number | null
  week_pct: number | null
  session_resets_at: string | null
  week_resets_at: string | null
}

const near = (a: string | null, b: string | null): boolean => {
  if (!a || !b) return a === b
  const x = Date.parse(a)
  const y = Date.parse(b)
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= RESET_TOLERANCE_MS
}

/** Week-% risen per session-% risen for one account, or null with under 40 session points. Only
 *  consecutive samples at most 30 min apart, in the same session window and the same week window
 *  (reset times within 15 min), count. */
export function weekPerSession(rows: SampleRow[]): number | null {
  const points = rows.filter((r) => r.session_pct !== null).length
  if (points < MIN_SESSION_POINTS) return null
  let session = 0
  let week = 0
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    if (b.at_ms - a.at_ms > MAX_GAP_MS) continue
    if (!near(a.session_resets_at, b.session_resets_at)) continue
    if (!near(a.week_resets_at, b.week_resets_at)) continue
    if (a.session_pct !== null && b.session_pct !== null)
      session += Math.max(0, b.session_pct - a.session_pct)
    if (a.week_pct !== null && b.week_pct !== null) week += Math.max(0, b.week_pct - a.week_pct)
  }
  return session > 0 ? week / session : null
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface WindowsPerWeek {
  value: number
  accounts: number
  fellBack: boolean
}

/** Pro windows' worth of each plan's own windows that fit in a week, from usage_samples. */
export function measuredWindowsPerWeek(
  accounts: Array<{ key: string; plan: Plan }>,
  now = Date.now(),
): Record<Plan, WindowsPerWeek> {
  const since = now - SAMPLE_DAYS * 86_400_000
  const ratios: Record<Plan, number[]> = { Pro: [], 'Max 5×': [], 'Max 20×': [] }
  for (const a of accounts) {
    const rows = db
      .query<SampleRow, [string, number]>(
        'select at_ms, session_pct, week_pct, session_resets_at, week_resets_at from usage_samples where key = ? and at_ms >= ? order by at_ms',
      )
      .all(a.key, since)
    const r = weekPerSession(rows)
    if (r !== null && r > 0) ratios[a.plan].push(r)
  }
  const out = {} as Record<Plan, WindowsPerWeek>
  for (const p of PLANS) {
    const n = ratios[p].length
    out[p] = n
      ? { value: 1 / median(ratios[p]), accounts: n, fellBack: false }
      : { value: FALLBACK_WINDOWS_PER_WEEK[p], accounts: 0, fellBack: true }
  }
  return out
}

// --- settings -----------------------------------------------------------------

export interface Discounts {
  anthropic: number
  deepseek: number
  openrouter: number
  other: number
}

export interface RoutingSettings {
  enabled: boolean
  apiPreferencePct: number
  closeRatio: number
  discounts: Discounts
  sessionOverheadPct: number
  planPrices: Record<Plan, number>
}

const num = (raw: string, d: number): number => {
  const n = raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) ? n : d
}
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

export function clampDiscounts(raw: unknown): Discounts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const one = (k: keyof Discounts) => {
    const n = Number(o[k])
    return Number.isFinite(n) ? clamp(n, 0, 100) : 0
  }
  return {
    anthropic: one('anthropic'),
    deepseek: one('deepseek'),
    openrouter: one('openrouter'),
    other: one('other'),
  }
}

export function readRoutingSettings(): RoutingSettings {
  let discounts: Discounts
  try {
    discounts = clampDiscounts(JSON.parse(getSetting('routing_discounts') || '{}'))
  } catch {
    discounts = clampDiscounts({})
  }
  const enabledRaw = getSetting('routing_enabled').trim().toLowerCase()
  return {
    enabled: !['0', 'false', 'off', 'no'].includes(enabledRaw),
    apiPreferencePct: clamp(num(getSetting('routing_api_preference_pct'), 60), 0, 100),
    closeRatio: Math.max(1, num(getSetting('routing_close_ratio'), 3)),
    discounts,
    sessionOverheadPct: clamp(num(getSetting('routing_session_overhead_pct'), 1), 0, 100),
    planPrices: {
      Pro: Math.max(0, num(getSetting('routing_price_pro'), DEFAULT_PLAN_PRICE.Pro)),
      'Max 5×': Math.max(0, num(getSetting('routing_price_max5'), DEFAULT_PLAN_PRICE['Max 5×'])),
      'Max 20×': Math.max(0, num(getSetting('routing_price_max20'), DEFAULT_PLAN_PRICE['Max 20×'])),
    },
  }
}

// --- fractions ----------------------------------------------------------------

/** What a subscription costs as a share of the same work at list price, at full use. */
export function effectiveFraction(
  price: number,
  windowsPerWeek: number,
  size: number,
  dollarsPerProWindow: number,
): number {
  return price / (windowsPerWeek * size * WEEKS_PER_MONTH * dollarsPerProWindow)
}

/** The plans' fractions weighted by how many signed-in CLI instances each plan has. */
export function weightedFleetFraction(
  fractions: Record<Plan, number>,
  counts: Record<Plan, number>,
): number {
  const total = PLANS.reduce((s, p) => s + counts[p], 0)
  if (total === 0) return fractions.Pro
  return PLANS.reduce((s, p) => s + fractions[p] * counts[p], 0) / total
}

export interface PlanRow {
  plan: Plan
  instances: number
  price: number
  windowsPerWeek: number
  windowsMeasuredFrom: number
  windowsFellBack: boolean
  sizeInProWindows: number
  effectiveFraction: number
  dollarsPerProWindow: number
}

export interface CostModel {
  dollarsPerProWindow: DollarsPerProWindow
  plans: PlanRow[]
  fleetFraction: number
  settings: RoutingSettings
}

export function costModel(now = Date.now()): CostModel {
  const settings = readRoutingSettings()
  const dpw = measuredDollarsPerProWindow(now)
  const instances = listCliInstances().filter((i) => i.loggedIn)
  const counts: Record<Plan, number> = { Pro: 0, 'Max 5×': 0, 'Max 20×': 0 }
  const accounts: Array<{ key: string; plan: Plan }> = []
  for (const i of instances) {
    const plan = planOf(i.planLabel)
    if (!plan) continue
    counts[plan]++
    accounts.push({ key: `cli:${i.id}`, plan })
  }
  const wpw = measuredWindowsPerWeek(accounts, now)
  const fractions = {} as Record<Plan, number>
  const plans = PLANS.map((plan): PlanRow => {
    const f = effectiveFraction(
      settings.planPrices[plan],
      wpw[plan].value,
      PLAN_SIZE[plan],
      dpw.value,
    )
    fractions[plan] = f
    return {
      plan,
      instances: counts[plan],
      price: settings.planPrices[plan],
      windowsPerWeek: wpw[plan].value,
      windowsMeasuredFrom: wpw[plan].accounts,
      windowsFellBack: wpw[plan].fellBack,
      sizeInProWindows: PLAN_SIZE[plan],
      effectiveFraction: f,
      dollarsPerProWindow: dpw.value,
    }
  })
  return {
    dollarsPerProWindow: dpw,
    plans,
    fleetFraction: weightedFleetFraction(fractions, counts),
    settings,
  }
}

// --- the table of models ------------------------------------------------------

export function providerGroup(provider: string): keyof Discounts {
  const p = provider.toLowerCase()
  if (p.includes('anthropic') || p.includes('claude')) return 'anthropic'
  if (p.includes('deepseek')) return 'deepseek'
  if (p.includes('openrouter')) return 'openrouter'
  return 'other'
}

// --- the decision -------------------------------------------------------------

export interface RoutingContext {
  enabled: boolean
  apiPreferencePct: number
  closeRatio: number
  discounts: Discounts
  sessionOverheadPct: number
  dollarsPerProWindow: number
  fleetFraction: number
}

export function currentContext(): RoutingContext {
  const m = costModel()
  return {
    enabled: m.settings.enabled,
    apiPreferencePct: m.settings.apiPreferencePct,
    closeRatio: m.settings.closeRatio,
    discounts: m.settings.discounts,
    sessionOverheadPct: m.settings.sessionOverheadPct,
    dollarsPerProWindow: m.dollarsPerProWindow.value,
    fleetFraction: m.fleetFraction,
  }
}

export interface RouteInput {
  key: string
  listUsd?: number | null
  api: { provider: string; model: string; usd: number } | null
  subscriptionRoom: boolean
}

export interface RouteDecision {
  route: 'api' | 'subscription'
  why: string
  apiUsd: number | null
  subscriptionUsd: number | null
  close: boolean
}

/** FNV-1a of the key, 0..99: the same key always lands on the same side of the split. */
export function bucketOf(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 100
}

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`

export function decideRoute(
  input: RouteInput,
  ctx: RoutingContext = currentContext(),
): RouteDecision {
  const hasList =
    typeof input.listUsd === 'number' && Number.isFinite(input.listUsd) && input.listUsd >= 0
  const apiUsd = input.api
    ? input.api.usd * (1 - (ctx.discounts[providerGroup(input.api.provider)] ?? 0) / 100)
    : null
  const subscriptionUsd = hasList
    ? (input.listUsd as number) * ctx.fleetFraction +
      (ctx.sessionOverheadPct / 100) * ctx.dollarsPerProWindow * ctx.fleetFraction
    : null
  const done = (route: 'api' | 'subscription', why: string, close = false): RouteDecision => ({
    route,
    why,
    apiUsd,
    subscriptionUsd,
    close,
  })
  if (!input.api)
    return done(
      'subscription',
      input.subscriptionRoom
        ? 'No API model fits, and a subscription has room.'
        : 'No API model fits and no subscription has room; sending it to the subscription queue.',
    )
  if (!ctx.enabled) return done('api', 'Cost routing is off, so work goes to the API.')
  if (!input.subscriptionRoom) return done('api', 'No subscription account has room right now.')
  if (subscriptionUsd === null)
    return done('api', 'No list cost to compare, so it goes to the API.')
  const api = apiUsd as number
  const hi = Math.max(api, subscriptionUsd)
  const lo = Math.min(api, subscriptionUsd)
  const close = hi === 0 || hi / lo <= ctx.closeRatio
  if (!close) {
    return api < subscriptionUsd
      ? done(
          'api',
          `The API (${usd(api)}) is more than ${ctx.closeRatio}x cheaper than the subscription (${usd(subscriptionUsd)}).`,
        )
      : done(
          'subscription',
          `The subscription (${usd(subscriptionUsd)}) is more than ${ctx.closeRatio}x cheaper than the API (${usd(api)}).`,
        )
  }
  const apiSide = bucketOf(input.key) < ctx.apiPreferencePct
  return done(
    apiSide ? 'api' : 'subscription',
    `Costs are close (API ${usd(api)}, subscription ${usd(subscriptionUsd)}); the ${ctx.apiPreferencePct}% API preference put this key on the ${apiSide ? 'API' : 'subscription'} side.`,
    true,
  )
}
