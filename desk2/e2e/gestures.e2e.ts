// First gestures end to end (bun run e2e:gestures; Windows, Edge): the FIRST gesture on a never-touched lazy trigger (a kit
// Tooltip, IconTooltip, Tip, LazyOverlay or first-interest stand-in), judged by its outcome. Each case loads the page fresh, so
// every stand-in is untouched, does one gesture through CDP Input events on one control, and reads whether the control did its
// job: the menu or popover opened, the sidebar hid, the row became the selected one, the toggle flipped once, the name copied once.
// Gestures: tap (touchStart/touchEnd), long-press (900 ms touch), press (mouse down/up with no move before it), hover-press (move,
// 150 ms, down/up: the ordinary mouse path, and the moment a 120 ms tooltip opens), right-click, key (focus, Enter), hover, focus.
// hover-leave judges the way out: rest until it opens, then move away; it must have opened and be gone. `paused` holds the page as
// a window without focus (lib/pause-motion.ts), where every tooltip and breakdown the pointer left stayed on screen.
// Starts the built Desk 2 (web/dist, hydra/dist: run `bun run build` first) as a hidden process on E2E_PORT (default 7819) with a
// throwaway HYDRA_DESK_HOME; /ah/api goes on to the live AgentHydra daemon, read only: no case here acts on an account (the Open
// and Focus row icons are only hovered or focused), it only opens menus and popovers, hides the sidebar, selects a row, flips a
// view toggle or copies an address to the clipboard. DevWebUI's /dw status and projects are answered here with an invented
// project (a stopped server and a running one), and a POST under /dw with {}, so the Dev servers cases touch no real server. Prints PASS/FAIL per case; exits 1 on any FAIL. Prints aria-labels only,
// never a control's text (a row's text is a chat title, a name cell's an account). GESTURE_ONLY=pane|desk and GESTURE_WHAT=<text>
// pick cases; GESTURE_TRACE=1 prints each case's pointer, mouse, focus and click events (target tag, data-slot, data-state).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DESK = resolve(import.meta.dir, '..')
const PORT = Number(process.env.E2E_PORT) || 7819
const CDP = Number(process.env.E2E_CDP_PORT) || 9439
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Kind = 'tap' | 'long-press' | 'press' | 'hover-press' | 'right-click' | 'key' | 'hover' | 'focus' | 'hover-leave'
interface Case {
  page: 'pane' | 'desk'
  what: string
  kind: Kind
  /** JS expression: the target element (first visible match). */
  pick: string
  /** JS expression run before and after the gesture (X, Y are the point): true when the control did its job. */
  ok: string
  /** The pane tab, by its mod+digit shortcut (default 5, the CLI table; 6 is the desktop table). */
  tab?: string
  /** JS expression printed beside the verdict. */
  diag?: string
  /** hover-press: ms between arriving and pressing (default 150). */
  wait?: number
  /** Hold the page as a window without focus does: its animations paused (the class lib/pause-motion.ts sets). */
  paused?: boolean
  /** JS expression run once the desk is up and before the target is looked for: it turns on the view the target is in. */
  setup?: string
}

