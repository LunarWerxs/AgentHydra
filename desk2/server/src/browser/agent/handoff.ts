// browser_handoff and browser_profile_login: a saved browser handed to a human with nothing attached (the way past a bot
// check), and the login that rides in the profile afterwards. Ports Connections' browserActionLogin (browser.mjs:2861-2923)
// and handOffProfile with its helpers (browser.mjs:3228-3525), without the attach path or its session bookkeeping.

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { closeBrowser, LIVE_CHROME_FLAGS, liveBrowser } from '../cdp'
import { dropPage } from '../ledger'
import { readLedger } from '../ownership'
import {
  applyNote,
  cookieStorePath,
  mutateRegistry,
  profileCookieScan,
  registryEntry,
  safeMtime,
} from '../profiles-write'
import { listProfiles, storeRoot } from '../store'
import type { ToolCaller } from './contract'
import { ToolInputError } from './errors'
import { forgetPagesOf } from './navigate'
import type { ToolDef } from './registry'
import { findBrowserBinary, launchedHeadless } from './session'
import { profileLocked, readSignInWindow, SIGN_IN_MARKER, waitUntil } from './sign-in-window'

type Params = Record<string, unknown>
type Json = Record<string, unknown>

const LAUNCH_WAIT_MS = 15_000

export interface VisibleLaunch {
  pid: number | undefined
  exited(): boolean
}

export type LaunchVisible = (args: { dir: string; argv: string[] }) => VisibleLaunch

function launchChromeVisible({ argv }: { dir: string; argv: string[] }): VisibleLaunch {
  const bin = findBrowserBinary()
  if (!bin)
    throw new Error('No installed Chrome/Edge found. Install Chrome (or Edge) — no separate Playwright/Chromium download is needed.')
  let exited = false
  const child = spawn(bin, argv, { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('exit', () => {
    exited = true
  })
  child.on('error', () => {
    exited = true
  })
  child.unref()
  return { pid: child.pid, exited: () => exited }
}

let launchVisible: LaunchVisible = launchChromeVisible

export function setLaunchVisible(fn: LaunchVisible | null): void {
  launchVisible = fn ?? launchChromeVisible
}

const stringParam = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

function profileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'default'
  )
}

function scopedKey(root: string, dir: string): string {
  const inWorkspace = relative(join(root, 'ws'), dir)
  if (inWorkspace && !inWorkspace.startsWith('..') && !isAbsolute(inWorkspace))
    return inWorkspace.split(/[\\/]/).join('/')
  return relative(root, dir).split(/[\\/]/).join('/')
}

/** The registry key and folder a profile name resolves to, as browser_* calls resolve it. Creates nothing. */
export async function profileLocation(name: string, cwd: string | undefined): Promise<{ key: string; dir: string }> {
  const slug = profileSlug(name)
  const root = storeRoot()
  const at = (dir: string) => ({ key: scopedKey(root, dir), dir })
  if (!cwd) return at(join(root, slug))
  const { result, refs } = await listProfiles(cwd)
  const open = refs.find((r) => r.profile.name === slug)
  if (open) return at(open.dir)
  if (!result.workspace) return at(join(root, slug))
  const mine = join(root, 'ws', result.workspace, slug)
  const legacy = join(root, slug)
  if (!existsSync(mine) && existsSync(legacy) && lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink())
    return at(legacy)
  return at(mine)
}

export type HandoffDecision = 'keep' | 'detach' | 'close-relaunch' | 'launch'

// Connections browser.mjs:3233. The launch-owned branch is not ported: AgentHydra keeps no record of which window it spawned.
export function decideHandoff({
  signInWindow = false,
  liveWindow = false,
  headless = false,
  signIn = false,
} = {}): HandoffDecision {
  if (signInWindow) return 'keep'
  if (liveWindow) return headless || signIn ? 'close-relaunch' : 'detach'
  return 'launch'
}

// Connections browser.mjs:3242. Stock Chrome, visible: no --remote-debugging-port, no headless, no off-screen position.
export function handoffLaunchArgs(profile: string, urls: string[] = []): string[] {
  return [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...LIVE_CHROME_FLAGS, ...urls]
}

// Connections browser.mjs:3351.
export function normalizeHandoffUrls(urls: unknown): string[] {
  if (urls == null) return []
  const list = Array.isArray(urls) ? urls : [urls]
  return list
    .map((u) => String(u).trim())
    .filter((u) => u !== '')
    .map((u) => {
      if (u.startsWith('-')) throw new ToolInputError(`browser_handoff: ${JSON.stringify(u)} is not a URL`)
      return u
    })
}

// Connections browser.mjs:3364.
async function portIsHeadless(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const v = (await res.json()) as { Browser?: string; 'User-Agent'?: string }
    return /headless/i.test(`${v['User-Agent'] ?? ''} ${v.Browser ?? ''}`)
  } catch {
    return false
  }
}

function dropOwnedPages(dir: string): void {
  for (const targetId of readLedger(dir).keys()) dropPage(dir, targetId)
  forgetPagesOf(dir)
}

