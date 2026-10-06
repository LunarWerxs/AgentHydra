// The browser pane's server: the saved-browser store reader, the routes and the live websocket. The store is a temp
// folder of invented profiles (HYDRA_DESK_BROWSER_STORE); a running Chrome is faked with a small server that answers
// like DevTools, plus (when Chrome is installed) one real headless Chrome on a temp profile.

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserLiveOut, BrowserOpened, BrowserProfiles, BrowserTab } from '@shared/browser'
import { findChrome } from '../../src/browser/cdp'
import { createServer, type DeskServer } from '../../src/index'
import { cleanTemps, commitAll, git, initRepo, tempDir } from '../git/helpers'

setDefaultTimeout(60_000)

const servers: DeskServer[] = []
const fakes: { stop(force?: boolean): unknown }[] = []
const saved = { store: process.env.HYDRA_DESK_BROWSER_STORE, chrome: process.env.HYDRA_DESK_CHROME }

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const f of fakes.splice(0)) await f.stop(true)
  for (const k of ['store', 'chrome'] as const) {
    const name = k === 'store' ? 'HYDRA_DESK_BROWSER_STORE' : 'HYDRA_DESK_CHROME'
    if (saved[k] === undefined) delete process.env[name]
    else process.env[name] = saved[k]
  }
})
// Chrome's helper processes can hold a profile folder for a moment after it is killed: retry, then leave it to the OS.
afterAll(async () => {
  for (let i = 0; i < 10; i++) {
    try {
      cleanTemps()
      return
    } catch {
      await Bun.sleep(300)
    }
  }
})

const WS_PROJ = 'proj-aaaa1111'
const WS_OTHER = 'other-bbbb2222'
const write = (file: string, data: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
}

/** A store of invented profiles: workspace Proj owns alpha and beta, Other owns gamma, 'legacy' belongs to nobody. */
function makeStore(opts: { projPath?: string; registry?: unknown } = {}): { root: string; base: string } {
  const base = tempDir('desk-browser-')
  const root = join(base, 'browser-profiles')
  process.env.HYDRA_DESK_BROWSER_STORE = root
  for (const p of [`ws/${WS_PROJ}/alpha`, `ws/${WS_PROJ}/beta`, `ws/${WS_OTHER}/gamma`, 'legacy', 'default']) mkdirSync(join(root, p), { recursive: true })
  write(join(root, 'workspaces.json'), {
    [WS_PROJ]: { workspace: opts.projPath ?? 'c:/Users/me/Proj' },
    [WS_OTHER]: { workspace: 'c:/Users/me/Other' },
  })
  write(
    join(root, 'registry.json'),
    opts.registry ?? {
      profiles: {
        [`${WS_PROJ}/alpha`]: { sessionHosts: ['github.com', 'example.com'], note: 'the example.com admin login', noteAt: '2026-10-01T10:00:00.000Z' },
        [`${WS_PROJ}/beta`]: { sessionHosts: [] },
        [`${WS_OTHER}/gamma`]: { note: 'other project' },
      },
    },
  )
  write(join(base, 'browser-profile-logins.json'), {
    [`${WS_PROJ}/alpha`]: {
      'example.com': { state: 'reached', title: 'Admin', at: '2026-10-02T09:00:00.000Z' },
      'github.com': { state: 'signin-wall', title: 'Sign in', at: '2026-10-03T09:00:00.000Z' },
    },
  })
  return { root, base }
}

async function boot(): Promise<DeskServer> {
  const plugins = tempDir('desk-plugins-')
  write(join(plugins, '65-browser.ts'), `export { default } from ${JSON.stringify(join(import.meta.dir, '../../src/plugins/65-browser.ts'))}\n`)
  const desk = await createServer({ port: 0, home: tempDir('desk-home-'), pluginsDir: plugins })
  servers.push(desk)
  return desk
}

/** A server answering like a Chrome's DevTools port, with the DevToolsActivePort file a real one writes in `dir`. */
function fakeChrome(dir: string, tabId: string): { port: number } {
  const guid = `/devtools/browser/${tabId}-guid`
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/json/version') return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1/${guid}` })
      if (path === '/json/list')
        return Response.json([
          { id: 'worker1', type: 'service_worker', url: 'x', title: 'x' },
          { id: tabId, type: 'page', url: `https://example.com/${tabId}`, title: `Page ${tabId}` },
        ])
      return new Response('no', { status: 404 })
    },
  })
  fakes.push(server)
  write(join(dir, 'DevToolsActivePort'), `${server.port}\n${guid}\n`)
  return { port: server.port as number }
}