const VISIBLE = `(els) => els.find((el) => { const r = el.getBoundingClientRect(); if (r.width < 6 || r.height < 6 || r.top < 0 || r.bottom > innerHeight) return false;
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at && (at === el || el.contains(at)) })`
const MENU_OPEN = `document.querySelectorAll('[role="menu"]').length > 0`
const POPOVER_OPEN = `document.querySelectorAll('[data-slot="popover-content"], [role="dialog"]').length > 0`
const TIP_OPEN = `document.querySelectorAll('[data-slot="tooltip-content"]').length > 0`
// Each breakdown's state, animation and opacity: a closed one still on screen says why it stayed.
const POPOVER_STATES =`[...document.querySelectorAll('[data-slot="popover-content"]')].map((e) => { const c = getComputedStyle(e); return [e.getAttribute('data-state'), c.animationName, c.animationPlayState, c.opacity] })`
// A usage chip in an Instances row (UsageBadge): its breakdown opens on hover.
const USAGE = `(${VISIBLE})([...document.querySelectorAll('[data-instance-num] [data-slot="popover-trigger"].tabular-nums')])`
const ROW_MENU = `(${VISIBLE})([...document.querySelectorAll('[data-instance-num] button[aria-haspopup="menu"]')])`
const ROW_CELL = `(${VISIBLE})([...document.querySelectorAll('[data-instance-num] td:nth-child(2)')])`
const HIDE = `(${VISIBLE})([...document.querySelectorAll('button[aria-label="Hide sidebar"]')])`
const HIDDEN = `!!document.querySelector('button[aria-label="Show sidebar"]')`
const ROW = `(${VISIBLE})([...document.querySelectorAll('[role="button"][aria-description^="Runs in"]')].filter((el) => !el.getAttribute('aria-current')))`
const SELECTED = `(() => { const at = document.elementFromPoint(X, Y); const row = at && at.closest('[role="button"][aria-description^="Runs in"]'); return !!row && row.getAttribute('aria-current') === 'page' })()`
const ROW_MORE = `(${VISIBLE})([...document.querySelectorAll('button[aria-label^="More options for"]')].filter((b) => !b.closest('[aria-current]')))`
const HISTORY = `(${VISIBLE})([...document.querySelectorAll('button[aria-label^="Accounts signed in on #"]')])`
// A tooltip-wrapped toggle (aria-pressed): its first value is noted when it is first picked.
const toggle = (sel: string) => `(() => { const b = (${VISIBLE})([...document.querySelectorAll('${sel}')]); if (b && window.__p0 === undefined) window.__p0 = b.getAttribute('aria-pressed'); return b })()`
const flipped = (sel: string) => `(document.querySelector('${sel}')?.getAttribute('aria-pressed') !== window.__p0)`
const TASKS = 'button[aria-label="CliMayte tasks in the sidebar"]'
// Instances rows: icon-only actions in IconTooltips (Open and Focus act on real accounts: hovered or focused, never clicked) and
// the name cell, a 16px button in an IconTooltip whose click copies the account's address and shows one toast.
const ACTION = `(${VISIBLE})([...document.querySelectorAll('[data-instance-num] button[aria-label="Open"], [data-instance-num] button[aria-label="Focus"]')])`
const NAME = `(${VISIBLE})([...document.querySelectorAll('[data-instance-num] button.cursor-pointer.truncate.text-start')])`
// Only the copy's own toast: the page can show another toast on load.
const TOASTS = `[...document.querySelectorAll('[data-sonner-toast]')].filter((t) => t.textContent.includes('Copied')).length`

// The Dev servers button and a server's row in the sidebar's list (servers/DevServersList.vue): a click on the row shows
// its details in the right-hand pane and starts nothing (owner, 2026-10-07).
const DEV = 'button[aria-label="Dev servers"]'
const DEV_ROW = `(${VISIBLE})([...document.querySelectorAll('[role="region"][aria-label="Dev servers"] [role="button"][aria-label="api details"]')])`
const DETAILS_PANE = `!!document.querySelector('aside[aria-label="Server details"]')`
// What Desk answers to the window here for the dev servers (shared/devwebui.ts): one invented project with a running and a stopped server.
const DW_FIXTURE: Record<string, unknown> = {
  '/dw/status': { state: 'running', pid: 1, running: 1 },
  '/dw/api/projects': [{ id: 'p1', name: 'example-app', path: 'C:/Users/me/code/example-app/.devwebui', processes: [
    { id: 'p1-web', name: 'web', command: 'npm run dev', cwd: '', port: 5173, status: 'running', exitCode: null, projectId: 'p1' },
    { id: 'p1-api', name: 'api', command: 'npm run api', cwd: '', port: 8787, status: 'stopped', exitCode: null, projectId: 'p1' },
  ] }],
}

