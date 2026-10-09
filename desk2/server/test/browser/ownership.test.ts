// Which chat sees which page of a shared saved browser: a faked Chrome (DevTools' /json endpoints) with a ledger file
// (.connections-tabs.json) beside the profile, two invented chats, and the routes of plugins/65-browser.ts.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserOpened, BrowserTab } from '@shared/browser'
import { TabScope } from '../../src/browser/ownership'
import { createServer, type DeskServer } from '../../src/index'
import { tempDir } from '../git/helpers'

setDefaultTimeout(30_000)

const servers: DeskServer[] = []
const fakes: { stop(force?: boolean): unknown }[] = []
const saved = process.env.HYDRA_DESK_BROWSER_STORE
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const f of fakes.splice(0)) await f.stop(true)
  if (saved === undefined) delete process.env.HYDRA_DESK_BROWSER_STORE
  else process.env.HYDRA_DESK_BROWSER_STORE = saved
})

const SLUG = 'proj-aaaa1111'
const CWD = 'c:/Users/me/Proj'
const write = (file: string, data: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
}

/** Two Desk chats, c1 and c2; c2 continued from an earlier session (an heir). */
const SESSIONS: Record<string, string[]> = { c1: ['sess-1'], c2: ['sess-2-new', 'sess-2-old'] }

interface Fake {
  dir: string
  tabs: BrowserTab[]
}

/** One profile 'alpha' of workspace Proj with a faked running Chrome holding `ids` as pages. */
function setup(ids: string[], ledger?: Record<string, { chat: string; at: string }>): Fake {
  const base = tempDir('desk-own-')
  const root = join(base, 'browser-profiles')
  process.env.HYDRA_DESK_BROWSER_STORE = root
  const dir = join(root, 'ws', SLUG, 'alpha')
  mkdirSync(dir, { recursive: true })
  write(join(root, 'workspaces.json'), { [SLUG]: { workspace: CWD } })
  write(join(root, 'registry.json'), { profiles: { [`${SLUG}/alpha`]: {} } })
  if (ledger) write(join(dir, '.connections-tabs.json'), { v: 1, tabs: ledger })
  const tabs: BrowserTab[] = ids.map((id) => ({ id, url: `https://example.com/${id}`, title: `Page ${id}` }))
  let n = 0
  const guid = '/devtools/browser/own-guid'
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/json/version') return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1${guid}` })
      if (u.pathname === '/json/list') return Response.json(tabs.map((t) => ({ ...t, type: 'page' })))
      if (u.pathname === '/json/new' && req.method === 'PUT') {
        const t = { id: `new${++n}`, url: decodeURIComponent(u.search.slice(1)), title: '' }
        tabs.push(t)
        return Response.json({ ...t, type: 'page' })
      }
      if (u.pathname.startsWith('/json/close/')) {
        const i = tabs.findIndex((t) => t.id === decodeURIComponent(u.pathname.slice('/json/close/'.length)))
        if (i >= 0) tabs.splice(i, 1)
        return new Response('Target is closing')
      }
      return new Response('no', { status: 404 })
    },
  })
  fakes.push(server)
  write(join(dir, 'DevToolsActivePort'), `${server.port}\n${guid}\n`)
  return { dir, tabs }
}

/** A CliMayte worker as the bridge reports it: its own sessions and the session that dispatched it. */
interface FakeWorker {
  originSessionId: string
  sessions: string[]
}

async function boot(workers: FakeWorker[] = []): Promise<DeskServer> {
  const plugins = tempDir('desk-plugins-')
  write(join(plugins, '65-browser.ts'), `export { default } from ${JSON.stringify(join(import.meta.dir, '../../src/plugins/65-browser.ts'))}\n`)
  const desk = await createServer({
    port: 0,
    home: tempDir('desk-home-'),
    pluginsDir: plugins,
    deps: {
      chatSessions: (id: string) => SESSIONS[id] ?? [],
      bridge: { workers: async () => workers },
    },
  })
  servers.push(desk)
  return desk
}

const q = (p: Record<string, string>) => new URLSearchParams(p).toString()
const json = { 'content-type': 'application/json' }
const open = (desk: DeskServer, chat?: string) =>
  fetch(`${desk.url}/api/browser/open`, { method: 'POST', headers: json, body: JSON.stringify({ cwd: CWD, profile: 'alpha', ...(chat ? { chat } : {}) }) }).then((r) => r.json() as Promise<BrowserOpened>)
const tabsOf = async (desk: DeskServer, chat?: string) =>
  ((await (await fetch(`${desk.url}/api/browser/tabs?${q({ cwd: CWD, profile: 'alpha', ...(chat ? { chat } : {}) })}`)).json()) as BrowserTab[]).map((t) => t.id)
const live = (desk: DeskServer, chat: string, tab: string) =>
  fetch(`${desk.url}/api/browser/live?${q({ cwd: CWD, profile: 'alpha', chat, tab })}`, {
    headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
  })

const LEDGER = {
  a1: { chat: 'sess-1', at: '2020-01-07T10:00:00.000Z' },
  b1: { chat: 'sess-2-old', at: '2020-01-07T10:05:00.000Z' },
}

