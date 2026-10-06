// plugins/59-repoyeti-git.ts against a fake RepoYeti on a random port: the state read, commit, undo with RepoYeti's own
// preview as the guard, Create PR (branch, commit, push, compare page) and the refusals.

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPOYETI_GIT } from '@shared/connectors'
import type { ConnectorDef, Detected } from '../../src/connectors/types'
import { createServer, type DeskServer } from '../../src/index'

const PLUGINS = ['57-connectors.ts', '59-repoyeti-git.ts']
const temps: string[] = []
const stops: (() => unknown)[] = []
const saved = process.env.HYDRA_DESK_HOME

const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}

let repo = ''
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ry-git-repo-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo])
  Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'git@github.com:example-owner/example-repo.git'])
}, 20_000)

afterAll(() => rmSync(repo, { recursive: true, force: true }))

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  if (saved === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = saved
})

interface Fake {
  url: string
  /** Every mutating call, in order: "POST /path" plus its body. */
  calls: { line: string; body: unknown }[]
  branch: string
  dirty: number
  undoOk: boolean
}

function fakeRepoYeti(over: Partial<Fake> = {}): Fake {
  const fake: Fake = { url: '', calls: [], branch: 'main', dirty: 2, undoOk: true, ...over }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      const line = `${req.method} ${path}`
      if (path === '/api/health') return Response.json({ service: 'repoyeti', version: '1.3.0' })
      if (line === 'GET /api/repos') return Response.json({ repos: [{ id: 'r1', absPath: repo }] })
      if (line === 'GET /api/repos/r1/branches') return Response.json({ ok: true, current: fake.branch, branches: [{ name: 'main' }, { name: 'feature/x' }] })
      if (line === 'GET /api/repos/r1/changes') return Response.json({ files: [], total: fake.dirty })
      if (line === 'GET /api/repos/r1/undo') {
        const step = { to: 'abc123', subject: 'commit: add b' }
        return Response.json({
          ok: true,
          undo: fake.undoOk ? { ok: true, step } : { ok: false, message: 'that commit is already pushed' },
          redo: { ok: false, message: 'nothing to redo' }
        })
      }
      if (line === 'POST /api/repos/r1/commit-message') return Response.json({ ok: true, message: 'Add b and tweak a' })
      if (req.method === 'POST') {
        const body = await req.json().catch(() => null)
        fake.calls.push({ line, body })
        if (line === 'POST /api/repos/r1/push' && fake.branch === 'broken') return Response.json({ ok: false, message: 'rejected (non-fast-forward)' }, { status: 409 })
        if (line === 'POST /api/repos/r1/branch') fake.branch = (body as { name: string }).name
        return Response.json({ ok: true, code: 'OK', message: 'done' })
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
  const home = temp('ry-git-home-')
  process.env.HYDRA_DESK_HOME = home
  const plugins = temp('ry-git-plugins-')
  for (const name of PLUGINS) {
    const file = join(import.meta.dir, '..', '..', 'src', 'plugins', name)
    writeFileSync(join(plugins, name), `export { default } from ${JSON.stringify(pathToFileURL(file).href)}\n`)
  }
  const server = await createServer({ port: 0, home, pluginsDir: plugins, deps: { connectors: [def(detected)] } })
  stops.push(() => server.stop())
  return server
}

const running = (fake: Fake): Detected => ({ state: 'running', url: fake.url, version: '1.3.0' })
const act = (s: DeskServer, action: string, body: object, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${s.port}${REPOYETI_GIT}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ cwd: repo, ...body }) })

test('the state names the branches, the default branch, the GitHub remote and what undo would do', async () => {
  const fake = fakeRepoYeti()
  const s = await desk(running(fake))
  const res = await fetch(`http://127.0.0.1:${s.port}${REPOYETI_GIT}/state?cwd=${encodeURIComponent(repo)}`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    repoId: 'r1',
    branch: 'main',
    defaultBranch: 'main',
    branches: ['main', 'feature/x'],
    remote: { owner: 'example-owner', repo: 'example-repo' },
    undo: 'commit: add b',
    redo: null
  })
})

test('a refused undo shows RepoYeti reason and the commit needs a message', async () => {
  const fake = fakeRepoYeti({ undoOk: false })
  const s = await desk(running(fake))
  const state = (await (await fetch(`http://127.0.0.1:${s.port}${REPOYETI_GIT}/state?cwd=${encodeURIComponent(repo)}`)).json()) as { undo: string | null; undoWhy: string }
  expect([state.undo, state.undoWhy]).toEqual([null, 'that commit is already pushed'])
  expect((await act(s, 'undo', {})).status).toBe(422)
  expect((await act(s, 'commit', { message: '  ' })).status).toBe(400)
  expect(fake.calls).toEqual([])
})

test('commit sends the message and amend; undo repeats RepoYeti own preview step as its guard', async () => {
  const fake = fakeRepoYeti()
  const s = await desk(running(fake))
  expect(await (await act(s, 'commit', { message: 'Fix it', amend: true })).json()).toEqual({ ok: true, message: 'Amended the last commit' })
  expect((await act(s, 'undo', {})).status).toBe(200)
  expect(fake.calls).toEqual([
    { line: 'POST /api/repos/r1/commit', body: { message: 'Fix it', amend: true } },
    { line: 'POST /api/repos/r1/undo', body: { expect: { to: 'abc123', subject: 'commit: add b' } } }
  ])
})

test('Create PR on the default branch makes a branch, commits the draft, pushes and answers the compare page', async () => {
  const fake = fakeRepoYeti()
  const s = await desk(running(fake))
  const body = (await (await act(s, 'create-pr', {})).json()) as { ok: boolean; compareUrl: string }
  expect(fake.calls.map((c) => c.line)).toEqual(['POST /api/repos/r1/branch', 'POST /api/repos/r1/commit', 'POST /api/repos/r1/push'])
  expect((fake.calls[0]!.body as { switch: boolean }).switch).toBe(true)
  expect(fake.calls[1]!.body).toEqual({ message: 'Add b and tweak a' })
  expect(body.compareUrl).toMatch(/^https:\/\/github\.com\/example-owner\/example-repo\/compare\/desk\/\d{8}-\d{4}\?expand=1$/)
})

test('Create PR on a feature branch with nothing to commit only pushes', async () => {
  const fake = fakeRepoYeti({ branch: 'feature/x', dirty: 0 })
  const s = await desk(running(fake))
  const body = (await (await act(s, 'create-pr', {})).json()) as { compareUrl: string }
  expect(fake.calls.map((c) => c.line)).toEqual(['POST /api/repos/r1/push'])
  expect(body.compareUrl).toBe('https://github.com/example-owner/example-repo/compare/feature/x?expand=1')
})

test("RepoYeti's push refusal comes back as a short error and no page is offered", async () => {
  const fake = fakeRepoYeti({ branch: 'broken', dirty: 0 })
  const s = await desk(running(fake))
  const res = await act(s, 'push', {})
  expect(res.status).toBe(502)
  expect(((await res.json()) as { error: string }).error).toContain('non-fast-forward')
})

test('nothing is sent while RepoYeti is not running, to a foreign Origin, or for an unknown action', async () => {
  const fake = fakeRepoYeti()
  const down = await desk({ state: 'installed', url: null, version: null })
  expect((await act(down, 'push', {})).status).toBe(409)
  const s = await desk(running(fake))
  expect((await act(s, 'push', {}, { origin: 'https://evil.example.com' })).status).toBe(403)
  expect((await act(s, 'format-disk', {})).status).toBe(404)
  expect(fake.calls).toEqual([])
})
