// plugins/50-devwebui.ts and devwebui/daemon.ts against a fake DevWebUI daemon: found by pointer or DEVWEBUI_URL
// and only when /api/health says DevWebUI, started once however many panes ask, /dw/api/* passed on only for
// Desk 2's own page with the daemon's credential added and never shown.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DevWebDaemon } from '../../src/devwebui/daemon'
import { createServer, type DeskServer } from '../../src/index'

const PLUGINS = join(import.meta.dir, '..', '..', 'src', 'plugins')
const SECRET = 'f00dfacecafebeef'
const temps: string[] = []
const stops: (() => unknown)[] = []
const saved = { home: process.env.HYDRA_DESK_HOME, dw: process.env.DEVWEBUI_HOME, url: process.env.DEVWEBUI_URL }
let dwHome = ''

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

beforeEach(() => {
  dwHome = temp('desk-dw-home-')
  process.env.DEVWEBUI_HOME = dwHome
  delete process.env.DEVWEBUI_URL
})

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const [k, v] of [['HYDRA_DESK_HOME', saved.home], ['DEVWEBUI_HOME', saved.dw], ['DEVWEBUI_URL', saved.url]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

interface Seen {
  method: string
  path: string
  body: string
  authorization: string | null
  origin: string | null
}

/** A DevWebUI that answers health, and every other call with what it was sent. */
function fakeDaemon(service = 'devwebui'): { url: string; seen: Seen[] } {
  const seen: Seen[] = []
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/api/health') return Response.json({ ok: true, service })
      const s = { method: req.method, path: u.pathname + u.search, body: await req.text(), authorization: req.headers.get('authorization'), origin: req.headers.get('origin') }
      seen.push(s)
      return Response.json({ projects: [], echo: s.path })
    }
  })
  stops.push(() => srv.stop(true))
  return { url: `http://127.0.0.1:${srv.port}`, seen }
}

const point = (url: string): void => writeFileSync(join(dwHome, 'runtime.json'), JSON.stringify({ url, pid: 1 }))

