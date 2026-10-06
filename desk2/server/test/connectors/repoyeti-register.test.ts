// plugins/58-repoyeti.ts against a fake RepoYeti on a random port: a folder RepoYeti already lists, a newly added one,
// a folder that is not a git work tree, the connector not running, and a foreign Origin.

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPOYETI_REGISTER } from '@shared/connectors'
import type { ConnectorDef, Detected } from '../../src/connectors/types'
import { createServer, type DeskServer } from '../../src/index'

const PLUGINS = ['57-connectors.ts', '58-repoyeti.ts']
const temps: string[] = []
const stops: (() => unknown)[] = []
const saved = process.env.HYDRA_DESK_HOME

const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}

let repo = ''
let plain = ''
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ry-reg-repo-'))
  Bun.spawnSync(['git', 'init', '-q', repo])
  mkdirSync(join(repo, 'sub'))
  plain = mkdtempSync(join(tmpdir(), 'ry-reg-plain-'))
  // 20s: a real `git init`; a cold Windows CI runner has run spawns ~9.5x slower than a desk.
}, 20_000)

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  if (saved === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = saved
})

interface Fake {
  url: string
  listed: { id: string; absPath: string }[]
  posts: unknown[]
  headers: Headers[]
}

function fakeRepoYeti(listed: Fake['listed'], reject?: string): Fake {
  const fake: Fake = { url: '', listed, posts: [], headers: [] }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      fake.headers.push(req.headers)
      if (path === '/api/health') return Response.json({ service: 'repoyeti', version: '1.0.0' })
      if (path === '/api/repos' && req.method === 'GET') return Response.json({ repos: fake.listed })
      if (path === '/api/repos/register' && req.method === 'POST') {
        const body = (await req.json()) as { path: string }
        fake.posts.push(body)
        if (reject) return Response.json({ ok: false, code: 'TEMP_PATH_REFUSED', message: reject }, { status: 409 })
        return Response.json({ ok: true, code: 'OK', message: 'registered', repo: { id: 'new-id', absPath: body.path } }, { status: 201 })
      }
      return new Response('no', { status: 404 })
    }
  })
  stops.push(() => server.stop(true))
  fake.url = `http://127.0.0.1:${server.port}`
  return fake
}

const def = (detected: Detected): ConnectorDef => ({
  info: { id: 'repoyeti', name: 'RepoYeti', blurb: 'x', homepage: 'https://example.com', installable: false, pane: true },
  detect: async () => detected
})

async function desk(detected: Detected): Promise<DeskServer> {
  const home = temp('ry-reg-home-')
  process.env.HYDRA_DESK_HOME = home
  const plugins = temp('ry-reg-plugins-')
  for (const name of PLUGINS) {
    const file = join(import.meta.dir, '..', '..', 'src', 'plugins', name)
    writeFileSync(join(plugins, name), `export { default } from ${JSON.stringify(pathToFileURL(file).href)}\n`)
  }
  const server = await createServer({ port: 0, home, pluginsDir: plugins, deps: { connectors: [def(detected)] } })
  stops.push(() => server.stop())
  return server
}

const post = (server: DeskServer, cwd: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}${REPOYETI_REGISTER}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ cwd }) })

test('a folder RepoYeti already lists is not added again', async () => {
  const fake = fakeRepoYeti([{ id: 'r1', absPath: resolve(repo) }])
  const res = await post(await desk({ state: 'running', url: fake.url, version: '1.0.0' }), repo)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, added: false, repoId: 'r1' })
  expect(fake.posts).toEqual([])
})

test('a new folder is registered, from a subfolder too, with no Origin header', async () => {
  const fake = fakeRepoYeti([])
  const res = await post(await desk({ state: 'running', url: fake.url, version: '1.0.0' }), join(repo, 'sub'))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, added: true, repoId: 'new-id' })
  expect((fake.posts[0] as { path: string }).path.toLowerCase()).toBe(resolve(repo).toLowerCase())
  expect(fake.headers.every((h) => h.get('origin') === null)).toBe(true)
})

test('a folder that is not a git work tree is refused and never sent', async () => {
  const fake = fakeRepoYeti([])
  const server = await desk({ state: 'running', url: fake.url, version: '1.0.0' })
  expect((await post(server, plain)).status).toBe(400)
  expect((await post(server, 'relative/dir')).status).toBe(400)
  expect(fake.posts).toEqual([])
})

test("RepoYeti's refusal comes back as a clear error", async () => {
  const fake = fakeRepoYeti([], 'that folder is inside a temporary directory')
  const res = await post(await desk({ state: 'running', url: fake.url, version: '1.0.0' }), repo)
  expect(res.status).toBe(422)
  expect(((await res.json()) as { error: string }).error).toContain('temporary')
})

test('nothing is done while the connector is not running', async () => {
  const fake = fakeRepoYeti([])
  const res = await post(await desk({ state: 'installed', url: null, version: null }), repo)
  expect(res.status).toBe(409)
  expect(fake.headers).toEqual([])
})

test('a foreign Origin is refused', async () => {
  const fake = fakeRepoYeti([])
  const res = await post(await desk({ state: 'running', url: fake.url, version: '1.0.0' }), repo, { origin: 'https://evil.example.com' })
  expect(res.status).toBe(403)
  expect(fake.posts).toEqual([])
})
