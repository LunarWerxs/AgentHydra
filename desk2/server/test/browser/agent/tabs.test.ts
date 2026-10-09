import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallResult, ToolCaller } from '../../../src/browser/agent/contract'
import { callTool } from '../../../src/browser/agent/tools'
import { closeBrowser, liveBrowser, pageTabs, readPortFile } from '../../../src/browser/cdp'
import { readLedger } from '../../../src/browser/ownership'

setDefaultTimeout(60_000)

const callerA: ToolCaller = { session: 'session-alpha' }
const callerB: ToolCaller = { session: 'session-beta' }

const PAGES: Record<string, string> = {
  '/a': '<!doctype html><title>Fixture Alpha</title><p>alpha words</p>',
  '/b': '<!doctype html><title>Fixture Beta</title><p>beta words</p>',
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

describe('the tab tools drive a real headless Chrome', () => {
  const root = mkdtempSync(join(tmpdir(), 'hydra-tabs-'))
  const home = mkdtempSync(join(tmpdir(), 'hydra-tabs-home-'))
  const dir = join(root, 'tabs')
  const attachedDir = join(root, 'attached')
  const previousStore = process.env.HYDRA_DESK_BROWSER_STORE
  const previousHome = process.env.HYDRA_DESK_HOME
  let fixture: ReturnType<typeof Bun.serve> | undefined
  let base = ''
  let port = 0

  const openUnownedTab = async (url: string): Promise<void> => {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT', signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`/json/new: ${res.status}`)
  }

  beforeAll(() => {
    process.env.HYDRA_DESK_BROWSER_STORE = root
    process.env.HYDRA_DESK_HOME = home
    fixture = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const html = PAGES[new URL(req.url).pathname]
        if (!html) return new Response('no such fixture page', { status: 404 })
        return new Response(html, { headers: { 'content-type': 'text/html' } })
      },
    })
    base = `http://127.0.0.1:${fixture.port}`
  })

  afterAll(async () => {
    fixture?.stop(true)
    await closeBrowser(dir).catch(() => false)
    await closeBrowser(attachedDir).catch(() => false)
    await removeWhenUnlocked(root, Date.now() + 40_000)
    rmSync(home, { recursive: true, force: true })
    restoreEnv('HYDRA_DESK_BROWSER_STORE', previousStore)
    restoreEnv('HYDRA_DESK_HOME', previousHome)
  }, 120_000)

  test('browser_tab switches the caller to an unowned tab and reads it', async () => {
    answered(await callTool('browser_navigate', { url: `${base}/a`, profile: 'tabs' }, callerA))
    port = readPortFile(dir)?.port ?? 0
    expect(port).toBeGreaterThan(0)
    await openUnownedTab(`${base}/b`)
    for (let i = 0; i < 100 && !(await pageTabs(port)).some((t) => t.title === 'Fixture Beta'); i++) await sleep(100)
    const switched = answered(await callTool('browser_tab', { match: '/b', profile: 'tabs' }, callerA))
    expect(switched.text).toBe(`tab → Fixture Beta | ${base}/b`)
    const text = answered(await callTool('browser_get_text', { profile: 'tabs' }, callerA))
    expect(text.text).toContain('beta words')
    expect(text.text).not.toContain('alpha words')
  })

  test('browser_tab refuses a tab another caller owns', async () => {
    answered(await callTool('browser_navigate', { url: `${base}/b`, profile: 'tabs' }, callerB))
    const res = await callTool('browser_tab', { match: '/a', profile: 'tabs' }, callerB)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected a refusal')
    expect(res.error).toContain("another chat's tab")
  })

  test('browser_close as one caller closes only its own tabs and leaves Chrome running for the other', async () => {
    const closed = answered(await callTool('browser_close', { profile: 'tabs' }, callerA))
    expect(closed.text).toBe('browser closed (1 profile)')
    expect(await liveBrowser(dir)).not.toBeNull()
    const urls = (await pageTabs(port)).map((t) => t.url)
    expect(urls).toContain(`${base}/b`)
    expect(urls).not.toContain(`${base}/a`)
    expect(urls.filter((u) => u === `${base}/b`).length).toBe(1)
    expect([...readLedger(dir).values()].every((row) => row.chat === 'session-beta')).toBe(true)
  })

  test('browser_close as the last caller closes the Chrome', async () => {
    const closed = answered(await callTool('browser_close', { profile: 'tabs' }, callerB))
    expect(closed.text).toBe('browser closed (1 profile)')
    expect(await liveBrowser(dir)).toBeNull()
  })

  test('browser_close with attachPort forgets only the caller page and leaves that Chrome running', async () => {
    answered(await callTool('browser_navigate', { url: `${base}/a`, profile: 'attached' }, callerB))
    const attachedPort = readPortFile(attachedDir)?.port ?? 0
    expect(attachedPort).toBeGreaterThan(0)
    answered(await callTool('browser_navigate', { url: `${base}/b`, attachPort: attachedPort }, callerB))
    const closed = answered(await callTool('browser_close', { attachPort: attachedPort }, callerB))
    expect(closed.text).toBe('browser closed (1 profile)')
    expect(await liveBrowser(attachedDir)).not.toBeNull()
    expect((await pageTabs(attachedPort)).length).toBeGreaterThan(0)
  })
})
