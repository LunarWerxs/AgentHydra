// Copy, cut and paste in the live browser pane end to end (bun run e2e:clipboard; Windows, Chrome, a visible window moved off screen).
// Starts a throwaway Chrome (temp profile, its own debugging port) on a local page with an <input>, a multi-line <textarea> and plain
// text, drives it through LiveSession with the messages the pane sends (SavedBrowsers.vue's onKey: Control down, then the key; a
// drag selection; Ctrl+A), plays the Desk page's part (the `clipboard` answer goes to the Windows clipboard, a paste sends the
// clipboard text as `text`), and reads the Windows clipboard. E2E_RUNS (default 10) rounds of every case; E2E_LEGACY=1 forwards every
// key as plain keys (how the pane worked before) to show what failed. The owner's clipboard is saved first and restored at the end;
// its old text is never printed. Exits 1 on any FAIL.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer'
import { LiveSession } from '../server/src/browser/cdp'
import { clipboardAction, keyMessage } from '../web/src/components/servers/logic'
import type { BrowserLiveIn, BrowserLiveOut } from '../shared/browser'

const RUNS = Number(process.env.E2E_RUNS) || 10
const LEGACY = process.env.E2E_LEGACY === '1'
const CHROME = process.env.E2E_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n$/, '')

const ps = (script: string, env: Record<string, string> = {}) =>
  spawnSync('powershell', ['-NoProfile', '-STA', '-Command', script], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true }).stdout ?? ''
const getClip = () => norm(ps('Get-Clipboard -Raw'))
const setClip = (text: string) => void ps('Set-Clipboard -Value $env:CLIP_TEXT', { CLIP_TEXT: text })

const dir = mkdtempSync(join(tmpdir(), 'desk2-clip-'))
const backup = join(dir, 'clip.txt')
ps(`$t = Get-Clipboard -Raw; if ($t) { [IO.File]::WriteAllText($env:BK, $t) }`, { BK: backup })

const html = `<!doctype html><meta charset=utf-8><body style="font:16px sans-serif;margin:20px">
<input id=name value="Ada Example" style="display:block;width:300px;margin:8px 0">
<input id=email value="ada@example.com" style="display:block;width:300px;margin:8px 0">
<textarea id=msg style="display:block;width:400px;height:120px;margin:8px 0">First line of an invented message.
Second line, also invented.
Third line to finish.</textarea>
<p id=para style="width:400px">Plain page text that is not in any box, just a paragraph.</p>`
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) })

