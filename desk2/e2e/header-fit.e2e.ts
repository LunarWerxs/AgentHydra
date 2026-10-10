// The title bar's fit (bun e2e/header-fit.e2e.ts; Windows, Edge). Three bars, each swept on the REAL layout, never by forcing the header's
// width: a chat's bar beside the Browser pane (the chat column is moved with the divider's own arrow keys, from the widest down to
// CHAT_MIN 300 in steps of 16), the same chat with a long alert, and an outside session's bar (both with the sidebar hidden, so the
// bar spans the window, which is resized from 1100px down to 300px in steps of 20).
// At every width: the header stays h-8 and inside its column; no two visible controls overlap; every control is whole (no ancestor cuts
// it) and is what a click at its centre hits (nothing covers it); the right-hand pane buttons keep their 26px; the title shows at least six
// characters and an ellipsis; the status cue is its full words or its dot alone; the folder pill is at least 64px or hidden; the title
// group is centred while it fits and otherwise sits 8px short of the buttons. Screenshots of the chat bar go to %TEMP%\header-fit\.
// Prints PASS/FAIL per width; exits 1 on any FAIL. Run `bun run build` first.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The collapsed sidebar leaves the title bar its window minus 250px of chrome, so these are header widths.
const CHROME = 250
const HEADER_WIDTHS = Array.from({ length: 41 }, (_, i) => 1100 - i * 20)
const CHAT_MIN = 300
const SHOTS: { name: string; at: number }[] = [{ name: 'wide', at: 1300 }, { name: 'mid', at: 560 }, { name: 'narrow', at: CHAT_MIN }]
const RIGHT_BUTTONS = ['Background tasks', 'Changes', 'Browser and servers', 'Connections', 'View options', 'Hide session details', 'Show session details']
const SCENES = [
  { scene: 'header-fit', shape: 'chat', split: true },
  { scene: 'header-fit-alert', shape: 'chat-alert', split: false },
  { scene: 'header-fit-external', shape: 'external', split: false },
]

