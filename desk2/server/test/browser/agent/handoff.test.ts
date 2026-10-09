import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCaller } from '../../../src/browser/agent/contract'
import { ToolInputError } from '../../../src/browser/agent/errors'
import {
  decideHandoff,
  HANDOFF_TOOLS,
  normalizeHandoffUrls,
  setLaunchVisible,
  type VisibleLaunch,
} from '../../../src/browser/agent/handoff'
import { connect, navigate } from '../../../src/browser/agent/navigate'
import { findBrowserBinary } from '../../../src/browser/agent/session'
import {
  profileLocked,
  releaseSignInWindow,
  SIGN_IN_MARKER,
  signInWindowLive,
  waitUntil,
} from '../../../src/browser/agent/sign-in-window'
import { closeBrowser, pageTabs, readPortFile } from '../../../src/browser/cdp'
import { readLedger } from '../../../src/browser/ownership'
import { registryFile } from '../../../src/browser/profiles-write'

describe('browser_handoff decides what happens to the profile window', () => {
  test('a sign-in window it already holds is kept as it is', () => {
    expect(decideHandoff({ signInWindow: true, liveWindow: true, headless: true })).toBe('keep')
  })

  test('a visible window with a port is detached, so the human keeps every tab', () => {
    expect(decideHandoff({ liveWindow: true, headless: false })).toBe('detach')
  })

  test('an automation window is closed and relaunched plain', () => {
    expect(decideHandoff({ liveWindow: true, headless: true })).toBe('close-relaunch')
  })

  test('a window that must sign in is relaunched even when visible', () => {
    expect(decideHandoff({ liveWindow: true, headless: false, signIn: true })).toBe('close-relaunch')
  })

  test('no window at all launches a plain one', () => {
    expect(decideHandoff({})).toBe('launch')
  })
})

describe('the sign-in marker counts only while its window still holds the profile', () => {
  test('a live pid holding the lock with no debug port counts', () => {
    expect(signInWindowLive({ pid: 4242, pidAlive: true, locked: true, lockTarget: 'host-4242' })).toBe(true)
  })

  test('a port file means an automation window, not a plain one', () => {
    expect(signInWindowLive({ pid: 4242, pidAlive: true, locked: true, lockTarget: 'host-4242', portFile: true })).toBe(false)
  })

  test('a dead pid or an unlocked profile is stale', () => {
    expect(signInWindowLive({ pid: 4242, pidAlive: false, locked: true })).toBe(false)
    expect(signInWindowLive({ pid: 4242, pidAlive: true, locked: false })).toBe(false)
  })

  test('a lock held by another pid is not this window', () => {
    expect(signInWindowLive({ pid: 4242, pidAlive: true, locked: true, lockTarget: 'host-9999' })).toBe(false)
  })
})

describe('browser_handoff urls', () => {
  test('blank entries are dropped and a bare string is one url', () => {
    expect(normalizeHandoffUrls([' https://example.com/ ', '', '  '])).toEqual(['https://example.com/'])
    expect(normalizeHandoffUrls('https://example.test/')).toEqual(['https://example.test/'])
  })

  test('a value that reads as a Chrome flag is refused, never passed through', () => {
    expect(() => normalizeHandoffUrls(['--remote-debugging-port=9222'])).toThrow(ToolInputError)
  })
})

const SECRET = 'hydra-cookie-value-that-must-never-leak'
const who: ToolCaller = { session: 'handoff-session' }
const TITLES: Record<string, string> = { '/a': 'Handoff Alpha', '/b': 'Handoff Beta', '/c': 'Handoff Gamma' }

function tool(name: string) {
  const found = HANDOFF_TOOLS.find((t) => t.name === name)
  if (!found) throw new Error(`no ${name} tool`)
  return found
}