describe('two chats on one profile', () => {
  test('each gets its own page from open, and sees only its own pages and unowned ones (an heir keeps its predecessor’s page)', async () => {
    setup(['a1', 'b1', 'free1'], LEDGER)
    const desk = await boot()
    expect((await open(desk, 'c1')).tab?.id).toBe('a1')
    expect((await open(desk, 'c2')).tab?.id).toBe('b1')
    expect(await tabsOf(desk, 'c1')).toEqual(['a1', 'free1'])
    expect(await tabsOf(desk, 'c2')).toEqual(['b1', 'free1'])
  })

  test('a chat with several pages gets the one driven last', async () => {
    setup(['a1', 'a2', 'b1'], { ...LEDGER, a2: { chat: 'sess-1', at: '2020-01-07T11:00:00.000Z' } })
    const desk = await boot()
    expect((await open(desk, 'c1')).tab?.id).toBe('a2')
  })

  test('a ?tab= of the other chat’s page is refused; a page that is not open is 404', async () => {
    setup(['a1', 'b1', 'free1'], LEDGER)
    const desk = await boot()
    const res = await live(desk, 'c1', 'b1')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain('another chat')
    expect((await live(desk, 'c1', 'nope')).status).toBe(404)
  })

  test('closing the other chat’s page is refused and leaves it open', async () => {
    const f = setup(['a1', 'b1'], LEDGER)
    const desk = await boot()
    const res = await fetch(`${desk.url}/api/browser/page/close`, { method: 'POST', headers: json, body: JSON.stringify({ cwd: CWD, profile: 'alpha', chat: 'c1', tab: 'b1' }) })
    expect(res.status).toBe(403)
    expect(f.tabs.map((t) => t.id)).toEqual(['a1', 'b1'])
  })

  test('every open page belongs to another chat: a new blank page is opened, and it is this chat’s alone', async () => {
    const f = setup(['b1'], LEDGER)
    const desk = await boot()
    expect((await open(desk, 'c1')).tab?.id).toBe('new1')
    expect(f.tabs.map((t) => t.id)).toEqual(['b1', 'new1'])
    expect((await open(desk, 'c1')).tab?.id).toBe('new1')
    expect(await tabsOf(desk, 'c1')).toEqual(['new1'])
    expect(await tabsOf(desk, 'c2')).toEqual(['b1'])
  })

  test('a page opened from a chat’s pane is that chat’s, never shown in another chat’s', async () => {
    setup(['b1'], LEDGER)
    const desk = await boot()
    const res = await fetch(`${desk.url}/api/browser/page`, { method: 'POST', headers: json, body: JSON.stringify({ cwd: CWD, profile: 'alpha', chat: 'c1', url: 'https://example.com/x' }) })
    const made = (await res.json()) as BrowserTab
    expect(await tabsOf(desk, 'c1')).toEqual([made.id])
    expect(await tabsOf(desk, 'c2')).toEqual(['b1'])
  })

  test('the preview of a chat with no page of its own is 404, never the other chat’s page', async () => {
    setup(['b1'], LEDGER)
    const desk = await boot()
    const res = await fetch(`${desk.url}/api/browser/preview?${q({ cwd: CWD, profile: 'alpha', chat: 'c1' })}`)
    expect(res.status).toBe(404)
  })
})

describe('pages of the CliMayte workers a chat dispatched', () => {
  const WORKERS: FakeWorker[] = [
    { originSessionId: 'sess-1', sessions: ['worker-sess'] },
    { originSessionId: 'worker-sess', sessions: ['sub-worker-sess'] },
    { originSessionId: 'sess-2-new', sessions: ['other-worker-sess'] },
  ]
  const WORKER_LEDGER = {
    w1: { chat: 'worker-sess', at: '2020-01-07T10:00:00.000Z' },
    s1: { chat: 'sub-worker-sess', at: '2020-01-07T10:01:00.000Z' },
    o1: { chat: 'other-worker-sess', at: '2020-01-07T10:02:00.000Z' },
  }

  test('a page a worker opens is in its parent chat’s list, its sub-worker’s too, and not in an unrelated chat’s', async () => {
    setup(['w1', 's1', 'o1', 'free1'], WORKER_LEDGER)
    const desk = await boot(WORKERS)
    expect(await tabsOf(desk, 'c1')).toEqual(['w1', 's1', 'free1'])
    expect(await tabsOf(desk, 'c2')).toEqual(['o1', 'free1'])
  })

  test('the parent chat can close its worker’s page, and another chat cannot', async () => {
    const f = setup(['w1', 'free1'], WORKER_LEDGER)
    const desk = await boot(WORKERS)
    const close = (chat: string) => fetch(`${desk.url}/api/browser/page/close`, { method: 'POST', headers: json, body: JSON.stringify({ cwd: CWD, profile: 'alpha', chat, tab: 'w1' }) })
    expect((await close('c2')).status).toBe(403)
    expect((await close('c1')).status).toBe(200)
    expect(f.tabs.map((t) => t.id)).toEqual(['free1'])
  })
})

describe('a browser with no ledger', () => {
  test('every page is unowned: the first one and the whole list, for any chat or none', async () => {
    setup(['p1', 'p2'])
    const desk = await boot()
    expect((await open(desk, 'c1')).tab?.id).toBe('p1')
    expect((await open(desk, 'c2')).tab?.id).toBe('p1')
    expect((await open(desk)).tab?.id).toBe('p1')
    expect(await tabsOf(desk, 'c1')).toEqual(['p1', 'p2'])
    expect(await tabsOf(desk)).toEqual(['p1', 'p2'])
  })

  test('a ledger that cannot be read is no ledger', () => {
    const f = setup(['p1'])
    write(join(f.dir, '.connections-tabs.json'), '{ not json')
    expect(new TabScope(f.dir, 'c1', ['s']).visible(f.tabs)).toEqual(f.tabs)
  })
})

describe('TabScope', () => {
  test('a page owned by a non-Desk owner is no Desk chat’s', () => {
    const f = setup(['m1', 'free'], { m1: { chat: 'mcp:other', at: '2020-01-07T10:00:00.000Z' } })
    const scope = new TabScope(f.dir, 'c1', ['sess-1'])
    expect(scope.visible(f.tabs).map((t) => t.id)).toEqual(['free'])
    expect(scope.best(f.tabs)?.id).toBe('free')
  })
})