const chrome = spawn(CHROME, [`--user-data-dir=${join(dir, 'profile')}`, '--remote-debugging-port=9461', '--no-first-run', '--no-default-browser-check',
  '--window-position=-2000,-2000', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-size=900,700', 'about:blank'], { stdio: 'ignore', windowsHide: true })
const results: { ok: boolean; line: string }[] = []
let session: LiveSession | null = null
let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null

try {
  for (let t = 0; t < 60; t++) {
    if (await fetch('http://127.0.0.1:9461/json/version').then((r) => r.ok, () => false)) break
    await sleep(250)
  }
  let clipboardOut: string | null = null
  const out = (m: BrowserLiveOut) => {
    if (m.type === 'clipboard') {
      clipboardOut = m.text
      if (m.text) setClip(m.text)
    }
  }
  const tab = await LiveSession.pick(9461, null)
  if (!tab) throw new Error('no page in the test Chrome')
  session = new LiveSession(9461, out, () => {})
  await session.start(tab)
  const send = (m: BrowserLiveIn) => session!.input(m)
  await send({ type: 'viewport', width: 800, height: 600 })
  await send({ type: 'navigate', url: `http://127.0.0.1:${server.port}/` })
  browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9461', defaultViewport: null })
  const page = (await browser.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${server.port}`))!
  for (let t = 0; t < 40 && !(await page.$('#msg')); t++) await sleep(100)

  const MOD = (ctrl: boolean) => ({ altKey: false, shiftKey: false, ctrlKey: ctrl, metaKey: false })
  /** The pane's onKey for one press: keydown and keyup of `key`, with Control held when `ctrl`. */
  async function press(key: string, ctrl = false) {
    if (ctrl) await send(keyMessage({ type: 'keydown', key: 'Control', code: 'ControlLeft', ...MOD(true) }))
    const e = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ...MOD(ctrl) }
    const action = LEGACY ? (ctrl && key === 'v' ? 'paste' : null) : clipboardAction(e)
    if (action === 'paste') await send({ type: 'text', text: getClip() })
    else if (action) await send({ type: 'copy', cut: action === 'cut' })
    else await send(keyMessage({ type: 'keydown', ...e }))
    if (action !== 'paste') await send(keyMessage({ type: 'keyup', ...e }))
    if (ctrl) await send(keyMessage({ type: 'keyup', key: 'Control', code: 'ControlLeft', ...MOD(false) }))
    await sleep(250)
  }
  const mouse = (event: 'down' | 'up' | 'move', x: number, y: number, clickCount = 1, held = false) =>
    send({ type: 'mouse', event, x, y, button: event === 'move' && !held ? 'none' : 'left', clickCount: event === 'move' ? 0 : clickCount, modifiers: 0 })
  const center = async (sel: string, fx = 0.5, fy = 0.5) => page.$eval(sel, (el, fx, fy) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy } }, fx, fy)
  const reset = () => page.evaluate(() => {
    ;(document.getElementById('name') as HTMLInputElement).value = 'Ada Example'
    ;(document.getElementById('msg') as HTMLTextAreaElement).value = 'First line of an invented message.\nSecond line, also invented.\nThird line to finish.'
    ;(document.activeElement as HTMLElement | null)?.blur()
    getSelection()?.removeAllRanges()
  })
  /** What the page has selected, as a copy would take it. */
  const selected = () => page.evaluate(() => {
    const a = document.activeElement as HTMLInputElement | null
    return a && typeof a.selectionStart === 'number' && a.selectionStart !== null ? a.value.slice(a.selectionStart, a.selectionEnd!) : String(getSelection())
  })

  type Target = { name: string; select: () => Promise<void>; value: () => Promise<string>; editable: boolean }
  const targets: Target[] = [
    { name: 'input', editable: true, value: () => page.$eval('#name', (e) => (e as HTMLInputElement).value),
      select: async () => { const p = await center('#name'); await mouse('down', p.x, p.y); await mouse('up', p.x, p.y); await press('a', true) } },
    { name: 'textarea', editable: true, value: () => page.$eval('#msg', (e) => (e as HTMLTextAreaElement).value),
      select: async () => {
        const a = await center('#msg', 0.05, 0.12)
        const b = await center('#msg', 0.7, 0.4)
        await mouse('down', a.x, a.y); await mouse('move', (a.x + b.x) / 2, (a.y + b.y) / 2, 1, true); await mouse('move', b.x, b.y, 1, true); await mouse('up', b.x, b.y)
      } },
    { name: 'page text', editable: false, value: () => page.$eval('#para', (e) => e.textContent ?? ''),
      select: async () => { const p = await center('#para', 0.2, 0.3); await mouse('down', p.x, p.y, 3); await mouse('up', p.x, p.y, 3) } },
  ]

  const check = (ok: boolean, line: string) => { results.push({ ok, line }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`) }
  for (const t of targets) {
    for (const mode of ['copy', 'cut', 'paste'] as const) {
      let good = 0
      let why = ''
      for (let n = 1; n <= RUNS; n++) {
        await reset()
        clipboardOut = null
        const sentinel = `sentinel-${t.name}-${mode}-${n}`
        setClip(sentinel)
        const before = await t.value()
        await t.select()
        const want = await selected()
        if (mode === 'paste') {
          if (!t.editable) { good++; continue }
          setClip(`pasted text ${n}`)
          await press('v', true)
          const v = await t.value()
          if (v.includes(`pasted text ${n}`) && !v.includes(want || '\u0000')) good++
          else why = `value after paste: ${JSON.stringify(v.slice(0, 60))}`
        } else {
          await press(mode === 'copy' ? 'c' : 'x', true)
          const got = getClip()
          const after = await t.value()
          const gone = mode === 'cut' && t.editable ? after === before.replace(want, '') : after === before
          if (want && got === norm(want) && gone) good++
          else why = `selected ${JSON.stringify(want.slice(0, 30))}, clipboard ${JSON.stringify(got.slice(0, 30))}${gone ? '' : ', page text not as expected'}`
        }
      }
      check(good === RUNS, `${t.name} ${mode}: ${good}/${RUNS}${why && good < RUNS ? ` (last: ${why})` : ''}`)
    }
  }
} finally {
  try { await browser?.disconnect() } catch {}
  session?.close()
  chrome.kill()
  server.stop(true)
  ps(`if (Test-Path $env:BK) { Set-Clipboard -Value ([IO.File]::ReadAllText($env:BK)) }`, { BK: backup })
  await sleep(500)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
if (results.some((r) => !r.ok)) process.exit(1)
console.log('all passed')
