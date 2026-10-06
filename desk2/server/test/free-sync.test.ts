// The Free login sync between two PCs (free-instances/sync.ts): each PC a FreeInstances of its own in a
// temp home, the store a stand-in for the login-sync Worker's /v1/free (the Worker's own tests own its
// compare-and-swap; this one keeps that contract and nothing else). DPAPI is real, so Windows only.

import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeRunner, RunOutput } from '../src/free-instances/runner'
import type { FreeRuntime } from '../src/free-instances/runtime'
import { FreeInstances } from '../src/free-instances/service'
import { FreeSync, readLogin, writeLogin } from '../src/free-instances/sync'

const dirs: string[] = []
const services: FreeInstances[] = []
afterEach(() => { services.splice(0).forEach(s => s.stop()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })

/** /v1/free as the Worker keeps it: version 0 creates, the current version replaces, else 409. */
function fakeStore(token: string) {
  const rows = new Map<string, { id: string; version: number; blob: string; meta: unknown }>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
      const path = new URL(req.url).pathname
      if (path === '/v1/free') return Response.json({ free: [...rows.values()].map(({ blob: _b, ...r }) => r) })
      const id = path.slice('/v1/free/'.length)
      if (req.method === 'GET') return rows.has(id) ? Response.json(rows.get(id)) : Response.json({ error: 'not found' }, { status: 404 })
      const body = (await req.json()) as { version: number; blob: string; meta: unknown }
      if ((rows.get(id)?.version ?? 0) !== body.version) return Response.json({ error: 'version conflict' }, { status: 409 })
      rows.set(id, { id, version: body.version + 1, blob: body.blob, meta: body.meta })
      return Response.json({ version: body.version + 1 })
    }
  })
  return { url: `http://127.0.0.1:${server.port}`, rows, stop: () => server.stop(true) }
}

/** One PC: its Free instances, with a harness whose log out deletes the session file, as the real one does. */
function pc() {
  const home = mkdtempSync(join(tmpdir(), 'desk-free-sync-'))
  dirs.push(home)
  const runtime: FreeRuntime = {
    ready: () => true,
    ensure: async () => {},
    config: id => ({ harnessDir: home, python: join(home, 'python.exe'), stateDir: join(home, 'free', 'instances', id), cacheDir: join(home, 'cache') })
  }
  const ok = (value: unknown): RunOutput => ({ code: 0, stdout: JSON.stringify(value) })
  const runner: FreeRunner = async (config, request) => {
    if (request.command === 'forget') rmSync(join(config.stateDir, request.provider === 'chatgpt' ? 'chatgpt' : '', 'session.dpapi'), { force: true })
    return ok({ ok: true, authenticated: true })
  }
  const service = new FreeInstances(home, runner, runtime)
  services.push(service)
  return { home, service, host: service.syncHost() }
}

/** Until no operation runs (a landed login is checked at once). */
async function settled(service: FreeInstances) {
  for (let i = 0; i < 50 && service.status().jobs.some(j => j.state === 'running'); i++) await Bun.sleep(5)
}

const sessionKey = (value: string, expires: number) => [
  { name: 'sessionKey', value, domain: '.claude.ai', path: '/', expires },
  { name: 'cf_clearance', value: `cf-${value}`, domain: '.claude.ai', path: '/', expires: -1 }
]
const signedInAs = (file: string) => readLogin(file, 'claude')?.cookies.find(c => c.name === 'sessionKey')?.value

test.skipIf(process.platform !== 'win32')('a deleted account disappears on the other PC, is not adopted again, and its tombstone settles', async () => {
  const token = randomBytes(16).toString('hex')
  const store = fakeStore(token)
  try {
    const key = randomBytes(32)
    const creds = async () => ({ url: store.url, token, key })
    const a = pc()
    const b = pc()
    const syncA = new FreeSync(a.home, a.host, creds)
    const syncB = new FreeSync(b.home, b.host, creds)
    const account = a.service.create({ provider: 'claude', name: 'Example account' })
    writeLogin(a.host.sessionFile(account), 'claude', sessionKey('first', 1_900_000_000))
    await syncA.pass()
    await syncB.pass()
    await settled(b.service)
    expect(b.service.status().instances).toHaveLength(1)

    await a.service.remove(account.id)
    expect(a.host.deleted().map(d => d.id)).toEqual([account.id])
    await syncA.pass()
    expect(a.host.deleted()).toEqual([])
    await syncB.pass()
    expect(b.service.status().instances).toEqual([])
    // Neither PC takes the account back on a later pass.
    await syncB.pass()
    await syncA.pass()
    expect(b.service.status().instances).toEqual([])
    expect(a.service.status().instances).toEqual([])
    expect(b.host.deleted()).toEqual([])
  } finally {
    store.stop()
  }
})

test.skipIf(process.platform !== 'win32')('a Free login reaches the other PC, the newer sign-in wins, and a log out reaches both', async () => {
  const token = randomBytes(16).toString('hex')
  const store = fakeStore(token)
  try {
    const key = randomBytes(32)
    const creds = async () => ({ url: store.url, token, key })
    const a = pc()
    const b = pc()
    const syncA = new FreeSync(a.home, a.host, creds)
    const syncB = new FreeSync(b.home, b.host, creds)

    const account = a.service.create({ provider: 'claude', name: 'Example account' })
    const fileA = a.host.sessionFile(account)
    expect(writeLogin(fileA, 'claude', sessionKey('first', 1_900_000_000))).toBe(true)
    await syncA.pass()
    // The store holds ciphertext only.
    expect(JSON.stringify([...store.rows.values()])).not.toContain('first')

    await syncB.pass()
    await settled(b.service)
    const onB = b.service.status().instances
    expect(onB.map(i => [i.id, i.num, i.provider, i.name, i.loggedIn])).toEqual([[account.id, 1, 'claude', 'Example account', true]])
    const fileB = b.host.sessionFile(onB[0]!)
    expect(signedInAs(fileB)).toBe('first')

    // Signed in again on B: the later sign-in goes up and lands on A.
    writeLogin(fileB, 'claude', sessionKey('second', 1_900_500_000))
    await syncB.pass()
    await syncA.pass()
    await settled(a.service)
    expect(signedInAs(fileA)).toBe('second')
    // An older login written back on A (an operation that started before the landing) does not go up.
    writeLogin(fileA, 'claude', sessionKey('first', 1_900_000_000))
    await syncA.pass()
    await settled(a.service)
    expect(signedInAs(fileA)).toBe('second')

    // Logged out on A: B, still on that login, logs out too.
    await a.service.logout(account.id)
    await syncA.pass()
    await syncB.pass()
    expect(existsSync(fileB)).toBe(false)
    expect(b.service.status().instances[0]!.loggedIn).toBe(false)
  } finally {
    store.stop()
  }
})
