// Startup, idle and size meter (bun e2e/perf.e2e.ts; Windows, Edge, after `bun run build`): measures a throwaway Desk built
// from PERF_DESK (default this folder, so an old checkout is measured the same way) and writes PERF_OUT (default
// tmp/perf.json). Never the live window: the server runs hidden on a free port with a temp HYDRA_DESK_HOME (a throwaway: no
// Login sync, no Free runtime), headless Edge on a temp profile, and both are removed when the run ends, together with a
// dev-servers service started under that temp home. /ah/api goes on to the live AgentHydra daemon, read only.
//
// What it records (counts and bytes repeat run to run; milliseconds are judged only against their own spread):
//   bundle   bytes and gzip bytes of web/dist and hydra/dist, and of what each index.html loads before first paint
//   startup  PERF_RUNS cold starts: process start to /api/health answering (ms)
//   page     the window's Navigation Timing, first contentful paint, shell drawn, first sidebar row, requests and bytes
//   idle     for each scenario (visible: the window open in front; hidden: another tab in front; pane: AgentHydra slid in;
//            nowindow: no page at all), over PERF_IDLE_S seconds: the page's requests, bytes and main-thread ms, and the
//            server's CPU ms, processes started, outbound requests (counted by e2e/lib/perf-preload.ts) and memory
//   localhost the /dw/localhost scan: ms and processes started per call
// Prints the summary; PERF_ONLY=bundle,startup,page,idle,localhost,service picks phases.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { freePort } from './lib/free-port'

const DESK = resolve(process.env.PERF_DESK || resolve(import.meta.dir, '..'))
const OUT = resolve(process.env.PERF_OUT || join(import.meta.dir, '..', 'tmp', 'perf.json'))
const RUNS = Number(process.env.PERF_RUNS) || 5
const IDLE_S = Number(process.env.PERF_IDLE_S) || 60
const ONLY = new Set((process.env.PERF_ONLY || 'bundle,startup,page,idle,localhost,service').split(','))
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PRELOAD = join(import.meta.dir, 'lib', 'perf-preload.ts')

/** Every Desk home and Edge profile of a run nests in this one temp root, which goes when the run exits, however it ends. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'desk2-perf-'))
process.on('exit', () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {}
})
let scratchMade = 0
function scratchDir(name: string): string {
  const dir = join(SCRATCH, `${name}-${++scratchMade}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN
}
const round = (n: number) => Math.round(n * 10) / 10

const result: Record<string, unknown> = { desk: DESK, at: new Date().toISOString(), idleSeconds: IDLE_S }
const cleanup: (() => void | Promise<void>)[] = []

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}
function bundle(dist: string) {
  const files = walk(dist)
  const by: Record<string, { files: number; bytes: number; gzip: number }> = {}
  for (const f of files) {
    const ext = f.split('.').pop() ?? ''
    const kind = ['js', 'css'].includes(ext) ? ext : ['woff2', 'woff', 'ttf'].includes(ext) ? 'font' : 'other'
    const buf = readFileSync(f)
    by[kind] ??= { files: 0, bytes: 0, gzip: 0 }
    by[kind].files++
    by[kind].bytes += buf.length
    by[kind].gzip += kind === 'font' ? buf.length : Bun.gzipSync(buf).length
  }
  // What index.html asks for before the page can paint: its module script, modulepreloads and stylesheets.
  const html = existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : ''
  const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+\.(?:js|css))"/g)].map((m) => m[1])
  let startBytes = 0
  let startGzip = 0
  for (const ref of refs) {
    const f = join(dist, ref.replace(/^\/(ah\/)?/, ''))
    if (!existsSync(f)) continue
    const buf = readFileSync(f)
    startBytes += buf.length
    startGzip += Bun.gzipSync(buf).length
  }
  const total = Object.values(by).reduce((a, b) => ({ bytes: a.bytes + b.bytes, gzip: a.gzip + b.gzip }), { bytes: 0, gzip: 0 })
  return { files: files.length, ...total, byKind: by, startup: { files: refs.length, bytes: startBytes, gzip: startGzip } }
}

interface ProcStat { pid: number; cpuMs: number; workingSet: number; privateBytes: number }
async function procStats(pids: number[]): Promise<Record<number, ProcStat>> {
  const live = pids.filter((p) => p > 0)
  if (!live.length) return {}
  const ps = `Get-Process -Id ${live.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalMilliseconds) $($_.WorkingSet64) $($_.PrivateMemorySize64)" }`
  const p = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], { stdout: 'pipe', stderr: 'ignore', windowsHide: true })
  const text = await new Response(p.stdout).text()
  await p.exited
  const out: Record<number, ProcStat> = {}
  for (const line of text.trim().split(/\r?\n/)) {
    const [pid, cpu, ws, pb] = line.trim().split(/\s+/).map(Number)
    if (pid) out[pid] = { pid, cpuMs: cpu, workingSet: ws, privateBytes: pb }
  }
  return out
}
/** The dev-servers service a temp home started, by the pid in its service.json (only the pid is read). */
function servicePid(home: string): number {
  try {
    const pid = (JSON.parse(readFileSync(join(home, 'devservers', 'service.json'), 'utf8')) as { pid?: unknown }).pid
    return typeof pid === 'number' ? pid : 0
  } catch {
    return 0
  }
}
function killQuietly(pid: number) {
  try {
    if (pid > 0) process.kill(pid)
  } catch {}
}

