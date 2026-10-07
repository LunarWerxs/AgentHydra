/**
 * Cost routing: /api/routing/cost-model, /api/routing/settings (PUT), /api/routing/decide (POST).
 * What the numbers mean and how the choice is made: docs/COST-MODEL.md.
 */

import priceFile from '../../../hswarm/data/prices.json'
import { climaytePickModel } from '../climayte'
import { type CliMayteKind, climayteKind } from '../climayte-scorecard'
import { setSetting } from '../db'
import { app } from '../http-app'
import { priceFor, pricesAsOf, priceTokens } from '../pricing'
import {
  clampDiscounts,
  costModel,
  currentContext,
  decideRoute,
  providerGroup,
  readRoutingSettings,
} from '../routing-cost'

async function body(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null)
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d

app.get('/api/routing/cost-model', (c) => {
  const m = costModel()
  // Ids only from the price file; every rate comes through pricing.ts (a downloaded catalog wins there).
  const models = Object.keys(priceFile.models)
    .sort()
    .filter((id) => /^(claude|deepseek)/.test(id))
    .flatMap((id) => {
      const p = priceFor(id)
      if (!p) return []
      const provider = id.startsWith('claude') ? 'anthropic' : 'deepseek'
      const d = m.settings.discounts[providerGroup(provider)]
      return [
        {
          model: id,
          provider,
          listIn: p.input,
          listOut: p.output,
          afterDiscountIn: round(p.input * (1 - d / 100)),
          afterDiscountOut: round(p.output * (1 - d / 100)),
          subscriptionIn: round(p.input * m.fleetFraction),
          subscriptionOut: round(p.output * m.fleetFraction),
        },
      ]
    })
  return c.json({
    dollarsPerProWindow: m.dollarsPerProWindow,
    plans: m.plans,
    fleetFraction: m.fleetFraction,
    models,
    pricesAsOf: pricesAsOf(),
    settings: m.settings,
  })
})

/** A finite number from a number or a numeric string; anything else (boolean, array, null, '') is junk. */
const numeric = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const clampTo = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

app.put('/api/routing/settings', async (c) => {
  const b = await body(c)
  const bad: string[] = []
  const writes: Array<[string, string]> = []
  /** One numeric field: absent leaves it alone, junk is named in the 400, a number is clamped. */
  const field = (name: string, key: string, lo: number, hi: number) => {
    const v = b[name]
    if (v === undefined) return
    const n = numeric(v)
    if (n === null) bad.push(name)
    else writes.push([key, String(clampTo(n, lo, hi))])
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled === 'boolean') writes.push(['routing_enabled', b.enabled ? '1' : '0'])
    else bad.push('enabled')
  }
  field('apiPreferencePct', 'routing_api_preference_pct', 0, 100)
  field('sessionOverheadPct', 'routing_session_overhead_pct', 0, 100)
  field('closeRatio', 'routing_close_ratio', 1, 100)
  if (b.discounts !== undefined) {
    if (b.discounts && typeof b.discounts === 'object' && !Array.isArray(b.discounts)) {
      const d = b.discounts as Record<string, unknown>
      const next: Record<string, unknown> = { ...readRoutingSettings().discounts }
      for (const k of Object.keys(next)) {
        if (d[k] === undefined) continue
        const n = numeric(d[k])
        if (n === null) bad.push(`discounts.${k}`)
        else next[k] = n
      }
      writes.push(['routing_discounts', JSON.stringify(clampDiscounts(next))])
    } else bad.push('discounts')
  }
  if (b.planPrices !== undefined) {
    if (b.planPrices && typeof b.planPrices === 'object' && !Array.isArray(b.planPrices)) {
      const p = b.planPrices as Record<string, unknown>
      for (const [name, key] of [
        ['Pro', 'routing_price_pro'],
        ['Max 5×', 'routing_price_max5'],
        ['Max 20×', 'routing_price_max20'],
      ] as const) {
        if (p[name] === undefined) continue
        const n = numeric(p[name])
        if (n === null) bad.push(`planPrices.${name}`)
        else writes.push([key, String(clampTo(n, 0, 10_000))])
      }
    } else bad.push('planPrices')
  }
  // Good fields are stored even when others are junk; the 400 names only the junk.
  for (const [key, value] of writes) setSetting(key, value)
  if (bad.length) return c.json({ error: `invalid value for: ${bad.join(', ')}`, fields: bad }, 400)
  return c.json(readRoutingSettings())
})

app.post('/api/routing/decide', async (c) => {
  const b = await body(c)
  if (typeof b.key !== 'string' || !b.key) return c.json({ error: 'key is required' }, 400)
  let api: { provider: string; model: string; usd: number } | null = null
  if (b.api !== null && b.api !== undefined) {
    const a = b.api as Record<string, unknown>
    if (
      !a ||
      typeof a !== 'object' ||
      typeof a.provider !== 'string' ||
      typeof a.model !== 'string'
    )
      return c.json({ error: 'api must be null or { provider, model, usd }' }, 400)
    const usd = numeric(a.usd)
    if (usd === null || usd < 0)
      return c.json({ error: 'api.usd must be a finite number >= 0' }, 400)
    api = { provider: a.provider, model: a.model, usd }
  }
  let list = numeric(b.listUsd)
  // Work on a signed-in account costs the plan's share of what the model CliMayte runs it on lists at (owner,
  // 2026-10-07): a caller that names the task's kind and size gets that model priced here, not its own guess.
  let subscriptionModel: string | null = null
  if (b.kind !== undefined) {
    let kind: CliMayteKind | null
    try {
      kind = climayteKind(b.kind)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }
    const t = (b.tokens && typeof b.tokens === 'object' ? b.tokens : {}) as Record<string, unknown>
    const input = numeric(t.input)
    const output = numeric(t.output)
    if (!kind || input === null || output === null || input < 0 || output < 0)
      return c.json({ error: 'kind needs tokens: { input, output }, numbers >= 0' }, 400)
    subscriptionModel = climaytePickModel(kind)
    const none = { cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 }
    list = priceTokens(
      { [subscriptionModel]: { input, output, ...none } },
      Date.now(),
      input,
    ).costUsd
  }
  const decision = decideRoute(
    {
      key: b.key,
      listUsd: list !== null && list >= 0 ? list : null,
      api,
      subscriptionRoom: b.subscriptionRoom === true,
    },
    currentContext(),
  )
  return c.json({ ...decision, subscriptionModel })
})