const q = (p: Record<string, string>) => new URLSearchParams(p).toString()
const profiles = async (desk: DeskServer, cwd: string) => (await (await fetch(`${desk.url}/api/browser/profiles?${q({ cwd })}`)).json()) as BrowserProfiles
const post = (desk: DeskServer, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${desk.url}/api/browser/open`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('workspace of a chat', () => {
  test('matches the cwd whatever its case, slashes or trailing slash', async () => {
    makeStore()
    const desk = await boot()
    for (const cwd of ['c:/Users/me/Proj', 'C:\\Users\\Me\\PROJ', 'C:\\Users\\me\\Proj\\', 'c:/users/me//proj/']) {
      const r = await profiles(desk, cwd)
      expect(r.workspace).toBe(WS_PROJ)
      expect(r.profiles.map((p) => p.name)).toEqual(['alpha', 'beta'])
    }
  })

  test('a linked worktree and a subfolder of the repo belong to the main checkout', async () => {
    const repo = initRepo()
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    commitAll(repo)
    const wt = join(tempDir('desk-wt-'), 'feature')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt)
    mkdirSync(join(repo, 'sub'), { recursive: true })
    makeStore({ projPath: repo.replace(/\\/g, '/').toUpperCase() })
    const desk = await boot()
    expect((await profiles(desk, wt)).workspace).toBe(WS_PROJ)
    expect((await profiles(desk, join(repo, 'sub'))).workspace).toBe(WS_PROJ)
    expect((await profiles(desk, tempDir('desk-elsewhere-'))).workspace).toBeNull()
  })

  test('a folder of no workspace gets none of any workspace’s profiles', async () => {
    makeStore()
    const desk = await boot()
    const r = await profiles(desk, 'c:/Users/me/Nowhere')
    expect(r).toEqual({ workspace: null, profiles: [] })
  })
})

describe('profiles listed', () => {
  test('own ones carry note, sites newest first, session hosts and a last-used time; another workspace’s are never listed', async () => {
    makeStore()
    const desk = await boot()
    const r = await profiles(desk, 'c:/Users/me/Proj')
    expect(r.error).toBeUndefined()
    expect(r.profiles.map((p) => p.name)).not.toContain('gamma')
    const alpha = r.profiles.find((p) => p.name === 'alpha')
    expect(alpha).toMatchObject({
      own: true,
      open: false,
      note: 'the example.com admin login',
      sessionHosts: ['github.com', 'example.com'],
      sites: [
        { host: 'github.com', state: 'signin-wall', at: '2026-10-03T09:00:00.000Z' },
        { host: 'example.com', state: 'reached', at: '2026-10-02T09:00:00.000Z' },
      ],
    })
    expect(Number.isNaN(Date.parse(alpha?.lastUsedAt as string))).toBe(false)
    expect(r.profiles.find((p) => p.name === 'beta')?.note).toBeNull()
    // the other workspace's own chat sees only gamma
    expect((await profiles(desk, 'c:/Users/me/Other')).profiles.map((p) => p.name)).toEqual(['gamma'])
  })

  test('an unowned profile shows only while it is open, as not own', async () => {
    const { root } = makeStore()
    const desk = await boot()
    expect((await profiles(desk, 'c:/Users/me/Proj')).profiles.map((p) => p.name)).toEqual(['alpha', 'beta'])
    fakeChrome(join(root, 'legacy'), 'leg')
    fakeChrome(join(root, 'default'), 'def')
    const r = await profiles(desk, 'c:/Users/me/Proj')
    expect(r.profiles.map((p) => [p.name, p.own, p.open])).toEqual([
      ['alpha', true, false],
      ['beta', true, false],
      ['default', false, true],
      ['legacy', false, true],
    ])
    // and the same unowned browsers show for the other workspace too
    expect((await profiles(desk, 'c:/Users/me/Other')).profiles.map((p) => p.name)).toEqual(['default', 'gamma', 'legacy'])
  })

  test('a port file whose Chrome is gone, or whose endpoint is another launch’s, is not open', async () => {
    const { root } = makeStore()
    const desk = await boot()
    write(join(root, 'ws', WS_PROJ, 'alpha', 'DevToolsActivePort'), '1\n/devtools/browser/x\n')
    const other = fakeChrome(join(root, 'ws', WS_PROJ, 'beta'), 'b')
    write(join(root, 'ws', WS_PROJ, 'beta', 'DevToolsActivePort'), `${other.port}\n/devtools/browser/someone-else\n`)
    const r = await profiles(desk, 'c:/Users/me/Proj')
    expect(r.profiles.map((p) => p.open)).toEqual([false, false])
  })

  test('a missing store is an empty list and no error', async () => {
    process.env.HYDRA_DESK_BROWSER_STORE = join(tempDir('desk-nostore-'), 'nothing-here')
    const desk = await boot()
    expect(await profiles(desk, 'c:/Users/me/Proj')).toEqual({ workspace: null, profiles: [] })
  })

  test('a corrupt registry is an error field, and the profiles still list', async () => {
    const { root } = makeStore()
    write(join(root, 'registry.json'), '{ not json')
    const desk = await boot()
    const r = await profiles(desk, 'c:/Users/me/Proj')
    expect(r.error).toContain('registry.json')
    expect(r.profiles.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(r.profiles[0]?.note).toBeNull()
  })
})

describe('open and tabs', () => {
  test('an open own profile answers started:false with its first page; the port in the request is ignored', async () => {
    const { root } = makeStore()
    const desk = await boot()
    fakeChrome(join(root, 'ws', WS_PROJ, 'alpha'), 'real')
    const decoy = fakeChrome(join(root, 'ws', WS_OTHER, 'gamma'), 'decoy')
    const opened = (await (await post(desk, { cwd: 'c:/Users/me/Proj', profile: 'alpha', port: decoy.port })).json()) as BrowserOpened
    expect(opened).toEqual({ profile: 'alpha', started: false, tab: { id: 'real', url: 'https://example.com/real', title: 'Page real' } })
    const tabs = await fetch(`${desk.url}/api/browser/tabs?${q({ cwd: 'c:/Users/me/Proj', profile: 'alpha', port: String(decoy.port) })}`)
    expect(((await tabs.json()) as BrowserTab[]).map((t) => t.id)).toEqual(['real'])
  })

  test('another workspace’s profile, an unknown one and a closed unowned one are not found; a closed own one has no tabs', async () => {
    makeStore()
    const desk = await boot()
    expect((await post(desk, { cwd: 'c:/Users/me/Proj', profile: 'gamma' })).status).toBe(404)
    expect((await post(desk, { cwd: 'c:/Users/me/Proj', profile: 'nope' })).status).toBe(404)
    expect((await post(desk, { cwd: 'c:/Users/me/Proj', profile: 'legacy' })).status).toBe(404)
    expect((await post(desk, { cwd: 'c:/Users/me/Proj' })).status).toBe(400)
    expect((await fetch(`${desk.url}/api/browser/tabs?${q({ cwd: 'c:/Users/me/Proj', profile: 'alpha' })}`)).status).toBe(409)
    expect((await fetch(`${desk.url}/api/browser/tabs?${q({ cwd: 'c:/Users/me/Proj', profile: 'gamma' })}`)).status).toBe(404)
  })

  test('with no Chrome installed, opening says so', async () => {
    makeStore()
    process.env.HYDRA_DESK_CHROME = join(tempDir('desk-nochrome-'), 'chrome.exe')
    const desk = await boot()
    const res = await post(desk, { cwd: 'c:/Users/me/Proj', profile: 'alpha' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('Chrome is not installed')
    expect((await post(desk, { cwd: 'c:/Users/me/Proj', profile: 'alpha', url: 'javascript:alert(1)' })).status).toBe(400)
  })

  test('login:true starts the browser with no debugging port and answers started:true, tab:null', async () => {
    const { root } = makeStore()
    // Any program will do as the "Chrome": it is only started, and the answer must not wait for a port.
    process.env.HYDRA_DESK_CHROME = process.execPath
    const desk = await boot()
    const res = await post(desk, { cwd: 'c:/Users/me/Proj', profile: 'beta', login: true })
    expect(await res.json()).toEqual({ profile: 'beta', started: true, tab: null })
    expect(existsSync(join(root, 'ws', WS_PROJ, 'beta', 'DevToolsActivePort'))).toBe(false)
  })
})

describe('own-page guard', () => {
  test('a foreign or another local page’s Origin is refused on every route and the websocket upgrade', async () => {
    const { root } = makeStore()
    fakeChrome(join(root, 'ws', WS_PROJ, 'alpha'), 'real')
    const desk = await boot()
    const cwd = 'c:/Users/me/Proj'
    for (const origin of ['https://evil.example.com', 'http://localhost:9']) {
      const h = { origin }
      const upgrade = { ...h, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }
      expect((await fetch(`${desk.url}/api/browser/profiles?${q({ cwd })}`, { headers: h })).status).toBe(403)
      expect((await post(desk, { cwd, profile: 'alpha' }, h)).status).toBe(403)
      expect((await fetch(`${desk.url}/api/browser/tabs?${q({ cwd, profile: 'alpha' })}`, { headers: h })).status).toBe(403)
      expect((await fetch(`${desk.url}/api/browser/live?${q({ cwd, profile: 'alpha' })}`, { headers: upgrade })).status).toBe(403)
    }
    // Desk 2's own page passes.
    const own = { origin: desk.url }
    expect((await fetch(`${desk.url}/api/browser/profiles?${q({ cwd })}`, { headers: own })).status).toBe(200)
  })
})

// --- a real Chrome ---------------------------------------------------------------------------------------------

const chrome = findChrome()

/** Collects what the live socket sends; `until` waits for the first message matching. */
function liveSocket(url: string) {
  const got: BrowserLiveOut[] = []
  const ws = new WebSocket(url)
  const waiters: { match: (m: BrowserLiveOut) => boolean; resolve: (m: BrowserLiveOut) => void }[] = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as BrowserLiveOut
    got.push(msg)
    for (const w of [...waiters]) if (w.match(msg)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(msg))
  }
  const until = (match: (m: BrowserLiveOut) => boolean, ms = 20_000) => {
    const seen = got.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise<BrowserLiveOut>((resolve, reject) => {
      waiters.push({ match, resolve })
      setTimeout(() => reject(new Error(`timed out; got ${got.map((m) => m.type).join(',')}`)), ms)
    })
  }
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('socket error'))
  })
  return { ws, got, until, opened }
}

const preview = (desk: DeskServer, cwd: string, profile: string, headers: Record<string, string> = {}) =>
  fetch(`${desk.url}/api/browser/preview?${q({ cwd, profile })}`, { headers })

describe('preview', () => {
  test('a closed or unknown profile is 404, another workspace’s is 403, a foreign page is 403, and none of them starts a Chrome', async () => {
    makeStore()
    const desk = await boot()
    expect((await preview(desk, 'c:/Users/me/Proj', 'alpha')).status).toBe(404)
    expect((await preview(desk, 'c:/Users/me/Proj', 'nope')).status).toBe(404)
    expect((await preview(desk, 'c:/Users/me/Proj', 'legacy')).status).toBe(404)
    expect((await preview(desk, 'c:/Users/me/Proj', 'gamma')).status).toBe(403)
    expect((await preview(desk, 'c:/Users/me/Proj', 'alpha', { origin: 'http://evil.example.com' })).status).toBe(403)
    expect((await fetch(`${desk.url}/api/browser/preview?${q({ cwd: 'c:/Users/me/Proj' })}`)).status).toBe(400)
  })
})

describe.skipIf(!chrome)('preview of a real headless Chrome', () => {
  let pid = 0
  afterEach(() => {
    if (pid) killTree(pid)
    pid = 0
  })

  test('answers a small uncached JPEG of the page', async () => {
    const { root } = makeStore()
    const dir = join(root, 'ws', WS_PROJ, 'alpha')
    const site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<title>Invented page</title><h1>Hello</h1>', { headers: { 'content-type': 'text/html' } }) })
    fakes.push(site)
    const proc = Bun.spawn(
      [chrome as string, '--headless=new', `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `http://127.0.0.1:${site.port}/`],
      { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', windowsHide: true },
    )
    pid = proc.pid
    const until = Date.now() + 20_000
    while (!existsSync(join(dir, 'DevToolsActivePort')) && Date.now() < until) await Bun.sleep(100)
    const desk = await boot()
    let res = await preview(desk, 'c:/Users/me/Proj', 'alpha')
    for (let i = 0; i < 50 && res.status !== 200; i++) {
      await Bun.sleep(150)
      res = await preview(desk, 'c:/Users/me/Proj', 'alpha')
    }
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff])
    expect(bytes.length).toBeGreaterThan(500)
    // Sized by the JPEG's own header: SOF0/SOF2 hold height then width.
    let w = 0
    for (let i = 2; i < bytes.length - 9; i++) {
      if (bytes[i] === 0xff && (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2)) {
        w = (bytes[i + 7] << 8) | bytes[i + 8]
        break
      }
    }
    expect(w).toBeGreaterThan(0)
    expect(w).toBeLessThanOrEqual(640)
  })
})