const CASES: Case[] = []
const each = (kinds: Kind[], c: Omit<Case, 'kind'>) => { for (const kind of kinds) CASES.push({ ...c, kind }) }
each(['tap', 'press', 'hover-press', 'key'], { page: 'pane', what: 'row ... menu opens', pick: ROW_MENU, ok: MENU_OPEN })
each(['right-click'], { page: 'pane', what: 'row name cell context menu opens', pick: ROW_CELL, ok: MENU_OPEN })
each(['tap', 'press', 'hover-press', 'key'], { page: 'pane', what: 'login history opens its popover', pick: HISTORY, ok: POPOVER_OPEN, tab: '6' })
each(['hover', 'focus'], { page: 'pane', what: 'row action icon (Open/Focus) shows its tooltip', pick: ACTION, ok: TIP_OPEN, tab: '6' })
each(['tap', 'press', 'hover-press', 'key'], { page: 'pane', what: 'name cell copies once, no tooltip', pick: NAME, ok: `${TOASTS} === 1 && !(${TIP_OPEN})`, tab: '6', diag: `[${TOASTS}, ${TIP_OPEN}]` })
CASES.push({ page: 'pane', what: 'name cell copies once, no tooltip (300 ms rest)', kind: 'hover-press', wait: 300, pick: NAME, ok: `${TOASTS} === 1 && !(${TIP_OPEN})`, tab: '6', diag: `[${TOASTS}, ${TIP_OPEN}]` })
each(['long-press'], { page: 'pane', what: 'name cell long-press shows its tooltip, no copy', pick: NAME, ok: `${TOASTS} === 0 && (${TIP_OPEN})`, tab: '6', diag: `[${TOASTS}, ${TIP_OPEN}]` })
// Owner, 2026-10-06 ("these stupid popups won't stop"): every tooltip and breakdown the pointer passed stayed on screen.
each(['hover-leave'], { page: 'pane', what: 'name cell tooltip goes with the pointer, window unfocused', pick: NAME, ok: TIP_OPEN, tab: '6', paused: true })
each(['hover-leave'], { page: 'pane', what: 'usage breakdown goes with the pointer, window unfocused', pick: USAGE, ok: POPOVER_OPEN, paused: true, diag: POPOVER_STATES })
each(['tap', 'press', 'hover-press', 'key'], { page: 'desk', what: 'Tip button: Hide sidebar hides it', pick: HIDE, ok: HIDDEN })
each(['tap', 'press', 'hover-press'], { page: 'desk', what: 'sidebar row (outside a session) is selected', pick: ROW, ok: SELECTED })
each(['right-click'], { page: 'desk', what: 'sidebar row context menu opens', pick: ROW, ok: MENU_OPEN })
each(['tap', 'press', 'hover-press', 'key'], { page: 'desk', what: 'sidebar row ... menu opens', pick: ROW_MORE, ok: MENU_OPEN })
each(['press', 'hover-press'], { page: 'desk', what: 'Tip toggle: CliMayte tasks flips once, no tooltip', pick: toggle(TASKS), ok: `${flipped(TASKS)} && !(${TIP_OPEN})`, diag: `[${flipped(TASKS)}, ${TIP_OPEN}]` })
each(['press', 'hover-press'], { page: 'desk', what: 'Tip toggle: Dev servers flips once, no tooltip', pick: toggle(DEV), ok: `${flipped(DEV)} && !(${TIP_OPEN})`, diag: `[${flipped(DEV)}, ${TIP_OPEN}]` })
each(['tap', 'press', 'hover-press', 'key'], { page: 'desk', what: 'Dev servers row shows its details', pick: DEV_ROW, ok: DETAILS_PANE, setup: `document.querySelector('${DEV}').click()` })

