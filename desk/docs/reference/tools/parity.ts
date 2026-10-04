// Parity harness: renders Hydra Desk's '#/parity/<scene>' and compares it with the real Claude Code
// capture named in docs/reference/real/scenes.json. Usage (from desk/):
//   bun run parity <scene|all> [--crop x,y,w,h] [--zoom N] [--threshold T] [--dist <built web dir>] [--keep]
// Writes tmp/parity/<scene>/{real,ours,side,diff,overlay}.png (+ *-zoom.png with --crop) and report.json.
// Safe to run from several agents at once: every run builds into its own tmp/parity/.runs/<id>/, serves
// on an OS-chosen port, runs its own headless Edge profile, and replaces output files by rename.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}
interface Scene {
  name: string
  ref: string | null
  route: string
  viewport: { width: number; height: number }
  dpr: number
  crop?: Rect
  place?: Rect
  note?: string
}

const ROOT = resolve(import.meta.dir, '../../..')
const WEB = join(ROOT, 'web')
const REAL = join(ROOT, 'docs/reference/real')
const OUT = join(ROOT, 'tmp/parity')

function usage(msg?: string): never {
  if (msg) console.error(msg)
  console.error('usage: bun run parity <scene|all> [--crop x,y,w,h] [--zoom N] [--threshold T] [--dist <dir>] [--keep] [--verbose]')
  process.exit(2)
}

const argv = process.argv.slice(2)
const flags: Record<string, string> = {}
const names: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === '--keep') flags.keep = '1'
  else if (a === '--verbose') flags.verbose = '1'
  else if (a.startsWith('--')) {
    const v = argv[++i]
    if (v === undefined) usage(`${a} needs a value`)
    flags[a.slice(2)] = v
  } else names.push(a)
}
if (!names.length) usage()

const all: Scene[] = JSON.parse(readFileSync(join(REAL, 'scenes.json'), 'utf8')).scenes
const scenes = names.includes('all') ? all : names.map((n) => all.find((s) => s.name === n) ?? usage(`unknown scene '${n}'; scenes: ${all.map((s) => s.name).join(', ')}`))

const crop = flags.crop ? flags.crop.split(',').map(Number) : null
if (crop && (crop.length !== 4 || crop.some((n) => !Number.isFinite(n)))) usage('--crop is x,y,w,h in reference pixels')
const zoom = Math.max(1, Math.round(Number(flags.zoom ?? (crop ? 4 : 1))))
const threshold = Number(flags.threshold ?? 0.1)

const step = (msg: string) => flags.verbose && console.error(`  [${new Date().toISOString().slice(11, 23)}] ${msg}`)

const runId = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const runDir = join(OUT, '.runs', runId)
mkdirSync(runDir, { recursive: true })

// A run that was killed leaves its folder; drop the ones whose owner process is gone.
for (const name of readdirSync(join(OUT, '.runs'))) {
  const pid = Number(name.split('-')[1])
  if (name === runId || !pid) continue
  let alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  if (!alive && Date.now() - statSync(join(OUT, '.runs', name)).mtimeMs > 2 * 60_000) {
    try {
      rmSync(join(OUT, '.runs', name), { recursive: true, force: true })
    } catch {}
  }
}

