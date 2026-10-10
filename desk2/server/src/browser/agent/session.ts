// The Chrome of one profile folder for the browser tools: attach to the one already running there, else launch one
// detached so it outlives this process (a service or Desk restart re-attaches instead of relaunching). Follows
// Connections' browser.mjs (startBrowserSession, reconnectToProfile, markLaunch), which it never edits.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LaunchError, LIVE_CHROME_FLAGS, readPortFile } from '../cdp'
import { releaseSignInWindow } from './sign-in-window'

const HOST = '127.0.0.1'
const LAUNCH_DEADLINE_MS = 15_000
const POLL_MS = 100
const HEADLESS_MARK = '.connections-headless'

export interface BrowserEndpoint {
  port: number
  browserWsUrl: string
  launched: boolean
  headless: boolean
}

export interface EnsureOptions {
  headed?: boolean
}

const inFlight = new Map<string, Promise<BrowserEndpoint>>()

/** One Chrome per folder: concurrent calls for a folder share the one attach or launch. */
export function ensureBrowserEndpoint(
  dir: string,
  opts: EnsureOptions = {},
): Promise<BrowserEndpoint> {
  const key = resolve(dir)
  const running = inFlight.get(key)
  if (running) return running
  const p = attachOrLaunch(key, opts).finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

/** Drops the in-memory launch bookkeeping, as a service restart does; the next call still finds a running Chrome on disk. */
export function forgetLaunches(): void {
  inFlight.clear()
}

async function answering(dir: string): Promise<{ port: number; browserWsUrl: string } | null> {
  const file = readPortFile(dir)
  if (!file) return null
  try {
    const res = await fetch(`http://${HOST}:${file.port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const version = (await res.json()) as { webSocketDebuggerUrl?: string }
    const url = String(version.webSocketDebuggerUrl ?? '')
    if (!url || (file.wsPath && !url.endsWith(file.wsPath))) return null
    return { port: file.port, browserWsUrl: url }
  } catch {
    return null
  }
}

async function attachOrLaunch(dir: string, opts: EnsureOptions): Promise<BrowserEndpoint> {
  await releaseSignInWindow(dir)
  const live = await answering(dir)
  if (live) return { ...live, launched: false, headless: launchedHeadless(dir) }

  const headless = !opts.headed
  const bin = findBrowserBinary()
  if (!bin)
    throw new LaunchError('No installed Chrome or Edge (looked in the standard install folders)')
  // Chrome's own port file is not deleted first: it counts only when /json/version answers with its endpoint path.
  // A stale file fails that check, and deleting a live Chrome's file would hide it from a hand-off.
  const spawned: { error: Error | null } = { error: null }
  const args = await launchArgs(dir, bin, headless)
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', (e) => {
    spawned.error = e
  })
  child.unref()

  const until = Date.now() + LAUNCH_DEADLINE_MS
  while (Date.now() < until) {
    if (spawned.error) throw new LaunchError(`Chrome did not start: ${spawned.error.message}`)
    const up = await answering(dir)
    if (up) {
      // A launch that Chrome handed to an instance already running on this folder exits at once: attached, not launched.
      const launched = child.exitCode === null
      if (launched) writeMarker(dir, headless)
      return { ...up, launched, headless }
    }
    // Chrome hands a launch on a folder it already holds to that Chrome and exits; a plain window has no port to answer with.
    if (child.exitCode !== null)
      throw new LaunchError(
        `Chrome exited at once on ${dir}: a Chrome without a debugging port (a plain window) already holds this profile. Close that window, then retry.`,
      )
    await sleep(POLL_MS)
  }
  throw new LaunchError('Chrome did not announce its debugging port within 15 seconds')
}

export async function launchArgs(dir: string, bin: string, headless: boolean): Promise<string[]> {
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    // Connections browser.mjs:2011-2017: a headless launch is hidden by its flags, not by a window.
    ...(headless
      ? ['--headless=new', '--window-position=-32000,-32000', ...(await headlessUserAgentArgs(bin))]
      : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-background-networking',
    ...LIVE_CHROME_FLAGS,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    'about:blank',
  ]
}

// Connections browser.mjs:103-108 and :73-82. Headless Chrome names itself in its user agent and Cloudflare blocks it,
// so the headless launch sends the windowed user agent of the same Chrome.
async function headlessUserAgentArgs(bin: string): Promise<string[]> {
  const major = await browserMajor(bin)
  if (!major) return []
  const os =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64'
  const edge = /msedge|microsoft edge/i.test(bin) ? ` Edg/${major}.0.0.0` : ''
  return [
    `--user-agent=Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${edge}`,
  ]
}

const majors = new Map<string, Promise<number | null>>()

// Connections browser.mjs:86-98: on Windows the version folders beside the exe (running it would open a window).
export function browserMajor(bin: string, platform: NodeJS.Platform = process.platform): Promise<number | null> {
  let major = majors.get(bin)
  if (!major) majors.set(bin, (major = readBrowserMajor(bin, platform)))
  return major
}

async function readBrowserMajor(bin: string, platform: NodeJS.Platform): Promise<number | null> {
  try {
    if (platform === 'win32') {
      const found = readdirSync(dirname(bin))
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .map((d) => Number(d.split('.')[0]))
      return found.length ? Math.max(...found) : null
    }
    const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const timer = setTimeout(() => proc.kill(), 5000)
    try {
      const out = await new Response(proc.stdout).text()
      if ((await proc.exited) !== 0) return null
      const m = /(\d+)\.\d+\.\d+/.exec(out)
      return m ? Number(m[1]) : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

// Connections browser.mjs:46-71: the same candidates in the same order, so a profile keeps the browser it logged in with.
export function findBrowserBinary(): string | null {
  const e = process.env
  const candidates =
    process.platform === 'win32'
      ? [
          `${e.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${e['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${e.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          `${e['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${e.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge',
          ]
  return candidates.find((c) => existsSync(c)) ?? null
}

// Connections browser.mjs:121-138: the marker holds this launch's endpoint path, so only the Chrome that wrote it matches.
function writeMarker(dir: string, headless: boolean): void {
  const wsPath = readPortFile(dir)?.wsPath
  if (headless && wsPath) writeFileSync(join(dir, HEADLESS_MARK), wsPath)
  else rmSync(join(dir, HEADLESS_MARK), { force: true })
}

export function launchedHeadless(dir: string): boolean {
  const wsPath = readPortFile(dir)?.wsPath
  if (!wsPath || !existsSync(join(dir, HEADLESS_MARK))) return false
  return readFileSync(join(dir, HEADLESS_MARK), 'utf8') === wsPath
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
