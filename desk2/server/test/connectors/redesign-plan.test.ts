import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRedesignMcp } from '../../src/connectors/redesign-mcp'
import { failureKind, listsToRefill, planJobs, poolCutOff, rankModels, styledBrief, workingNow, type Health, type KeyEntry, type KeyPool, type ModelInfo } from '../../src/connectors/redesign-plan'

const NOW = 1_800_000_000_000
const good = (n: number, extra: Partial<KeyEntry> = {}): KeyEntry[] => Array.from({ length: n }, () => ({ lastError: null, lastUsedAt: NOW - 1000, lastSuccessAt: NOW - 500, ...extra }))
const model = (id: string, keyEnv: string, starred = false): ModelInfo => ({ id, label: id, keyEnv, vision: true, enabled: true, starred })
const pool = (name: string, entries: KeyEntry[]): KeyPool => ({ pool: name, available: entries.length, entries })
const socketCut: KeyEntry = { lastError: 'network error: The socket connection was closed unexpectedly.', lastUsedAt: NOW - 1000, lastSuccessAt: NOW - 90_000_000 }

describe('model plan', () => {
  const models = [model('claude', 'ANTHROPIC_API_KEYS', true), model('flash', 'GEMINI_FLASH_API_KEYS'), model('pro', 'GEMINI_PRO_API_KEYS', true), model('medium', 'MISTRAL_API_KEYS'), model('small', 'MISTRAL_API_KEYS')]
  const pools = [pool('ANTHROPIC_API_KEYS', [socketCut, socketCut]), pool('GEMINI_FLASH_API_KEYS', good(4)), pool('GEMINI_PRO_API_KEYS', good(4)), pool('MISTRAL_API_KEYS', good(6))]

  test('a pool whose newest error is the socket cut-off is skipped; a later success clears it; an old cut-off is forgotten', () => {
    expect(poolCutOff(pool('A', [socketCut, socketCut]), NOW)).toBe(true)
    expect(poolCutOff(pool('A', [socketCut, { lastError: null, lastUsedAt: NOW - 10, lastSuccessAt: NOW - 5 }]), NOW)).toBe(false)
    expect(poolCutOff(pool('A', [{ ...socketCut, lastUsedAt: NOW - 7 * 3_600_000 }]), NOW)).toBe(false)
    const ranked = rankModels(models, pools, {}, new Set(), NOW)
    expect(ranked.find((r) => r.model.id === 'claude')?.tier).toBe(3)
    expect(planJobs(ranked, 6)).not.toContain('claude')
  })

  test('cooling keys do not count as working; failing keys neither', () => {
    const entries = [...good(2), { lastError: 'HTTP 429', lastUsedAt: 5, lastSuccessAt: null }, { ...good(1)[0], cooldownUntil: NOW + 60_000 }] as KeyEntry[]
    expect(workingNow(pool('P', entries), NOW)).toBe(2)
  })

  test('count 4 with 3 working models and a dead Claude: four jobs, no model carries them alone, a model repeats only after the others', () => {
    const ranked = rankModels(models, pools, { flash: { okAt: NOW - 1000 }, medium: { okAt: NOW - 2000 } }, new Set(), NOW)
    const jobs = planJobs(ranked, 4)
    expect(jobs).toHaveLength(4)
    expect(new Set(jobs).size).toBeGreaterThanOrEqual(3)
    expect(jobs.filter((j) => j === 'flash' || j === 'pro' || j === 'medium' || j === 'small').length).toBe(4)
    // known-good models (a recent success) come before untried ones
    expect(jobs.slice(0, 2).sort()).toEqual(['flash', 'medium'])
  })

  test('with only one working model the run still asks for `count` jobs, all on it', () => {
    const only = rankModels([model('medium', 'MISTRAL_API_KEYS')], [pool('MISTRAL_API_KEYS', good(3))], {}, new Set(), NOW)
    expect(planJobs(only, 4)).toEqual(['medium', 'medium', 'medium', 'medium'])
  })

  test('a model that failed lately sinks below untried ones, and replacements (maxTier 1) never use it', () => {
    const health: Health = { flash: { failAt: NOW - 1000, why: 'recitation' }, medium: { okAt: NOW - 100 } }
    const ranked = rankModels(models, pools, health, new Set(), NOW)
    expect(ranked.find((r) => r.model.id === 'flash')?.tier).toBe(2)
    expect(planJobs(ranked, 6, new Map(), 1)).not.toContain('flash')
    // a blocked model is gone entirely, and nothing usable left plans nothing
    expect(planJobs(rankModels(models, pools, health, new Set(['pro', 'medium', 'small', 'flash', 'claude']), NOW), 2, new Map(), 1)).toEqual([])
  })

  test('replacements spread by load: a model that already ran twice is picked after one that ran once', () => {
    const ranked = rankModels([model('medium', 'MISTRAL_API_KEYS'), model('flash', 'GEMINI_FLASH_API_KEYS')], [pool('MISTRAL_API_KEYS', good(6)), pool('GEMINI_FLASH_API_KEYS', good(6))], {}, new Set(), NOW)
    expect(planJobs(ranked, 1, new Map([['medium', 2], ['flash', 1]]), 1)).toEqual(['flash'])
  })

  test('failureKind and the style hint of a repeat', () => {
    expect(failureKind('network error: The socket connection was closed unexpectedly')).toBe('cutoff')
    expect(failureKind('empty response (finishReason=RECITATION)')).toBe('recitation')
    expect(failureKind('all keys cooling down (GEMINI_FLASH_API_KEYS)')).toBe('cooling')
    expect(failureKind('HTTP 429: quota')).toBe('quota')
    expect(failureKind('no answer within 140 s')).toBe('stalled')
    expect(styledBrief('a page', 0)).toBe('a page')
    expect(styledBrief('a page', 1)).not.toBe(styledBrief('a page', 2))
    expect(styledBrief('a page', 1)).toStartWith('a page')
  })
})