const cleanup: (() => unknown)[] = []
let cleaned = false
async function cleanUp() {
  if (cleaned) return
  cleaned = true
  for (const f of cleanup.reverse()) {
    try {
      await f()
    } catch (e) {
      step(`cleanup: ${(e as Error).message}`)
    }
  }
  if (flags.keep) return console.error(`kept ${runDir}`)
  for (let i = 0; i < 12; i++) {
    try {
      rmSync(runDir, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(250) // Edge's helper processes let go of the profile a moment after the browser exits
    }
  }
  console.error(`parity: ${runDir} is still locked by exiting Edge helpers; the next run removes it`)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void cleanUp().then(() => process.exit(130)))

async function build(): Promise<string> {
  if (flags.dist) return resolve(flags.dist)
  const dist = join(runDir, 'dist')
  const bin = join(WEB, 'node_modules/.bin', process.platform === 'win32' ? 'vite.exe' : 'vite')
  // Pipes, not files: a file handed to Bun.spawn stays open in this process and locks the run folder.
  const p = Bun.spawn([bin, 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: WEB, stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  if ((await p.exited) !== 0 || !existsSync(join(dist, 'index.html'))) {
    throw new Error(`web build failed (another agent may be mid-edit; retry in a minute):\n${(out + err).slice(-3000)}`)
  }
  return dist
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.wasm': 'application/wasm'
}

function serve(dist: string) {
  const tool = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><script src="/__parity/parity-page.js"></script>`
  const file = (path: string) => {
    const f = Bun.file(path)
    return new Response(f, { headers: { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' } })
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname)
      if (path === '/__parity/tool.html') return new Response(tool, { headers: { 'content-type': MIME['.html']! } })
      if (path === '/__parity/parity-page.js') return file(join(import.meta.dir, 'parity-page.js'))
      if (path.startsWith('/__parity/ref/')) {
        const p = resolve(REAL, path.slice('/__parity/ref/'.length))
        return p.startsWith(REAL) && existsSync(p) ? file(p) : new Response('not found', { status: 404 })
      }
      if (path.startsWith('/api/') || path.startsWith('/ws')) return new Response('parity: no server', { status: 503 })
      const p = resolve(dist, '.' + path)
      if (p.startsWith(dist) && path !== '/' && existsSync(p)) return file(p)
      return file(join(dist, 'index.html'))
    }
  })
  cleanup.push(() => server.stop(true))
  return `http://127.0.0.1:${server.port}`
}

function edgePath(): string {
  const list = [
    process.env.PARITY_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ]
  const hit = list.find((p) => p && existsSync(p))
  if (!hit) throw new Error('no Edge or Chrome found; set PARITY_BROWSER')
  return hit
}

class Cdp {
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners: ((m: any) => void)[] = []
  constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!
        this.pending.delete(m.id)
        if (m.error) p.reject(new Error(`${m.error.message} ${m.error.data ?? ''}`))
        else p.resolve(m.result)
      } else for (const l of this.listeners) l(m)
    }
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = () => res(null)
      ws.onerror = () => rej(new Error('CDP connect failed'))
    })
    return new Cdp(ws)
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 60_000): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e))
      })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  once(method: string, sessionId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const l = (m: any) => {
        if (m.method === method && m.sessionId === sessionId) done(true)
      }
      const t = setTimeout(() => done(false), timeoutMs)
      const done = (v: boolean) => {
        clearTimeout(t)
        this.listeners = this.listeners.filter((x) => x !== l)
        resolve(v)
      }
      this.listeners.push(l)
    })
  }
  close() {
    this.ws.close()
  }
}

async function launch(first: Scene): Promise<Cdp> {
  const profile = join(runDir, 'edge')
  mkdirSync(profile, { recursive: true })
  const proc = Bun.spawn(
    [
      edgePath(),
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-features=msEdgeSidebarV2,msHubApps,Translate',
      '--font-render-hinting=none',
      `--force-device-scale-factor=${first.dpr}`,
      `--window-size=${first.viewport.width},${first.viewport.height}`,
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank'
    ],
    { stdout: 'ignore', stderr: 'ignore', windowsHide: true }
  )
  // Runs after Browser.close (cleanup is last-in, first-out): give Edge a moment, then take down the tree.
  cleanup.push(async () => {
    await Promise.race([proc.exited, Bun.sleep(5000)])
    if (proc.exitCode === null) {
      if (process.platform === 'win32') Bun.spawnSync(['taskkill', '/pid', String(proc.pid), '/t', '/f'], { windowsHide: true, stdout: 'ignore', stderr: 'ignore' })
      else proc.kill('SIGKILL')
      await Promise.race([proc.exited, Bun.sleep(3000)])
    }
    step(`Edge exit code ${proc.exitCode}`)
    // Helpers (renderers, crashpad) can outlive the browser; every one of them names this run's profile.
    if (process.platform === 'win32') {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='${basename(edgePath())}'" | Where-Object { $_.CommandLine -like '*${runId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      const encoded = Buffer.from(ps, 'utf16le').toString('base64') // no quoting through the command line
      Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, stdout: 'ignore', stderr: 'ignore' })
    }
  })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await Bun.sleep(100)
  if (!existsSync(portFile)) throw new Error('headless Edge did not start within 15 s')
  const [port, path] = readFileSync(portFile, 'utf8').split(/\r?\n/)
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`)
  cleanup.push(async () => {
    await cdp.send('Browser.close', {}, undefined, 3000).catch(() => {})
    cdp.close()
  })
  return cdp
}

async function openPage(cdp: Cdp, url: string): Promise<string> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.bringToFront', {}, sessionId)
  if (url !== 'about:blank') await cdp.send('Page.navigate', { url }, sessionId)
  return sessionId
}

async function evaluate(cdp: Cdp, sessionId: string, expression: string, timeoutMs = 60_000): Promise<any> {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function waitFor(cdp: Cdp, sessionId: string, expression: string, timeoutMs: number): Promise<any> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await evaluate(cdp, sessionId, expression).catch(() => null)
    if (v) return v
    await Bun.sleep(100)
  }
  return null
}

async function shoot(cdp: Cdp, base: string, scene: Scene): Promise<string> {
  const sessionId = await openPage(cdp, 'about:blank')
  try {
    const { width, height } = scene.viewport
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scene.dpr, mobile: false }, sessionId)
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId)
    step(`${scene.name}: navigate ${scene.route}`)
    await cdp.send('Page.navigate', { url: `${base}/${scene.route}` }, sessionId)
    const state = await waitFor(cdp, sessionId, `window.__parity && window.__parity.ready && JSON.parse(JSON.stringify(window.__parity))`, 20_000)
    if (!state) throw new Error(`#/parity/${scene.name} never reported ready (is the route registered and the scene known to the page?)`)
    if (state.error) throw new Error(`#/parity/${scene.name}: ${state.error}`)
    step(`${scene.name}: ready`)
    if (state.hover) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: state.hover.x, y: state.hover.y }, sessionId)
    }
    // Let fonts, transitions and timers settle on virtual time, then one real frame.
    const expired = cdp.once('Emulation.virtualTimeBudgetExpired', sessionId, 8000)
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: 2000 }, sessionId)
    await expired
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance' }, sessionId).catch(() => {})
    await evaluate(cdp, sessionId, `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))))`, 10_000).catch(() => {})
    step(`${scene.name}: settled, capturing`)
    const clip = scene.crop ?? { x: 0, y: 0, width, height }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { ...clip, scale: 1 } }, sessionId)
    return `data:image/png;base64,${shot.data}`
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
  }
}

