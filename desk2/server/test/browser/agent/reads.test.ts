import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallResult } from '../../../src/browser/agent/contract'
import { callTool } from '../../../src/browser/agent/tools'
import { closeBrowser, findChrome } from '../../../src/browser/cdp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><html><head><title>Fixture Ledger</title></head><body>
<h1>Quarterly Orchid Ledger</h1>
<button id="save">Save draft</button>
<input id="q" type="text" aria-label="Search the catalog" value="lantern">
<p id="note">Harbor note: seven crates shipped.</p>
</body></html>`

let chrome: ChildProcess | undefined
let profile = ''
let port = 0
let server: ReturnType<typeof Bun.serve> | undefined
let pageUrl = ''

beforeAll(async () => {
  const bin = findChrome()
  if (!bin) throw new Error('no Chrome installed: the reads test needs headless Chrome')
  profile = mkdtempSync(join(tmpdir(), 'hydra-reads-test-'))
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
    if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0])
    if (!port) await sleep(100)
  }
  if (!port) throw new Error('Chrome did not open a debugging port')
  for (let i = 0; i < 150; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)
    if (up) break
    await sleep(100)
  }

  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) })
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

describe('browser read tools (port of Connections browser.mjs)', () => {
  test('caller A navigates, then snapshot, get_text and read see its page', async () => {
    const a = { chat: 'chat-a' }
    const nav = ok(await callTool('browser_navigate', { url: pageUrl, attachPort: port, waitMs: 800 }, a))
    expect(nav).toContain('navigated')

    const outline = ok(await callTool('browser_snapshot', { attachPort: port }, a))
    expect(outline).toMatch(/button "Save draft" \[ref=e\d+\]/)
    expect(outline).toMatch(/textbox "Search the catalog" \[ref=e\d+\]/)

    const text = ok(await callTool('browser_get_text', { attachPort: port }, a))
    expect(text).toContain('Quarterly Orchid Ledger')
    expect(text).toContain('Harbor note: seven crates shipped.')

    expect(ok(await callTool('browser_read', { selector: '#q', attachPort: port }, a))).toBe('lantern')
    expect(ok(await callTool('browser_read', { selector: '#note', attachPort: port }, a))).toBe(
      'Harbor note: seven crates shipped.',
    )
    expect(ok(await callTool('browser_read', { selector: 'h1', attr: 'id', attachPort: port }, a))).toBe('')
  }, 60_000)

  test('caller B cannot see caller A page', async () => {
    const b = { chat: 'chat-b' }
    const outline = ok(await callTool('browser_snapshot', { attachPort: port }, b))
    expect(outline).not.toContain('Save draft')
    expect(outline).toContain('(the page exposes no accessible content yet')

    const text = ok(await callTool('browser_get_text', { attachPort: port }, b))
    expect(text).not.toContain('Harbor note')
  }, 60_000)

  test('read reports a missing element and a missing selector as errors', async () => {
    const missing = await callTool('browser_read', { selector: '#absent', attachPort: port }, { chat: 'chat-a' })
    expect(missing.ok).toBe(false)
    const none = await callTool('browser_read', { attachPort: port }, { chat: 'chat-a' })
    expect(none.ok).toBe(false)
  }, 60_000)
})
