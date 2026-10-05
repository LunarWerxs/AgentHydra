/**
 * Cost routing: /api/routing/cost-model, /api/routing/settings (PUT), /api/routing/decide (POST).
 * What the numbers mean and how the choice is made: docs/COST-MODEL.md.
 */

import { setSetting } from '../db'
import { app } from '../http-app'
import { pricedModelIds, priceFor, pricesAsOf } from '../pricing'
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
  const models = pricedModelIds()
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

const pct = (v: unknown): number | null => {
  const n = Number(v)
  return v === null || v === '' || !Number.isFinite(n) ? null : Math.min(100, Math.max(0, n))
}

app.put('/api/routing/settings', async (c) => {
  const b = await body(c)
  if (typeof b.enabled === 'boolean') setSetting('routing_enabled', b.enabled ? '1' : '0')
  const pref = pct(b.apiPreferencePct)
  if (pref !== null) setSetting('routing_api_preference_pct', String(pref))
  const overhead = pct(b.sessionOverheadPct)
  if (overhead !== null) setSetting('routing_session_overhead_pct', String(overhead))
  const ratio = Number(b.closeRatio)
  if (b.closeRatio !== undefined && Number.isFinite(ratio))
    setSetting('routing_close_ratio', String(Math.max(1, ratio)))
  if (b.discounts && typeof b.discounts === 'object') {
    const next = { ...readRoutingSettings().discounts, ...(b.discounts as object) }
    setSetting('routing_discounts', JSON.stringify(clampDiscounts(next)))
  }
  if (b.planPrices && typeof b.planPrices === 'object') {
    const p = b.planPrices as Record<string, unknown>
    for (const [field, key] of [
      ['Pro', 'routing_price_pro'],
      ['Max 5×', 'routing_price_max5'],
      ['Max 20×', 'routing_price_max20'],
    ] as const) {
      const n = Number(p[field])
      if (p[field] !== undefined && Number.isFinite(n)) setSetting(key, String(Math.max(0, n)))
    }
  }
  return c.json(readRoutingSettings())
})

app.post('/api/routing/decide', async (c) => {
  const b = await body(c)
  if (typeof b.key !== 'string' || !b.key) return c.json({ error: 'key is required' }, 400)
  let api: { provider: string; model: string; usd: number } | null = null
  if (b.api !== null && b.api !== undefined) {
    const a = b.api as Record<string, unknown>
    if (
      typeof a.provider !== 'string' ||
      typeof a.model !== 'string' ||
      !Number.isFinite(Number(a.usd))
    )
      return c.json({ error: 'api must be null or { provider, model, usd }' }, 400)
    api = { provider: a.provider, model: a.model, usd: Number(a.usd) }
  }
  const listUsd = b.listUsd === null || b.listUsd === undefined ? null : Number(b.listUsd)
  return c.json(
    decideRoute(
      {
        key: b.key,
        listUsd: Number.isFinite(listUsd) ? listUsd : null,
        api,
        subscriptionRoom: b.subscriptionRoom === true,
      },
      currentContext(),
    ),
  )
})