describe('key refill choice', () => {
  const models = [model('flash', 'GEMINI_FLASH_API_KEYS'), model('medium', 'MISTRAL_API_KEYS'), model('claude', 'ANTHROPIC_API_KEYS')]
  test('pools we rely on with fewer than 6 working keys are topped up; full, unplanned and cut-off pools are not', () => {
    const pools = [pool('GEMINI_FLASH_API_KEYS', good(6)), pool('MISTRAL_API_KEYS', good(3)), pool('ANTHROPIC_API_KEYS', [socketCut])]
    const ranked = rankModels(models, pools, {}, new Set(), NOW)
    expect(listsToRefill(ranked, ['flash', 'medium', 'claude'], pools, 6, NOW)).toEqual(['mistral'])
    expect(listsToRefill(ranked, ['flash'], pools, 6, NOW)).toEqual([])
    const thin = [pool('GEMINI_FLASH_API_KEYS', good(2)), pool('MISTRAL_API_KEYS', [...good(5), { lastError: 'bad', lastUsedAt: 9, lastSuccessAt: null }]), pool('ANTHROPIC_API_KEYS', [socketCut])]
    expect(listsToRefill(rankModels(models, thin, {}, new Set(), NOW), ['flash', 'medium', 'claude'], thin, 6, NOW).sort()).toEqual(['gemini', 'mistral'])
  })
})

/** A stand-in for ReDesign: runs finish at once; a model listed in `bad` fails with that error, one in `hang` never finishes. */
function fake(opts: { pools: KeyPool[]; models: ModelInfo[]; bad?: Record<string, string>; hang?: string[] }) {
  const runs: { models: string[]; prompt: string }[] = []
  const cancelled: string[] = []
  let refilled = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/api/bootstrap') return Response.json({ models: opts.models, keys: { pools: refilled ? opts.pools.map((p) => ({ ...p, entries: good(8) })) : opts.pools } })
      if (u.pathname === '/api/inputs/upload') return Response.json({ addedIds: ['in-1'] })
      if (u.pathname === '/api/run') {
        const b = (await req.json()) as { models: string[]; prompts: { custom: string } }
        runs.push({ models: b.models, prompt: b.prompts.custom })
        return Response.json({ runId: `run-${runs.length}` })
      }
      const cancel = /^\/api\/runs\/(run-\d+)\/cancel$/.exec(u.pathname)
      if (cancel) {
        cancelled.push(cancel[1] as string)
        return Response.json({ ok: true })
      }
      const run = /^\/api\/runs\/run-(\d+)$/.exec(u.pathname)
      if (run) {
        const r = runs[Number(run[1]) - 1] as { models: string[] }
        const jobs = r.models.map((m, n) => {
          const id = `j${run[1]}-${n}`
          if (opts.hang?.includes(m)) return { id, status: 'running', modelId: m }
          if (opts.bad?.[m]) return { id, status: 'error', modelId: m, error: opts.bad[m] }
          return { id, status: 'ok', modelId: m, file: `run-${run[1]}/o${n}.html` }
        })
        return Response.json({ status: jobs.some((j) => j.status === 'running') ? 'running' : 'done', jobs })
      }
      if (u.pathname.startsWith('/output-raw/')) return Response.json({ caption: 'a layout' })
      if (u.pathname === '/api/output/screenshot') return new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } })
      return Response.json({}, { status: 404 })
    }
  })
  return { server, runs, cancelled, url: `http://127.0.0.1:${server.port}`, markRefilled: () => void refilled++ }
}