interface Desk { port: number; home: string; pid: number; counts: string; startedMs: number; proc: ReturnType<typeof Bun.spawn> }
async function startDesk(tag: string, seed?: (home: string) => void): Promise<Desk> {
  const home = scratchDir(tag)
  seed?.(home)
  const counts = join(home, 'perf-counts.jsonl')
  const port = freePort()
  const t0 = performance.now()
  const proc = Bun.spawn([process.execPath, '--preload', PRELOAD, 'server/src/index.ts'], {
    cwd: DESK,
    env: { ...process.env, HYDRA_DESK_PORT: String(port), HYDRA_DESK_HOME: home, PERF_COUNT_FILE: counts },
    stdout: 'ignore', stderr: 'ignore', windowsHide: true,
  })
  let up = false
  while (!up && performance.now() - t0 < 60_000) {
    try {
      up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok
    } catch {}
    if (!up) await sleep(10)
  }
  if (!up) throw new Error(`the server did not answer on ${port} within 60 s`)
  const desk = { port, home, pid: proc.pid, counts, startedMs: performance.now() - t0, proc }
  return desk
}
async function stopDesk(d: Desk) {
  killQuietly(servicePid(d.home))
  d.proc.kill()
  await d.proc.exited
  await sleep(300)
  try {
    rmSync(d.home, { recursive: true, force: true })
  } catch {}
}
function countsSince(d: Desk, since: number) {
  if (!existsSync(d.counts)) return { spawns: 0, fetches: 0, spawnBy: {}, fetchBy: {} }
  const rows = readFileSync(d.counts, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: number; kind: string; what: string })
  const recent = rows.filter((r) => r.t >= since)
  const tally = (kind: string) => {
    const by: Record<string, number> = {}
    for (const r of recent.filter((x) => x.kind === kind)) {
      const key = kind === 'fetch' ? shape(r.what) : r.what
      by[key] = (by[key] ?? 0) + 1
    }
    return by
  }
  return { spawns: recent.filter((r) => r.kind === 'spawn').length, fetches: recent.filter((r) => r.kind === 'fetch').length, spawnBy: tally('spawn'), fetchBy: tally('fetch') }
}

interface Cdp { send: (method: string, params?: object, session?: string) => Promise<any>; on: (fn: (m: any) => void) => void; close: () => void }
async function cdp(url: string): Promise<Cdp> {
  const ws = new WebSocket(url)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  const listeners: ((m: any) => void)[] = []
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m.result ?? m)
      pending.delete(m.id)
    } else for (const fn of listeners) fn(m)
  }
  return {
    send: (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })) }),
    on: (fn) => void listeners.push(fn),
    close: () => ws.close(),
  }
}
async function startEdge() {
  const port = freePort()
  const profile = scratchDir('edge')
  const edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
    // No occlusion or backgrounding switches (the gestures check has them): a page behind another must go hidden here.
    '--no-default-browser-check', '--window-size=1500,950', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  let version: { webSocketDebuggerUrl?: string } = {}
  for (let t = 0; t < 100 && !version.webSocketDebuggerUrl; t++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch {}
    if (!version.webSocketDebuggerUrl) await sleep(100)
  }
  if (!version.webSocketDebuggerUrl) throw new Error('headless Edge did not answer')
  const browser = await cdp(version.webSocketDebuggerUrl)
  const stop = async () => {
    try { await Promise.race([browser.send('Browser.close'), sleep(3000)]) } catch {}
    browser.close()
    edge.kill()
    await sleep(500)
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }
  return { browser, stop }
}
/** A request path with its ids and account folders taken out, so the summary names routes and never a person's folder. */
const shape = (path: string) => path.replace(/\/assets\/.*$/, '/assets/*').replace(/\/(instances|cli-instances|codex-instances|desktop-instances)\/[^/]+/g, '/$1/:id').replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id')

