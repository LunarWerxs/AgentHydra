// Speed of the live browser pane, end to end (bun run e2e:browser-speed; Windows, Chrome, a throwaway profile).
// Starts a throwaway Chrome on a local test page (a CSS animation, a 40000 px scroller, a button and two marker boxes),
// serves LiveSession's frames over a websocket relay exactly as the Desk plugin does, and a viewer page that decodes and
// draws each frame the way SavedBrowsers.vue's showFrame/draw do (an Image from a data: URL, then drawImage on a canvas).
// Three modes: headed (no extra flags, window moved off screen), headed+anti-throttle (LIVE_CHROME_FLAGS, what the pane
// launches) and headless (--headless=new --disable-gpu). Writes tmp/browser-speed.json (or --out) and prints a table.
// Exits 1 when a mode gets no frame, times out a probe, or draws under 5 fps.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import puppeteer from 'puppeteer'
import { LIVE_CHROME_FLAGS, LiveSession, findChrome, liveBrowser, pageTabs, parseLiveIn } from '../server/src/browser/cdp'
import type { BrowserLiveOut } from '../shared/browser'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const OUT = resolve(import.meta.dir, '..', arg('--out') ?? 'tmp/browser-speed.json')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const TEST_PAGE = `<!doctype html><meta charset=utf-8><title>speed test</title>
<style>
html,body{margin:0;width:900px;height:700px;overflow:hidden;font:14px sans-serif;background:#fff}
#btn{position:absolute;left:20px;top:20px;width:200px;height:60px;background:#ddd;line-height:60px;text-align:center}
#m1,#m2{position:absolute;top:20px;width:100px;height:60px;background:rgb(0,128,200)}
#m1{left:400px}#m2{left:560px}
#scroller{position:absolute;left:20px;top:120px;width:860px;height:480px;overflow-y:auto;border:1px solid #888}
#rows{height:40000px;background:repeating-linear-gradient(#fff 0 19px,#e8e8e8 19px 20px)}
#spin{position:absolute;left:0;top:640px;width:60px;height:40px;background:#f60;animation:go 2.4s linear infinite alternate}
@keyframes go{to{transform:translateX(800px)}}
</style>
<div id=btn>Button</div><div id=m1></div><div id=m2></div>
<div id=scroller><div id=rows></div></div><div id=spin></div>
<script>
let n = 0
document.getElementById('btn').onclick = () => { n++; const r = (n * 53) % 256; document.getElementById('m1').style.background = 'rgb(' + r + ',40,' + (255 - r) + ')' }
const sc = document.getElementById('scroller')
sc.onscroll = () => { document.getElementById('m2').style.background = 'rgb(' + (sc.scrollTop % 256) + ',128,200)' }
</script>`

