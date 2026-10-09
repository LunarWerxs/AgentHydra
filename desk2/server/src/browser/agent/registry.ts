// The browser tools AgentHydra serves: one ToolDef per tool, with the description and input schema a model sees and
// the handler that answers it. A new tool is one more entry here; the service lists and calls them from this array.

import { readLedger } from '../ownership'
import { pageTabs } from '../cdp'
import { listProfiles, type Listing, type ProfileRef } from '../store'
import type { BrowserProfile } from '@shared/browser'
import type { ToolCaller, ToolName } from './contract'

export class ToolInputError extends Error {}

export type ToolHandler = (params: Record<string, unknown>, caller: ToolCaller) => Promise<string>

export interface ToolDef {
  name: ToolName
  description: string
  inputSchema: Record<string, unknown>
  run: ToolHandler
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

const ATTACH_PORT_PROP = {
  attachPort: {
    type: 'number',
    description:
      'attach to an ALREADY-RUNNING Chrome exposing this CDP port (e.g. a window the user signed into) instead of the profile browser',
  },
}

const PROFILE_PROP = {
  profile: {
    type: 'string',
    description:
      "Which saved browser to use (a persistent named profile - logins there survive across sessions). Omit = this workspace's company browser. See browser_profiles for the list.",
  },
}

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

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'browser_profiles',
    description:
      "List THIS WORKSPACE's saved browsers - persistent named profiles (default: one per company), plus the pre-partition ones nobody owns (`unowned`) whose logins and cookies survive across sessions. Shows each profile's name, whether it's open right now (a live Chrome), and when it was last used. `sites` carries, per host a session has driven that profile to, whether the page loaded (`reached`), bounced to a sign-in (`signin-wall`) or hit a bot challenge (`challenged`), with the timestamp. READ THIS BEFORE OPENING ANYTHING: it lets you pick the profile that already holds the login. An entry is a dated observation, never a promise: sessions expire silently, so treat an old `reached` as a hint. Pass profile:'<name>' on browser_targets or browser_frames to read a specific one.",
    inputSchema: { type: 'object', properties: {} },
    run: async (_params, caller) => pretty(listingRows(await listProfiles(requireCwd(caller)))),
  },
  {
    name: 'browser_status',
    description:
      "Situational awareness for the browser - call this FIRST when the page looks wrong, you hit an unexpected login screen, or you're unsure which window you're driving. Answers, without opening anything: every browser window open across this workspace's saved profiles, each with its tabs (the title and URL of each), and which chat, if any, owns each tab. Pass attachPort to report on a specific attached CDP session instead.",
    inputSchema: { type: 'object', properties: { ...ATTACH_PORT_PROP } },
    run: async (params, caller) => {
      const attachPort = numberParam(params, 'attachPort')
      const listing = await listProfiles(requireCwd(caller))
      const lines: string[] = []
      const ports = attachPort
        ? [{ port: attachPort, dir: null as string | null, name: `port ${attachPort}` }]
        : listing.refs.filter((r) => r.port !== null).map((r) => ({ port: r.port as number, dir: r.dir, name: r.profile.name }))
      if (ports.length === 0) return "OPEN BROWSER WINDOWS (0): none open on this workspace's saved profiles"
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
  },
  {
    name: 'browser_profile_find',
    description:
      "ASK THIS BEFORE YOU OPEN ANY BROWSER OR ASK ANYONE TO LOG IN. Answers 'which saved browser in this workspace is ALREADY logged in for X?' from the profile index. `for` takes what a person would say: a service word ('gmail', 'cloudflare', 'stripe'), a URL, or an identity. It returns the matching profiles ranked, with the hosts each one is signed into. Matching is on cookie HOST NAMES (values are never read) plus the profile's name and note. A recorded session is a dated observation, not a promise; if the site still asks for a login, the person must sign in again.",
    inputSchema: {
      type: 'object',
      properties: {
        for: { type: 'string', description: "service word, URL, or identity - 'gmail', 'https://dash.cloudflare.com', 'Example Owner'" },
      },
      required: ['for'],
    },
    run: async (params, caller) => {
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
  },
  {
    name: 'browser_targets',
    description:
      'List every CDP target the browser knows about - open tabs, pages, workers and extension background targets - each with its type, title, URL, and whether it is attached. Use it to confirm a page\'s service worker registered, or to see what is there before reading a page. Complements browser_frames, which shows in-page iframe topology rather than the target list.',
    inputSchema: { type: 'object', properties: { ...ATTACH_PORT_PROP, ...PROFILE_PROP } },
    run: async (params, caller) => {
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
  },
  {
    name: 'browser_frames',
    description:
      "List the frame topology of the main page - the main frame plus every cross-origin iframe and popup, each with a text snippet. A debugging aid for 'element not found' when the content sits inside an iframe.",
    inputSchema: { type: 'object', properties: { ...ATTACH_PORT_PROP, ...PROFILE_PROP } },
    run: async (params, caller) => {
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
  },
]