/** A page target attached with a flat session; network events counted per request. */
async function openPage(browser: Cdp, url: string) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const net = { requests: 0, bytes: 0, urls: {} as Record<string, number> }
  browser.on((m) => {
    if (m.sessionId !== sessionId) return
    if (m.method === 'Network.requestWillBeSent') {
      net.requests++
      try {
        const u = new URL(m.params.request.url)
        const key = shape(u.pathname)
        net.urls[key] = (net.urls[key] ?? 0) + 1
      } catch {}
    }
    if (m.method === 'Network.loadingFinished') net.bytes += m.params.encodedDataLength ?? 0
  })
  const send = (method: string, params: object = {}) => browser.send(method, params, sessionId)
  const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  await send('Network.enable')
  await send('Page.enable')
  await send('Performance.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const t0 = performance.now()
  await send('Page.navigate', { url })
  await send('Page.bringToFront')
  return { targetId, sessionId, net, send, ev, t0 }
}
type Page = Awaited<ReturnType<typeof openPage>>
async function until(page: Page, expression: string, ms: number) {
  for (const end = performance.now() + ms; performance.now() < end; await sleep(25)) if (await page.ev(expression)) return true
  return false
}
async function metrics(page: Page): Promise<Record<string, number>> {
  const { metrics: list } = await page.send('Performance.getMetrics')
  return Object.fromEntries((list as { name: string; value: number }[]).map((m) => [m.name, m.value]))
}

// The window's shell (its sidebar toggle) and its first sidebar row: a desk chat or an outside session from AgentHydra.
const SHELL = `!!document.querySelector('button[aria-label="Hide sidebar"], button[aria-label="Show sidebar"]')`
const ROW = `!!document.querySelector('[role="button"][aria-description^="Runs in"], [data-chat-id]')`

/** One idle window over a page (or none) and the server: what each spent in IDLE_S seconds. */
async function idle(d: Desk, page: Page | null, label: string) {
  await sleep(3000) // let the scenario's own switch settle before counting
  const pids = [d.pid, servicePid(d.home)]
  const before = await procStats(pids)
  const net0 = page ? { ...page.net } : null
  const m0 = page ? await metrics(page) : null
  const since = Date.now()
  await sleep(IDLE_S * 1000)
  const after = await procStats([d.pid, servicePid(d.home)])
  const m1 = page ? await metrics(page) : null
  const counts = countsSince(d, since)
  const svc = servicePid(d.home)
  const row = {
    scenario: label,
    serverCpuMs: round((after[d.pid]?.cpuMs ?? NaN) - (before[d.pid]?.cpuMs ?? NaN)),
    serviceCpuMs: svc ? round((after[svc]?.cpuMs ?? 0) - (before[svc]?.cpuMs ?? 0)) : 0,
    serverWorkingSetMB: round((after[d.pid]?.workingSet ?? NaN) / 1048576),
    serverPrivateMB: round((after[d.pid]?.privateBytes ?? NaN) / 1048576),
    serviceWorkingSetMB: svc ? round((after[svc]?.workingSet ?? 0) / 1048576) : 0,
    serverSpawns: counts.spawns,
    serverFetches: counts.fetches,
    spawnBy: counts.spawnBy,
    fetchBy: counts.fetchBy,
    ...(page && net0 && m0 && m1
      ? {
          pageRequests: page.net.requests - net0.requests,
          pageKB: round((page.net.bytes - net0.bytes) / 1024),
          pageTaskMs: round((m1.TaskDuration - m0.TaskDuration) * 1000),
          pageScriptMs: round((m1.ScriptDuration - m0.ScriptDuration) * 1000),
          pageLayouts: m1.LayoutCount - m0.LayoutCount,
          pageStyleRecalcs: m1.RecalcStyleCount - m0.RecalcStyleCount,
          pageHeapMB: round(m1.JSHeapUsedSize / 1048576),
          pageNodes: m1.Nodes,
          hidden: await page.ev('document.hidden'),
        }
      : {}),
  }
  console.log(`  idle ${label}: ${JSON.stringify(row)}`)
  return row
}

