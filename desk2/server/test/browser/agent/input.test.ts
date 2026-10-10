import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallResult } from '../../../src/browser/agent/contract'
import { callTool } from '../../../src/browser/agent/tools'
import { closeBrowser, findChrome } from '../../../src/browser/cdp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><html><head><title>Fixture Input</title></head><body>
<button id="rec" onclick="window.__clicks=(window.__clicks||0)+1">Record click</button>
<div id="host"></div>
<script>const root=document.getElementById('host').attachShadow({mode:'open'});root.innerHTML="<button onclick='window.__shadow=true'>Shadow button</button>";</script>
<iframe id="fr" srcdoc="<button onclick='parent.__frame=true'>Frame button</button>"></iframe>
<div id="hov" style="width:200px;height:40px;background:#eee" onmouseenter="window.__hover=true">Hover zone</div>
<select id="pick" onchange="window.__picked=this.value"><option value="alpha">Alpha</option><option value="beta">Beta</option><option value="gamma">Gamma</option></select>
<button id="trig" onclick="document.getElementById('lb').style.display='block'">Pick colour</button>
<div id="lb" role="listbox" style="display:none;position:absolute;top:0;left:400px;background:#fff"><div role="option" onclick="window.__custom=this.innerText;this.parentNode.style.display='none'">Red</div><div role="option" onclick="window.__custom=this.innerText;this.parentNode.style.display='none'">Green</div></div>
<input id="name" type="text" aria-label="Name field" value="old value">
<form id="f" onsubmit="event.preventDefault();window.__submitted=true"><input id="q" type="text" aria-label="Search the catalog" value="lantern"></form>
</body></html>`

let chrome: ChildProcess | undefined
let profile = ''
let port = 0
let server: ReturnType<typeof Bun.serve> | undefined
let pageUrl = ''

beforeAll(async () => {
  const bin = findChrome()
  if (!bin) throw new Error('no Chrome installed: the input test needs headless Chrome')
  profile = mkdtempSync(join(tmpdir(), 'hydra-input-test-'))
  chrome = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=800,600',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  )
  for (let i = 0; i < 150 && !port; i++) {
    const file = join(profile, 'DevToolsActivePort')
    try {
      if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0])
    } catch {
      // On Windows Chrome holds the file locked while it writes it (EBUSY): the port is not there yet.
    }
    if (!port) await sleep(100)
  }
  if (!port) throw new Error('Chrome did not open a debugging port')
  for (let i = 0; i < 150; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)
    if (up) break
    await sleep(100)
  }

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
  })
  pageUrl = `http://127.0.0.1:${server.port}/`
}, 60_000)

afterAll(async () => {
  server?.stop(true)
  if (profile) await closeBrowser(profile).catch(() => false)
  chrome?.kill()
  for (let i = 0; i < 20 && profile; i++) {
    try {
      rmSync(profile, { recursive: true, force: true })
      break
    } catch {
      await sleep(200)
    }
  }
})

const ok = (r: CallResult): string => {
  if (!r.ok) throw new Error(`${r.status}: ${r.error}`)
  return r.text
}

const caller = { chat: 'chat-input' }

async function pageWs(): Promise<string> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string
    url: string
    webSocketDebuggerUrl?: string
  }[]
  const page = list.find((t) => t.type === 'page' && t.url.startsWith(pageUrl))
  if (!page?.webSocketDebuggerUrl) throw new Error('the fixture page is not open')
  return page.webSocketDebuggerUrl
}

async function evalPage(expression: string): Promise<unknown> {
  const ws = new WebSocket(await pageWs())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('evaluate: no answer'))
    }, 5000)
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { result?: { value?: unknown } } }
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      resolve(msg.result?.result?.value)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('evaluate: socket failed'))
    }
  })
}

const snapshotRef = async (name: string): Promise<string> => {
  const outline = ok(await callTool('browser_snapshot', { attachPort: port }, caller))
  const match = outline.match(new RegExp(`"${name}" \\[ref=(e\\d+)\\]`))
  if (!match) throw new Error(`no ref for "${name}" in the snapshot`)
  return match[1]
}