function writeAtomic(path: string, data: Uint8Array | string) {
  const tmp = `${path}.${runId}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

const dataUrlBytes = (u: string) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')

async function main() {
  step('building web')
  const dist = await build()
  const base = serve(dist)
  step(`serving ${base}; starting Edge`)
  const cdp = await launch(scenes[0]!)
  const tool = await openPage(cdp, `${base}/__parity/tool.html`)
  if (!(await waitFor(cdp, tool, 'window.parityToolReady === true', 15_000))) throw new Error('tool page did not load')

  let failed = 0
  for (const scene of scenes) {
    const dir = join(OUT, scene.name)
    mkdirSync(dir, { recursive: true })
    try {
      const ours = await shoot(cdp, base, scene)
      if (!scene.ref) {
        writeAtomic(join(dir, 'ours.png'), dataUrlBytes(ours))
        console.log(`${scene.name}: no real reference yet; wrote ours.png (${scene.route})`)
        continue
      }
      const args = {
        refUrl: `/__parity/ref/${scene.ref}`,
        oursUrl: ours,
        place: scene.place ?? null,
        threshold,
        tile: 64,
        worst: 6,
        crop: crop ? { x: crop[0], y: crop[1], width: crop[2], height: crop[3] } : null,
        zoom,
        realLabel: `REAL  ${scene.ref}`,
        oursLabel: `OURS  ${scene.route}`
      }
      step(`${scene.name}: comparing`)
      // A background tab may defer image decoding; the tool page must be the front one while it works.
      await cdp.send('Page.bringToFront', {}, tool)
      const r = await evaluate(cdp, tool, `window.parityProcess(${JSON.stringify(args)})`, 120_000)
      for (const [name, u] of Object.entries(r.images as Record<string, string>)) writeAtomic(join(dir, `${name}.png`), dataUrlBytes(u))
      const { images: _images, ...report } = r
      writeAtomic(join(dir, 'report.json'), JSON.stringify({ scene, threshold, at: new Date().toISOString(), ...report }, null, 2))
      const shotSize = r.oursSource.width === r.place.width && r.oursSource.height === r.place.height ? '1:1' : `scaled ${r.oursSource.width}x${r.oursSource.height} -> ${r.place.width}x${r.place.height}`
      console.log(`${scene.name}: ${r.mismatchPercent}% mismatch (${r.diffPixels}/${r.comparedPixels} px, ${r.width}x${r.height}, ours ${shotSize}) -> tmp/parity/${scene.name}/`)
      for (const t of r.worst) console.log(`  tile x=${t.x} y=${t.y} ${t.width}x${t.height}: ${t.pixels} px (${t.percent}%)`)
      if (r.crop) console.log(`  zoom: ${r.crop.x},${r.crop.y} ${r.crop.width}x${r.crop.height} x${zoom} -> {real,ours,diff,side}-zoom.png`)
    } catch (e) {
      failed++
      console.error(`${scene.name}: FAILED ${(e as Error).message}`)
    }
  }
  return failed
}

let code = 0
try {
  code = (await main()) ? 1 : 0
} catch (e) {
  console.error(`parity: ${(e as Error).message}`)
  code = 1
} finally {
  await cleanUp()
}
process.exit(code)
