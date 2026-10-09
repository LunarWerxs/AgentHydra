// The six read-only browser tools as AgentHydra serves them. They look at the saved-browser store and at Chromes
// already running on it (through each profile's DevToolsActivePort); none of them launches a Chrome.

import { readLedger } from '../ownership'
import { pageTabs } from '../cdp'
import { listProfiles, type Listing, type ProfileRef } from '../store'
import type { BrowserProfile } from '@shared/browser'
import { isReadTool, type CallResult, type ToolCaller, type ToolParams } from './contract'

class ToolInputError extends Error {}

type Handler = (params: Record<string, unknown>, caller: ToolCaller) => Promise<string>

const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new ToolInputError(`${key} must be a port number`)
  return n
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function requireCwd(caller: ToolCaller): string {
  if (!caller.cwd) throw new ToolInputError('the call needs the chat folder (caller.cwd) to pick its workspace')
  return caller.cwd
}

function listingRows(listing: Listing): Record<string, unknown> {
  const row = (ref: ProfileRef) => {
    const p: BrowserProfile = ref.profile
    return {
      profile: p.name,
      scope: p.own ? 'workspace' : 'unowned',
      key: p.own ? `${listing.result.workspace}/${p.name}` : p.name,
      open: p.open,
      lastUsed: p.lastUsedAt,
      signedInHosts: p.sessionHosts,
      note: p.note,
      ...(p.title ? { title: p.title } : {}),
      sites: p.sites,
    }
  }
  return {
    workspace: listing.result.workspace,
    managed: listing.refs.filter((r) => r.profile.own).map(row),
    unowned: listing.refs.filter((r) => !r.profile.own).map(row),
    ...(listing.result.error ? { error: listing.result.error } : {}),
  }
}

async function profileRefOrPort(
  listing: Listing,
  params: Record<string, unknown>,
): Promise<{ port: number; dir: string | null }> {
  const attachPort = numberParam(params, 'attachPort')
  if (attachPort) return { port: attachPort, dir: null }
  const name = stringParam(params, 'profile')
  if (name) {
    const ref = listing.refs.find((r) => r.profile.name === name)
    if (!ref || ref.port === null) throw new ToolInputError(`profile '${name}' is not open; open it in its own Chrome or pass attachPort`)
    return { port: ref.port, dir: ref.dir }
  }
  throw new ToolInputError('pass profile (an open saved browser) or attachPort (a Chrome debugging port)')
}

const cdpVersion = async (port: number): Promise<string> => {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`/json/version: ${res.status}`)
  const v = (await res.json()) as { webSocketDebuggerUrl?: string }
  if (!v.webSocketDebuggerUrl) throw new Error('the Chrome did not name its debugger socket')
  return v.webSocketDebuggerUrl
}

async function cdpOnce(wsUrl: string, method: string, params: object, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`${method}: no answer`))
    }, timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`${method}: socket failed`))
    }
  })
}