async function boot(daemon: DevWebDaemon): Promise<DeskServer> {
  const home = temp('desk-dw-desk-')
  const plugins = temp('desk-dw-plugins-')
  writeFileSync(join(plugins, '50-devwebui.ts'), `export { default } from ${JSON.stringify(pathToFileURL(join(PLUGINS, '50-devwebui.ts')).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { devwebui: daemon } })
  stops.push(() => desk.stop())
  return desk
}

const newDaemon = (launch?: () => Promise<void> | void): DevWebDaemon => new DevWebDaemon({ home: temp('desk-dw-data-'), launch })

test('a daemon is found by the pointer, and only when its health says DevWebUI', async () => {
  const fake = fakeDaemon()
  point(fake.url)
  const desk = await boot(newDaemon())
  expect(await (await fetch(`${desk.url}/dw/status`)).json()).toEqual({ state: 'running', url: fake.url })

  const other = fakeDaemon('something-else')
  point(other.url)
  expect((await (await fetch(`${desk.url}/dw/status`)).json()).state).toBe('stopped')
})

test('a pointer left by a daemon that is gone reads as stopped; DEVWEBUI_URL wins over the pointer', async () => {
  point('http://127.0.0.1:1')
  const desk = await boot(newDaemon())
  expect((await (await fetch(`${desk.url}/dw/status`)).json()).state).toBe('stopped')

  const fake = fakeDaemon()
  process.env.DEVWEBUI_URL = `${fake.url}/`
  expect(await (await fetch(`${desk.url}/dw/status`)).json()).toEqual({ state: 'running', url: fake.url })
})

test('two panes asking at once start one daemon, and none is started while one answers', async () => {
  const fake = fakeDaemon()
  let launches = 0
  const daemon = newDaemon(async () => {
    launches++
    await Bun.sleep(300)
    point(fake.url)
  })
  const desk = await boot(daemon)
  const ask = () => fetch(`${desk.url}/dw/start`, { method: 'POST' }).then((r) => r.json())
  const [a, b] = await Promise.all([ask(), ask()])
  expect([a.state, b.state]).toEqual(['starting', 'starting'])
  for (let i = 0; i < 50 && (await (await fetch(`${desk.url}/dw/status`)).json()).state !== 'running'; i++) await Bun.sleep(100)
  expect((await ask()).state).toBe('running')
  expect(launches).toBe(1)
})

test('a start that fails says why', async () => {
  const desk = await boot(
    newDaemon(() => {
      throw new Error('bun install failed in the server manager folder')
    })
  )
  await fetch(`${desk.url}/dw/start`, { method: 'POST' })
  let status: any
  for (let i = 0; i < 50; i++) {
    status = await (await fetch(`${desk.url}/dw/status`)).json()
    if (status.state === 'failed') break
    await Bun.sleep(50)
  }
  expect(status).toEqual({ state: 'failed', url: null, reason: 'bun install failed in the server manager folder' })
})

test('/dw/api/* reaches the daemon with its path, query and body, and answers 503 when none runs', async () => {
  const desk = await boot(newDaemon())
  expect((await fetch(`${desk.url}/dw/api/projects`)).status).toBe(503)

  const fake = fakeDaemon()
  point(fake.url)
  const res = await fetch(`${desk.url}/dw/api/processes/p1.web/start?x=1`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
  expect(res.status).toBe(200)
  expect(fake.seen.at(-1)).toMatchObject({ method: 'POST', path: '/api/processes/p1.web/start?x=1', body: '{"a":1}' })
})

test('/dw/api/* refuses another page, and no browser provenance goes on', async () => {
  const fake = fakeDaemon()
  point(fake.url)
  const desk = await boot(newDaemon())
  const foreign = await fetch(`${desk.url}/dw/api/projects`, { headers: { origin: 'http://localhost:9999' } })
  expect(foreign.status).toBe(403)
  const crossSite = await fetch(`${desk.url}/dw/api/projects`, { headers: { 'sec-fetch-site': 'same-site' } })
  expect(crossSite.status).toBe(403)
  expect(fake.seen).toHaveLength(0)

  const own = await fetch(`${desk.url}/dw/api/projects`, { headers: { origin: new URL(desk.url).origin, 'sec-fetch-site': 'same-origin' } })
  expect(own.status).toBe(200)
  expect(fake.seen[0]?.origin).toBeNull()
})

test("the daemon's credential is added to what goes on and never reaches the page", async () => {
  const fake = fakeDaemon()
  point(fake.url)
  mkdirSync(dwHome, { recursive: true })
  writeFileSync(join(dwHome, '.cookie'), `__cookie__:${SECRET}`)
  const desk = await boot(newDaemon())
  const res = await fetch(`${desk.url}/dw/api/projects`, { headers: { authorization: 'Bearer from-the-page' } })
  const sent = fake.seen[0]?.authorization ?? ''
  expect(Buffer.from(sent.replace('Basic ', ''), 'base64').toString()).toBe(`__cookie__:${SECRET}`)
  const shown = JSON.stringify(Object.fromEntries(res.headers as unknown as Iterable<[string, string]>)) + (await res.text()) + JSON.stringify(await (await fetch(`${desk.url}/dw/status`)).json())
  expect(shown).not.toContain(SECRET)
  expect(shown).not.toContain(Buffer.from(`__cookie__:${SECRET}`).toString('base64'))
})

test("the credential is not sent to a daemon that is not on this machine's loopback", async () => {
  const { daemonAuth } = await import('../../src/devwebui/daemon')
  writeFileSync(join(dwHome, '.cookie'), `__cookie__:${SECRET}`)
  expect(daemonAuth('http://example.test:4000')).toBeNull()
  expect(daemonAuth('http://127.0.0.1:4000')).not.toBeNull()
})

/** A DevWebUI with projects: lists them, loads a folder's .devwebui, offers a scaffold for `proposals`, and writes it. */
function projectsDaemon(projects: { id: string; name: string; path: string; processes: unknown[] }[], proposals: Record<string, unknown> = {}) {
  const calls: string[] = []
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/api/health') return Response.json({ ok: true, service: 'devwebui' })
      calls.push(`${req.method} ${u.pathname}`)
      if (u.pathname === '/api/projects') return Response.json(projects)
      const body = (await req.json()) as Record<string, any>
      if (u.pathname === '/api/projects/load') {
        const proposal = proposals[body.path]
        if (proposal) return Response.json({ needsScaffold: true, dir: body.path, fileName: '.devwebui', proposal })
        return Response.json({ error: `No .devwebui file found in ${body.path}, and no dev script to build one from.` }, { status: 400 })
      }
      if (u.pathname === '/api/projects/scaffold') {
        const file = join(body.dir, body.fileName)
        writeFileSync(file, JSON.stringify(body.project))
        const project = { id: 'new1', name: body.project.name, path: file, processes: [] }
        projects.push(project)
        return Response.json({ ok: true, project, firstLoad: true, created: file })
      }
      return Response.json({ error: 'unexpected' }, { status: 404 })
    }
  })
  stops.push(() => srv.stop(true))
  return { url: `http://127.0.0.1:${srv.port}`, calls }
}

const folder = (desk: DeskServer, cwd: unknown, headers: Record<string, string> = {}) =>
  fetch(`${desk.url}/dw/folder`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ cwd }) })

