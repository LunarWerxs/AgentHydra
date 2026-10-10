import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallResult } from '../../../src/browser/agent/contract'
import { callTool } from '../../../src/browser/agent/tools'
import { closeBrowser, findChrome } from '../../../src/browser/cdp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const HTML = (body: string) => `<!doctype html><html><head><title>Fixture Script</title></head><body>${body}</body></html>`

const FORM = HTML(
  '<input id="q" type="text"><button id="save" onclick="document.getElementById(\'out\').textContent=\'Saved: \'+document.getElementById(\'q\').value">Save</button><div id="out"></div>',
)

let chrome: ChildProcess | undefined
let profile = ''
let port = 0
let server: ReturnType<typeof Bun.serve> | undefined
let base = ''
let hits = 0

beforeAll(async () => {
  const bin = findChrome()
  if (!bin) throw new Error('no Chrome installed: the script test needs headless Chrome')
  profile = mkdtempSync(join(tmpdir(), 'hydra-script-test-'))
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
    fetch: (req) => {
      const path = new URL(req.url).pathname
      if (path === '/form') return new Response(FORM, { headers: { 'content-type': 'text/html' } })
      if (path === '/count') {
        hits++
        return new Response(HTML('<p>counted</p>'), { headers: { 'content-type': 'text/html' } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
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

const caller = { chat: 'chat-script' }
const script = (steps: unknown[]): Promise<CallResult> => callTool('browser_script', { steps, attachPort: port }, caller)
const ok = (r: CallResult): string => {
  if (!r.ok) throw new Error(`${r.status}: ${r.error}`)
  return r.text
}
const lines = async (steps: unknown[]): Promise<string[]> => ok(await script(steps)).split('\n')

describe('browser_script (port of Connections browser.mjs browserActionScript)', () => {
  test('runs goto, type, click, waitText and read in order and answers one line per step', async () => {
    const out = await lines([
      { do: 'goto', url: `${base}/form`, waitMs: 500 },
      { do: 'type', selector: '#q', text: 'hello' },
      { do: 'click', selector: '#save' },
      { do: 'waitText', text: 'Saved: hello', timeoutMs: 5000 },
      { do: 'read', selector: '#out' },
    ])
    expect(out).toHaveLength(5)
    expect(out[0]).toStartWith('1. goto → navigated')
    expect(out[3]).toBe('4. waitText → found: Saved: hello')
    expect(out[4]).toContain('Saved: hello')
  })

  test('a failed step aborts the rest and counts the steps not run', async () => {
    const out = await lines([
      { do: 'goto', url: `${base}/form`, waitMs: 300 },
      { do: 'read', selector: '#missing' },
      { do: 'text' },
    ])
    expect(out).toHaveLength(3)
    expect(out[1]).toStartWith('2. read FAILED:')
    expect(out[2]).toBe('(aborted — 1 step(s) not run)')
  })

  test('an optional failed step lets the script continue', async () => {
    const out = await lines([
      { do: 'read', selector: '#missing', optional: true },
      { do: 'goto', url: `${base}/form`, waitMs: 300 },
    ])
    expect(out[0]).toStartWith('1. read FAILED:')
    expect(out[1]).toStartWith('2. goto → navigated')
    expect(out.join('\n')).not.toContain('aborted')
  })

  test('close, script and a step with no do are skipped, not run', async () => {
    const out = await lines([{ do: 'close' }, { do: 'script', steps: [] }, {}])
    expect(out).toEqual([
      '1. close SKIPPED (not allowed in a script)',
      '2. script SKIPPED (not allowed in a script)',
      '3. undefined SKIPPED (not allowed in a script)',
    ])
  })

  test('a step that types a secret refuses the whole script before any step runs', async () => {
    const before = hits
    const r = await script([{ do: 'goto', url: `${base}/count`, waitMs: 300 }, { do: 'type', secret: 'pw', selector: '#q' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('a browser_script step cannot type a `secret` - nothing ran.')
    expect(hits).toBe(before)
  })

  test('waitSel and waitText answer a timeout after their limit', async () => {
    expect(await lines([{ do: 'waitSel', selector: '#nope', timeoutMs: 300 }])).toEqual([
      '1. waitSel FAILED: timeout (300ms) waiting for selector: #nope',
      '(aborted — 0 step(s) not run)',
    ])
    expect(await lines([{ do: 'waitText', text: 'never shown', timeoutMs: 300 }])).toEqual([
      '1. waitText FAILED: timeout (300ms) waiting for page text: never shown',
      '(aborted — 0 step(s) not run)',
    ])
  })

  test('sleep waits the milliseconds it is given and answers them', async () => {
    expect(await lines([{ do: 'sleep', ms: 10 }])).toEqual(['1. sleep → slept 10ms'])
  })

  test('a script that goes to etsy.com is refused whole, before any step runs', async () => {
    const r = await script([{ do: 'goto', url: 'https://www.etsy.com/' }])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.error).toStartWith('browser REFUSED: www.etsy.com')
    }
  })
})