// The viewer mirrors SavedBrowsers.vue: a newest-token decode, drawn on a canvas sized to the frame.
// Marker centres are CSS px of the 900x700 page; the sample is taken at the same fraction of the frame.
const VIEWER_PAGE = `<!doctype html><meta charset=utf-8><canvas id=c></canvas><script>
const stats = { connectedAt: 0, firstDrawAt: 0, draws: [], emitted: [], frameChars: [], decodeMs: [], clicks: [], wheels: [], done: false, error: '' }
window.__stats = stats
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d', { willReadFrequently: true })
const MARKS = { click: [450, 50], scroll: [610, 50] }
const last = { click: null, scroll: null }
let waiting = null
let decoding = 0
let ws = null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)) }
function sample(which) {
  const p = MARKS[which]
  const d = ctx.getImageData(Math.round((p[0] / 900) * canvas.width), Math.round((p[1] / 700) * canvas.height), 1, 1).data
  return [d[0], d[1], d[2]]
}
function far(a, b) { return !a || !b || Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 60 }
function onFrame(m, arrived) {
  const token = ++decoding
  const image = new Image()
  image.onload = () => {
    if (token !== decoding) return
    canvas.width = m.width
    canvas.height = m.height
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const now = Date.now()
    stats.draws.push(now)
    stats.decodeMs.push(now - arrived)
    if (!stats.firstDrawAt) stats.firstDrawAt = now
    last.click = sample('click')
    last.scroll = sample('scroll')
    if (waiting) {
      const c = sample(waiting.which)
      if (far(c, waiting.base) && now >= waiting.sentAt) { const done = waiting.done; waiting = null; done(now - done.sentAt) }
    }
  }
  image.src = 'data:image/jpeg;base64,' + m.data
}
function probe(which, act) {
  return new Promise((resolve) => {
    const base = last[which]
    const sentAt = Date.now()
    let timer = null
    const done = (ms) => { clearTimeout(timer); resolve(ms) }
    done.sentAt = sentAt
    waiting = { which, base, sentAt, done }
    timer = setTimeout(() => { waiting = null; resolve(null) }, 4000)
    act()
  })
}
const mouse = (event) => send({ type: 'mouse', event, x: 120, y: 50, button: event === 'move' ? 'none' : 'left', clickCount: event === 'move' ? 0 : 1, modifiers: 0 })
async function run() {
  stats.connectedAt = Date.now()
  ws = new WebSocket('ws://' + location.host + '/live')
  ws.onopen = () => send({ type: 'viewport', width: 900, height: 700 })
  ws.onmessage = (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'frame') { stats.emitted.push(Date.now()); stats.frameChars.push(ev.data.length); onFrame(m, Date.now()) }
  }
  for (let t = 0; t < 400 && !stats.firstDrawAt; t++) await sleep(50)
  await sleep(1500)
  const from = Date.now(), d0 = stats.draws.length, e0 = stats.emitted.length
  await sleep(5000)
  const span = (Date.now() - from) / 1000
  stats.fpsDrawn = (stats.draws.length - d0) / span
  stats.fpsEmitted = (stats.emitted.length - e0) / span
  for (let i = 0; i < 6; i++) {
    stats.clicks.push(await probe('click', () => { mouse('move'); mouse('down'); mouse('up') }))
    await sleep(900)
  }
  for (let i = 0; i < 6; i++) {
    stats.wheels.push(await probe('scroll', () => send({ type: 'wheel', x: 300, y: 300, deltaX: 0, deltaY: 100 })))
    await sleep(900)
  }
  stats.done = true
}
run().catch((e) => { stats.error = String(e); stats.done = true })
</script>`

const median = (xs: number[]): number => percentile(xs, 0.5)
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const round = (n: number) => (Number.isFinite(n) ? Math.round(n) : null)
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

interface Viewer {
  connectedAt: number
  firstDrawAt: number
  draws: number[]
  emitted: number[]
  frameChars: number[]
  decodeMs: number[]
  clicks: (number | null)[]
  wheels: (number | null)[]
  fpsDrawn: number
  fpsEmitted: number
  done: boolean
  error: string
}

interface Mode {
  name: string
  headless: boolean
  flags: string[]
  control?: boolean
}

// The control shows what a plain headed Chrome does: no frames, which is why the pane launches with LIVE_CHROME_FLAGS.
const MODES: Mode[] = [
  { name: 'headed (control, no flags)', headless: false, flags: [], control: true },
  { name: 'headed+anti-throttle', headless: false, flags: LIVE_CHROME_FLAGS },
  { name: 'headless', headless: true, flags: [] },
]