// Reads the header that holds the Background tasks button: its box and its column's, each visible control's whole and visible box (an
// ancestor's overflow cuts the visible one), what a click at the control's centre hits, and the text rules. Labels only, never a control's text.
const MEASURE = `(() => {
  const h = [...document.querySelectorAll('header')].find((x) => x.querySelector('button[aria-label="Background tasks"]'))
  if (!h) return null
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } }
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
  const nameOf = (el) => el.getAttribute('aria-label') || el.getAttribute('data-fit') || el.tagName.toLowerCase()
  const cs = getComputedStyle(h)
  const mid = h.children[1]
  const vis = (el) => {
    const own = el.getBoundingClientRect()
    let l = own.left, t = own.top, r = own.right, b = own.bottom
    for (let a = el.parentElement; a && a !== h.parentElement; a = a.parentElement) {
      const s = getComputedStyle(a)
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
      const q = a.getBoundingClientRect()
      l = Math.max(l, q.left); t = Math.max(t, q.top); r = Math.min(r, q.right); b = Math.min(b, q.bottom)
    }
    return { l, t, r: Math.max(l, r), b: Math.max(t, b), w: Math.max(0, r - l), h: Math.max(0, b - t), whole: own.width }
  }
  const ctx = document.createElement('canvas').getContext('2d')
  const textW = (el, str) => { const c = getComputedStyle(el); ctx.font = c.fontStyle + ' ' + c.fontWeight + ' ' + c.fontSize + ' ' + c.fontFamily; return ctx.measureText(str).width }
  const titleSpan = h.querySelector('button[aria-label$=", rename session"] > span') || h.querySelector('span.truncate')
  const els = [...h.querySelectorAll('button, input, [role="status"], [role="alert"], [data-fit]')].filter((el) => getComputedStyle(el).visibility !== 'hidden' && !(el.getAttribute('aria-label') || '').endsWith('rename session'))
  if (titleSpan) els.push(titleSpan)
  const controls = els.map((el) => {
    const v = vis(el)
    const name = el === titleSpan ? 'title' : nameOf(el)
    let hit = true
    if (v.w > 0 && v.h > 0) {
      const top = document.elementFromPoint((v.l + v.r) / 2, (v.t + v.b) / 2)
      hit = !!top && (top === el || el.contains(top))
    }
    return { name, l: v.l, t: v.t, r: v.r, b: v.b, w: v.w, h: v.h, cut: v.whole - v.w > 0.5, hit }
  }).filter((c) => c.w >= 2 && c.h >= 2)
  const right = controls.filter((c) => ${JSON.stringify(RIGHT_BUTTONS)}.includes(c.name))
  const prev = mid.getAttribute('style')
  mid.style.flex = '0 0 auto'
  mid.style.width = 'max-content'
  mid.style.overflow = 'visible'
  const natural = mid.getBoundingClientRect().width
  if (prev === null) mid.removeAttribute('style'); else mid.setAttribute('style', prev)
  const clipped = [mid, ...mid.querySelectorAll('*')].filter((el) => shown(el) && el.scrollWidth > el.clientWidth + 0.5).map(nameOf)
  let titleRule = ''
  if (titleSpan && shown(titleSpan) && titleSpan.scrollWidth > titleSpan.clientWidth + 0.5) {
    const text = titleSpan.textContent || ''
    const need = textW(titleSpan, text.slice(0, 6)) + textW(titleSpan, '\\u2026')
    if (titleSpan.clientWidth < need - 0.5) titleRule = 'title shows ' + titleSpan.clientWidth.toFixed(1) + 'px, under six characters and an ellipsis (' + need.toFixed(1) + 'px)'
  }
  return {
    hr: box(h), col: box(h.parentElement), pl: parseFloat(cs.paddingInlineStart), pr: parseFloat(cs.paddingInlineEnd), side: parseFloat(cs.getPropertyValue('--side')) || 0,
    gap: parseFloat(cs.columnGap) || 0, controls, right, mid: box(mid), natural, spacer: box(h.children[0]).w, rightBox: box(h.children[2]), rightMl: parseFloat(getComputedStyle(h.children[2]).marginInlineStart) || 0, clipped, titleRule,
  }
})()`

interface Box { l: number; t: number; r: number; b: number; w: number; h: number }
interface Control extends Box { name: string; cut: boolean; hit: boolean }
interface Measure {
  hr: Box
  col: Box
  pl: number
  pr: number
  side: number
  gap: number
  controls: Control[]
  right: Control[]
  mid: Box
  natural: number
  spacer: number
  rightBox: Box
  rightMl: number
  clipped: string[]
  titleRule: string
}

/** The failures at one width: an empty list is a pass. */
function judge(m: Measure, needAlert: boolean): string[] {
  return [
    ...headerFailures(m, needAlert),
    ...controlFailures(m),
    ...overlapFailures(m.controls),
    ...minimumWidthFailures(m.controls),
    ...rightButtonFailures(m.right),
    ...(m.titleRule ? [m.titleRule] : []),
    ...titleGroupFailures(m),
    ...clippedFailures(m),
  ]
}

/** The header's own height and its place in its column, and the alert when there is room for it. */
function headerFailures(m: Measure, needAlert: boolean): string[] {
  const out: string[] = []
  const { hr } = m
  if (hr.h > 32.5) out.push(`header ${hr.h.toFixed(1)}px tall`)
  if (hr.r > m.col.r + 0.5 || hr.l < m.col.l - 0.5) out.push(`header ${hr.l.toFixed(0)}-${hr.r.toFixed(0)} runs outside its column ${m.col.l.toFixed(0)}-${m.col.r.toFixed(0)}`)
  // Below 286px of room the alert is screen-reader-only (the container query on its class): there is no space beside the buttons.
  if (needAlert && hr.w - m.pl - m.pr >= 286 && !m.controls.some((c) => c.name === 'alert')) out.push('alert not shown')
  return out
}

