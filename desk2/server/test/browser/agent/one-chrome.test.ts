import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  ensureBrowserEndpoint,
  findBrowserBinary,
  forgetLaunches,
  launchArgs,
} from '../../../src/browser/agent/session'
import { closeBrowser, LaunchError, readPortFile } from '../../../src/browser/cdp'
import { profileLocked, waitUntil } from '../../../src/browser/agent/sign-in-window'

const home = mkdtempSync(join(tmpdir(), 'hydra-one-chrome-home-'))
const store = mkdtempSync(join(tmpdir(), 'hydra-one-chrome-store-'))
const previousHome = process.env.HYDRA_DESK_HOME
const previousStore = process.env.HYDRA_DESK_BROWSER_STORE
const folders: string[] = []
const startedPids: number[] = []

beforeAll(() => {
  process.env.HYDRA_DESK_HOME = home
  process.env.HYDRA_DESK_BROWSER_STORE = store
})

function newFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-one-chrome-'))
  folders.push(dir)
  return dir
}

function chromeBin(): string {
  const bin = findBrowserBinary()
  if (!bin) throw new Error('no Chrome or Edge installed for this test')
  return bin
}

// Browser processes whose command line names the folder (matched by its unique basename, not by process name).
// mainOnly drops the renderer, GPU and utility helpers, which a running browser starts and stops on its own.
function chromePids(dir: string, mainOnly = false): number[] {
  const needle = basename(dir)
  if (process.platform === 'win32') {
    const helper = mainOnly ? " -and $_.CommandLine -notlike '*--type=*'" : ''
    const script = `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.Name -match 'chrome|msedge|chromium'${helper} } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 60_000,
    }).trim()
    if (!out) return []
    const parsed = JSON.parse(out) as number | number[]
    return (Array.isArray(parsed) ? parsed : [parsed]).sort((a, b) => a - b)
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  return out
    .split('\n')
    .filter(
      (line) =>
        line.includes(needle) &&
        /chrome|msedge|chromium/i.test(line) &&
        !(mainOnly && line.includes('--type=')),
    )
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .sort((a, b) => a - b)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // already gone
  }
}

function startChrome(args: string[], bin: string): ChildProcess {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
  if (child.pid) startedPids.push(child.pid)
  return child
}

async function answersWithin(dir: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const file = readPortFile(dir)
    if (file) {
      try {
        const res = await fetch(`http://127.0.0.1:${file.port}/json/version`, {
          signal: AbortSignal.timeout(1500),
        })
        if (res.ok) return true
      } catch {
        // not up yet
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
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

afterAll(async () => {
  await Promise.all(folders.map((dir) => closeBrowser(dir).catch(() => false)))
  for (const dir of folders) {
    let pids: number[] = []
    try {
      pids = chromePids(dir)
    } catch {
      // listing failed under load: the recorded pids below still get killed
    }
    for (const pid of pids) killTree(pid)
  }
  for (const pid of startedPids) killTree(pid)
  const until = Date.now() + 60_000
  for (const dir of folders) await removeWhenUnlocked(dir, until)
  rmSync(home, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = previousHome
  if (previousStore === undefined) delete process.env.HYDRA_DESK_BROWSER_STORE
  else process.env.HYDRA_DESK_BROWSER_STORE = previousStore
}, 120_000)

describe('one Chrome per saved-browser profile', () => {
  test('a Chrome started outside AgentHydra with a debug port is attached to, never doubled or killed', async () => {
    const dir = newFolder()
    const bin = chromeBin()
    const outside = startChrome(await launchArgs(dir, bin, true), bin)
    expect(await waitUntil(() => profileLocked(dir) && readPortFile(dir) !== null, 20_000)).toBe(true)
    expect(await answersWithin(dir, 20_000)).toBe(true)
    const before = chromePids(dir, true)
    expect(before).toContain(outside.pid as number)

    forgetLaunches()
    const endpoint = await ensureBrowserEndpoint(dir)
    expect(endpoint.launched).toBe(false)
    expect(endpoint.port).toBe(readPortFile(dir)?.port as number)

    expect(chromePids(dir, true)).toEqual(before)
    expect(alive(outside.pid as number)).toBe(true)
  }, 90_000)

  test('a plain Chrome window on the folder is neither killed nor doubled: the launch refuses and names the profile', async () => {
    const dir = newFolder()
    const bin = chromeBin()
    const plain = startChrome(
      [`--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'],
      bin,
    )
    expect(await waitUntil(() => profileLocked(dir), 20_000)).toBe(true)
    const before = chromePids(dir, true)
    expect(before).toContain(plain.pid as number)
    expect(readPortFile(dir)).toBeNull()

    forgetLaunches()
    const error = await ensureBrowserEndpoint(dir).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(LaunchError)
    expect((error as Error).message).toContain(dir)
    expect((error as Error).message).toContain('without a debugging port')

    expect(alive(plain.pid as number)).toBe(true)
    expect(chromePids(dir, true)).toEqual(before)
  }, 90_000)

  test('with no Chrome on the folder the launch succeeds and reports launched', async () => {
    const dir = newFolder()
    const endpoint = await ensureBrowserEndpoint(dir)
    expect(endpoint.launched).toBe(true)
    expect(chromePids(dir).length).toBeGreaterThan(0)
  }, 90_000)
})