async function measure(mode: Mode, chromePath: string) {
  const dir = mkdtempSync(join(tmpdir(), 'desk2-speed-'))
  const profile = join(dir, 'profile')
  const testServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(TEST_PAGE, { headers: { 'content-type': 'text/html' } }) })
  const testUrl = `http://127.0.0.1:${testServer.port}/`
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--window-size=900,700']
  if (mode.headless) args.push('--headless=new', '--disable-gpu')
  else args.push('--window-position=-2000,-2000')
  args.push(...mode.flags, testUrl)
  const chrome = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true })
  let port = 0
  let session: LiveSession | null = null
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null
  let relay: ReturnType<typeof Bun.serve> | null = null
  try {
    for (let i = 0; i < 80 && !port; i++) {
      await sleep(200)
      port = (await liveBrowser(profile))?.port ?? 0
    }
    if (!port) throw new Error(`${mode.name}: Chrome did not announce its port`)
    for (let i = 0; i < 40; i++) {
      if ((await pageTabs(port).catch(() => [])).some((t) => t.url.startsWith(testUrl))) break
      await sleep(150)
    }
    await sleep(1500)
    const cdpPort = port
    relay = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        const path = new URL(req.url).pathname
        if (path === '/live') return server.upgrade(req) ? undefined : new Response('no upgrade', { status: 400 })
        if (path === '/viewer') return new Response(VIEWER_PAGE, { headers: { 'content-type': 'text/html' } })
        return new Response('not found', { status: 404 })
      },
      websocket: {
        open(ws) {
          session = new LiveSession(cdpPort, (m: BrowserLiveOut) => ws.send(JSON.stringify(m)), () => ws.close())
          void LiveSession.pick(cdpPort, null).then((tab) => (tab ? session?.start(tab) : ws.close()), () => ws.close())
        },
        message(_ws, raw) {
          const msg = parseLiveIn(String(raw))
          if (msg) void session?.input(msg)
        },
        close() {
          session?.close()
          session = null
        },
      },
    })
    browser = await puppeteer.launch({ headless: 'shell', args: LIVE_CHROME_FLAGS })
    const page = await browser.newPage()
    await page.bringToFront()
    await page.goto(`http://127.0.0.1:${relay.port}/viewer`)
    await page.waitForFunction('window.__stats && window.__stats.done', { timeout: 180_000, polling: 250 })
    const v = (await page.evaluate(() => (window as unknown as { __stats: Viewer }).__stats)) as Viewer
    if (v.error) throw new Error(`${mode.name}: viewer failed: ${v.error}`)
    const clicks = v.clicks.filter((x): x is number => x !== null)
    const wheels = v.wheels.filter((x): x is number => x !== null)
    return {
      mode: mode.name,
      timeToFirstFrameMs: v.firstDrawAt ? round(v.firstDrawAt - v.connectedAt) : null,
      fpsDrawn: Math.round(v.fpsDrawn * 10) / 10,
      fpsEmitted: Math.round(v.fpsEmitted * 10) / 10,
      bytesPerFrame: round(mean(v.frameChars)),
      decodeMedianMs: round(median(v.decodeMs)),
      clickLagMedianMs: round(median(clicks)),
      clickLagP90Ms: round(percentile(clicks, 0.9)),
      clickTimeouts: v.clicks.length - clicks.length,
      wheelLagMedianMs: round(median(wheels)),
      wheelLagP90Ms: round(percentile(wheels, 0.9)),
      wheelTimeouts: v.wheels.length - wheels.length,
    }
  } finally {
    try {
      await browser?.close()
    } catch {
      // floor-ok: the viewer's browser already gone
    }
    session?.close()
    relay?.stop(true)
    chrome.kill()
    testServer.stop(true)
    await sleep(500)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // floor-ok: a profile Chrome still holds open, left for the OS temp cleanup
    }
  }
}

const chromePath = process.env.E2E_CHROME || findChrome()
if (!chromePath) throw new Error('Chrome is not installed (set E2E_CHROME)')
// LiveSession.close() rejects the CDP calls still in flight; nothing awaits those, so they are noise here.
process.on('unhandledRejection', (e) => {
  if (!String(e).includes('detached')) throw e
})

const results: Awaited<ReturnType<typeof measure>>[] = []
for (const mode of MODES) results.push(await measure(mode, chromePath))

const report = { at: new Date().toISOString(), chrome: chromePath, results }
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
const cell = (x: unknown) => String(x ?? 'none').padStart(9)
console.log(['mode'.padEnd(20), 'ttff ms'.padStart(9), 'fps drawn'.padStart(9), 'fps emit'.padStart(9), 'bytes/frm'.padStart(9), 'click med/p90'.padStart(14), 'wheel med/p90'.padStart(14), 'timeouts'.padStart(9)].join(' '))
for (const r of results)
  console.log(
    [
      r.mode.padEnd(20),
      cell(r.timeToFirstFrameMs),
      cell(r.fpsDrawn),
      cell(r.fpsEmitted),
      cell(r.bytesPerFrame),
      `${r.clickLagMedianMs ?? 'none'}/${r.clickLagP90Ms ?? 'none'}`.padStart(14),
      `${r.wheelLagMedianMs ?? 'none'}/${r.wheelLagP90Ms ?? 'none'}`.padStart(14),
      cell(r.clickTimeouts + r.wheelTimeouts),
    ].join(' '),
  )

const missed = results.filter((r, i) => !MODES[i].control && (r.timeToFirstFrameMs === null || r.clickTimeouts + r.wheelTimeouts > 0 || r.fpsDrawn < 5))
if (missed.length) {
  console.error(`browser-speed: missed the gate (no frame, a timeout, or under 5 fps): ${missed.map((r) => r.mode).join(', ')}`)
  process.exitCode = 1
}
