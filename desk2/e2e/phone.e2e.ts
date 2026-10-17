// A phone-wide window, headless, on the parity page (`bun run e2e:phone`, after `bun run build`). 2026-10-17: under COMPACT_WIDTH the
// sidebar became a drawer over the chat, but the right-hand panes still sat beside the chat as a 380px column (the Browser pane as a
// split keeping the chat's 300px), so at 375px every pane pushed the chat to nothing and ran off the screen.
// At 375x812: the drawer starts shut and nothing scrolls sideways; each title-bar pane takes the chat's place under the title bar, the
// whole width, with a back row over it, and its back row and its own button each bring the chat back; with a pane open, a chat picked
// in the drawer shuts the drawer and brings the chat back. At 1920x1080 the panes keep their wide places: Changes a 380px column
// beside the chat, the Browser pane a split with the chat at CHAT_DEFAULT, and no back row.
// Every click is a real mouse event at the control's centre. Prints PASS/FAIL per check; exits 1 on any FAIL.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'
import { CHAT_DEFAULT } from '../web/src/components/shell/logic'
import { rmRetry } from '../server/test/rm-retry'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Longer than the drawer's slide (--dur-slow) and a pane's lazy load.
const SETTLE = 900
const PANES = ['Changes', 'Browser and servers', 'To-do', 'Connections']

const SCRATCH = mkdtempSync(join(tmpdir(), 'desk2-phone-'))
const home = join(SCRATCH, 'home')
const profile = join(SCRATCH, 'edge')
mkdirSync(home)
mkdirSync(profile)
const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK, env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home },
  stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