try {
  if (ONLY.has('bundle')) {
    result.bundle = { web: bundle(join(DESK, 'web', 'dist')), hydra: bundle(join(DESK, 'hydra', 'dist')) }
    console.log('bundle', JSON.stringify(result.bundle))
  }

  if (ONLY.has('startup')) {
    const ms: number[] = []
    for (let i = 0; i < RUNS; i++) {
      const d = await startDesk(`s${i}`)
      ms.push(round(d.startedMs))
      await stopDesk(d)
    }
    result.startup = { runs: ms, medianMs: median(ms), minMs: Math.min(...ms), maxMs: Math.max(...ms) }
    console.log('startup', JSON.stringify(result.startup))
  }

  if (ONLY.has('page') || ONLY.has('idle') || ONLY.has('localhost')) {
    const d = await startDesk('page')
    cleanup.push(() => stopDesk(d))
    const mem0 = (await procStats([d.pid]))[d.pid]
    result.serverAtStart = { workingSetMB: round((mem0?.workingSet ?? NaN) / 1048576), privateMB: round((mem0?.privateBytes ?? NaN) / 1048576), healthMs: round(d.startedMs) }
    const edge = await startEdge()
    cleanup.unshift(() => edge.stop())

    let page: Page | null = null
    if (ONLY.has('page') || ONLY.has('idle')) {
      page = await openPage(edge.browser, `http://127.0.0.1:${d.port}/`)
      const shell = await until(page, SHELL, 30_000)
      const shellMs = performance.now() - page.t0
      const row = await until(page, ROW, 30_000)
      const rowMs = performance.now() - page.t0
      await until(page, `document.readyState === 'complete'`, 30_000)
      await sleep(5000)
      if ((await page.ev('document.hidden')) !== false) throw new Error('the measured page is hidden: Page.bringToFront did not take')
      const nav = await page.ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; const p = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]));
        const r = performance.getEntriesByType('resource'); const sum = (k) => r.filter((e) => e.initiatorType === k || (k === 'script' && e.name.endsWith('.js'))).reduce((a, e) => a + (e.encodedBodySize || 0), 0);
        return { responseStart: Math.round(n.responseStart), domInteractive: Math.round(n.domInteractive), domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), ...p,
          resources: r.length, jsKB: Math.round(sum('script') / 1024), cssKB: Math.round(r.filter((e) => e.name.endsWith('.css')).reduce((a, e) => a + (e.encodedBodySize || 0), 0) / 1024),
          ahFrameLoaded: [...document.querySelectorAll('iframe')].some((f) => (f.src || '').includes('/ah/')) } })()`)
      const m = await metrics(page)
      result.page = { ...nav, shellMs: shell ? Math.round(shellMs) : null, firstRowMs: row ? Math.round(rowMs) : null, requestsFirst5s: page.net.requests, kbFirst5s: round(page.net.bytes / 1024), urls: { ...page.net.urls }, heapMB: round(m.JSHeapUsedSize / 1048576), nodes: m.Nodes, coldOpenMs: Math.round(d.startedMs + (nav?.['first-contentful-paint'] ?? NaN)) }
      console.log('page', JSON.stringify(result.page))
    }

    if (ONLY.has('idle') && page) {
      const rows = []
      rows.push(await idle(d, page, 'visible'))
      // Another tab in front of it in the same window: the window's page then reports document.hidden, as a minimized or
      // covered AgentHydra window does. (Minimizing a headless window does not hide its page.)
      // Focus emulation also holds a page visible: off while it is covered, on again after.
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      const other = await edge.browser.send('Target.createTarget', { url: 'about:blank', newWindow: false })
      const { sessionId: otherSession } = await edge.browser.send('Target.attachToTarget', { targetId: other.targetId, flatten: true })
      await edge.browser.send('Page.bringToFront', {}, otherSession)
      if (!(await until(page, 'document.hidden === true', 5000))) throw new Error('the window page did not go hidden behind another tab')
      rows.push(await idle(d, page, 'hidden'))
      await edge.browser.send('Target.closeTarget', { targetId: other.targetId })
      await page.send('Page.bringToFront')
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      if (!(await until(page, 'document.hidden === false', 5000))) throw new Error('the window page did not come back to the front')
      // AgentHydra slid in over the chat: its button is aria-pressed while it shows.
      await page.ev(`document.querySelector('button[aria-label="AgentHydra"]')?.click()`)
      if (!(await until(page, `document.querySelector('button[aria-label="AgentHydra"]')?.getAttribute('aria-pressed') === 'true'`, 10_000))) throw new Error('the AgentHydra pane did not open')
      await sleep(5000)
      rows.push(await idle(d, page, 'pane'))
      await page.ev(`document.querySelector('button[aria-label="AgentHydra"]')?.click()`)
      await edge.browser.send('Target.closeTarget', { targetId: page.targetId })
      page = null
      rows.push(await idle(d, null, 'nowindow'))
      result.idle = rows
    }

    if (ONLY.has('localhost')) {
      // A first call, three at once (the Dev list and a pane asking together) after any cache has run out, then one more.
      const call = async () => {
        const t = performance.now()
        const r = await fetch(`http://127.0.0.1:${d.port}/dw/localhost`)
        await r.arrayBuffer()
        return { ms: Math.round(performance.now() - t), status: r.status }
      }
      const timed = async (run: () => Promise<{ ms: number; status: number }[]>) => {
        const since = Date.now()
        const calls = await run()
        return { ms: Math.max(...calls.map((c) => c.ms)), spawns: countsSince(d, since).spawns, status: calls.map((c) => c.status) }
      }
      const cold = await timed(async () => [await call()])
      await sleep(11_000)
      const together = await timed(() => Promise.all([call(), call(), call()]))
      const again = await timed(async () => [await call()])
      result.localhost = { cold, together, again }
      console.log('localhost', JSON.stringify(result.localhost))
    }
    const mem1 = (await procStats([d.pid]))[d.pid]
    result.serverAtEnd = { workingSetMB: round((mem1?.workingSet ?? NaN) / 1048576), privateMB: round((mem1?.privateBytes ?? NaN) / 1048576) }
  }

  if (ONLY.has('service')) {
    // The dev-servers service with a found list the size of a real one (440 folders, every one on disk), polled the way
    // the open Dev servers list polls it (servers/store.ts: status, projects and found every 2 s), then left alone.
    const FOUND = 440
    const d = await startDesk('svc', (home) => {
      const items = []
      for (let i = 0; i < FOUND; i++) {
        const dir = join(home, 'seed', `app-${i}`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `app-${i}`, scripts: { dev: 'vite' } }))
        items.push({ kind: 'detected', path: dir, name: `app-${i}`, processes: 0, framework: 'vite', foundAt: Date.now() })
      }
      mkdirSync(join(home, 'devservers'), { recursive: true })
      writeFileSync(join(home, 'devservers', 'found.json'), JSON.stringify({ items, lastScan: null }))
    })
    cleanup.push(() => stopDesk(d))
    const base = `http://127.0.0.1:${d.port}`
    const t0 = performance.now()
    await fetch(`${base}/dw/service`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }).then((r) => r.arrayBuffer())
    let ready = false
    while (!ready && performance.now() - t0 < 60_000) {
      ready = servicePid(d.home) > 0 && (await fetch(`${base}/dw/api/found`, { headers: { 'x-dw-no-start': '1' } }).then((r) => r.ok, () => false))
      if (!ready) await sleep(250)
    }
    if (!ready) throw new Error('the dev-servers service did not answer within 60 s')
    const svc = servicePid(d.home)
    const startMs = Math.round(performance.now() - t0)
    await sleep(5000)
    const span = async (poll: boolean) => {
      const before = await procStats([d.pid, svc])
      const since = Date.now()
      const ticks: number[] = []
      const end = performance.now() + IDLE_S * 1000
      while (performance.now() < end) {
        if (poll) {
          const t = performance.now()
          await fetch(`${base}/dw/status`).then((r) => r.arrayBuffer())
          await Promise.all(['projects', 'found'].map((route) => fetch(`${base}/dw/api/${route}`, { headers: { 'x-dw-no-start': '1' } }).then((r) => r.arrayBuffer())))
          ticks.push(performance.now() - t)
        }
        await sleep(2000)
      }
      const after = await procStats([d.pid, svc])
      const c = countsSince(d, since)
      return {
        serviceCpuMs: round((after[svc]?.cpuMs ?? NaN) - (before[svc]?.cpuMs ?? NaN)),
        serverCpuMs: round((after[d.pid]?.cpuMs ?? NaN) - (before[d.pid]?.cpuMs ?? NaN)),
        serviceWorkingSetMB: round((after[svc]?.workingSet ?? NaN) / 1048576),
        servicePrivateMB: round((after[svc]?.privateBytes ?? NaN) / 1048576),
        serverSpawns: c.spawns,
        ...(poll ? { polls: ticks.length, pollMsMedian: round(median(ticks)) } : {}),
      }
    }
    const polled = await span(true)
    console.log('service polled', JSON.stringify(polled))
    const quiet = await span(false)
    console.log('service quiet', JSON.stringify(quiet))
    result.service = { found: FOUND, startMs, polled, quiet }
  }
} finally {
  for (const fn of cleanup) {
    try { await fn() } catch {}
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 1))
  console.log(`wrote ${OUT}`)
}
