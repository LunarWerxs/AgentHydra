import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import factory from '../../src/connectors/defs/redesign'
import { designImagePath, serveDesignImage } from '../../src/connectors/redesign-images'
import { createRedesignMcp, poolFailing, removeQuietly } from '../../src/connectors/redesign-mcp'
import type { ConnectorStatus } from '@shared/connectors'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

interface Fake {
  server: ReturnType<typeof Bun.serve>
  url: string
  uploads: { name: string; bytes: number }[]
  runs: Record<string, unknown>[]
  keyed: boolean
}

/** A stand-in for ReDesign's HTTP API: just the routes redesign-mcp uses. */
function fakeRedesign(): Fake {
  const state = { uploads: [] as { name: string; bytes: number }[], runs: [] as Record<string, unknown>[], keyed: true }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      const json = (v: unknown, status = 200) => Response.json(v, { status })
      if (u.pathname === '/api/health') return json({ ok: true, service: 'redesign', ts: 1 })
      if (u.pathname === '/api/bootstrap') {
        return json({
          models: [
            { id: 'm-a', label: 'Model A', keyEnv: 'A_KEYS', vision: true, enabled: true },
            { id: 'm-b', label: 'Model B', keyEnv: 'B_KEYS', vision: true, enabled: true }
          ],
          keys: { pools: [{ pool: 'A_KEYS', available: state.keyed ? 1 : 0 }, { pool: 'B_KEYS', available: 0 }] }
        })
      }
      if (u.pathname === '/api/inputs/upload') {
        const body = (await req.json()) as { images: { name: string; data: string }[] }
        for (const i of body.images) state.uploads.push({ name: i.name, bytes: Buffer.from(i.data, 'base64').length })
        return json({ saved: [], addedIds: ['input-1'], inputs: [] })
      }
      if (u.pathname === '/api/run') {
        state.runs.push((await req.json()) as Record<string, unknown>)
        return json({ runId: `run-${state.runs.length}` })
      }
      const run = /^\/api\/runs\/run-(\d+)$/.exec(u.pathname)
      if (run) {
        const body = state.runs[Number(run[1]) - 1] as { models: string[] }
        return json({ status: 'done', jobs: body.models.map((m, n) => ({ id: `job-${run[1]}-${n + 1}`, status: 'ok', modelId: m, file: `run-${run[1]}/out-${n + 1}.html` })) })
      }
      if (u.pathname.startsWith('/output-raw/')) return json({ caption: 'A calm two-column layout' })
      if (u.pathname === '/api/output/screenshot') return new Response(PNG, { headers: { 'content-type': 'image/png' } })
      if (/^\/api\/runs\/run-\d+\/design-md$/.test(u.pathname)) return new Response(`# spec for ${u.searchParams.get('job')}`)
      return json({ error: 'not found' }, 404)
    }
  })
  return Object.assign(state, { server, url: `http://127.0.0.1:${server.port}` })
}

