// Files dropped on a chat (bun e2e/attach-files.e2e.ts; Windows, Edge): a PDF, a Markdown note, an email, a zip and a BMP
// dropped on the TRANSCRIPT (not the box) each become a chip in the composer, upload to <home>/attachments with the same
// bytes, and none is refused as "not an image"; a file dropped on the sidebar attaches nothing and never navigates the page.
// Needs the built Desk 2 (run `bun run build` first); runs on a throwaway HYDRA_DESK_HOME, prints PASS/FAIL per case and
// saves a screenshot of the composer to E2E_SHOT (default: the temp folder).

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { portFrom } from './lib/free-port'
import { QUIET_EDGE } from './lib/edge-flags'

const DESK = resolve(import.meta.dir, '..')
const PORT = portFrom(process.env.E2E_PORT)
const CDP = portFrom(process.env.E2E_CDP_PORT)
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const SHOT = process.env.E2E_SHOT || join(tmpdir(), 'desk2-attach-files.png')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TITLE = 'Invented attach check'

// Invented contents; each is sent as the browser would send a dropped file.
const FILES = [
  { name: 'spec.pdf', type: 'application/pdf', text: '%PDF-1.4\n% invented\n' },
  { name: 'notes.md', type: 'text/markdown', text: '# Notes\n\n- one\n' },
  { name: 'invoice.eml', type: 'message/rfc822', text: 'From: owner@example.com\nSubject: Invoice\n\nSee attached.\n' },
  { name: 'bundle.zip', type: 'application/zip', text: 'PK\u0005\u0006' + '\u0000'.repeat(18) },
  { name: 'shot.bmp', type: 'image/bmp', text: 'BM invented' },
]

const home = mkdtempSync(join(tmpdir(), 'desk2-attach-home-'))
const profile = mkdtempSync(join(tmpdir(), 'desk2-attach-edge-'))
const cwd = mkdtempSync(join(tmpdir(), 'desk2-attach-cwd-'))
const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
  cwd: DESK, env: { ...process.env, HYDRA_DESK_PORT: String(PORT), HYDRA_DESK_HOME: home },
  stdout: 'ignore', stderr: 'ignore', windowsHide: true,
})
let edge: ReturnType<typeof Bun.spawn> | null = null
let ws: WebSocket | null = null
let failed = 0
const report = (name: string, why: string) => {
  if (why) failed++
  console.log(`${why ? 'FAIL' : 'PASS'} ${name}${why ? `: ${why}` : ''}`)
}

// Drops the files on the element the selector names, as a drag from Explorer would; answers whether the page took the drop.
const dropOn = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'missing'
  const dt = new DataTransfer()
  for (const f of ${JSON.stringify(FILES)}) dt.items.add(new File([f.text], f.name, { type: f.type }))
  el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
  el.dispatchEvent(drop)
  return drop.defaultPrevented ? 'taken' : 'not taken'
})()`
const CHIPS = `JSON.stringify([...document.querySelectorAll('button[aria-label^="Remove "]')].map((b) => b.closest('div').textContent.trim()))`

try {
  let up = false
  for (let t = 0; t < 60 && !up; t++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok } catch {}
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`)
  const created = await fetch(`http://127.0.0.1:${PORT}/api/chats`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, title: TITLE }),
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
  await send('Page.enable')
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  const row = `[...document.querySelectorAll('button[aria-label="More options for ${TITLE}"]')][0]?.closest('[role="button"]')`
  if (!(await until(`!!${row}`, 25_000))) throw new Error('the chat row never showed')
  await ev(`${row}.click()`)
  if (!(await until(`!!document.querySelector('[data-file-drop] [data-testid="transcript"], [data-file-drop] textarea')`, 15_000))) throw new Error('the chat never opened')
  await sleep(500)

  // 1. Dropped on the transcript, not the box.
  const target = (await ev(`!!document.querySelector('[data-file-drop] [data-testid="transcript"]')`)) ? '[data-file-drop] [data-testid="transcript"]' : '[data-file-drop] > div'
  const took = await ev(dropOn(target))
  const settled = await until(`(() => { const c = ${CHIPS}; return JSON.parse(c).length === ${FILES.length} && !c.includes('Attaching') })()`, 15_000)
  const chips: string[] = JSON.parse(await ev(CHIPS))
  const notice: string = (await ev(`document.body.innerText.includes('is not an image') ? 'refused as not an image' : ''`)) ?? ''
  report('a drop on the transcript attaches every file', took !== 'taken' ? `drop ${took}` : !settled ? `chips ${JSON.stringify(chips)}` : notice)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))

  // 2. Each upload holds the dropped bytes, under its own name.
  const kept = new Map<string, string>()
  try {
    for (const dir of readdirSync(join(home, 'attachments'))) for (const f of readdirSync(join(home, 'attachments', dir))) kept.set(f, readFileSync(join(home, 'attachments', dir, f), 'utf8'))
  } catch {}
  const wrong = FILES.filter((f) => kept.get(f.name) !== f.text).map((f) => f.name)
  report('each file is kept with its bytes', wrong.length ? `missing or different: ${wrong.join(', ')}` : '')

  // 3. A file dropped on the sidebar attaches nothing and the page stays.
  const before = location()
  const outside = await ev(dropOn('nav, aside, [aria-label="Sidebar"]'))
  await sleep(800)
  const after: string[] = JSON.parse(await ev(CHIPS))
  report('a drop outside the chat attaches nothing and never navigates', outside === 'missing' ? 'no sidebar to drop on' : outside !== 'taken' ? 'the window was left to open the file' : after.length !== FILES.length ? `chips went ${chips.length} -> ${after.length}` : (await location()) !== (await before) ? 'page navigated' : '')

  function location(): Promise<string> {
    return ev('location.href')
  }
} catch (err) {
  report('setup', err instanceof Error ? err.message : String(err))
} finally {
  ws?.close()
  edge?.kill()
  server.kill()
  await sleep(300)
  for (const dir of [home, profile, cwd]) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}
console.log(`screenshot: ${SHOT}`)
process.exit(failed ? 1 : 0)