const handlers: Record<keyof ToolParams, Handler> = {
  browser_profiles: async (_params, caller) => pretty(listingRows(await listProfiles(requireCwd(caller)))),

  browser_status: async (params, caller) => {
    const attachPort = numberParam(params, 'attachPort')
    const listing = await listProfiles(requireCwd(caller))
    const lines: string[] = []
    const ports = attachPort
      ? [{ port: attachPort, dir: null as string | null, name: `port ${attachPort}` }]
      : listing.refs.filter((r) => r.port !== null).map((r) => ({ port: r.port as number, dir: r.dir, name: r.profile.name }))
    if (ports.length === 0) return 'OPEN BROWSER WINDOWS (0): none open on this workspace\'s saved profiles'
    for (const p of ports) {
      const ledger = p.dir ? readLedger(p.dir) : new Map<string, { chat: string; at: number }>()
      lines.push(`\n${p.name} (debugging port ${p.port}):`)
      const tabs = await pageTabs(p.port)
      if (tabs.length === 0) lines.push('  (no pages)')
      for (const t of tabs) {
        const owner = ledger.get(t.id)
        const who = !owner ? 'unowned' : owner.chat === caller.chat ? 'this chat' : 'another chat'
        lines.push(`  · ${t.title.slice(0, 80)} — ${t.url.slice(0, 160)} [${who}]`)
      }
    }
    return lines.join('\n').trimStart()
  },

  browser_profile_find: async (params, caller) => {
    const query = stringParam(params, 'for')
    if (!query) throw new ToolInputError("browser_profile_find needs for:'<service, url or identity>'")
    const listing = await listProfiles(requireCwd(caller))
    const hosts = [...query.toLowerCase().matchAll(/(?:[a-z0-9-]+\.)+[a-z]{2,}/g)].map((m) => m[0])
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
    const word = query.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const hostMatches = (host: string, want: string) => host === want || want.endsWith(`.${host}`) || host.endsWith(`.${want}`)
    const matches = listing.refs
      .map((ref) => {
        const p = ref.profile
        const matchedHosts = hosts.filter((w) => p.sessionHosts.some((h) => hostMatches(h, w)))
        const nameHit = word.length >= 3 && p.name.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(word)
        const noteHit = word.length >= 3 && (p.note ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').includes(word)
        const wordHit = words.some((w) => p.sessionHosts.some((h) => h.includes(w)))
        const points = matchedHosts.length * 10 + (nameHit ? 3 : 0) + (noteHit ? 3 : 0) + (matchedHosts.length === 0 && wordHit ? 1 : 0)
        return { profile: p.name, scope: p.own ? 'workspace' : 'unowned', points, matchedHosts, nameHit, noteHit, note: p.note, open: p.open }
      })
      .filter((m) => m.points > 0)
      .sort((a, b) => b.points - a.points)
    return pretty({ query, matches })
  },

  browser_targets: async (params, caller) => {
    const { port } = await profileRefOrPort(await listProfiles(requireCwd(caller)), params)
    const wsUrl = await cdpVersion(port)
    let res: { targetInfos?: { type: string; title?: string; url?: string; attached?: boolean }[] }
    try {
      res = await cdpOnce(wsUrl, 'Target.getTargets', { filter: [{}] })
    } catch {
      res = await cdpOnce(wsUrl, 'Target.getTargets', {})
    }
    const rows = (res.targetInfos ?? [])
      .filter((t) => !String(t.url ?? '').startsWith('devtools:'))
      .map((t) => ({ type: t.type, title: (t.title ?? '').slice(0, 80), url: (t.url ?? '').slice(0, 160), attached: !!t.attached }))
    return rows.length ? pretty(rows) : '(no targets)'
  },

  browser_frames: async (params, caller) => {
    const { port } = await profileRefOrPort(await listProfiles(requireCwd(caller)), params)
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) as {
      id: string
      type: string
      url: string
      webSocketDebuggerUrl?: string
    }[]
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!page?.webSocketDebuggerUrl) return '(no page to read)'
    let text: string
    try {
      const r = await cdpOnce(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: "(document.body?document.body.innerText:'').slice(0,120)",
        returnByValue: true,
      })
      text = String(r?.result?.value ?? '').replace(/\s+/g, ' ')
    } catch (err) {
      text = `(eval failed: ${String(err instanceof Error ? err.message : err).slice(0, 40)})`
    }
    return pretty([{ session: page.id.slice(0, 8), type: 'main', url: page.url.slice(0, 50), text }])
  },
}

export async function callTool(name: string, params: Record<string, unknown> = {}, caller: ToolCaller = {}): Promise<CallResult> {
  if (!isReadTool(name)) return { ok: false, status: 404, error: `no browser tool named ${name}` }
  try {
    return { ok: true, text: await handlers[name](params, caller) }
  } catch (err) {
    if (err instanceof ToolInputError) return { ok: false, status: 400, error: err.message }
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) }
  }
}
