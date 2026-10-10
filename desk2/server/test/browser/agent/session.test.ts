import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureBrowserEndpoint,
  forgetLaunches,
  launchArgs,
} from '../../../src/browser/agent/session'
import { closeBrowser } from '../../../src/browser/cdp'

const folders: string[] = []

function newFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-session-'))
  folders.push(dir)
  return dir
}

async function versionOf(port: number): Promise<{ webSocketDebuggerUrl?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(2000),
  })
  expect(res.ok).toBe(true)
  return (await res.json()) as { webSocketDebuggerUrl?: string }
}

// Chrome releases its profile files several seconds after Browser.close answers, so every folder is closed first and removal waits on one shared deadline.
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

afterAll(async () => {
  await Promise.all(folders.map((dir) => closeBrowser(dir).catch(() => false)))
  const until = Date.now() + 40_000
  for (const dir of folders) await removeWhenUnlocked(dir, until)
}, 120_000)

describe('browser session endpoint', () => {
  test('a launch on an empty folder answers /json/version, and concurrent calls share it', async () => {
    const dir = newFolder()
    const [a, b] = await Promise.all([ensureBrowserEndpoint(dir), ensureBrowserEndpoint(dir)])
    expect(a.launched).toBe(true)
    expect(a.headless).toBe(true)
    expect(b).toEqual(a)
    expect((await versionOf(a.port)).webSocketDebuggerUrl).toBe(a.browserWsUrl)
    expect(existsSync(join(dir, '.connections-headless'))).toBe(true)
  }, 30_000)

  test('a second call while the Chrome runs attaches to that same instance', async () => {
    const dir = newFolder()
    const first = await ensureBrowserEndpoint(dir)
    const second = await ensureBrowserEndpoint(dir)
    expect(second.launched).toBe(false)
    expect(second.port).toBe(first.port)
    expect(second.browserWsUrl).toBe(first.browserWsUrl)
  }, 30_000)

  test('after the in-memory state is dropped, the next call attaches to the Chrome still running', async () => {
    const dir = newFolder()
    const first = await ensureBrowserEndpoint(dir)
    forgetLaunches()
    const again = await ensureBrowserEndpoint(dir)
    expect(again.launched).toBe(false)
    expect(again.browserWsUrl).toBe(first.browserWsUrl)
    expect(again.headless).toBe(true)
  }, 30_000)

  test('a marker from another endpoint does not make the running Chrome report headless', async () => {
    const dir = newFolder()
    const first = await ensureBrowserEndpoint(dir)
    writeFileSync(join(dir, '.connections-headless'), '/devtools/browser/some-other-launch')
    forgetLaunches()
    const again = await ensureBrowserEndpoint(dir)
    expect(again.launched).toBe(false)
    expect(again.browserWsUrl).toBe(first.browserWsUrl)
    expect(again.headless).toBe(false)
  }, 30_000)

  test('a headed request launches without the headless flags, which only the headless request adds', async () => {
    const headedArgs = await launchArgs('/tmp/profile', '/nonexistent/chrome', false)
    expect(headedArgs.some((a) => a.startsWith('--headless'))).toBe(false)
    expect(headedArgs.some((a) => a.startsWith('--window-position'))).toBe(false)
    const headlessArgs = await launchArgs('/tmp/profile', '/nonexistent/chrome', true)
    expect(headlessArgs).toContain('--headless=new')
  })

  test('a stale DevToolsActivePort from a dead Chrome does not fool the attach', async () => {
    const dir = newFolder()
    const dead = Bun.serve({ port: 0, fetch: () => new Response('') })
    const stalePort = dead.port
    dead.stop(true)
    writeFileSync(join(dir, 'DevToolsActivePort'), `${stalePort}\n/devtools/browser/stale-launch\n`)

    const endpoint = await ensureBrowserEndpoint(dir)
    expect(endpoint.launched).toBe(true)
    expect(endpoint.browserWsUrl.endsWith('/devtools/browser/stale-launch')).toBe(false)
    expect((await versionOf(endpoint.port)).webSocketDebuggerUrl).toBe(endpoint.browserWsUrl)
  }, 30_000)
})