// Connections browser.mjs:3420.
async function launchHandoffWindow(dir: string, urls: string[]): Promise<void> {
  rmSync(join(dir, 'DevToolsActivePort'), { force: true })
  mkdirSync(dir, { recursive: true })
  const launch = launchVisible({ dir, argv: handoffLaunchArgs(dir, urls) })
  await waitUntil(() => profileLocked(dir) || launch.exited(), LAUNCH_WAIT_MS, 250)
  if (launch.exited() || !profileLocked(dir))
    throw new Error(
      `browser_handoff: Chrome was launched on ${dir} but ${
        launch.exited()
          ? 'exited at once - most likely another window already holds this profile and took the launch'
          : 'never took the profile lock within 15s'
      }. Close any window on this profile and call again.`,
    )
  writeFileSync(join(dir, SIGN_IN_MARKER), JSON.stringify({ pid: launch.pid, launchedAt: new Date().toISOString() }))
}

// Connections browser.mjs:3449.
function handoffResult(name: string, how: string, keptPort: number | null = null): string {
  const after =
    keptPort === null
      ? `It has NO debug port, so to the human and to a bot check it is an ordinary Chrome. Once the human is done, the next browser_* call with profile:'${name}' closes it gracefully (cookies flush) and relaunches the same profile with a port; the login rides in the profile.`
      : `That window still listens on port ${keptPort}; any later browser_* call with profile:'${name}' or attachPort:${keptPort} re-attaches (a bot check sees the debugger again from that moment), so call browser_handoff again before the next check.`
  return `handed off '${name}': ${how}. NOTHING is attached - a human can pass Google sign-in, Cloudflare, reCAPTCHA or ALTCHA in that window now. ${after}`
}