let edge: ReturnType<typeof Bun.spawn> | null = null
const sockets: WebSocket[] = []
let failed = 0
let total = 0
const result = (ok: boolean, what: string, why = '') => {
  total++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || !why ? '' : ` :: ${why}`}`)
}

// The control so named (its aria-label, else its text) outside an inert part, with its centre; for 'row', the first chat row in the
// sidebar that is not the current one.
const centre = (label: string) => `(() => {
  const b = ${label === 'row'
    ? `[...document.querySelectorAll('[data-testid="sidebar-slot"] [role="button"]')].find((x) => x.classList.contains('group/row') && x.getAttribute('aria-current') !== 'page' && !x.closest('[inert]') && x.getBoundingClientRect().width > 0)`
    : `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent.trim()) === ${JSON.stringify(label)} && !x.closest('[inert]') && x.getBoundingClientRect().width > 0)`}
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`
// Where things are: the pane's column (and the pane in it), the back row and whether a click at its button's centre reaches it, the
// chat under it, the title bar, the drawer's scrim, and how wide the page scrolls.
const LAYOUT = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), width: Math.round(r.width) } }
  const aside = document.querySelector('aside[aria-label]:not([aria-label="Session details"]):not([aria-label="Sidebar"])')
  const pane = aside && [...aside.children].find((c) => c.getAttribute('data-testid') !== 'pane-back-row' && c.getAttribute('role') !== 'separator')
  const back = document.querySelector('[data-testid="pane-back-row"] button')
  const br = back && back.getBoundingClientRect()
  const at = br && document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2)
  const chat = document.querySelector('main [data-file-drop]')
  return {
    aside: box(aside), pane: box(pane), name: aside && aside.getAttribute('aria-label'),
    back: !!back, backHit: !!at && (at === back || back.contains(at)),
    chat: !!chat && getComputedStyle(chat).display !== 'none', main: box(document.querySelector('main')),
    title: box(document.querySelector('main') && document.querySelector('main').parentElement.querySelector('header')),
    scrim: !!document.querySelector('[data-testid="sidebar-scrim"]'),
    scrollWidth: document.documentElement.scrollWidth, innerWidth,
  }
})()`
type Box = { left: number; top: number; right: number; width: number }
type Layout = { aside: Box | null; pane: Box | null; name: string | null; back: boolean; backHit: boolean; chat: boolean; main: Box | null; title: Box | null; scrim: boolean; scrollWidth: number; innerWidth: number }

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {} // floor-ok: not up yet, asked again
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1500,950', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  let list: { type: string; webSocketDebuggerUrl: string }[] = []
  for (let t = 0; t < 50 && !list.length; t++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() } catch {} // floor-ok: Edge not listening yet, asked again
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
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id) }
  }
  const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  await send('Page.enable')
  await send('Runtime.enable')
  const layout = async () => (await ev(LAYOUT)) as Layout

  /** A real click at the centre of the control so named ('row': a chat row in the sidebar); false when there is none. */
  async function click(label: string): Promise<boolean> {
    const at = (await ev(centre(label))) as { x: number; y: number } | null
    if (!at) return false
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none' })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await sleep(SETTLE)
    return true
  }
  /** The scene in a window this size, the clock moving so the parity page's frozen Date.now does not drop a click (AGENTS.md). */
  async function open(width: number, height: number) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?phone=${width}#/parity/whole-window` })
    let ready = false
    for (let t = 0; t < 300 && !ready; t++) {
      await sleep(150)
      ready = !!(await ev(`!!(window.__parity && window.__parity.ready) && location.href.includes('phone=${width}')`))
    }
    if (!ready) throw new Error(`${width}px: the parity page did not get ready`)
    await ev(`(() => { const frozen = Date.now(); let n = 1; Date.now = () => frozen + 1000 * n++ })()`)
    await sleep(SETTLE)
  }
  const fits = (l: Layout) => l.scrollWidth === l.innerWidth
  /** The layout once the open pane has drawn (each loads lazily, slower on a busy machine), or after 6 s as it is. */
  async function paneLayout(): Promise<Layout> {
    let l = await layout()
    for (let t = 0; t < 30 && l.aside && !l.pane; t++) {
      await sleep(200)
      l = await layout()
    }
    return l
  }

  // A phone.
  await open(375, 812)
  const start = await layout()
  result(!start.scrim && start.chat && start.main?.left === 0 && start.main.width === 375 && fits(start), 'at 375px the drawer starts shut and the chat takes the window', JSON.stringify(start))
  let opened = 0
  for (const label of PANES) {
    if (!(await click(label))) continue
    opened++
    const l = await paneLayout()
    const over = !!l.aside && !!l.pane && !!l.title && l.aside.left === 0 && l.aside.right === 375 && l.pane.left >= 0 && l.pane.right <= 375 && l.aside.top >= l.title.top
    result(over && l.back && l.backHit && !l.chat && fits(l), `${label} takes the chat's place, the whole width, with its back row`, JSON.stringify(l))
    await click('Back to the chat')
    const back = await layout()
    result(!back.aside && back.chat && fits(back), `${label}: its back row brings the chat back`, JSON.stringify(back))
    await click(label)
    await click(label)
    const toggled = await layout()
    result(!toggled.aside && toggled.chat, `${label}: its own button shuts it again`, JSON.stringify(toggled))
  }
  result(opened >= 3, `the title bar offers the panes (${opened} of ${PANES.join(', ')})`)
  // CliMayte opens from the composer: its rows' long titles are cut short instead of drawing it wider than the window.
  await ev(`window.dispatchEvent(new Event('hydra-desk:open-climayte'))`)
  await sleep(SETTLE)
  const cm = await paneLayout()
  result(cm.name === 'CliMayte' && !!cm.pane && cm.pane.right <= 375 && cm.back && fits(cm), 'CliMayte fits the window, with its back row', JSON.stringify(cm))
  await click('Back to the chat')
  // A chat picked in the drawer brings the chat back from a pane.
  await click('Changes')
  await click('Show sidebar')
  const drawer = await layout()
  result(drawer.scrim, 'with a pane open, the sidebar opens as a drawer over it', JSON.stringify(drawer))
  const picked = await click('row')
  const after = await layout()
  result(picked && !after.scrim && !after.aside && after.chat && fits(after), 'a chat picked in the drawer shuts it and brings the chat back', JSON.stringify(after))

  // A wide window: the panes as they always were.
  await open(1920, 1080)
  await click('Changes')
  const changes = await paneLayout()
  result(!!changes.aside && changes.aside.right === 1920 && changes.aside.width === 380 && !changes.back && changes.chat && changes.main?.right === changes.aside.left, 'at 1920px Changes is a 380px column beside the chat', JSON.stringify(changes))
  await click('Changes')
  await click('Browser and servers')
  const servers = await paneLayout()
  result(!!servers.aside && servers.aside.top === 0 && servers.aside.right === 1920 && !servers.back && servers.chat && servers.main?.width === CHAT_DEFAULT, `at 1920px the Browser pane splits the stage with the chat at ${CHAT_DEFAULT}px`, JSON.stringify(servers))
} finally {
  for (const s of sockets) s.close()
  edge?.kill()
  server.kill()
  await Promise.all([edge?.exited, server.exited])
  try { rmRetry(SCRATCH) } catch {} // floor-ok: a temp folder Edge still holds
}
console.log(`${total - failed} of ${total} phone checks pass`)
process.exit(failed || !total ? 1 : 0)