const gitIn = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })

test('/dw/folder answers the project a folder is already in, without loading anything', async () => {
  const root = temp('desk-dw-known-')
  const known = { id: 'p1', name: 'Site', path: join(root, '.devwebui'), processes: [] }
  const fake = projectsDaemon([known])
  point(fake.url)
  const desk = await boot(newDaemon())
  const res = await folder(desk, join(root, 'src'))
  expect(await res.json()).toEqual({ project: known })
  expect(fake.calls).toEqual(['GET /api/projects'])
})

test('/dw/folder sets up a folder DevWebUI can build a .devwebui for, and keeps that file out of git status', async () => {
  const repo = temp('desk-dw-repo-')
  const cwd = join(repo, 'apps', 'web')
  mkdirSync(cwd, { recursive: true })
  expect(gitIn(repo, 'init', '-q').exitCode).toBe(0)
  const proposal = { name: 'Web', processes: [{ id: 'dev', name: 'Dev', command: 'npm run dev', port: 3000 }] }
  const fake = projectsDaemon([], { [cwd]: proposal })
  point(fake.url)
  const desk = await boot(newDaemon())

  const out = await (await folder(desk, cwd)).json()
  expect(out).toMatchObject({ project: { id: 'new1', name: 'Web' }, created: join(cwd, '.devwebui') })
  expect(fake.calls).toEqual(['GET /api/projects', 'POST /api/projects/load', 'POST /api/projects/scaffold'])
  expect(existsSync(join(cwd, '.devwebui'))).toBe(true)
  expect(gitIn(repo, 'status', '--porcelain', '--untracked-files=all').stdout.toString()).toBe('')
  expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toEndWith('\n/apps/web/.devwebui\n')

  // Asked again, the folder is now a project: nothing is written twice.
  expect(await (await folder(desk, cwd)).json()).toMatchObject({ project: { id: 'new1' } })
  expect(fake.calls.slice(3)).toEqual(['GET /api/projects'])
  // Real git processes: alone the test takes about 1 s, but 2026-10-06's full gate under load ran past 5 s.
}, 30_000)

test('/dw/folder says when there is nothing to run, and refuses another page, no cwd, and no daemon', async () => {
  const empty = temp('desk-dw-empty-')
  const desk = await boot(newDaemon())
  expect((await folder(desk, empty)).status).toBe(503)

  const fake = projectsDaemon([])
  point(fake.url)
  expect(await (await folder(desk, empty)).json()).toEqual({ nothing: 'Nothing to run here: no .claude/launch.json, and no dev script in package.json.' })
  expect((await folder(desk, '')).status).toBe(400)
  expect((await folder(desk, empty, { origin: 'http://localhost:9999' })).status).toBe(403)
  expect(existsSync(join(empty, '.devwebui'))).toBe(false)
})