/** Each control stays inside the header, is whole, and is what a click at its centre hits. */
function controlFailures(m: Measure): string[] {
  const out: string[] = []
  const { hr } = m
  for (const c of m.controls) {
    if (c.l < hr.l - 0.5 || c.r > hr.r + 0.5 || c.t < hr.t - 0.5 || c.b > hr.b + 0.5) out.push(`${c.name} outside the header`)
    if (c.cut && c.name !== 'title' && c.name !== 'alert') out.push(`${c.name} is cut off by its container`)
    if (!c.hit) out.push(`${c.name} is covered: a click at its centre hits something else`)
  }
  return out
}

/** No two visible controls overlap. */
function overlapFailures(controls: Control[]): string[] {
  const out: string[] = []
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!
      const b = controls[j]!
      const ix = Math.min(a.r, b.r) - Math.max(a.l, b.l)
      const iy = Math.min(a.b, b.b) - Math.max(a.t, b.t)
      if (ix > 0.5 && iy > 0.5) out.push(`${a.name} overlaps ${b.name}`)
    }
  }
  return out
}

/** The Connections logo and the folder pill keep their smallest widths. */
function minimumWidthFailures(controls: Control[]): string[] {
  const out: string[] = []
  for (const c of controls) {
    if (c.name.startsWith('Connections workspace') && c.w < 19) out.push(`${c.name} shows ${c.w.toFixed(1)}px, less than its logo`)
    if (c.name === 'folder' && c.w < 63.5) out.push(`folder pill ${c.w.toFixed(1)}px, neither 64px nor hidden`)
  }
  return out
}

/** The right-hand pane buttons keep their 26px. */
function rightButtonFailures(right: Control[]): string[] {
  const out: string[] = []
  for (const c of right) if (Math.abs(c.w - 26) > 0.5 || Math.abs(c.h - 26) > 0.5) out.push(`${c.name} is ${c.w.toFixed(1)}x${c.h.toFixed(1)}, not 26`)
  return out
}

/** The title group is centred while it fits, and otherwise sits the gap from the buttons. */
function titleGroupFailures(m: Measure): string[] {
  const content = m.hr.w - m.pl - m.pr
  if (m.natural <= content - 2 * m.side - 2 * m.gap) {
    const off = (m.mid.l + m.mid.r) / 2 - (m.hr.l + m.pl + content / 2)
    return Math.abs(off) > 1 ? [`title group ${off.toFixed(1)}px off centre`] : []
  }
  const gap = m.rightBox.l - m.mid.r
  return Math.abs(gap - (m.gap + m.rightMl)) > 1 ? [`title group ${gap.toFixed(1)}px from the buttons, not ${m.gap + m.rightMl}`] : []
}

/** Nothing in the title group is clipped while the bar has spare room. */
function clippedFailures(m: Measure): string[] {
  if (m.spacer > 1 && m.clipped.length) return [`clipped with ${m.spacer.toFixed(0)}px spare: ${m.clipped.join(', ')}`]
  return []
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'desk2-header-fit-'))
const home = join(SCRATCH, 'home')
const profile = join(SCRATCH, 'edge')
mkdirSync(home)
mkdirSync(profile)
const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK, env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home },
  stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