const call = async (mcp: ReturnType<typeof createRedesignMcp>, args: Record<string, unknown>) => {
  const res = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'design_options', arguments: args } })) as { result: { isError?: boolean; content: { text: string }[] } }
  const text = res.result.content[0]?.text ?? ''
  return { isError: res.result.isError === true, text, data: text.includes('{') ? (JSON.parse(text.slice(text.indexOf('\n\n') + 2)) as { run: string; note?: string; options: { model: string; image: string }[] }) : null }
}

describe('design_options returns `count` options', () => {
  const dirs: string[] = []
  const servers: { stop: (f: boolean) => void }[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const outDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'redesign-plan-'))
    dirs.push(d)
    return d
  }
  const models = [model('flash', 'GEMINI_FLASH_API_KEYS'), model('medium', 'MISTRAL_API_KEYS'), model('small', 'MISTRAL_API_KEYS'), model('claude', 'ANTHROPIC_API_KEYS', true)]
  const pools = (mistral = 8) => [pool('GEMINI_FLASH_API_KEYS', good(6)), pool('MISTRAL_API_KEYS', good(mistral)), pool('ANTHROPIC_API_KEYS', [socketCut])]

  test('jobs that fail are replaced on other working models until count options exist; Claude behind a cut-off is never asked', async () => {
    const f = fake({ pools: pools(), models, bad: { flash: 'empty response (finishReason=RECITATION)' } })
    servers.push(f.server)
    const res = await call(createRedesignMcp({ baseUrl: f.url, outDir: outDir(), pollMs: 2 }), { brief: 'a settings page', count: 4 })
    expect(res.isError).toBe(false)
    expect(res.data?.options).toHaveLength(4)
    expect(res.data?.options.every((o) => o.model !== 'flash' && o.model !== 'claude')).toBe(true)
    const asked = f.runs.flatMap((r) => r.models)
    expect(asked).not.toContain('claude')
    expect(asked.filter((m) => m === 'flash')).toHaveLength(1) // blocked after its first failure
    expect(f.runs.length).toBeGreaterThan(1)
    expect(new Set(f.runs.map((r) => r.prompt)).size).toBeGreaterThan(1) // repeats of a model carry another style hint
    expect(res.text).toContain('requested')
  })

  test('when the time budget ends the call returns what it has, says what is missing, and cancels what still runs', async () => {
    const f = fake({ pools: pools(), models: [model('flash', 'GEMINI_FLASH_API_KEYS'), model('medium', 'MISTRAL_API_KEYS')], hang: ['flash'] })
    servers.push(f.server)
    const res = await call(createRedesignMcp({ baseUrl: f.url, outDir: outDir(), pollMs: 2, budgetMs: 60, graceMs: 0, minStartMs: 0 }), { brief: 'x', count: 4 })
    expect(res.data?.options.length).toBeGreaterThan(0)
    expect(res.data?.options.length).toBeLessThan(4)
    expect(res.data?.note).toMatch(/Only \d of 4 options came back/)
    expect(f.cancelled.length).toBeGreaterThan(0)
  })

  test('a job that never answers is given up on, its model replaced, and the call does not wait for it', async () => {
    const f = fake({ pools: pools(), models: [model('flash', 'GEMINI_FLASH_API_KEYS'), model('medium', 'MISTRAL_API_KEYS'), model('small', 'MISTRAL_API_KEYS')], hang: ['flash'] })
    servers.push(f.server)
    const res = await call(createRedesignMcp({ baseUrl: f.url, outDir: outDir(), pollMs: 2, stallMs: 30, minStartMs: 0 }), { brief: 'x', count: 4 })
    expect(res.data?.options).toHaveLength(4)
    expect(res.data?.options.every((o) => o.model !== 'flash')).toBe(true)
    expect(f.runs.flatMap((r) => r.models).filter((m) => m === 'flash')).toHaveLength(1)
  })

  test('a thin Mistral pool is topped up from HSwarm before the run (counts only), a full one is not', async () => {
    const f = fake({ pools: pools(3), models })
    servers.push(f.server)
    const asked: string[][] = []
    const refill = async (lists: string[]) => {
      asked.push(lists)
      f.markRefilled()
      return 'topped up ReDesign keys from HSwarm (MISTRAL_API_KEYS +5)'
    }
    const thin = await call(createRedesignMcp({ baseUrl: f.url, outDir: outDir(), pollMs: 2, refill }), { brief: 'x', count: 3 })
    expect(asked).toEqual([['mistral']])
    expect(thin.data?.note).toContain('topped up')
    const f2 = fake({ pools: pools(8), models })
    servers.push(f2.server)
    await call(createRedesignMcp({ baseUrl: f2.url, outDir: outDir(), pollMs: 2, refill }), { brief: 'x', count: 3 })
    expect(asked).toHaveLength(1)
  })
})