describe('redesign connector', () => {
  let tmp: string
  let fake: Fake
  // Only the keys these tests change are put back. Assigning a copy back to process.env (as this did until
  // 2026-10-10) left later files with a plain object holding Bun's upper-cased Windows keys, so
  // process.env.ProgramFiles read undefined, findChrome found no Chrome and six browser test files failed.
  const KEYS = ['REDESIGN_HOME', 'REDESIGN_EXE', 'REDESIGN_URL', 'PORT'] as const
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'redesign-test-'))
    fake = fakeRedesign()
  })
  afterAll(() => {
    fake.server.stop(true)
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  test('detect: running when health answers, installed from installed.json, absent otherwise', async () => {
    process.env.REDESIGN_HOME = join(tmp, 'nohome')
    process.env.PORT = '1'
    delete process.env.REDESIGN_EXE
    const home = join(tmp, 'desk')
    const def = factory({ home })

    process.env.REDESIGN_URL = 'http://127.0.0.1:1'
    expect((await def.detect()).state).toBe('absent')

    const dest = join(home, 'apps', 'redesign')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'redesign-windows-x64.exe'), 'x')
    writeFileSync(join(dest, 'installed.json'), JSON.stringify({ version: 'v1.7.1', asset: 'redesign-windows-x64.exe' }))
    expect(await def.detect()).toMatchObject({ state: 'installed', version: 'v1.7.1', url: null })

    process.env.REDESIGN_URL = fake.url
    expect(await def.detect()).toMatchObject({ state: 'running', url: fake.url, version: 'v1.7.1' })

    // its runtime pointer is followed when REDESIGN_URL is not set
    delete process.env.REDESIGN_URL
    mkdirSync(process.env.REDESIGN_HOME, { recursive: true })
    writeFileSync(join(process.env.REDESIGN_HOME, 'runtime.json'), JSON.stringify({ url: fake.url }))
    expect((await def.detect()).state).toBe('running')
  })

  test("chat: Desk's HTTP MCP route carrying ReDesign's address, and the design-first paragraph, only while running", () => {
    const def = factory({ home: join(tmp, 'desk') })
    const status = { id: 'redesign', state: 'running', url: 'http://127.0.0.1:5178' } as ConnectorStatus
    const chat = def.chat?.('C:/Users/me/app', status)
    const server = chat?.mcpServers?.redesign as { type: string; url: string }
    expect(server.type).toBe('http')
    const url = new URL(server.url)
    expect(url.pathname).toBe('/mcp/redesign')
    expect(url.searchParams.get('url')).toBe('http://127.0.0.1:5178')
    expect(chat?.prompt).toContain('design_options')
    expect(chat?.prompt).toContain('design_pick')
    expect(def.chat?.('C:/Users/me/app', { ...status, state: 'installed', url: null })).toBeNull()
  })

  const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method, params })
  const text = (r: unknown) => ((r as { result: { content: { text: string }[] } }).result.content[0] as { text: string }).text

  test('redesign-mcp: tools/list, then design_options and design_pick round trip', async () => {
    const outDir = join(tmp, 'out')
    const shot = join(tmp, 'current.png')
    writeFileSync(shot, PNG)
    const mcp = createRedesignMcp({ baseUrl: fake.url, outDir, pollMs: 5 })

    const list = (await mcp.handle(rpc(1, 'tools/list'))) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(['design_options', 'design_pick'])

    const res = await mcp.handle(rpc(2, 'tools/call', { name: 'design_options', arguments: { brief: 'a settings page', screenshot: shot, count: 4 } }))
    const out = JSON.parse(text(res).split('\n\n').slice(1).join('\n\n')) as { run: string; options: { option: number; image: string; markdown: string; description: string; name: string }[] }
    expect(out.run).toBe('run-1')
    expect(out.options).toHaveLength(4)
    expect(JSON.parse(readFileSync(join(outDir, 'run-1', 'options.json'), 'utf8'))).toHaveLength(4)
    expect(out.options[1]).toMatchObject({ option: 2, name: 'Fresh layout' })
    expect(out.options[0]?.name).toBe('As briefed')
    expect(JSON.stringify(out.options)).not.toContain('two-column')
    expect(out.options[1]?.markdown).toBe(`![Option 2: Model A](${out.options[1]?.image})`)
    for (const o of out.options) expect(readFileSync(o.image).equals(PNG)).toBe(true)
    expect(fake.uploads[0]).toEqual({ name: 'current.png', bytes: PNG.length })
    // only the model with a key is used, four times: one run per style-hint instance, the first with the brief as written
    expect(fake.runs).toHaveLength(4)
    expect(fake.runs[0]).toMatchObject({ inputs: ['input-1'], models: ['m-a'], modelQuantities: { 'm-a': 1 }, mock: false, prompts: { presets: [], custom: 'a settings page' } })
    expect(new Set(fake.runs.map((r) => (r.prompts as { custom: string }).custom)).size).toBe(4)

    const pick = await mcp.handle(rpc(3, 'tools/call', { name: 'design_pick', arguments: { run: 'run-1', option: 2 } }))
    expect(text(pick)).toContain('# spec for job-2-1')
    expect(text(pick)).toContain('option-2.png')
    const bad = await mcp.handle(rpc(4, 'tools/call', { name: 'design_pick', arguments: { run: 'run-1', option: 9 } }))
    expect((bad as { result: { isError: boolean } }).result.isError).toBe(true)
  })

  test('redesign-mcp: brief only uploads a placeholder; mock still uses a keyed model', async () => {
    fake.uploads.length = 0
    const mcp = createRedesignMcp({ baseUrl: fake.url, outDir: join(tmp, 'out2'), pollMs: 5 })
    const res = await mcp.handle(rpc(1, 'tools/call', { name: 'design_options', arguments: { brief: 'x', mock: true, count: 3 } }))
    expect((res as { result: { isError?: boolean } }).result.isError).toBeUndefined()
    expect(fake.uploads[0]?.name).toBe('brief-only.png')
    expect(fake.runs.slice(-3).every((r) => r.mock === true && JSON.stringify(r.models) === '["m-a"]')).toBe(true)
  })

  test('redesign-mcp: no working key and not mock is a clear error that sends the person to ReDesign', async () => {
    fake.keyed = false
    const before = fake.runs.length
    const mcp = createRedesignMcp({ baseUrl: fake.url, outDir: join(tmp, 'out3'), pollMs: 5 })
    const res = (await mcp.handle(rpc(1, 'tools/call', { name: 'design_options', arguments: { brief: 'x' } }))) as { result: { isError: boolean } }
    expect(res.result.isError).toBe(true)
    expect(text(res)).toContain('Settings → Connectors → ReDesign → Open')
    expect(fake.runs.length).toBe(before)
    fake.keyed = true
  })

  test('redesign-mcp: ask_owner is in the schema; true tells the AI to wait, false (default) to pick itself', async () => {
    const mcp = createRedesignMcp({ baseUrl: fake.url, outDir: join(tmp, 'out-ask'), pollMs: 5 })
    const list = (await mcp.handle(rpc(1, 'tools/list'))) as { result: { tools: { name: string; description: string; inputSchema: { properties: Record<string, { type: string }> } }[] } }
    const tool = list.result.tools.find((t) => t.name === 'design_options')
    expect(tool?.inputSchema.properties.ask_owner?.type).toBe('boolean')
    expect(tool?.description).toContain('ask_owner')
    const asked = text(await mcp.handle(rpc(2, 'tools/call', { name: 'design_options', arguments: { brief: 'x', mock: true, ask_owner: true } })))
    expect(asked).toContain('end your turn and wait')
    expect(asked).toContain('call design_pick for the option they chose')
    expect(JSON.parse(asked.slice(asked.indexOf('{'))).ask_owner).toBe(true)
    const own = text(await mcp.handle(rpc(3, 'tools/call', { name: 'design_options', arguments: { brief: 'x', mock: true } })))
    expect(own).toContain('you decide')
    expect(own).not.toContain('end your turn and wait')
    expect(JSON.parse(own.slice(own.indexOf('{'))).ask_owner).toBe(false)
  })

  test('removeQuietly: retries a folder Windows still holds (EBUSY) and never throws', async () => {
    let calls = 0
    const busyTwice = () => {
      calls++
      if (calls < 3) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    await removeQuietly('x', busyTwice, 10, 1)
    expect(calls).toBe(3)
    const alwaysBusy = () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }
    await expect(removeQuietly('x', alwaysBusy, 3, 1)).resolves.toBeUndefined()
  })

  test('poolFailing: a pool whose every key last answered with an error; fresh or recently good keys are not', () => {
    const bad = { lastError: 'network error', lastUsedAt: 20, lastSuccessAt: 10 }
    expect(poolFailing({ pool: 'P', available: 2, entries: [bad, { ...bad, lastSuccessAt: null }] })).toBe(true)
    expect(poolFailing({ pool: 'P', available: 2, entries: [bad, { lastError: null, lastUsedAt: null, lastSuccessAt: null }] })).toBe(false)
    expect(poolFailing({ pool: 'P', available: 1, entries: [{ lastError: 'old', lastUsedAt: 20, lastSuccessAt: 25 }] })).toBe(false)
    expect(poolFailing({ pool: 'P', available: 1 })).toBe(false)
  })

  test('redesign-mcp: models of a failing pool are skipped; a run lost to cooldown says when the key is back and what to do', async () => {
    const until = Date.now() + 90_000
    const failing = { lastError: 'network error: The socket connection was closed unexpectedly', lastUsedAt: 2, lastSuccessAt: 1, cooldownUntil: until }
    const runs: Record<string, unknown>[] = []
    let cooled = false
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const u = new URL(req.url)
        const pools = [
          { pool: 'A_KEYS', available: 1, entries: [failing] },
          { pool: 'B_KEYS', available: 1, entries: [{ lastError: null, lastUsedAt: null, lastSuccessAt: null }] }
        ]
        if (u.pathname === '/api/bootstrap') {
          return Response.json({
            models: [
              { id: 'm-a', label: 'A', keyEnv: 'A_KEYS', vision: true, starred: true },
              { id: 'm-b', label: 'B', keyEnv: 'B_KEYS', vision: true }
            ],
            keys: { pools }
          })
        }
        if (u.pathname === '/api/keys') return Response.json({ pools })
        if (u.pathname === '/api/inputs/upload') return Response.json({ addedIds: ['in-1'] })
        if (u.pathname === '/api/run') {
          runs.push((await req.json()) as Record<string, unknown>)
          return Response.json({ runId: 'run-c' })
        }
        if (u.pathname === '/api/runs/run-c') {
          const error = cooled ? 'all keys cooling down (A_KEYS)' : 'all keys cooling down (B_KEYS)'
          return Response.json({ status: 'done', jobs: [{ id: 'j1', status: 'skipped', modelId: 'm-b', error }] })
        }
        return Response.json({}, { status: 404 })
      }
    })
    try {
      const mcp = createRedesignMcp({ baseUrl: `http://127.0.0.1:${server.port}`, outDir: join(tmp, 'out-cool'), pollMs: 5 })
      await mcp.handle(rpc(1, 'tools/call', { name: 'design_options', arguments: { brief: 'x', count: 3 } }))
      // the pool with failing keys is skipped; the other model gets all three jobs, and a cooled pool is never retried with a replacement
      expect(runs.map((r) => r.models)).toEqual([['m-b'], ['m-b'], ['m-b']])
      cooled = true
      const res = (await mcp.handle(rpc(2, 'tools/call', { name: 'design_options', arguments: { brief: 'x', count: 3 } }))) as { result: { isError: boolean } }
      expect(res.result.isError).toBe(true)
      const msg = text(res)
      expect(msg).toContain('every key of A_KEYS was cooling down')
      expect(msg).toMatch(/free again at .+ \(in (89|90) s\)/)
      expect(msg).toContain('socket connection was closed')
      expect(msg).toContain("Use HSwarm's keys")
    } finally {
      server.stop(true)
    }
  })

  test('design image route: serves a picture in the folder, refuses traversal, odd names and outside paths', async () => {
    const dir = join(tmp, 'design-options')
    mkdirSync(join(dir, 'run-9'), { recursive: true })
    writeFileSync(join(dir, 'run-9', 'option-1.png'), PNG)
    writeFileSync(join(tmp, 'secret.png'), PNG)
    writeFileSync(join(dir, 'run-9', 'notes.txt'), 'x')
    const ok = serveDesignImage(dir, 'run-9', 'option-1.png')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true)
    for (const [run, file] of [
      ['..', 'secret.png'],
      ['run-9', '../secret.png'],
      ['run-9', 'option-1.png/../../secret.png'],
      ['run-9', 'notes.txt'],
      ['run-9', 'option-2.png'],
      ['../design-options/run-9', 'option-1.png'],
      ['run-9\..', 'option-1.png'],
      ['', 'option-1.png']
    ] as const) {
      expect(designImagePath(dir, run, file)).toBeNull()
      expect(serveDesignImage(dir, run, file).status).toBe(404)
    }
  })
})
