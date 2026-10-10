import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallResult } from '../../../src/browser/agent/contract'
import { callTool } from '../../../src/browser/agent/tools'
import { closeBrowser, findChrome } from '../../../src/browser/cdp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const HTML = (body: string) => `<!doctype html><html><head><title>Fixture Exec</title></head><body>${body}</body></html>`

const ROUTES: Record<string, { type: string; body: string }> = {
  '/hidden': {
    type: 'text/html',
    body: HTML('<h1>Hidden picker</h1><input type="file" id="hidden" style="display:none">'),
  },
  '/shadow': {
    type: 'text/html',
    body: HTML(
      '<div id="host"></div><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML=\'<input type="file" id="sh">\';</script>',
    ),
  },
  '/frame-host': {
    type: 'text/html',
    body: HTML('<iframe id="frame" src="/frame" width="300" height="100"></iframe>'),
  },
  '/frame': {
    type: 'text/html',
    body: HTML('<input type="file" id="fr" accept=".txt">'),
  },
  '/multi': {
    type: 'text/html',
    body: HTML('<input type="file" id="many" multiple>'),
  },
  '/api': { type: 'application/json', body: '{"greeting":"harbor"}' },
}

let chrome: ChildProcess | undefined
let profile = ''
let port = 0
let server: ReturnType<typeof Bun.serve> | undefined
let base = ''
let fixtures = ''
let alpha = ''
let beta = ''

beforeAll(async () => {
  const bin = findChrome()
  if (!bin) throw new Error('no Chrome installed: the exec test needs headless Chrome')
  profile = mkdtempSync(join(tmpdir(), 'hydra-exec-test-'))
  fixtures = mkdtempSync(join(tmpdir(), 'hydra-exec-files-'))
  alpha = join(fixtures, 'ledger-alpha.txt')
  beta = join(fixtures, 'ledger-beta.txt')
  writeFileSync(alpha, 'alpha rows')
  writeFileSync(beta, 'beta rows')
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
      const route = ROUTES[new URL(req.url).pathname]
      if (!route) return new Response('not found', { status: 404 })
      return new Response(route.body, { headers: { 'content-type': route.type } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
}, 60_000)

afterAll(async () => {
  server?.stop(true)
  if (profile) await closeBrowser(profile).catch(() => false)
  chrome?.kill()
  for (const dir of [profile, fixtures]) {
    for (let i = 0; i < 20 && dir; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await sleep(200)
      }
    }
  }
})

const ok = (r: CallResult): string => {
  if (!r.ok) throw new Error(`${r.status}: ${r.error}`)
  return r.text
}

const caller = { chat: 'chat-exec' }
async function open(path: string): Promise<void> {
  ok(await callTool('browser_navigate', { url: `${base}${path}`, attachPort: port, waitMs: 800 }, caller))
}

const evaluate = (expression: string, extra: Record<string, unknown> = {}) =>
  callTool('browser_evaluate', { expression, attachPort: port, ...extra }, caller)

describe('browser exec tools (port of Connections browser.mjs eval and upload)', () => {
  test('evaluate returns a number, an object as JSON, and awaits a fetched promise', async () => {
    await open('/hidden')
    expect(ok(await evaluate('1 + 2', {}))).toBe('3')
    expect(ok(await evaluate('({ rows: 4, title: document.title })', {}))).toBe(
      '{"rows":4,"title":"Fixture Exec"}',
    )
    expect(
      ok(await evaluate(`fetch(new URL('/api', location.href)).then((r) => r.json())`, {})),
    ).toBe('{"greeting":"harbor"}')
  }, 60_000)

  test('evaluate with timeoutMs errors instead of hanging on a never-settling promise', async () => {
    const started = Date.now()
    const r = await evaluate('new Promise(() => {})', { timeoutMs: 500 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toMatch(/^page error:/)
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  test('upload attaches to a hidden input in the main document', async () => {
    await open('/hidden')
    const answer = ok(await callTool('browser_upload_file', { file: alpha, attachPort: port, waitMs: 200 }, caller))
    expect(answer).toBe('attached to input[type=file] in the main frame: ledger-alpha.txt')
    expect(ok(await evaluate(`document.getElementById('hidden').files[0].name`, {}))).toBe('ledger-alpha.txt')
  }, 60_000)

  test('upload reaches an input inside an open shadow root', async () => {
    await open('/shadow')
    ok(await callTool('browser_upload_file', { file: alpha, attachPort: port, waitMs: 200 }, caller))
    expect(
      ok(await evaluate(`document.getElementById('host').shadowRoot.getElementById('sh').files[0].name`, {})),
    ).toBe('ledger-alpha.txt')
  }, 60_000)

  test('upload reaches an input in a same-origin iframe and names the accept list', async () => {
    await open('/frame-host')
    const answer = ok(await callTool('browser_upload_file', { file: beta, attachPort: port, waitMs: 200 }, caller))
    expect(answer).toBe('attached to input[type=file] in the same-origin iframe (input accepts .txt): ledger-beta.txt')
    expect(
      ok(await evaluate(`document.getElementById('frame').contentDocument.getElementById('fr').files[0].name`, {})),
    ).toBe('ledger-beta.txt')
  }, 60_000)

  test('upload attaches two files to a multiple input', async () => {
    await open('/multi')
    ok(await callTool('browser_upload_file', { files: [alpha, beta], attachPort: port, waitMs: 200 }, caller))
    expect(
      ok(await evaluate(`Array.from(document.getElementById('many').files).map((f) => f.name).join(',')`, {})),
    ).toBe('ledger-alpha.txt,ledger-beta.txt')
  }, 60_000)

  test('upload refuses a missing path and attaches nothing', async () => {
    await open('/hidden')
    const missing = join(fixtures, 'ledger-missing.txt')
    const r = await callTool('browser_upload_file', { file: missing, attachPort: port, waitMs: 200 }, caller)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('upload: file not found')
    expect(ok(await evaluate(`document.getElementById('hidden').files.length`, {}))).toBe('0')
  }, 60_000)
})
