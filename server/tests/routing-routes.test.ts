// Cost routing routes: input validation (docs/COST-MODEL.md), and one plan size for both models.
import { afterAll, expect, test } from 'bun:test'
import { planFactor } from '../src/climayte-placement'
import { getSetting, setSetting } from '../src/db'
import { app } from '../src/http-app'
import { PLAN_SIZE } from '../src/plans'
import '../src/routes/routing'

const saved = getSetting('routing_api_preference_pct')
afterAll(() => setSetting('routing_api_preference_pct', saved))

const send = (method: string, path: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const decide = (api: unknown, listUsd: unknown = 1) =>
  send('POST', '/api/routing/decide', { key: 'k', listUsd, api, subscriptionRoom: true })

test('decide refuses an api.usd that is null, empty or negative, and accepts a numeric string', async () => {
  const api = (usd: unknown) => ({ provider: 'deepseek', model: 'm', usd })
  for (const usd of [null, '', -1, 'abc']) {
    const r = await decide(api(usd))
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toContain('api.usd')
  }
  expect((await decide(api('0.5'))).status).toBe(200)
})

test('decide treats a junk listUsd as no list cost', async () => {
  const r = await decide({ provider: 'deepseek', model: 'm', usd: 1 }, '')
  expect(r.status).toBe(200)
  expect(((await r.json()) as { subscriptionUsd: number | null }).subscriptionUsd).toBeNull()
})

test('PUT settings leaves a field alone when its value is junk, and names it', async () => {
  setSetting('routing_api_preference_pct', '37')
  const r = await send('PUT', '/api/routing/settings', { apiPreferencePct: false })
  expect(r.status).toBe(400)
  expect(((await r.json()) as { fields: string[] }).fields).toEqual(['apiPreferencePct'])
  expect(getSetting('routing_api_preference_pct')).toBe('37')
  const ok = await send('PUT', '/api/routing/settings', { apiPreferencePct: '250' })
  expect(ok.status).toBe(200)
  expect(getSetting('routing_api_preference_pct')).toBe('100')
})

test('planFactor and PLAN_SIZE agree', () => {
  expect(planFactor('Max 5×')).toBe(PLAN_SIZE['Max 5×'])
  expect(planFactor('Max 20×')).toBe(PLAN_SIZE['Max 20×'])
  expect(planFactor('Pro')).toBe(1)
  expect(planFactor('something else')).toBe(1)
  expect(planFactor('Max 5×')).toBe(4.75)
})
