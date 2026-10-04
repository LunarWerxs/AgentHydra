// The folder menu's REST rows through the real server (plugins/20-engine.ts), with a fake folder dialog:
// GET/POST/DELETE /api/folders/recent and POST /api/folders/pick.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type DeskServer } from '../../src/index'
import { PickError } from '../../src/folders/pick'
import { fakeBridge, fakeQueries } from '../engine/manager/fakes'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '20-engine.ts')

const temps: string[] = []
const servers: DeskServer[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

/** The dialog's answers in order, and the start folder it was asked to open in each time. */
function fakeDialog(answers: (string | null | Error)[]) {
  const starts: (string | null)[] = []
  const pickFolder = async (start: string | null) => {
    starts.push(start)
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next ?? null
  }
  return { pickFolder, starts }
}

async function boot(pickFolder: (start: string | null) => Promise<string | null>): Promise<DeskServer> {
  const plugins = temp('desk-folders-plugins-')
  writeFileSync(join(plugins, '20-engine.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  const desk = await createServer({
    port: 0,
    home: temp('desk-folders-home-'),
    pluginsDir: plugins,
    deps: { newChats: 'sdk', queryImpl: fakeQueries().queryImpl, bridge: fakeBridge().bridge, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, pickFolder },
  })
  servers.push(desk)
  return desk
}

async function call<T = any>(desk: DeskServer, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await fetch(desk.url + path, init)
  return { status: res.status, body: (await res.json()) as T }
}

const q = (path: string) => `/api/folders/recent?path=${encodeURIComponent(path)}`

describe('folder menu routes', () => {
  test('Add new folder: the dialog opens beside the current folder and the folder chosen tops Recent', async () => {
    const root = temp('desk-folders-')
    const [current, picked] = ['current', 'picked'].map((n) => join(root, n))
    for (const d of [current, picked]) mkdirSync(d)
    const dialog = fakeDialog([picked, null, new PickError('the dialog broke'), '\\\\server\\share\\project'])
    const desk = await boot(dialog.pickFolder)

    expect(await call(desk, 'POST', '/api/folders/pick', { current })).toEqual({ status: 200, body: { path: picked } })
    expect(dialog.starts).toEqual([root])
    expect((await call(desk, 'GET', '/api/folders/recent')).body).toEqual([picked])

    expect(await call(desk, 'POST', '/api/folders/pick', {})).toEqual({ status: 200, body: { path: null } }) // cancelled
    expect(dialog.starts[1]).toBeNull()
    expect(await call(desk, 'POST', '/api/folders/pick', { current })).toEqual({ status: 502, body: { error: 'the dialog broke' } })
    const network = await call(desk, 'POST', '/api/folders/pick', { current })
    expect(network.status).toBe(400)
    expect(network.body.error).toMatch(/network folders/)
    expect((await call(desk, 'GET', '/api/folders/recent')).body).toEqual([picked])
  })

  test('choosing puts a folder on top, the X takes it off; both answer the new list', async () => {
    const root = temp('desk-folders-')
    const [a, b] = ['a', 'b'].map((n) => join(root, n))
    for (const d of [a, b]) mkdirSync(d)
    const desk = await boot(fakeDialog([]).pickFolder)

    expect((await call(desk, 'POST', '/api/folders/recent', { path: b })).body).toEqual([b])
    expect((await call(desk, 'POST', '/api/folders/recent', { path: a })).body).toEqual([a, b])
    expect((await call(desk, 'DELETE', q(a))).body).toEqual([b])
    expect((await call(desk, 'GET', '/api/folders/recent')).body).toEqual([b])

    expect((await call(desk, 'POST', '/api/folders/recent', { path: 'relative' })).status).toBe(400)
    expect((await call(desk, 'POST', '/api/folders/recent', { path: join(root, 'missing') })).status).toBe(400)
    expect((await call(desk, 'DELETE', q('relative'))).status).toBe(400)
  })
})
