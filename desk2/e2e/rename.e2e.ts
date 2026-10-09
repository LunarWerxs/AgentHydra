// Rename from a sidebar row's menus (bun e2e/rename.e2e.ts; Windows, Edge): on a Desk chat row and on an outside row, the
// right-click menu, the "..." menu and the R key inside an open right-click menu each pick Rename. The rename input must hold
// focus 300 ms after the menu closes, the typed title must show in the row, and the server must save it. Invented titles only.
// Needs the built Desk 2 (run `bun run build` first); runs on a throwaway HYDRA_DESK_HOME and prints PASS/FAIL per case.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Via = 'right-click' | 'three-dot' | 'R key'
type Target = 'desk chat' | 'outside row'
const VIAS: Via[] = ['right-click', 'three-dot', 'R key']
const TARGETS: Target[] = ['desk chat', 'outside row']
const FIRST_CHAT = 'Invented rename check'

// The sidebar row holding the target: a Desk chat by its title (its More button's label), an outside row by its description.
function rowOf(t: Target, title: string): string {
  return t === 'desk chat'
    ? `[...document.querySelectorAll('button[aria-label="More options for ${title}"]')][0]?.closest('[role="button"]')`
    : `[...document.querySelectorAll('[role="button"][aria-description^="Runs in"]')].find((el) => !el.getAttribute('aria-current') && el.querySelector('button[aria-label^="More options for"]'))`
}
const at = (t: Target, title: string, part: 'row' | 'more') =>
  `(() => { const row = ${rowOf(t, title)}; const el = row && (${part === 'more' ? `row.querySelector('button[aria-label^="More options for"]')` : 'row'}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
const box = (t: Target, title: string) =>
  `JSON.stringify((() => { const row = ${rowOf(t, title)}; if (!row) return null; const r = row.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })())`
const MENU = `!!document.querySelector('[role="menu"]')`
const RENAME_ITEM = `(() => { const it = [...document.querySelectorAll('[role="menuitem"][data-shortcut="R"]')].find((el) => el.textContent.startsWith('Rename')); if (!it) return null; const r = it.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
// Focus moves only, by tag and role: the outside row's label is a real session's title, never printed.
const TRACE = `(() => { window.__log = []; for (const k of ['focusin', 'focusout']) document.addEventListener(k, (e) => { const t = e.target; window.__log.push([Math.round(performance.now()), k, t.tagName, t.getAttribute && (t.getAttribute('data-slot') || t.getAttribute('role') || ''), t.getAttribute && t.getAttribute('aria-label') === 'Rename session' ? 'rename-input' : '']) }, true); return 1 })()`
const FOCUS = `(() => { const el = document.activeElement; const input = document.querySelector('input[aria-label="Rename session"]'); return { input: !!input, focused: !!input && el === input, active: el ? el.tagName + ' ' + (el.getAttribute('aria-label') || el.getAttribute('data-slot') || '') : 'none' } })()`
const rowShows = (title: string) => `[...document.querySelectorAll('[role="button"]')].some((el) => el.textContent.includes(${JSON.stringify(title)}))`

const home = mkdtempSync(join(tmpdir(), 'desk2-rename-home-'))
const profile = mkdtempSync(join(tmpdir(), 'desk2-rename-edge-'))
const cwd = mkdtempSync(join(tmpdir(), 'desk2-rename-cwd-'))
const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK, env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home },
  stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
let edge: ReturnType<typeof Bun.spawn> | null = null
let ws: WebSocket | null = null
let failed = 0

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {}
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  const created = await fetch(`http://127.0.0.1:${PORT}/api/chats`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, title: FIRST_CHAT }),
  })
  if (!created.ok) throw new Error(`create chat: ${created.status} ${await created.text()}`)

  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1500,950', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  let list: { type: string; webSocketDebuggerUrl: string }[] = []
  for (let t = 0; t < 300 && !list.length; t++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() } catch {}
    if (!list.length) await sleep(200)
  }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error(`no Edge page on CDP port ${CDP}`)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws!.onopen = r))
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id) } }
  const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws!.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression: string): Promise<any> => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  const until = async (expression: string, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ev(expression)) return true
    return false
  }
  const park = () => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 940 })
  const mouse = (type: string, x: number, y: number, button = 'none', buttons = 0) =>
    send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: button === 'none' ? 0 : 1 })
  const clickAt = async (p: { x: number; y: number }, button: 'left' | 'right') => {
    await mouse('mouseMoved', p.x, p.y)
    await sleep(150)
    await mouse('mousePressed', p.x, p.y, button, button === 'right' ? 2 : 1)
    await mouse('mouseReleased', p.x, p.y, button, 0)
  }
  const key = async (k: string, code: string, vk: number, text?: string) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  }
  const getJson = async (path: string): Promise<any[]> => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json()
  const savedOnServer = async (t: Target, title: string) => {
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(200)) {
      const rows = await getJson(t === 'desk chat' ? '/api/chats' : '/api/external/sessions')
      if (rows.some((r) => r.title === title)) return true
    }
    return false
  }
  await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  async function load(t: Target, title: string): Promise<boolean> {
    await park()
    await ev(`window.__previous = 1; try { sessionStorage.clear() } catch {}`)
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
    await send('Page.bringToFront')
    if (!(await until(`!window.__previous && document.readyState === 'complete' && !!document.querySelector('button[aria-label="Hide sidebar"]')`, 20_000))) return false
    let last = ''
    let since = Date.now()
    for (const end = Date.now() + 25_000; Date.now() < end; await sleep(150)) {
      const now: string = await ev(box(t, title))
      if (now !== last) { last = now; since = Date.now() } else if (now !== 'null' && Date.now() - since >= 1500) { await park(); await sleep(300); return true }
    }
    return false
  }

  // '' when the case passes, else the reason it fails.
  async function renameCase(t: Target, via: Via, from: string, to: string): Promise<string> {
    if (!(await load(t, from))) return 'no target row on screen'
    if (via === 'three-dot') {
      const more = await ev(at(t, from, 'more'))
      if (!more) return 'no More button on the row'
      await clickAt(more, 'left')
    } else {
      const row = await ev(at(t, from, 'row'))
      if (!row) return 'row left the screen'
      await clickAt(row, 'right')
    }
    if (!(await until(MENU, 3000))) return 'menu did not open'
    await ev(TRACE)
    if (via === 'R key') {
      await key('r', 'KeyR', 82, 'r')
    } else {
      const item = await ev(RENAME_ITEM)
      if (!item) return 'no Rename item in the open menu'
      await clickAt(item, 'left')
    }
    await sleep(300)
    const f = await ev(FOCUS)
    const trace = JSON.stringify(await ev(`window.__log`))
    if (!f.input) return `no rename input 300 ms after the menu closed; focus trace ${trace}`
    if (!f.focused) return `rename input not focused 300 ms after the menu closed (active: ${f.active}); focus trace ${trace}`
    await send('Input.insertText', { text: to })
    await key('Enter', 'Enter', 13, '\r')
    if (!(await until(rowShows(to), 5000))) {
      const rows = await getJson(t === 'desk chat' ? '/api/chats' : '/api/external/sessions')
      const hit = rows.some((r) => r.title === to)
      return `the row does not show the new title (server has it: ${hit}; input still open: ${(await ev(FOCUS)).input})`
    }
    if (!(await savedOnServer(t, to))) return 'the server did not save the new title'
    return ''
  }

  let chatTitle = FIRST_CHAT
  let n = 0
  for (const t of TARGETS) {
    for (const via of VIAS) {
      n++
      const to = `Invented renamed ${t === 'desk chat' ? 'chat' : 'outside'} ${n}`
      const reason = await renameCase(t, via, chatTitle, to)
      const name = `${t} | ${via}`
      if (reason) { failed++; console.log(`FAIL ${name} :: ${reason}`) } else console.log(`PASS ${name} :: focus held, title shown and saved`)
      if (t === 'desk chat') chatTitle = (await getJson('/api/chats'))[0]?.title ?? chatTitle
    }
  }
  console.log(failed ? `${failed} FAIL` : 'all PASS')
} finally {
  ws?.close()
  edge?.kill()
  server.kill()
  await sleep(300)
  for (const dir of [home, profile, cwd]) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}
process.exit(failed ? 1 : 0)
