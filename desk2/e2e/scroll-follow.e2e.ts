// Scroll-follow end to end (bun run e2e:scroll; Windows, Edge): the transcript follows a streaming reply only while
// Jacob is at the bottom. Drives web `#/stream-bench` (the transcript alone, one assistant reply growing a chunk at a time) in
// headless Edge through CDP, and checks: a reply growing under someone reading higher up never moves them (touchpad-sized wheel
// steps, a scrollbar drag, a keyboard Page Up, each WHILE it streams); the jump-to-bottom button shows in the bottom-right corner
// once they are well up and takes them down; a send (the composer's chat-sent event) takes them down; at the bottom it follows.
// Starts the web Vite dev server hidden on E2E_PORT (default a free port) and stops it afterwards. Prints PASS/FAIL per case; exits 1 on
// any FAIL.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const answers = (url: string) => fetch(url).then((r) => r.ok, () => false)

if (await answers(BASE)) throw new Error(`port ${PORT} is already in use`)
// Vite itself, not `bun run dev`: killing a `bun run` on Windows leaves its Vite child serving the port.
const vite = Bun.spawn([process.execPath, 'node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: join(DESK, 'web'), stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
let edge: ReturnType<typeof Bun.spawn> | null = null
const lines: { ok: boolean; line: string }[] = []
const profile = mkdtempSync(join(tmpdir(), 'desk2-scroll-edge-'))
const sockets: WebSocket[] = []

try {
  let up = false
  for (let t = 0; t < 120 && !up; t++) if (!(up = await answers(BASE))) await sleep(500)
  if (!up) throw new Error(`the Vite dev server did not answer on ${PORT}`)
  edge = Bun.spawn([EDGE, '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', ...QUIET_EDGE, '--window-size=1000,600', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
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
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id) } }
  const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const FRAME = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
  const SC = `document.querySelector('[data-transcript-scroller]')`
  /** n more chunks, a frame apart: each grows the last row, as an item.delta does, and past a reply's end new rows start. */
  const push = (n = 1) => ev(`(async () => { for (let i = 0; i < ${n}; i++) { await window.__streamBench.grow(); await ${FRAME} } })()`)
  const frame = () => ev(FRAME)
  type State = { top: number; distance: number; client: number; button: { left: number; right: number; bottom: number; top: number } | null; view: { right: number; bottom: number } }
  const state = async (): Promise<State> => ev(`(() => { const el = ${SC}; const b = document.querySelector('[aria-label="Scroll to bottom"]'); const r = el.getBoundingClientRect();
    const box = b && b.getBoundingClientRect(); return { top: el.scrollTop, distance: el.scrollHeight - el.scrollTop - el.clientHeight, client: el.clientHeight,
    button: box && box.width ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null, view: { right: r.right, bottom: r.bottom } } })()`)
  const check = (ok: boolean, line: string) => lines.push({ ok, line: `${ok ? 'PASS' : 'FAIL'} ${line}` })

  /** A fresh page with the reply streamed until the transcript is several screens tall, sitting at its bottom. */
  async function load(): Promise<void> {
    await ev('window.__previous = 1')
    // A query that changes every time: the same URL with only its #/ part would not load the page again.
    await send('Page.navigate', { url: `${BASE}/?load=${Date.now()}#/stream-bench` })
    let ready = false
    for (let t = 0; t < 100 && !(ready = await ev(`!window.__previous && !!window.__streamBench?.ready && !!${SC}`)); t++) await sleep(100)
    if (!ready) throw new Error('the stream bench did not load')
    for (let t = 0; t < 400; t++) {
      const s = await state()
      if (s.top + s.distance > s.client * 4) break
      await push(5)
    }
    await frame()
  }
  const wheel = (deltaY: number) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 300, deltaX: 0, deltaY })

  // 1. A touchpad: small wheel steps up, the reply growing between them. They stay up.
  await load()
  for (let i = 0; i < 12; i++) {
    await wheel(-8)
    await push(1)
  }
  await sleep(300)
  let a = await state()
  await push(15)
  await sleep(200)
  let b = await state()
  check(a.distance > 40 && Math.abs(b.top - a.top) < 2, `touchpad steps up while it streams stay up (distance ${Math.round(a.distance)}, top ${Math.round(a.top)} -> ${Math.round(b.top)})`)

  // 2. A scrollbar drag: no wheel event, the scroll lands in the same frame as a chunk. They stay up.
  await load()
  await ev(`(async () => { const el = ${SC}; el.scrollTop -= 400; await window.__streamBench.grow(); await ${FRAME} })()`)
  await sleep(200)
  a = await state()
  await push(15)
  await sleep(200)
  b = await state()
  check(a.distance > 300 && Math.abs(b.top - a.top) < 2, `a scrollbar drag up while it streams stays up (distance ${Math.round(a.distance)}, top ${Math.round(a.top)} -> ${Math.round(b.top)})`)

  // 3. Page Up on the keyboard while it streams. They stay up.
  await load()
  await ev(`(() => { const el = ${SC}; el.tabIndex = -1; el.focus() })()`)
  for (let i = 0; i < 2; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 })
    await push(3)
  }
  await sleep(400)
  a = await state()
  await push(15)
  await sleep(200)
  b = await state()
  check(a.distance > 200 && Math.abs(b.top - a.top) < 2, `Page Up while it streams stays up (distance ${Math.round(a.distance)}, top ${Math.round(a.top)} -> ${Math.round(b.top)})`)

  // 4. Well up: the reply grows and they do not move; the button sits in the bottom-right corner.
  await load()
  await wheel(-800)
  await sleep(400)
  a = await state()
  await push(20)
  await sleep(300)
  b = await state()
  check(Math.abs(b.top - a.top) < 2, `well up, 20 more chunks do not move them (top ${Math.round(a.top)} -> ${Math.round(b.top)})`)
  const btn = b.button
  check(!!btn && b.view.right - btn.right < 48 && b.view.bottom - btn.bottom < 120 && btn.left > b.view.right / 2,
    `the jump button shows in the bottom-right corner (${btn ? `right gap ${Math.round(b.view.right - btn.right)}, bottom gap ${Math.round(b.view.bottom - btn.bottom)}` : 'not shown'})`)

  // 5. The button takes them to the bottom, then hides, and the reply is followed from there.
  if (btn) {
    const x = (btn.left + btn.right) / 2
    const y = (btn.top + btn.bottom) / 2
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  await sleep(500)
  a = await state()
  await push(10)
  await sleep(300)
  b = await state()
  check(a.distance < 2 && b.distance < 2, `the button goes to the bottom and it follows from there (distance ${Math.round(a.distance)}, then ${Math.round(b.distance)})`)
  check(!b.button, 'the button hides at the bottom')

  // 6. Just a little up (a few lines): no button yet.
  await wheel(-100)
  await sleep(400)
  a = await state()
  check(a.distance > 40 && !a.button, `a few lines up shows no button yet (distance ${Math.round(a.distance)})`)

  // 7. A send in this chat takes them to the bottom from well up; one for another chat does not.
  await wheel(-800)
  await sleep(400)
  await ev(`window.dispatchEvent(new CustomEvent('hydra-desk:chat-sent', { detail: { chatId: 'some-other-chat', sessionId: null } }))`)
  await sleep(300)
  a = await state()
  await ev(`window.dispatchEvent(new CustomEvent('hydra-desk:chat-sent', { detail: { chatId: 'stream-bench', sessionId: null } }))`)
  await sleep(500)
  b = await state()
  check(a.distance > 300 && b.distance < 2, `a send here goes to the bottom, another chat's does not (other ${Math.round(a.distance)}, here ${Math.round(b.distance)})`)

  // 8. At the bottom it follows the reply.
  await push(10)
  await sleep(300)
  b = await state()
  check(b.distance < 2, `at the bottom it follows the reply (distance ${Math.round(b.distance)})`)

  // 9. A chat mounts with rows of varied height (replies of 200 to 3,200 characters, tool runs): it ends at its newest message.
  const SAMPLE = `window.__streamBench.sample(40, 1000)`
  await load()
  await ev(`window.__streamBench.mount('chat-a', ${SAMPLE})`)
  await sleep(1000)
  a = await state()
  check(a.distance <= 2, `a chat mounted with varied rows ends at its bottom after 1 s (distance ${Math.round(a.distance)})`)
  await sleep(2000)
  a = await state()
  check(a.distance <= 2, `a chat mounted with varied rows ends at its bottom after 3 s (distance ${Math.round(a.distance)})`)

  // 10. A chat mounts with no items (loading), and they arrive later: it ends at the bottom once they are in.
  for (const late of [800, 2000]) {
    await load()
    await ev(`window.__streamBench.mount('chat-b', [], true)`)
    await sleep(late)
    await ev(`window.__streamBench.arrive(${SAMPLE})`)
    await sleep(1000)
    a = await state()
    check(a.distance <= 2, `items arriving ${late} ms after the mount: at the bottom 1 s after they land (distance ${Math.round(a.distance)})`)
    await sleep(2000)
    a = await state()
    check(a.distance <= 2, `items arriving ${late} ms after the mount: at the bottom 3 s after they land (distance ${Math.round(a.distance)})`)
  }

  // 11. Scrolled up in one chat, then another chat mounts (a new key, as DeskFrame does): it starts at its bottom.
  await load()
  await ev(`window.__streamBench.mount('chat-a', ${SAMPLE})`)
  await sleep(800)
  await wheel(-600)
  await sleep(300)
  await ev(`window.__streamBench.mount('chat-c', window.__streamBench.sample(30, 5000))`)
  await sleep(1000)
  a = await state()
  check(a.distance <= 2, `switching chat lands at the new chat's bottom after 1 s (distance ${Math.round(a.distance)})`)
  await sleep(2000)
  a = await state()
  check(a.distance <= 2, `switching chat lands at the new chat's bottom after 3 s (distance ${Math.round(a.distance)})`)
} finally {
  // The Edge launched here may hand its window to another process: close the browser over CDP, then the launcher.
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()
    const b = new WebSocket(webSocketDebuggerUrl)
    await new Promise((r) => (b.onopen = r))
    b.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    await sleep(300)
    b.close()
  } catch {}
  for (const s of sockets) s.close()
  edge?.kill()
  vite.kill()
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
}

for (const l of lines) console.log(l.line)
const failed = lines.filter((l) => !l.ok).length
console.log(failed ? `${failed} of ${lines.length} FAILED` : `all ${lines.length} passed`)
process.exit(failed ? 1 : 0)