describe.skipIf(!chrome)('live view of a real headless Chrome', () => {
  let pid = 0
  afterEach(() => {
    if (pid) killTree(pid)
    pid = 0
  })

  test('frames arrive, navigation is reported, a non-http address is refused, and closing the browser ends the view', async () => {
    const { root } = makeStore()
    const dir = join(root, 'ws', WS_PROJ, 'alpha')
    const site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<title>Invented page</title><h1>Hello</h1>', { headers: { 'content-type': 'text/html' } }) })
    fakes.push(site)
    const proc = Bun.spawn(
      [chrome as string, '--headless=new', `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'],
      { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', windowsHide: true },
    )
    pid = proc.pid
    const until = Date.now() + 20_000
    while (!existsSync(join(dir, 'DevToolsActivePort')) && Date.now() < until) await Bun.sleep(100)
    expect(existsSync(join(dir, 'DevToolsActivePort'))).toBe(true)

    const desk = await boot()
    const cwd = 'c:/Users/me/Proj'
    // The page target can lag the port by a moment.
    let tabs: BrowserTab[] = []
    for (let i = 0; i < 50 && tabs.length === 0; i++) {
      const res = await fetch(`${desk.url}/api/browser/tabs?${q({ cwd, profile: 'alpha' })}`)
      if (res.ok) tabs = (await res.json()) as BrowserTab[]
      if (tabs.length === 0) await Bun.sleep(100)
    }
    expect(tabs.length).toBeGreaterThan(0)
    expect((await profiles(desk, cwd)).profiles.find((p) => p.name === 'alpha')?.open).toBe(true)

    const live = liveSocket(`${desk.url.replace('http', 'ws')}/api/browser/live?${q({ cwd, profile: 'alpha' })}`)
    await live.opened
    const frame = await live.until((m) => m.type === 'frame')
    expect(frame).toMatchObject({ type: 'frame' })
    expect((frame as Extract<BrowserLiveOut, { type: 'frame' }>).data.length).toBeGreaterThan(100)
    expect((frame as Extract<BrowserLiveOut, { type: 'frame' }>).width).toBeGreaterThan(0)

    // While the pane streams the page, a preview is that stream's newest frame, not a second capture.
    const shown = await preview(desk, cwd, 'alpha')
    expect(shown.status).toBe(200)
    const bytes = Buffer.from(await shown.arrayBuffer()).toString('base64')
    expect(live.got.some((m) => m.type === 'frame' && m.data === bytes)).toBe(true)

    live.ws.send(JSON.stringify({ type: 'navigate', url: 'data:text/html,<p>no</p>' }))
    live.ws.send(JSON.stringify({ type: 'navigate', url: `http://127.0.0.1:${site.port}/hello` }))
    const page = await live.until((m) => m.type === 'page' && m.tab.url.includes(`127.0.0.1:${site.port}/hello`))
    expect(page).toMatchObject({ type: 'page', canGoBack: true, canGoForward: false })
    expect(live.got.some((m) => m.type === 'page' && m.tab.url.startsWith('data:'))).toBe(false)

    live.ws.send(JSON.stringify({ type: 'history', go: 'back' }))
    await live.until((m) => m.type === 'page' && m.tab.url === 'about:blank' && m.canGoForward)

    // The browser goes away: the view says so and the socket closes.
    const closed = new Promise<void>((res) => (live.ws.onclose = () => res()))
    killTree(pid)
    pid = 0
    await live.until((m) => m.type === 'closed')
    await closed
  })
})

function killTree(pid: number): void {
  if (process.platform === 'win32') Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
  else process.kill(pid, 'SIGKILL')
}
