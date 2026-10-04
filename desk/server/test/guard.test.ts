// The local-only guard (index.ts localOnly / foreignRequest): another site's page, or a DNS name rebound to
// 127.0.0.1, gets a 403 from every route and from the /ws upgrade. The window, Vite's dev server on its own
// port and clients that send no Host or Origin (curl, the SDK, tests) pass.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createServer, type DeskServer, foreignRequest, localOnly } from '../src/index'

const temps: string[] = []
const servers: DeskServer[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const app = new Hono()
app.use('*', localOnly)
app.post('/api/folders/reveal', (c) => c.json({ ok: true }))

const ask = (headers: Record<string, string>) => app.request('/api/folders/reveal', { method: 'POST', headers })

const PASS: Record<string, string>[] = [
  {},
  { host: '127.0.0.1:7795' },
  { host: 'localhost' },
  { host: '[::1]:7795' },
  { host: '127.0.0.1:7795', origin: 'http://127.0.0.1:7795', 'sec-fetch-site': 'same-origin' },
  // Vite's dev server proxies with the browser's own Host and Origin
  { host: 'localhost:4795', origin: 'http://localhost:4795', 'sec-fetch-site': 'same-origin' },
  { host: 'LOCALHOST:7795', origin: 'http://[::1]:5173', 'sec-fetch-site': 'same-site' },
]

const REFUSE: Record<string, string>[] = [
  { host: 'evil.example' },
  { host: 'rebound.evil.example:7795' },
  { host: '127.0.0.1.evil.example:7795' },
  { host: 'evil.example@127.0.0.1:7795' },
  { host: '192.168.1.20:7795' },
  { origin: 'https://evil.example' },
  { origin: 'http://127.0.0.1.evil.example' },
  { origin: 'null' },
  { host: '127.0.0.1:7795', origin: 'https://evil.example' },
  { host: '127.0.0.1:7795', 'sec-fetch-site': 'cross-site' },
]

describe('foreignRequest', () => {
  test('passes this machine on any port and requests without the headers', () => {
    for (const h of PASS) expect(foreignRequest(new Headers(h))).toBeNull()
  })

  test('refuses another host, another origin and a cross-site fetch', () => {
    for (const h of REFUSE) expect(typeof foreignRequest(new Headers(h))).toBe('string')
  })
})

describe('localOnly', () => {
  test('a route answers this machine and 403 {error} to anything else', async () => {
    for (const h of PASS) expect((await ask(h)).status).toBe(200)
    for (const h of REFUSE) {
      const res = await ask(h)
      expect(res.status).toBe(403)
      expect(typeof ((await res.json()) as { error?: unknown }).error).toBe('string')
    }
  })

  test('the real server refuses another origin on its routes and its websocket upgrade', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-guard-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-guard-plugins-'))
    temps.push(home, plugins)
    const desk = await createServer({ port: 0, home, pluginsDir: plugins })
    servers.push(desk)

    expect((await fetch(`${desk.url}/api/health`)).status).toBe(200)
    const health = await fetch(`${desk.url}/api/health`, { headers: { origin: 'https://evil.example' } })
    expect(health.status).toBe(403)
    expect(((await health.json()) as { error: string }).error).toContain('evil.example')
    expect((await fetch(`${desk.url}/api/settings`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    // /ws is answered outside Hono: the guard comes before the upgrade
    expect((await fetch(`${desk.url}/ws`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${desk.url}/ws`)).status).toBe(426)
  })
})