// Connections browser.mjs:3465.
async function handOff(name: string, urls: string[], signIn: boolean, cwd: string | undefined): Promise<string> {
  const { dir } = await profileLocation(name, cwd)
  const signInPid = readSignInWindow(dir)
  const live = signInPid === null ? await liveBrowser(dir) : null
  const livePort = live?.port ?? null
  const headless = livePort !== null && (launchedHeadless(dir) || (await portIsHeadless(livePort)))
  const decision = decideHandoff({
    signInWindow: signInPid !== null,
    liveWindow: livePort !== null,
    headless,
    signIn,
  })

  if (decision === 'keep') {
    if (urls.length) launchVisible({ dir, argv: handoffLaunchArgs(dir, urls) })
    return handoffResult(
      name,
      urls.length
        ? 'the plain window from the last handoff was still open, so the pages were opened in it'
        : 'the plain window from the last handoff was still open, so it was left exactly as it is',
    )
  }
  if (decision === 'detach')
    return handoffResult(
      name,
      'a visible window was already open with nothing of this MCP attached, so it was left exactly as it is',
      livePort,
    )
  if (decision === 'close-relaunch') {
    dropOwnedPages(dir)
    if (!(await closeBrowser(dir)))
      throw new Error(`browser_handoff: the headless window on port ${livePort} ignored Browser.close - run browser_close and retry`)
    await waitUntil(() => !profileLocked(dir), LAUNCH_WAIT_MS)
    if (profileLocked(dir))
      throw new Error(
        `browser_handoff: ${dir} is still locked 15s after its window closed - a Chrome process still holds it; not launching a second one onto it`,
      )
    await launchHandoffWindow(dir, urls)
    return handoffResult(name, 'closed the automation window gracefully (cookies flushed) and relaunched it as a plain visible Chrome')
  }
  if (profileLocked(dir))
    throw new Error(
      `browser_handoff: a Chrome is already open on '${name}' that this MCP did not open and cannot reach (no live DevToolsActivePort). If it was started with --remote-debugging-port=N and something is attached, browser_close {attachPort:N} detaches; otherwise close that window and call again.`,
    )
  await launchHandoffWindow(dir, urls)
  return handoffResult(name, 'launched a plain visible Chrome on the profile')
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

// Connections browser.mjs:2861.
async function login(params: Params, caller: ToolCaller): Promise<string> {
  const name = profileSlug(String(params.profile ?? '').trim().replace(/^chrome:/i, ''))
  if (name === 'default')
    throw new ToolInputError(
      "browser_profile_login needs profile:'<name>' - the managed browser that should own this login (e.g. 'cloudflare-registrar')",
    )
  const url = stringParam(params.url)
  const host = url ? hostOf(url) : null
  const note = typeof params.note === 'string' ? params.note : undefined
  const { key, dir } = await profileLocation(name, caller.cwd)

  if (params.verify === true) {
    const scan = profileCookieScan(dir) ?? { hosts: [], sessionHosts: [] }
    const hit = host
      ? scan.sessionHosts.some((h) => h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`))
      : null
    const now = new Date().toISOString()
    const serves = mutateRegistry((reg: Json) => {
      const entry = registryEntry(reg, key)
      entry.hosts = scan.hosts
      entry.sessionHosts = scan.sessionHosts
      entry.hostsAt = safeMtime(cookieStorePath(dir))
      if (hit && host) {
        const prior = Array.isArray(entry.serves) ? (entry.serves as string[]) : []
        entry.serves = [...new Set([...prior, host])]
        entry.loginVerifiedAt = now
      }
      if (note !== undefined) applyNote(entry, note)
      return Array.isArray(entry.serves) ? (entry.serves as string[]) : []
    })
    const verdict =
      host === null
        ? 'pass url so this can say WHICH site it verified.'
        : hit
          ? `'${name}' now holds cookies for ${host} - drive it with profile:'${name}' on any browser_* call. Cookie VALUES were never read.`
          : `no cookies for ${host} in '${name}' yet - finish the sign-in in the window, then call verify again.`
    return JSON.stringify(
      { profile: name, verified: hit, host, hostCount: scan.hosts.length, serves, note: verdict },
      null,
      2,
    )
  }

  const handed = await handOff(name, normalizeHandoffUrls(url ? [url] : []), true, caller.cwd)
  mutateRegistry((reg: Json) => {
    const entry = registryEntry(reg, key)
    entry.loginOpenedAt = new Date().toISOString()
    if (host) entry.loginPendingFor = host
    if (note !== undefined) applyNote(entry, note)
  })
  return `${handed}\n\nSIGN IN IN THAT WINDOW${host ? ` (${host})` : ''}, then confirm it landed:\n  browser_profile_login { profile: "${name}"${url ? `, url: ${JSON.stringify(url)}` : ''}, verify: true }\nNothing is attached while you type - no debugger, so bot checks behave. After it verifies, every browser_* call with profile:"${name}" reuses this login, on this machine, for as long as the site's session lasts.`
}

const HANDOFF_DESCRIPTION =
  "Hand a saved browser to a HUMAN with NOTHING attached - the way past a bot check (Google sign-in, Cloudflare 'verify you are human', reCAPTCHA, ALTCHA), which refuses any Chrome with a debugger attached. If this MCP spawned that profile's window, it closes it gracefully (cookies flush) and relaunches plain, visible Chrome with NO debug port at all (a human reads a port-carrying window as automated), opening urls. If a visible window with a port is already open on the profile, it only DETACHES, so every tab and half-filled form survives. Never re-attaches. When the human is done, the next browser_* call with profile:'<name>' closes the plain window gracefully and relaunches the same profile with a port - the login rides in the profile - so do not make that call while the human is still in the window."

const LOGIN_DESCRIPTION =
  "⭐ THE WAY A LOGIN GETS INTO THIS MCP, once, forever. Opens a plain visible Chrome on a MANAGED profile with NOTHING attached (no debugger, so Cloudflare/Google/hCaptcha bot walls behave), the human signs in, and from then on every browser_* call with profile:'<name>' carries that session - across sessions, across machines rebooting, until the site itself expires it. Then call again with verify:true to RECORD that it landed: the cookie store's HOST NAMES are read (never a cookie VALUE) and written to the profile registry, so a later agent answers 'which browser is signed into Cloudflare?' from data instead of opening windows on the owner's desktop. ⛔ WHY NOT JUST USE THE HUMAN'S OWN CHROME PROFILE: Chrome ≥127 app-bound-encrypts cookies, so a copied profile launches SIGNED OUT and Chrome silently deletes what it cannot decrypt (measured on this machine: 96 cookies -> 0). browser_profiles LISTS their real profiles so you know which identity you need; this tool is how that identity becomes usable."

const handoffTool: ToolDef = {
  name: 'browser_handoff',
  description: HANDOFF_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'the saved browser to hand over (required - see browser_profiles)' },
      urls: { type: 'array', items: { type: 'string' }, description: 'pages to open in the handed-off window' },
    },
    required: ['profile'],
  },
  run: async (params, caller) => {
    const name = String(params.profile ?? '').trim()
    if (!name)
      throw new ToolInputError(
        "browser_handoff needs profile:'<name>' - the saved browser to hand to a human (see browser_profiles)",
      )
    return handOff(name, normalizeHandoffUrls(params.urls), false, caller.cwd)
  },
}

const loginTool: ToolDef = {
  name: 'browser_profile_login',
  description: LOGIN_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        description: "managed profile that should own the login, e.g. 'cloudflare-registrar' (created on first use)",
      },
      url: {
        type: 'string',
        description: 'the page to sign in on - also the host that verify:true checks for',
      },
      verify: {
        type: 'boolean',
        description: "skip the window; read the cookie store's host names and record whether the login landed",
      },
      note: {
        type: 'string',
        description:
          'optional note saved on the profile exactly as browser_profile_note does (which account and what it is for, never the site name or sign-in status, never a password or secret; max 500 chars)',
      },
    },
    required: ['profile'],
  },
  run: (params, caller) => login(params, caller),
}

export const HANDOFF_TOOLS: ToolDef[] = [handoffTool, loginTool]
