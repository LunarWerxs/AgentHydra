import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallResult, ToolCaller } from '../../../src/browser/agent/contract'
import { connect } from '../../../src/browser/agent/navigate'
import { callTool } from '../../../src/browser/agent/tools'
import { closeBrowser, pageTabs, readPortFile } from '../../../src/browser/cdp'
import { readLedger } from '../../../src/browser/ownership'

setDefaultTimeout(60_000)

const callerA: ToolCaller = { session: 'session-alpha' }
const callerB: ToolCaller = { session: 'session-beta' }

const PAGES: Record<string, string> = {
  '/a': '<!doctype html><title>Fixture Alpha</title><p>alpha</p>',
  '/b': '<!doctype html><title>Fixture Beta</title><p>beta</p>',
  '/err':
    '<!doctype html><title>Fixture Errors</title><script>console.error("boom-console");setTimeout(()=>{throw new Error("boom-uncaught")},0)</script>',
}

function answered(res: CallResult): Extract<CallResult, { ok: true }> {
  if (!res.ok) throw new Error(res.error)
  return res
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function removeWhenUnlocked(dir: string, until: number): Promise<void> {
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      if (Date.now() > until) throw e
      await sleep(200)
    }
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('the page tools drive a real headless Chrome', () => {
  const root = mkdtempSync(join(tmpdir(), 'hydra-page-tools-'))
  const home = mkdtempSync(join(tmpdir(), 'hydra-page-tools-home-'))
  const dir = join(root, 'fixture')
  const previousStore = process.env.HYDRA_DESK_BROWSER_STORE
  const previousHome = process.env.HYDRA_DESK_HOME
  let fixture: ReturnType<typeof Bun.serve> | undefined
  let base = ''
  let port = 0
  let alphaTab = ''

  const onAlphaPage = async <T>(work: (send: (m: string, p?: object) => Promise<any>) => Promise<T>): Promise<T> => {
    const link = await connect(`ws://127.0.0.1:${port}/devtools/page/${alphaTab}`)
    try {
      return await work((m, p = {}) => link.send(m, p))
    } finally {
      link.close()
    }
  }

  beforeAll(() => {
    process.env.HYDRA_DESK_BROWSER_STORE = root
    process.env.HYDRA_DESK_HOME = home
    fixture = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        if (path === '/delay') {
          await sleep(1200)
          return new Response('ok')
        }
        const html = PAGES[path]
        if (!html) return new Response('no such fixture page', { status: 404 })
        return new Response(html, { headers: { 'content-type': 'text/html' } })
      },
    })
    base = `http://127.0.0.1:${fixture.port}`
  })

  afterAll(async () => {
    fixture?.stop(true)
    await closeBrowser(dir).catch(() => false)
    await removeWhenUnlocked(root, Date.now() + 40_000)
    rmSync(home, { recursive: true, force: true })
    restoreEnv('HYDRA_DESK_BROWSER_STORE', previousStore)
    restoreEnv('HYDRA_DESK_HOME', previousHome)
  }, 120_000)

  test('browser_navigate opens the caller page the other tools will drive', async () => {
    const nav = answered(await callTool('browser_navigate', { url: `${base}/a`, profile: 'fixture' }, callerA))
    expect(nav.text).toContain('"title":"Fixture Alpha"')
    port = readPortFile(dir)?.port ?? 0
    expect(port).toBeGreaterThan(0)
    alphaTab = (await pageTabs(port)).find((t) => t.url === `${base}/a`)?.id ?? ''
    expect(alphaTab).not.toBe('')
  })

  test('a screenshot answers a JPEG by default and a lossless PNG at detail max', async () => {
    const jpeg = answered(await callTool('browser_take_screenshot', { profile: 'fixture' }, callerA))
    expect(jpeg.image?.mimeType).toBe('image/jpeg')
    expect(jpeg.image?.data.startsWith('/9j/')).toBe(true)
    expect(jpeg.text).toMatch(/^screenshot jpeg \d+KB · \d+×\d+px shown of \d+×\d+ css-px · click at CSS-px coords/)

    const png = answered(await callTool('browser_take_screenshot', { profile: 'fixture', detail: 'max' }, callerA))
    expect(png.image?.mimeType).toBe('image/png')
    expect(png.image?.data.startsWith('iVBORw0KGgo')).toBe(true)
    expect(png.text).toMatch(/^screenshot png /)
  })

  test('a screenshot with an unknown detail level is refused', async () => {
    const res = await callTool('browser_take_screenshot', { profile: 'fixture', detail: 'huge' }, callerA)
    expect(res.ok).toBe(false)
  })

  test('a resize answers the new viewport size', async () => {
    const res = answered(await callTool('browser_resize', { width: 375, height: 812, profile: 'fixture' }, callerA))
    expect(res.text).toBe('viewport → 375×812')
  })

  test('wait_idle waits for a request that is still in flight', async () => {
    const started = Date.now()
    const waiting = callTool('browser_wait_idle', { idleMs: 500, profile: 'fixture' }, callerA)
    await sleep(200)
    await onAlphaPage((send) => send('Runtime.evaluate', { expression: `fetch(${JSON.stringify(`${base}/delay`)})`, awaitPromise: false }))
    const res = answered(await waiting)
    expect(res.text).toBe('network idle (500ms quiet)')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
  })

  test('wait_tab picks up a popup the caller page opens and makes it the caller tab, owned by the caller', async () => {
    const waiting = callTool('browser_wait_tab', { profile: 'fixture', timeoutMs: 10_000 }, callerA)
    await sleep(300)
    await onAlphaPage((send) =>
      send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(`${base}/b`)})`, userGesture: true }),
    )
    const res = answered(await waiting)
    expect(res.text).toMatch(/^new tab → /)
    const popup = [...readLedger(dir).entries()].find(([id, row]) => id !== alphaTab && row.chat === 'session-alpha')
    expect(popup).toBeDefined()
  })

  test('wait_tab refuses a popup another caller owns, and times out', async () => {
    const waiting = callTool('browser_wait_tab', { profile: 'fixture', match: '/a?pop=2', timeoutMs: 800 }, callerB)
    await sleep(200)
    await onAlphaPage((send) =>
      send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(`${base}/a?pop=2`)})`, userGesture: true }),
    )
    const res = await waiting
    expect(res.ok).toBe(false)
  })

  test('tab_errors reports a console error and an uncaught exception already logged on a tab', async () => {
    answered(await callTool('browser_navigate', { url: `${base}/err`, profile: 'fixture', waitMs: 300 }, callerA))
    await sleep(300)
    const res = answered(await callTool('browser_tab_errors', { profile: 'fixture', timeoutMs: 5000 }, callerA))
    const report = JSON.parse(res.text) as {
      answered: number
      results: { url: string; errors: { kind: string; text: string }[] }[]
    }
    expect(report.answered).toBeGreaterThanOrEqual(1)
    const errs = report.results.flatMap((r) => r.errors)
    expect(errs.some((e) => e.kind === 'console.error' && e.text.includes('boom-console'))).toBe(true)
    expect(errs.some((e) => e.kind === 'exception' && e.text.includes('boom-uncaught'))).toBe(true)
  })
})