function pidsOn(dir: string): number[] {
  if (process.platform !== 'win32') {
    try {
      return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
    } catch {
      return []
    }
  }
  const script =
    'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:HYDRA_TEST_PROFILE) } | ForEach-Object { $_.ProcessId }'
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, HYDRA_TEST_PROFILE: dir },
    windowsHide: true,
  })
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Stands in for the human's window: a real headless Chrome with no debugging port, as a plain handoff launch leaves.
const launches: string[][] = []
function humanWindow({ argv }: { dir: string; argv: string[] }): VisibleLaunch {
  launches.push(argv)
  const bin = findBrowserBinary()
  if (!bin) throw new Error('no Chrome installed for the handoff test')
  let exited = false
  const child = spawn(bin, [...argv, '--headless=new', '--window-position=-32000,-32000'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('exit', () => {
    exited = true
  })
  child.on('error', () => {
    exited = true
  })
  child.unref()
  return { pid: child.pid, exited: () => exited }
}

function sessionHostsHold(node: unknown, host: string): boolean {
  if (Array.isArray(node)) return node.some((n) => sessionHostsHold(n, host))
  if (!node || typeof node !== 'object') return false
  const o = node as Record<string, unknown>
  for (const field of ['hosts', 'sessionHosts']) {
    const list = o[field]
    if (Array.isArray(list) && list.includes(host)) return true
  }
  return Object.values(o).some((v) => sessionHostsHold(v, host))
}

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

describe('browser_handoff and browser_profile_login drive a real headless Chrome', () => {
  setDefaultTimeout(60_000)
  const root = mkdtempSync(join(tmpdir(), 'hydra-handoff-'))
  const home = mkdtempSync(join(tmpdir(), 'hydra-handoff-home-'))
  const dirA = join(root, 'handoff-a')
  const dirB = join(root, 'handoff-b')
  const dirC = join(root, 'handoff-c')
  const previousStore = process.env.HYDRA_DESK_BROWSER_STORE
  const previousHome = process.env.HYDRA_DESK_HOME
  let fixture: ReturnType<typeof Bun.serve> | undefined
  let base = ''

  beforeAll(() => {
    process.env.HYDRA_DESK_BROWSER_STORE = root
    process.env.HYDRA_DESK_HOME = home
    fixture = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const title = TITLES[new URL(req.url).pathname]
        if (!title) return new Response('no such fixture page', { status: 404 })
        return new Response(`<!doctype html><title>${title}</title><p>fixture</p>`, {
          headers: { 'content-type': 'text/html' },
        })
      },
    })
    base = `http://127.0.0.1:${fixture.port}`
  })

  afterAll(async () => {
    setLaunchVisible(null)
    fixture?.stop(true)
    for (const dir of [dirA, dirB, dirC]) {
      await releaseSignInWindow(dir).catch(() => undefined)
      await closeBrowser(dir).catch(() => false)
      await waitUntil(() => pidsOn(dir).length === 0, 30_000)
      for (const pid of pidsOn(dir)) {
        try {
          process.kill(pid)
        } catch {
          // already gone
        }
      }
    }
    await removeWhenUnlocked(root, Date.now() + 40_000)
    rmSync(home, { recursive: true, force: true })
    restoreEnv('HYDRA_DESK_BROWSER_STORE', previousStore)
    restoreEnv('HYDRA_DESK_HOME', previousHome)
  }, 240_000)

  test('a headless automation window is closed, its ledger rows dropped, and it is relaunched with no debugging port', async () => {
    await navigate({ url: `${base}/a`, profile: 'handoff-a' }, who)
    const automation = pidsOn(dirA)
    expect(automation.length).toBeGreaterThan(0)
    expect(readLedger(dirA).size).toBeGreaterThan(0)

    setLaunchVisible(humanWindow)
    launches.length = 0
    const reply = await tool('browser_handoff').run({ profile: 'handoff-a', urls: [`${base}/a`] }, who)
    expect(String(reply)).toContain('closed the automation window gracefully')

    expect(await waitUntil(() => automation.every((p) => !alive(p)), 20_000)).toBe(true)
    expect(readLedger(dirA).size).toBe(0)
    expect(launches).toHaveLength(1)
    expect(launches[0]).toContain(`--user-data-dir=${dirA}`)
    expect(launches[0].some((a) => a.startsWith('--remote-debugging-port'))).toBe(false)
    expect(existsSync(join(dirA, SIGN_IN_MARKER))).toBe(true)
  }, 120_000)

  test('a login set in the window verifies by host name, and no cookie value reaches the reply or the registry', async () => {
    await navigate({ url: `${base}/b`, profile: 'handoff-b' }, who)
    const port = readPortFile(dirB)?.port ?? 0
    expect(port).toBeGreaterThan(0)
    const page = (await pageTabs(port)).find((t) => t.url === `${base}/b`)
    expect(page).toBeDefined()
    const link = await connect(`ws://127.0.0.1:${port}/devtools/page/${page?.id}`)
    try {
      const set = (await link.send('Network.setCookie', {
        name: 'hydra_sid',
        value: SECRET,
        url: `${base}/`,
        path: '/',
      })) as { success?: boolean }
      expect(set.success).toBe(true)
    } finally {
      link.close()
    }
    expect(await closeBrowser(dirB)).toBe(true)
    expect(await waitUntil(() => !profileLocked(dirB), 20_000)).toBe(true)

    const reply = String(await tool('browser_profile_login').run({ profile: 'handoff-b', url: `${base}/b`, verify: true }, who))
    const parsed = JSON.parse(reply) as { verified: boolean; host: string }
    expect(parsed.verified).toBe(true)
    expect(parsed.host).toBe('127.0.0.1')
    expect(reply).not.toContain(SECRET)

    const registry = readFileSync(registryFile(), 'utf8')
    expect(registry).not.toContain(SECRET)
    expect(sessionHostsHold(JSON.parse(registry), '127.0.0.1')).toBe(true)
  }, 120_000)

  test('a window a human left open is released by the next browser call, and its marker is removed', async () => {
    setLaunchVisible(humanWindow)
    launches.length = 0
    const reply = String(await tool('browser_handoff').run({ profile: 'handoff-c' }, who))
    expect(reply).toContain('launched a plain visible Chrome')
    const marker = JSON.parse(readFileSync(join(dirC, SIGN_IN_MARKER), 'utf8')) as { pid: number }
    expect(alive(marker.pid)).toBe(true)

    const page = await navigate({ url: `${base}/c`, profile: 'handoff-c' }, who)
    expect(page).toContain('Handoff Gamma')
    expect(await waitUntil(() => !alive(marker.pid), 20_000)).toBe(true)
    expect(existsSync(join(dirC, SIGN_IN_MARKER))).toBe(false)
    expect(readPortFile(dirC)).not.toBeNull()
  }, 120_000)
})
