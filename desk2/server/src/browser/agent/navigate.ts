// browser_navigate: opens a page in a saved browser's Chrome (or an attached one) for the caller, or reuses the page that
// caller already has there, and answers title and url the way Connections' browser_navigate does (browser.mjs
// browserActionGoto, :3919). Each caller keeps its own page in the shared Chrome; the map of whose page is which lives
// in this process.

import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pageTabs } from '../cdp'
import { ownPage } from '../ledger'
import { listProfiles, storeRoot } from '../store'
import type { ToolCaller } from './contract'
import { ToolInputError } from './errors'
import { dialogAnswerer } from './page-dialogs'
import { ensureBrowserEndpoint, findBrowserBinary } from './session'

const pages = new Map<string, string>()
const DEFAULT_WAIT_MS = 1500
const CDP_TIMEOUT_MS = 30_000

type Params = Record<string, unknown>

export interface Browser {
  key: string
  port: number
  browserWs: string
  dir: string | null
  exe: string
}

export interface Link {
  send(method: string, params: object): Promise<unknown>
  close(): void
}

const stringParam = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

export function attachPortParam(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new ToolInputError('attachPort must be a port number')
  return n
}

function profileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'default'
  )
}

export async function profileFolder(name: string, cwd: string | undefined): Promise<string> {
  const slug = profileSlug(name)
  const root = storeRoot()
  if (!cwd) return ensureDir(join(root, slug))
  const { result, refs } = await listProfiles(cwd)
  const open = refs.find((r) => r.profile.name === slug)
  if (open) return open.dir
  if (!result.workspace) return ensureDir(join(root, slug))
  const mine = join(root, 'ws', result.workspace, slug)
  const legacy = join(root, slug)
  if (!existsSync(mine) && existsSync(legacy) && lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink())
    return legacy
  return ensureDir(mine)
}

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

async function browserWsOf(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`/json/version: ${res.status}`)
  const v = (await res.json()) as { webSocketDebuggerUrl?: string }
  if (!v.webSocketDebuggerUrl) throw new Error('the Chrome did not name its debugger socket')
  return v.webSocketDebuggerUrl
}

export async function resolveBrowser(params: Params, caller: ToolCaller): Promise<Browser> {
  const exe = basename(findBrowserBinary() ?? 'chrome.exe')
  const attachPort = attachPortParam(params.attachPort)
  if (attachPort)
    return { key: `attach:${attachPort}`, port: attachPort, browserWs: await browserWsOf(attachPort), dir: null, exe }
  const dir = await profileFolder(stringParam(params.profile) ?? 'default', caller.cwd)
  const endpoint = await ensureBrowserEndpoint(dir, { headed: params.headed === true })
  return { key: dir, port: endpoint.port, browserWs: endpoint.browserWsUrl, dir, exe }
}

const callerKey = (caller: ToolCaller): string => caller.session || caller.chat || caller.worker || 'anonymous'

