import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeskSettings, ServerEvent } from '@shared/protocol'
import { createServer, type DeskServer } from '../src/index'
import { DEFAULT_SETTINGS } from '../src/settings'

const temps: string[] = []
const servers: DeskServer[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

async function boot(home: string, pluginsDir?: string): Promise<DeskServer> {
  // An empty plugins dir by default, so the real plugins other workers add never run in these tests.
  const desk = await createServer({ port: 0, home, pluginsDir: pluginsDir ?? tempDir('desk-plugins-') })
  servers.push(desk)
  return desk
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function firstMessage(url: string): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
    const timer = setTimeout(() => reject(new Error('no ws message within 5s')), 5000)
    ws.onmessage = (e) => {
      clearTimeout(timer)
      ws.close()
      resolve(JSON.parse(String(e.data)))
    }
    ws.onerror = () => reject(new Error('ws error'))
  })
}

describe('scaffold server', () => {
  test('GET /api/health answers ok with the version', async () => {
    const desk = await boot(tempDir('desk-home-'))
    const res = await fetch(`${desk.url}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: string }
    expect(body.ok).toBe(true)
    expect(typeof body.version).toBe('string')
  })

  test('settings: defaults, PUT merges one field, persists across a fresh server', async () => {
    const home = tempDir('desk-home-')
    const desk = await boot(home)
    expect(await (await fetch(`${desk.url}/api/settings`)).json()).toEqual(DEFAULT_SETTINGS)

    const put = await fetch(`${desk.url}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idleCloseMinutes: 45 }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ ...DEFAULT_SETTINGS, idleCloseMinutes: 45 })

    const bad = await fetch(`${desk.url}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultPermissionMode: 'yolo' }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('defaultPermissionMode')

    await desk.stop()
    servers.splice(servers.indexOf(desk), 1)
    const again = await boot(home)
    const settings = (await (await fetch(`${again.url}/api/settings`)).json()) as DeskSettings
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, idleCloseMinutes: 45 })
  })

  test('/ws sends a hello event carrying the settings', async () => {
    const desk = await boot(tempDir('desk-home-'))
    const hello = await firstMessage(desk.url)
    expect(hello).toEqual({ type: 'hello', version: desk.ctx.version, chats: [], settings: DEFAULT_SETTINGS })
  })

  test('loads a plugin from pluginsDir with (app, ctx), in file-name order', async () => {
    const plugins = tempDir('desk-plugins-')
    writeFileSync(
      join(plugins, '20-second.ts'),
      `export default function (app, ctx) {
        app.get('/api/probe', (c) => c.json({ order: ctx.deps.order, home: ctx.home, fake: ctx.deps.fake }))
      }`,
    )
    writeFileSync(join(plugins, '10-first.ts'), `export default async function (app, ctx) { ctx.deps.order = ['first'] }`)
    mkdirSync(join(plugins, 'not-a-plugin'))
    const home = tempDir('desk-home-')
    const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { fake: 'injected' } })
    servers.push(desk)
    const res = await fetch(`${desk.url}/api/probe`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ order: ['first'], home: desk.ctx.home, fake: 'injected' })
  })
})