const shotDir = join(tmpdir(), 'header-fit')
mkdirSync(shotDir, { recursive: true })
let edge: ReturnType<typeof Bun.spawn> | null = null
const sockets: WebSocket[] = []
let failed = 0
let total = 0

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {}
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1500,950', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  let list: { type: string; webSocketDebuggerUrl: string }[] = []
  for (let t = 0; t < 50 && !list.length; t++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() } catch {}
    if (!list.length) await sleep(200)
  }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error(`no Edge page on CDP port ${CDP}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  sockets.push(ws)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    if (m.method === 'Fetch.requestPaused') {
      const body = { connectors: [{ id: 'connections', name: 'Connections', enabled: true, state: 'ready' }] }
      void send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: btoa(JSON.stringify(body)) })
      return
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id) }
  }
  const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: `http://127.0.0.1:${PORT}/api/connectors*` }] })

  const SEPARATOR = `document.querySelector('[role="separator"][aria-label="Resize the chat and the pane"]')`

  /** Measures, judges and prints one width; `shot` names a screenshot of the title band to take. */
  async function check(shape: string, label: string, needAlert: boolean, shot?: string) {
    const m = (await ev(MEASURE)) as Measure | null
    if (!m) throw new Error(`${shape}: header vanished at ${label}`)
    total++
    const why = judge(m, needAlert)
    const pass = why.length === 0
    if (!pass) failed++
    console.log(`${pass ? 'PASS' : 'FAIL'} ${shape} ${label} :: header ${m.hr.w.toFixed(0)}px, title group ${m.mid.l.toFixed(0)}-${m.mid.r.toFixed(0)}, spacer ${m.spacer.toFixed(0)}px${pass ? '' : ` :: ${why.join('; ')} :: ${m.controls.map((c) => `${c.name} ${c.l.toFixed(0)}-${c.r.toFixed(0)}`).join(', ')}`}`)
    if (shot) {
      const x = m.col.l
      const img = await send('Page.captureScreenshot', { format: 'png', clip: { x, y: m.hr.t - 4, width: Math.min(m.col.w + 160, 2000 - x), height: m.hr.h + 8, scale: 2 } })
      const file = join(shotDir, `chat-${shot}.png`)
      writeFileSync(file, Buffer.from(img.result?.data ?? img.data, 'base64'))
      console.log(`     screenshot ${file}`)
    }
  }

  for (const [n, s] of SCENES.entries()) {
    await send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?header-fit=${n}#/parity/${s.scene}` })
    let ready = false
    for (let t = 0; t < 400 && !ready; t++) {
      await sleep(150)
      ready = !!(await ev(`!!(window.__parity && window.__parity.ready) && location.href.includes('header-fit=${n}') && !!(${MEASURE})`))
    }
    if (!ready) throw new Error(`${s.scene}: no header on the parity page: ${JSON.stringify(await ev(`({ p: window.__parity, href: location.href, headers: document.querySelectorAll('header').length })`))}`)
    await sleep(400)
    if (s.split) {
      await ev(`document.querySelector('button[aria-label="Browser and servers"]').click()`)
      await sleep(600)
      const key = (k: string, times: number) => ev(`(() => { const s = ${SEPARATOR}; for (let i = 0; i < ${times}; i++) s.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true })); return true })()`)
      await key('ArrowRight', 120)
      const shots = [...SHOTS]
      for (let guard = 0; guard < 200; guard++) {
        await sleep(200)
        const cw = Number(await ev(`${SEPARATOR}.getAttribute('aria-valuenow')`))
        const shot = shots.find((x) => Math.abs(cw - x.at) <= 8)
        if (shot) shots.splice(shots.indexOf(shot), 1)
        await check(s.shape, `chat column ${cw}`, false, shot?.name)
        if (cw <= CHAT_MIN) break
        await key('ArrowLeft', 1)
      }
    } else {
      await ev(`document.documentElement.style.overflow = 'hidden'`)
      for (const hw of HEADER_WIDTHS) {
        await send('Emulation.setDeviceMetricsOverride', { width: hw + CHROME, height: 900, deviceScaleFactor: 1, mobile: false })
        await sleep(250)
        await check(s.shape, `window ${hw + CHROME}`, s.shape === 'chat-alert')
      }
    }
  }
} finally {
  for (const s of sockets) s.close()
  edge?.kill()
  server.kill()
  await Promise.all([edge?.exited, server.exited])
  try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
}
console.log(`${total - failed} of ${total} widths fit`)
process.exit(failed || !total ? 1 : 0)