describe('browser input tools (port of Connections browser.mjs)', () => {
  test('navigate to the fixture, then click by ref, text, selector and coordinates', async () => {
    ok(await callTool('browser_navigate', { url: pageUrl, attachPort: port, waitMs: 800 }, caller))

    const ref = await snapshotRef('Record click')
    expect(ok(await callTool('browser_click', { ref, attachPort: port, waitMs: 100 }, caller))).toMatch(
      /^clicked e\d+ @ \(\d+,\d+\)$/,
    )
    expect(await evalPage('window.__clicks || 0')).toBe(1)

    ok(await callTool('browser_click', { text: 'Record click', attachPort: port, waitMs: 100 }, caller))
    expect(await evalPage('window.__clicks || 0')).toBe(2)

    ok(await callTool('browser_click', { selector: '#rec', attachPort: port, waitMs: 100 }, caller))
    expect(await evalPage('window.__clicks || 0')).toBe(3)

    const xy = (await evalPage(
      "(()=>{const r=document.getElementById('rec').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()",
    )) as { x: number; y: number }
    ok(await callTool('browser_click', { x: xy.x, y: xy.y, attachPort: port, waitMs: 100 }, caller))
    expect(await evalPage('window.__clicks || 0')).toBe(4)
  }, 60_000)

  test('click reaches an open shadow root and a same-origin iframe', async () => {
    ok(await callTool('browser_click', { text: 'Shadow button', attachPort: port, waitMs: 100 }, caller))
    expect(await evalPage('window.__shadow === true')).toBe(true)

    ok(await callTool('browser_click', { text: 'Frame button', attachPort: port, waitMs: 100 }, caller))
    expect(await evalPage('window.__frame === true')).toBe(true)
  }, 60_000)

  test('hover moves the mouse over an element', async () => {
    const text = ok(await callTool('browser_hover', { selector: '#hov', attachPort: port, waitMs: 100 }, caller))
    expect(text).toMatch(/^hovered /)
    expect(await evalPage('window.__hover === true')).toBe(true)
  }, 60_000)

  test('select picks a native option and a custom popup option', async () => {
    expect(
      ok(await callTool('browser_select', { selector: '#pick', option: 'Beta', attachPort: port }, caller)),
    ).toBe('selected "Beta" (native select)')
    expect(await evalPage("document.getElementById('pick').value")).toBe('beta')
    expect(await evalPage('window.__picked')).toBe('beta')

    expect(
      ok(await callTool('browser_select', { selector: '#trig', option: 'Green', attachPort: port }, caller)),
    ).toBe('selected "Green"')
    expect(await evalPage('window.__custom')).toBe('Green')
  }, 60_000)

  test('type replaces a prefilled value, by selector and by ref', async () => {
    ok(await callTool('browser_type', { selector: '#name', text: 'new name', attachPort: port }, caller))
    expect(await evalPage("document.getElementById('name').value")).toBe('new name')

    const ref = await snapshotRef('Search the catalog')
    ok(await callTool('browser_type', { ref, text: 'fresh', attachPort: port }, caller))
    expect(await evalPage("document.getElementById('q').value")).toBe('fresh')
  }, 60_000)

  test('press_key Enter submits the form that holds the focused field', async () => {
    ok(await callTool('browser_type', { selector: '#q', text: 'submit me', attachPort: port }, caller))
    expect(ok(await callTool('browser_press_key', { key: 'Enter', attachPort: port, waitMs: 100 }, caller))).toBe(
      'pressed Enter',
    )
    expect(await evalPage('window.__submitted === true')).toBe(true)
  }, 60_000)

  test('input tools report bad input as errors', async () => {
    const badKey = await callTool('browser_press_key', { key: 'F13', attachPort: port }, caller)
    expect(badKey.ok).toBe(false)
    if (!badKey.ok) expect(badKey.error).toContain('unknown key: F13')

    const noTarget = await callTool('browser_click', { attachPort: port }, caller)
    expect(noTarget.ok).toBe(false)

    const noOption = await callTool('browser_select', { selector: '#pick', attachPort: port }, caller)
    expect(noOption.ok).toBe(false)

    const noText = await callTool('browser_type', { selector: '#name', attachPort: port }, caller)
    expect(noText.ok).toBe(false)
  }, 60_000)
})