async function pageFor(browser: Browser, key: string): Promise<string> {
  const known = pages.get(key)
  if (known && (await pageTabs(browser.port).catch(() => [])).some((t) => t.id === known)) return known
  const link = await connect(browser.browserWs)
  try {
    const made = (await link.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
    pages.set(key, made.targetId)
    return made.targetId
  } finally {
    link.close()
  }
}

async function drive(port: number, targetId: string, url: string, waitMs: number): Promise<{ title: string; url: string }> {
  const link = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`)
  try {
    await link.send('Page.navigate', { url })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    const read = (await link.send('Runtime.evaluate', {
      expression: '({title:document.title,url:location.href})',
      returnByValue: true,
    })) as { result?: { value?: { title: string; url: string } } }
    return read.result?.value ?? { title: '', url }
  } finally {
    link.close()
  }
}

export function adopt(browser: Browser, caller: ToolCaller, targetId: string): void {
  pages.set(`${browser.key}|${callerKey(caller)}`, targetId)
}

export function forgetPage(browserKey: string, caller: ToolCaller): string | null {
  const key = `${browserKey}|${callerKey(caller)}`
  const targetId = pages.get(key) ?? null
  pages.delete(key)
  return targetId
}

export function forgetPagesOf(browserKey: string): void {
  const prefix = `${browserKey}|`
  for (const key of pages.keys()) if (key.startsWith(prefix)) pages.delete(key)
}

/** A link to one CDP endpoint; `onClose` hears when the browser drops it (its page or the browser went away). */
export function connect(
  url: string,
  onEvent?: (method: string, params: unknown) => void,
  onClose?: () => void,
): Promise<Link> {
  return new Promise<Link>((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    let seq = 0
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
      if (msg.id === undefined) {
        onEvent?.(msg.method ?? '', msg.params)
        return
      }
      const waiting = pending.get(msg.id)
      if (!waiting) return
      clearTimeout(waiting.timer)
      pending.delete(msg.id)
      if (msg.error) waiting.reject(new Error(msg.error.message))
      else waiting.resolve(msg.result)
    }
    ws.onerror = () => reject(new Error(`the browser did not accept ${url}`))
    if (onClose) ws.onclose = () => onClose()
    ws.onopen = () =>
      resolve({
        send: (method, params) =>
          new Promise((res, rej) => {
            const id = ++seq
            const timer = setTimeout(() => {
              pending.delete(id)
              rej(new Error(`${method}: no answer`))
            }, CDP_TIMEOUT_MS)
            pending.set(id, { resolve: res, reject: rej, timer })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close(),
      })
  })
}

// Each agent page keeps one link open with the Page domain on, answering its JavaScript dialogs (page-dialogs.ts)
// whenever they open: during a tool call or a moment after it. Chrome tells only a session that had Page enabled when
// a dialog opened, and a dialog it told nobody about cannot be answered over CDP at all (measured 2026-10-10: a later
// session's Page.enable gets no answer, and Page.handleJavaScriptDialog says "No dialog is showing"), so the page stays
// stuck until it is closed. Only the agent's own pages are watched: a tab in a person's own Chrome keeps its dialogs.
const dialogWatchers = new Map<string, Promise<void>>()
// A page already stuck behind a dialog nobody was told about never answers Page.enable; the tool goes on without it.
const WATCH_READY_MS = 2000

function watchDialogs(port: number, targetId: string): Promise<void> {
  const key = `${port}|${targetId}`
  const known = dialogWatchers.get(key)
  if (known) return known
  // Dropped when its link closes, so the next tool call on a page that is back (or a new browser) watches again.
  const forget = () => {
    if (dialogWatchers.get(key) === ready) dialogWatchers.delete(key)
  }
  const ready = openDialogWatcher(port, targetId, forget)
  dialogWatchers.set(key, ready)
  return ready
}

async function openDialogWatcher(port: number, targetId: string, forget: () => void): Promise<void> {
  let link: Link | null = null
  const answer = dialogAnswerer(targetId, (method, params) =>
    link ? link.send(method, params) : Promise.reject(new Error('the page link is not open')),
  )
  try {
    link = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, answer, forget)
  } catch {
    forget()
    return
  }
  await Promise.race([link.send('Page.enable', {}).catch(() => undefined), new Promise((r) => setTimeout(r, WATCH_READY_MS))])
}

export async function callerPage(params: Params, caller: ToolCaller): Promise<{ browser: Browser; targetId: string }> {
  const browser = await resolveBrowser(params, caller)
  const targetId = await pageFor(browser, `${browser.key}|${callerKey(caller)}`)
  if (browser.dir) ownPage(browser.dir, targetId, caller.session)
  await watchDialogs(browser.port, targetId)
  return { browser, targetId }
}

/** The page the caller already has open, or null: unlike callerPage, it never creates one. */
export async function knownPage(params: Params, caller: ToolCaller): Promise<{ browser: Browser; targetId: string } | null> {
  const browser = await resolveBrowser(params, caller)
  const targetId = pages.get(`${browser.key}|${callerKey(caller)}`)
  if (!targetId || !(await pageTabs(browser.port).catch(() => [])).some((t) => t.id === targetId)) return null
  return { browser, targetId }
}

export async function navigate(params: Params, caller: ToolCaller): Promise<string> {
  const url = stringParam(params.url)
  if (!url) throw new ToolInputError('url is required')
  const waitMs = Number(params.waitMs) > 0 ? Number(params.waitMs) : DEFAULT_WAIT_MS
  const { browser, targetId } = await callerPage(params, caller)
  const page = await drive(browser.port, targetId, url, waitMs)
  return `navigated → ${JSON.stringify(page)}  (browser: ${browser.exe})`
}
