import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type CdpSend, createPageSnapshot } from '../../../src/browser/agent/snapshot'
import { findChrome } from '../../../src/browser/cdp'

const FIXTURES = join(import.meta.dir, 'fixtures')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let chrome: ChildProcess | undefined
let profile = ''
let socket: WebSocket | undefined
let page: ReturnType<typeof createPageSnapshot>
let sendCdp: CdpSend

beforeAll(async () => {
  const bin = findChrome()
  if (!bin) throw new Error('no Chrome installed: the snapshot test needs headless Chrome')
  profile = mkdtempSync(join(tmpdir(), 'hydra-snapshot-test-'))
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

  let port = 0
  for (let i = 0; i < 150 && !port; i++) {
    const file = join(profile, 'DevToolsActivePort')
    if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0])
    if (!port) await sleep(100)
  }
  if (!port) throw new Error('Chrome did not open a debugging port')

  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string
    webSocketDebuggerUrl: string
  }[]
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('Chrome has no page target')

  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => socket!.addEventListener('open', r, { once: true }))
  let nextId = 1
  const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>()
  socket.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data))
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
  sendCdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
      socket!.send(JSON.stringify({ id, method, params }))
    })
  page = createPageSnapshot(sendCdp)

  await sendCdp('Page.enable')
  await sendCdp('Page.navigate', { url: pathToFileURL(join(FIXTURES, 'snapshot-page.html')).href })
  for (let i = 0; i < 100; i++) {
    const state = (await sendCdp('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    })) as { result?: { value?: string } }
    if (state.result?.value === 'complete') break
    await sleep(100)
  }
  await sleep(500)
}, 60_000)

afterAll(async () => {
  socket?.close()
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

const expected = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
// Chrome's backendDOMNodeIds differ between launches, so ref numbers are masked in the comparison; resolution is tested separately.
const maskRefs = (s: string) => s.replace(/\[ref=e\d+\]/g, '[ref=eN]')

describe('browser snapshot (port of Connections browser.mjs)', () => {
  let aria = ''

  test('the aria snapshot is byte-identical to Connections output (refs masked)', async () => {
    aria = await page.snapshot({})
    expect(maskRefs(aria)).toBe(expected('snapshot-aria.txt'))
  })

  test('the selectors snapshot is byte-identical to Connections output', async () => {
    expect(await page.snapshot({ mode: 'selectors' })).toBe(expected('snapshot-selectors.txt'))
  })

  test('maxLines caps the outline with the same footer as Connections', async () => {
    expect(maskRefs(await page.snapshot({ maxLines: 8 }))).toBe(
      expected('snapshot-aria-capped.txt'),
    )
  })

  test('refs resolve back to the elements they name', async () => {
    const refOf = (label: string) => {
      const line = aria.split('\n').find((l) => l.includes(label))
      const m = line && /\[ref=(e\d+)\]/.exec(line)
      if (!m) throw new Error(`no ref line for ${label}`)
      return m[1]!
    }
    const elementAt = async (ref: string) => {
      const pt = await page.resolveRef(ref)
      const hit = (await sendCdp('Runtime.evaluate', {
        expression: `(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y}); return e ? (e.id || e.textContent.trim()) : null })()`,
        returnByValue: true,
      })) as { result?: { value?: string } }
      return hit.result?.value
    }
    expect(await elementAt(refOf('button "Save draft"'))).toBe('Save draft')
    expect(await elementAt(refOf('textbox "Search the catalog"'))).toBe('q')
  })
})
