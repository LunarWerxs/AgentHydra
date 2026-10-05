// GET /api/stats/home through the real server (plugins/10-bridge.ts, bridge/stats.ts): the home screen's stats
// card consolidated from AgentHydra's spend and activity reports, CliMayte's totals and HSwarm's stats.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type DeskServer } from '../../src/index'
import { deadUrl, type FakeHydra, startFakeHydra } from './fake-hydra'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '10-bridge.ts')
const DAY = 86_400_000
const temps: string[] = []
const servers: DeskServer[] = []
const fakes: FakeHydra[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const f of fakes.splice(0)) await f.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A desk server whose only plugin is the bridge, pointed at hydraUrl. */
async function boot(hydraUrl: string): Promise<DeskServer> {
  const home = mkdtempSync(join(tmpdir(), 'desk-stats-home-'))
  const plugins = mkdtempSync(join(tmpdir(), 'desk-stats-plugins-'))
  temps.push(home, plugins)
  writeFileSync(join(plugins, '10-bridge.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { hydraUrl } })
  servers.push(desk)
  return desk
}

async function call(desk: DeskServer, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(desk.url + path)
  return { status: res.status, body: await res.json() }
}

test('GET /api/stats/home consolidates every source AgentHydra counts, and reuses the answer for a minute', async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  const desk = await boot(f.url)

  const { status, body } = await call(desk, '/api/stats/home?range=7d')
  expect(status).toBe(200)
  // The four reads, each scoped to the range.
  expect(f.gets).toContain('/api/analytics/spend?period=7d')
  expect(f.gets).toContain('/api/analytics/activity?period=7d')
  expect(f.gets).toContain('/api/hswarm/api/stats?days=7')
  const totals = f.gets.find((g) => g.startsWith('/api/corch/totals?since='))!
  expect(Math.abs(Date.parse(decodeURIComponent(totals.split('since=')[1]!)) - (Date.now() - 7 * DAY))).toBeLessThan(60_000)

  expect(body).toMatchObject({
    range: '7d',
    sessions: 60,
    messages: 900,
    tokens: { input: 1_000_000, cacheRead: 40_000_000, cacheWrite: 2_000_000, output: 500_000, total: 43_500_000 },
    costUsd: 1234.5,
    pricesAsOf: '2026-10-01',
    // Today, two days ago and 250 days ago; the quiet day AgentHydra listed is not active.
    activeDays: 3,
    peakHour: '2 PM',
    favoriteModel: 'claude-opus-5-5',
    agentMinutes: 321,
    climayte: { tasks: 12, sessions: 20, costUsd: 400, limitHits: 2 },
    hswarm: { tasks: 77, savedUsd: 55.5 },
    coverage: { sessions: 50, total: 60, refreshing: true },
    missing: [],
  })
  // Most tokens first; a source the card does not know keeps its key.
  expect(body.sources).toEqual([
    { key: 'desktop', label: 'Claude desktop', sessions: 20, messages: 500, tokens: 30_000_000, costUsd: 800 },
    { key: 'climayte', label: 'CliMayte', sessions: 30, messages: 300, tokens: 10_000_000, costUsd: 400 },
    { key: 'newtool', label: 'newtool', sessions: 10, messages: 100, tokens: 3_500_000, costUsd: null },
  ])
  // A `rank:` row is a dispatch rank, not a model, however many sessions it carries.
  expect(body.models).toEqual([
    { key: 'claude-opus-5-5', sessions: 40 },
    { key: 'claude-sonnet-5-5', sessions: 15 },
    { key: 'gpt-6-astra', sessions: 5 },
  ])
  // 27 weeks ending today, against the busiest day: today's 500 turns are 4, two days ago's 200 are 2,
  // and the day 250 days back has no cell.
  expect(body.heat).toHaveLength(189)
  expect(body.heat.at(-1).level).toBe(4)
  expect(body.heat.at(-3).level).toBe(2)
  expect(body.heat.filter((cell: { level: number }) => cell.level > 0)).toHaveLength(2)
  // Each cell names its local day and its number, for the square's hover.
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  expect(body.heat.at(-1)).toMatchObject({ day: today, count: 500 })

  const spends = () => f.gets.filter((g) => g.startsWith('/api/analytics/spend')).length
  const before = spends()
  expect((await call(desk, '/api/stats/home?range=7d')).body).toEqual(body)
  expect(spends()).toBe(before)
  expect((await call(desk, '/api/stats/home?range=year')).status).toBe(400)

  // HSwarm's `total` is lifetime whatever `days` asked: the 7 day card above summed the days listed
  // (77 tasks, $55.50), and only All takes the lifetime total.
  const all = await call(desk, '/api/stats/home?range=all')
  expect(f.gets).toContain('/api/hswarm/api/stats?days=90')
  expect(all.body.hswarm).toEqual({ tasks: 500, savedUsd: 400 })
})

test('a source that fails is missing, not 0; a failed spend report or AgentHydra down is an error', async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  f.state.stats.hswarm = 'HSwarm is not running'
  const desk = await boot(f.url)

  const { status, body } = await call(desk, '/api/stats/home')
  expect(status).toBe(200)
  expect(f.gets).toContain('/api/hswarm/api/stats?days=90')
  expect(f.gets).toContain('/api/corch/totals')
  expect(body).toMatchObject({ range: 'all', sessions: 60, peakHour: '2 PM', climayte: { tasks: 12 }, hswarm: null })
  expect(body.missing).toEqual([{ part: 'hswarm', reason: expect.stringContaining('HSwarm is not running') }])

  // The spend report is the card: without it there is no answer, even though the rest answered.
  f.state.stats.spend = 'the store is locked'
  const broken = await call(desk, '/api/stats/home?range=30d')
  expect(broken.status).toBe(502)
  expect(broken.body.error).toContain('the store is locked')

  expect((await call(await boot(deadUrl()), '/api/stats/home')).status).toBe(503)
})
