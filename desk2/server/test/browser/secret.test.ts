import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallResult } from '../../src/browser/agent/contract'
import { hostCheck, runSecret, type SecretRequest, secretRefusal } from '../../src/browser/agent/secret'
import { callTool } from '../../src/browser/agent/tools'
import { closeBrowser, findChrome } from '../../src/browser/cdp'
import { createServer, type DeskServer } from '../../src/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SECRET = 'fixture-secret-value-7Q'

const PAGE = `<!doctype html><html><head><title>Fixture Secret</title></head><body>
<input id="name" type="password" aria-label="Name field" value="old value">
<input id="q" type="text" aria-label="Search the catalog" value="lantern">
<input id="blank" type="text" aria-label="Blank field" value="">
<button id="rec">Record</button>
</body></html>`

const caller = { chat: 'chat-secret' }

let chrome: ChildProcess | undefined
let profile = ''
let port = 0
let httpServer: ReturnType<typeof Bun.serve> | undefined
let httpsServer: ReturnType<typeof Bun.serve> | undefined
let tlsDir = ''
let httpsPort = 0

function makeCert(dir: string): { cert: string; key: string } {
  const bin = Bun.which('openssl') ?? '/mingw64/bin/openssl'
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  const made = spawnSync(
    bin,
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=example.test'],
    { stdio: 'ignore' },
  )
  if (made.status !== 0) throw new Error('openssl could not make the fixture certificate')
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') }
}

beforeAll(async () => {
  const bin = findChrome()
  if (!bin) throw new Error('no Chrome installed: the secret test needs headless Chrome')
  profile = mkdtempSync(join(tmpdir(), 'hydra-secret-test-'))
  chrome = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--ignore-certificate-errors',
      '--host-resolver-rules=MAP * 127.0.0.1',
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
  const fetchPage = () => new Response(PAGE, { headers: { 'content-type': 'text/html' } })
  httpServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: fetchPage })
  tlsDir = mkdtempSync(join(tmpdir(), 'hydra-secret-tls-'))
  const { cert, key } = makeCert(tlsDir)
  httpsServer = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { cert, key }, fetch: fetchPage })
  httpsPort = httpsServer.port as number
}, 60_000)