const TRACE = `(() => { window.__log = []; const d = (e) => { const t = e.target; window.__log.push([Math.round(performance.now()), e.type, e.isTrusted, t && t.tagName,
  t && t.getAttribute && (t.getAttribute('aria-label') || t.getAttribute('data-slot')), t && t.getAttribute && t.getAttribute('data-state'), t && t.isConnected, e.pointerType || '']) };
  for (const k of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'focusin', 'focusout', 'pointerup', 'mouseup', 'click', 'touchstart', 'touchend']) window.addEventListener(k, d, true); return 1 })()`

if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use`)
// Both thrown away when the run ends.
const home = mkdtempSync(join(tmpdir(), 'desk2-gestures-home-'))
const profile = mkdtempSync(join(tmpdir(), 'desk2-gestures-edge-'))
const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK, env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home },
  stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
let edge: ReturnType<typeof Bun.spawn> | null = null
const lines: { ok: boolean; line: string }[] = []

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {}
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  let list: { type: string; webSocketDebuggerUrl: string }[] = []
  for (let t = 0; t < 50 && !list.length; t++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() } catch {}
    if (!list.length) await sleep(200)
  }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error(`no Edge page on CDP port ${CDP}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data));
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params
      const body = request.method === 'GET' ? DW_FIXTURE[new URL(request.url).pathname] : {}
      if (body === undefined) void send('Fetch.continueRequest', { requestId })
      else void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: btoa(JSON.stringify(body)) })
      return
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id) } }
  const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  /** Poll `expression` until it is truthy (true) or `ms` runs out (false). */
  const until = async (expression: string, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ev(expression)) return true
    return false
  }
  const park = () => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 940 })
  await send('Page.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: `http://127.0.0.1:${PORT}/dw/*` }] })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  /** Load the page fresh and wait until the case's target is on screen and has stopped changing: rows are replaced as data
   *  arrives after mount, so the SAME element (marked on first sight) must hold the same box for 1.5 s. The pane also waits out
   *  its warm data (App.vue starts it at idle, at the latest 4 s after mount), which re-sorts the desktop table once: a row that
   *  moves loses its focus and its open tooltip. */
  async function load(c: Case): Promise<boolean> {
    const settled = Date.now() + (c.page === 'pane' ? 6000 : 0)
    await park()
    // Page.navigate answers before the old document goes: mark it, and wait for a document without the mark.
    // A reload comes back to the screen it left (lib/view-memory.ts): every case starts from a fresh window instead.
    await ev(`window.__previous = 1; try { sessionStorage.clear(); localStorage.removeItem('hydra-desk.devservers.on') } catch {}`)
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${c.page === 'pane' ? '/ah/?embed=desk' : '/'}` })
    await send('Page.bringToFront')
    const fresh = `!window.__previous && document.readyState === 'complete'`
    if (c.page === 'pane') {
      // The tab shortcut is listened for once the app has mounted its tab bar.
      if (!(await until(`${fresh} && document.querySelectorAll('button').length > 5`, 20_000))) return false
      await sleep(500)
      const tab = c.tab ?? '5'
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: tab, code: `Digit${tab}`, modifiers: 2, windowsVirtualKeyCode: 48 + Number(tab) })
    } else {
      if (!(await until(`${fresh} && !!document.querySelector('button[aria-label="Hide sidebar"], button[aria-label="Show sidebar"]')`, 20_000))) return false
      if (await ev(HIDDEN)) {
        // A tap in an earlier case hid the sidebar and Desk remembers it: show it again, then load fresh so every stand-in is untouched.
        await ev(`document.querySelector('button[aria-label="Show sidebar"]').click()`)
        await sleep(500)
        return load(c)
      }
    }
    if (c.setup) await ev(c.setup)
    const seen = `(() => { const el = ${c.pick}; if (!el) return ''; el.__seen ??= Math.random(); return el.__seen + JSON.stringify(el.getBoundingClientRect()) })()`
    let last = ''
    let since = Date.now()
    for (const end = Date.now() + 25_000; ; await sleep(150)) {
      if (Date.now() > end) return false
      const now = await ev(seen)
      if (now !== last) { last = now; since = Date.now() } else if (now && Date.now() - since >= 1500 && Date.now() >= settled) break
    }
    await park()
    await sleep(300)
    return true
  }

  const only = process.env.GESTURE_ONLY
  const what = process.env.GESTURE_WHAT
  for (const c of CASES.filter((c) => (!only || c.page === only) && (!what || c.what.includes(what)))) {
    const name = `${c.page} | ${c.what} | ${c.kind}${c.wait ? ` ${c.wait}ms` : ''}`
    if (!(await load(c))) { lines.push({ ok: false, line: `FAIL ${name} :: no target on screen` }); console.log(lines.at(-1)!.line); continue }
    const p = await ev(`(() => { const el = ${c.pick}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: el.getAttribute('aria-label') || '' } })()`)
    if (!p) { lines.push({ ok: false, line: `FAIL ${name} :: the target left the screen` }); console.log(lines.at(-1)!.line); continue }
    const ok = c.ok.replaceAll('X', String(p.x)).replaceAll('Y', String(p.y))
    if (c.paused) await ev(`document.documentElement.classList.add('motion-paused')`)
    const before = await ev(ok)
    let mid: unknown = null
    if (process.env.GESTURE_TRACE) await ev(TRACE)
    const mouse = (type: string, button = 'none', buttons = 0) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons, clickCount: button === 'none' ? 0 : 1 })
    if (c.kind === 'tap' || c.kind === 'long-press') {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
      await sleep(c.kind === 'tap' ? 70 : 900)
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else if (c.kind === 'key' || c.kind === 'focus') {
      await ev(`(${c.pick}).focus()`)
      await sleep(c.kind === 'key' ? 150 : 400)
      if (c.kind === 'key') for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
    } else if (c.kind === 'hover') {
      await mouse('mouseMoved')
      await sleep(1200)
    } else if (c.kind === 'hover-leave') {
      await mouse('mouseMoved')
      await sleep(1200)
      mid = await ev(ok)
      await park()
      // Gone, not gone fast: a closing breakdown waits 220 ms, then fades; one left on screen never goes.
      await sleep(700)
    } else if (c.kind === 'right-click') {
      await mouse('mouseMoved')
      await sleep(150)
      await mouse('mousePressed', 'right', 2)
      await mouse('mouseReleased', 'right', 0)
    } else {
      if (c.kind === 'hover-press') { await mouse('mouseMoved'); await sleep(c.wait ?? 150) }
      await mouse('mousePressed', 'left', 1)
      await sleep(70)
      await mouse('mouseReleased', 'left', 0)
    }
    await sleep(800)
    const after = await ev(ok)
    const diag = c.diag ? ` ${JSON.stringify(await ev(c.diag))}` : ''
    // hover-leave: it opened and is gone; the rest: the control did its job.
    const pass = c.kind === 'hover-leave' ? !before && !!mid && !after : !before && !!after
    lines.push({ ok: pass, line: `${pass ? 'PASS' : 'FAIL'} ${name} :: before ${before}${c.kind === 'hover-leave' ? `, open ${mid}` : ''}, after ${after}${diag}${p.label ? ` [${p.label}]` : ''}` })
    console.log(lines.at(-1)!.line)
    if (process.env.GESTURE_TRACE) console.log(`     trace ${JSON.stringify(await ev(`window.__log`))}`)
  }
} finally {
  edge?.kill()
  server.kill()
  await Promise.all([edge?.exited, server.exited])
  // A folder Edge's helpers still hold a moment longer is left to the temp cleaner.
  for (const dir of [home, profile]) try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
}
const failed = lines.filter((l) => !l.ok).length
console.log(`${lines.length - failed} of ${lines.length} first gestures did their job`)
process.exit(failed || !lines.length ? 1 : 0)
