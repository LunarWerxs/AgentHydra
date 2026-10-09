import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ToolCaller } from '../../../src/browser/agent/contract'
import { ToolInputError } from '../../../src/browser/agent/errors'
import { navigate } from '../../../src/browser/agent/navigate'
import { findBrowserBinary } from '../../../src/browser/agent/session'
import { callTool } from '../../../src/browser/agent/tools'
import { closeBrowser, pageTabs, readPortFile } from '../../../src/browser/cdp'
import { readLedger } from '../../../src/browser/ownership'

setDefaultTimeout(60_000)

const caller: ToolCaller = { chat: 'chat-1', cwd: 'C:/Users/me/proj' }

describe('browser_navigate refuses a call it cannot run before it touches a Chrome', () => {
  test('a missing url is a tool input error', async () => {
    await expect(navigate({}, caller)).rejects.toBeInstanceOf(ToolInputError)
    await expect(navigate({ url: '   ' }, caller)).rejects.toBeInstanceOf(ToolInputError)
  })

  test('an attachPort that is not a port is a tool input error', async () => {
    await expect(navigate({ url: 'https://example.com', attachPort: 70000 }, caller)).rejects.toBeInstanceOf(ToolInputError)
    await expect(navigate({ url: 'https://example.com', attachPort: 'x' }, caller)).rejects.toBeInstanceOf(ToolInputError)
  })
})

const TITLES: Record<string, string> = { '/a': 'Fixture Alpha', '/b': 'Fixture Beta' }
const callerA: ToolCaller = { session: 'session-alpha' }
const callerB: ToolCaller = { session: 'session-beta' }

async function removeWhenUnlocked(dir: string, until: number): Promise<void> {
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      if (Date.now() > until) throw e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('browser_navigate drives a real headless Chrome', () => {
  const exe = basename(findBrowserBinary() ?? 'chrome.exe')
  const root = mkdtempSync(join(tmpdir(), 'hydra-navigate-'))
  const home = mkdtempSync(join(tmpdir(), 'hydra-navigate-home-'))
  const dir = join(root, 'fixture')
  const previousStore = process.env.HYDRA_DESK_BROWSER_STORE
  const previousHome = process.env.HYDRA_DESK_HOME
  let fixture: ReturnType<typeof Bun.serve> | undefined
  let base = ''
  let port = 0
  let alphaTab = ''
  let betaTab = ''

  beforeAll(() => {
    process.env.HYDRA_DESK_BROWSER_STORE = root
    process.env.HYDRA_DESK_HOME = home
    fixture = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const title = TITLES[new URL(req.url).pathname]
        if (!title) return new Response('no such fixture page', { status: 404 })
        return new Response(`<!doctype html><title>${title}</title><p>fixture</p>`, { headers: { 'content-type': 'text/html' } })
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

  test('the reply names the page title, the url reached and the browser', async () => {
    const reply = await navigate({ url: `${base}/a`, profile: 'fixture' }, callerA)
    expect(reply).toBe(`navigated → ${JSON.stringify({ title: 'Fixture Alpha', url: `${base}/a` })}  (browser: ${exe})`)
    port = readPortFile(dir)?.port ?? 0
    expect(port).toBeGreaterThan(0)
    alphaTab = (await pageTabs(port)).find((t) => t.url === `${base}/a`)?.id ?? ''
    expect(alphaTab).not.toBe('')
  }, 60_000)

  test('a second caller gets its own page, and the first caller reuses its page', async () => {
    const before = (await pageTabs(port)).length
    const reply = await navigate({ url: `${base}/b`, profile: 'fixture' }, callerB)
    expect(reply).toBe(`navigated → ${JSON.stringify({ title: 'Fixture Beta', url: `${base}/b` })}  (browser: ${exe})`)
    let tabs = await pageTabs(port)
    betaTab = tabs.find((t) => t.url === `${base}/b`)?.id ?? ''
    expect(betaTab).not.toBe('')
    expect(betaTab).not.toBe(alphaTab)
    expect(tabs).toHaveLength(before + 1)

    await navigate({ url: `${base}/a?again=1`, profile: 'fixture' }, callerA)
    tabs = await pageTabs(port)
    expect(tabs).toHaveLength(before + 1)
    expect(tabs.find((t) => t.id === alphaTab)?.url).toBe(`${base}/a?again=1`)
  }, 60_000)

  test('the profile tab ledger owns each page by its caller session', () => {
    const rows = readLedger(dir)
    expect(rows.get(alphaTab)?.chat).toBe('session-alpha')
    expect(rows.get(betaTab)?.chat).toBe('session-beta')
  })

  test('a website the browser tool may not drive is refused and opens no page', async () => {
    const before = (await pageTabs(port)).map((t) => t.id).sort()
    const res = await callTool('browser_navigate', { url: 'https://www.etsy.com/', profile: 'fixture' }, callerA)
    expect(res.ok).toBe(false)
    expect((await pageTabs(port)).map((t) => t.id).sort()).toEqual(before)
  }, 60_000)
})