afterAll(async () => {
  httpServer?.stop(true)
  httpsServer?.stop(true)
  if (profile) await closeBrowser(profile).catch(() => false)
  chrome?.kill()
  for (const dir of [profile, tlsDir]) {
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

const go = (url: string) => callTool('browser_navigate', { url, attachPort: port, waitMs: 300 }, caller).then(ok)

const at = (over: Partial<SecretRequest>): SecretRequest => ({ op: 'where', caller, attachPort: port, ...over })

const typeSecret = (over: Partial<SecretRequest> = {}) =>
  runSecret(
    at({ op: 'type', name: 'TEST_SECRET', value: SECRET, hosts: ['example.test'], selector: '#name', ...over }),
  )

const fieldValue = async (selector: string): Promise<unknown> => {
  const reply = await runSecret(at({ op: 'capture', fields: { v: selector } }))
  return reply.ok ? (reply.values as Record<string, string>).v : reply.error
}

describe('the request guard', () => {
  test('refuses a request carrying an Origin or Referer', () => {
    expect(secretRefusal(new Headers({ origin: 'http://127.0.0.1:7798' }), '127.0.0.1')).not.toBeNull()
    expect(secretRefusal(new Headers({ referer: 'http://127.0.0.1:7798/' }), '127.0.0.1')).not.toBeNull()
  })

  test('refuses a caller off this machine, and one it cannot name', () => {
    expect(secretRefusal(new Headers(), '10.0.0.5')).not.toBeNull()
    expect(secretRefusal(new Headers(), null)).not.toBeNull()
  })

  test('accepts loopback with no page headers', () => {
    expect(secretRefusal(new Headers(), '127.0.0.1')).toBeNull()
    expect(secretRefusal(new Headers(), '::1')).toBeNull()
  })
})

describe('the host check', () => {
  test('a plain host allows only itself; a *. host allows it and its subdomains, as Connections checks', () => {
    expect(hostCheck('https://example.test:8443/login', ['example.test'])).toEqual({ ok: true, host: 'example.test' })
    expect(hostCheck('https://sub.example.test/', ['example.test'])).toMatchObject({ ok: false, error: 'host_not_allowed' })
    expect(hostCheck('https://sub.example.test/', ['*.example.test'])).toEqual({ ok: true, host: 'sub.example.test' })
    expect(hostCheck('https://example.test/', ['*.example.test'])).toEqual({ ok: true, host: 'example.test' })
    expect(hostCheck('https://example.test/', ['https://example.test/login'])).toEqual({ ok: true, host: 'example.test' })
  })

  test('http is allowed only on this machine', () => {
    expect(hostCheck('http://localhost:5173/login', ['localhost'])).toEqual({ ok: true, host: 'localhost' })
    expect(hostCheck('http://127.0.0.1:5173/', ['127.0.0.1'])).toEqual({ ok: true, host: '127.0.0.1' })
  })

  test('refuses a lookalike host, a non-https page, and a host not listed', () => {
    expect(hostCheck('https://example.test.evil.test/', ['example.test']).ok).toBe(false)
    expect(hostCheck('https://example.test.evil.test/', ['*.example.test']).ok).toBe(false)
    expect(hostCheck('https://evil-example.test/', ['*.example.test']).ok).toBe(false)
    expect(hostCheck('http://example.test/', ['example.test'])).toMatchObject({ ok: false, error: 'not_https' })
    expect(hostCheck('https://other.test/', ['example.test'])).toMatchObject({ ok: false, error: 'host_not_allowed' })
  })
})

describe('runSecret', () => {
  test('rejects a request with a missing field or an unknown op before it touches a page', async () => {
    await expect(runSecret(at({ op: 'type', name: 'X', hosts: ['example.test'], selector: '#name' }))).rejects.toThrow(
      'value is required',
    )
    await expect(runSecret(at({ op: 'nope' as SecretRequest['op'] }))).rejects.toThrow('unknown op')
  })

  test('answers no_page for a caller with no page open', async () => {
    const reply = await runSecret(at({ caller: { chat: 'chat-nobody' } }))
    expect(reply).toMatchObject({ ok: false, error: 'no_page' })
  })

  test('where reports the page url and whether it is https', async () => {
    await go(`http://127.0.0.1:${(httpServer as { port: number }).port}/`)
    const reply = await runSecret(at({ op: 'where' }))
    expect(reply).toMatchObject({ ok: true, host: '127.0.0.1', https: false })
  })

  test('types nothing on a non-https page', async () => {
    await go(`http://example.test:${(httpServer as { port: number }).port}/`)
    const reply = await typeSecret()
    expect(reply).toMatchObject({ ok: false, error: 'not_https' })
    expect(JSON.stringify(reply)).not.toContain(SECRET)
    expect(await fieldValue('#name')).toBe('old value')
  })

  test('types the value into an allowed https host and every reply shows only the name', async () => {
    await go(`https://example.test:${httpsPort}/`)
    const logged: unknown[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => {
      const original = console[k]
      console[k] = (...args: unknown[]) => void logged.push(args)
      return () => (console[k] = original)
    })
    const reply = await typeSecret()
    spies.forEach((restore) => restore())
    expect(reply).toMatchObject({ ok: true, typed: '<secret>TEST_SECRET</secret>', host: 'example.test' })
    expect(JSON.stringify(reply)).not.toContain(SECRET)
    expect(JSON.stringify(logged)).not.toContain(SECRET)
    expect(await fieldValue('#name')).toBe(SECRET)
  })

  test('types on a subdomain only when the host is given as *.', async () => {
    await go(`https://sub.example.test:${httpsPort}/`)
    expect(await typeSecret()).toMatchObject({ ok: false, error: 'host_not_allowed' })
    expect(await typeSecret({ hosts: ['*.example.test'] })).toMatchObject({ ok: true, host: 'sub.example.test' })
  })

  test('refuses a lookalike host before typing anything', async () => {
    await go(`https://example.test.evil.test:${httpsPort}/`)
    const reply = await typeSecret()
    expect(reply).toMatchObject({ ok: false, error: 'host_not_allowed' })
    expect(JSON.stringify(reply)).toContain('example.test.evil.test')
    expect(JSON.stringify(reply)).not.toContain(SECRET)
    expect(await fieldValue('#name')).toBe('old value')
  })

  test('refuses a page whose host is not in the hosts list', async () => {
    await go(`https://example.test:${httpsPort}/`)
    expect(await typeSecret({ hosts: ['other.test'] })).toMatchObject({ ok: false, error: 'host_not_allowed' })
    expect(await fieldValue('#name')).toBe('old value')
  })

  test('answers selector_not_found and not_an_input for a bad target', async () => {
    expect(await typeSecret({ selector: '#nope' })).toMatchObject({ ok: false, error: 'selector_not_found' })
    expect(await typeSecret({ selector: '#rec' })).toMatchObject({ ok: false, error: 'not_an_input' })
  })

  test('captures field values by selector and by attribute', async () => {
    await go(`https://example.test:${httpsPort}/`)
    const reply = await runSecret(
      at({ op: 'capture', fields: { q: '#q', label: { selector: '#q', attr: 'aria-label' } } }),
    )
    expect(reply).toMatchObject({ ok: true, host: 'example.test', values: { q: 'lantern', label: 'Search the catalog' } })
  })

  test('answers field_empty naming the field, and selector_not_found naming it too', async () => {
    const empty = await runSecret(at({ op: 'capture', fields: { blank: '#blank' } }))
    expect(empty).toMatchObject({ ok: false, error: 'field_empty' })
    expect(empty.ok ? '' : empty.detail).toContain('blank')
    const missing = await runSecret(at({ op: 'capture', fields: { gone: '#gone' } }))
    expect(missing).toMatchObject({ ok: false, error: 'selector_not_found' })
    expect(missing.ok ? '' : missing.detail).toContain('gone')
  })
})

describe('POST /api/browser/secret', () => {
  let desk: DeskServer
  let home = ''

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'hydra-secret-home-'))
    desk = await createServer({ port: 0, home, webDist: join(home, 'no-window') })
  }, 60_000)

  afterAll(async () => {
    await desk.stop()
    rmSync(home, { recursive: true, force: true })
  }, 60_000)

  const post = (headers: Record<string, string>, body: unknown) =>
    fetch(`${desk.url}/api/browser/secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  test('answers 403 to a request carrying an Origin', async () => {
    const res = await post({ origin: desk.url }, { op: 'where', caller })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, error: 'forbidden' })
  })

  test('answers 403 to a request carrying a Referer', async () => {
    const res = await post({ referer: `${desk.url}/` }, { op: 'where', caller })
    expect(res.status).toBe(403)
  })

  test('answers 400 caller_required when no caller is named', async () => {
    const res = await post({}, { op: 'where' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: 'caller_required' })
  })
})
