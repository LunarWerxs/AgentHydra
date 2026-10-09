// The browser tools AgentHydra serves: one ToolDef per tool, with the description and input schema a model sees and
// the handler that answers it. A new tool is one more entry here; the service lists and calls them from this array.

import { pageTabs } from '../cdp'
import { readLedger } from '../ownership'
import {
  claimProfile,
  findPayload,
  profilesPayload,
  SavedBrowserError,
  saveProfileNote,
} from '../profiles-scope'
import { adoptProfile } from '../profiles-adopt'
import type { Listing } from '../store'
import { listProfiles } from '../store'
import { LIVE_TOOLS } from '../live/tools'
import type { ToolCaller, ToolName, ToolReply } from './contract'
import { ToolInputError } from './errors'
import { EXEC_TOOLS } from './exec'
import { INPUT_TOOLS } from './input'
import { navigate } from './navigate'
import { HANDOFF_TOOLS } from './handoff'
import { PAGE_TOOLS } from './page-tools'
import { READ_TOOLS } from './reads'
import { SCRIPT_TOOLS } from './script'
import { TAB_TOOLS } from './tabs'

export { ToolInputError }

const refused = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (err) {
    if (err instanceof SavedBrowserError) throw new ToolInputError(err.message)
    throw err
  }
}

const optionalText = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v)

export type ToolHandler = (params: Record<string, unknown>, caller: ToolCaller) => Promise<ToolReply>

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
  if (!Number.isInteger(n) || n <= 0 || n > 65535)
    throw new ToolInputError(`${key} must be a port number`)
  return n
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function requireCwd(caller: ToolCaller): string {
  if (!caller.cwd)
    throw new ToolInputError('the call needs the chat folder (caller.cwd) to pick its workspace')
  return caller.cwd
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
    if (!ref || ref.port === null)
      throw new ToolInputError(
        `profile '${name}' is not open; open it in its own Chrome or pass attachPort`,
      )
    return { port: ref.port, dir: ref.dir }
  }
  throw new ToolInputError(
    'pass profile (an open saved browser) or attachPort (a Chrome debugging port)',
  )
}

const cdpVersion = async (port: number): Promise<string> => {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(2000),
  })
  if (!res.ok) throw new Error(`/json/version: ${res.status}`)
  const v = (await res.json()) as { webSocketDebuggerUrl?: string }
  if (!v.webSocketDebuggerUrl) throw new Error('the Chrome did not name its debugger socket')
  return v.webSocketDebuggerUrl
}

async function cdpOnce(
  wsUrl: string,
  method: string,
  params: object,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`${method}: no answer`))
    }, timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
      }
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

/**
 * Whose page a tab is, for browser_status. The ledger records the Claude session that drives a page (ownPage), so it is
 * compared with the caller's session, never its Desk chat id: those are different ids and never match.
 */
export function tabOwnerLabel(ownerSession: string | undefined, caller: ToolCaller): 'unowned' | 'this chat' | 'another chat' {
  if (!ownerSession) return 'unowned'
  return caller.session !== undefined && ownerSession === caller.session ? 'this chat' : 'another chat'
}

export const TOOL_DEFS: ToolDef[] = [
  ...READ_TOOLS,
  ...EXEC_TOOLS,
  ...INPUT_TOOLS,
  ...PAGE_TOOLS,
  ...TAB_TOOLS,
  ...HANDOFF_TOOLS,
  ...SCRIPT_TOOLS,
  ...LIVE_TOOLS,
  {
    name: 'browser_profiles',
    description:
      "List THIS WORKSPACE's saved browsers - persistent named profiles (default: one per company), plus the pre-partition ones nobody owns (`unowned`) whose logins and cookies survive across sessions. Shows each profile's name, whether it's open right now (a live Chrome), and when it was last used. `sites` carries, per host a session has driven that profile to, whether the page loaded (`reached`), bounced to a sign-in (`signin-wall`) or hit a bot challenge (`challenged`), with the timestamp. READ THIS BEFORE OPENING ANYTHING: it lets you pick the profile that already holds the login. An entry is a dated observation, never a promise: sessions expire silently, so treat an old `reached` as a hint. Pass profile:'<name>' on browser_targets or browser_frames to read a specific one.",
    inputSchema: { type: 'object', properties: {} },
    run: async (_params, caller) => pretty(await profilesPayload(requireCwd(caller))),
  },
  {
    name: 'browser_profile_note',
    description:
      "Write down WHAT A SAVED BROWSER IS LOGGED INTO AND WHAT IT IS FOR, so any later chat in this workspace knows which one to use (browser_profiles and browser_profile_find return the note and title, and browser_profile_find also matches the note's words: for:'stripe' finds the browser whose note mentions Stripe). WHENEVER YOU SAVE A NOTE ALSO GIVE A SHORT TITLE (2-3 words, e.g. 'GitHub' or 'Shop admin'): the title is the name people see for the browser in lists instead of the raw profile name, so the TITLE names the site or the job. Keep the note itself to a FEW WORDS that say only what the title and the sign-in hosts do not: which ACCOUNT (the email or username - NEVER a password, token or any secret) and what the browser is FOR, e.g. 'billing@acme.com, refunds and payouts' or 'example-org/example-repo'. Never repeat the site name or host (the title and the sign-in hosts already show it). Never write sign-in status ('not signed in yet') or instructions to the owner: status in a note goes stale. Pass note, title or both: a field you leave out keeps its current value (title alone keeps the note, note alone keeps the title), and an empty string clears just that field. The note is trimmed and capped at 500 characters; the title is trimmed and CUT to 40 characters (not refused). Same scope as the rest of the browser tools: only this workspace's saved browsers (or an unowned pre-partition one); a profile another workspace owns is refused.",
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'the saved browser the note is about, as shown by browser_profiles',
        },
        note: {
          type: 'string',
          description:
            'a few words: which account (never a secret) and what it is for; never the site name or host, never sign-in status; empty clears the note; omit to keep it; max 500 chars',
        },
        title: {
          type: 'string',
          description:
            "short human name for the site or the job, 2-3 words, e.g. 'GitHub' or 'Shop admin'; trimmed and cut to 40 chars; empty clears it; omit to keep it",
        },
      },
      required: ['profile'],
    },
    run: async (params, caller) => {
      const profile = stringParam(params, 'profile')
      if (!profile)
        throw new ToolInputError('browser_profile_note needs profile:<the saved browser>')
      const fields = { note: optionalText(params.note), title: optionalText(params.title) }
      return pretty(await refused(() => saveProfileNote(requireCwd(caller), profile, fields)))
    },
  },
  {
    name: 'browser_profile_adopt',
    description:
      "Copy one of the MACHINE's own Chrome/Edge/Brave profiles into this MCP's managed store (see browser_profiles for the list of real profiles and what each is signed into). ⛔ READ THIS BEFORE REACHING FOR IT: on a modern Chrome it REFUSES, by design - app-bound cookie encryption means a copied session cannot be decrypted and Chrome deletes it silently on first launch, so a 'successful' copy would hand you a signed-out browser that claims to be the owner's. Use browser_profile_login instead; it is one human sign-in and the MCP owns the identity afterwards. Adoption still works on stores without an app-bound key (older Chrome, some Edge/Brave/Linux setups), and force:true copies the non-session files (preferences, storage) for the rare case that is what you want.",
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            "the real profile: a friendly name ('SaddleGauge'), a dir ('Profile 11'), or 'chrome:<either>'",
        },
        as: {
          type: 'string',
          description: 'managed profile name to create; defaults to the friendly name, slugified',
        },
        refresh: {
          type: 'boolean',
          description: 're-copy over an existing managed profile (it must have no live Chrome)',
        },
        force: {
          type: 'boolean',
          description:
            'copy even when the source is app-bound encrypted - the session will NOT come with it',
        },
      },
      required: ['from'],
    },
    run: async (params, caller) => {
      const from = stringParam(params, 'from')
      if (!from)
        throw new ToolInputError('browser_profile_adopt needs from:<the real profile: a friendly name, a dir, or chrome:<either>>')
      return pretty(
        await refused(() =>
          adoptProfile(
            requireCwd(caller),
            from,
            stringParam(params, 'as'),
            params.refresh === true,
            params.force === true,
          ),
        ),
      )
    },
  },
  {
    name: 'browser_profile_claim',
    description:
      "Move a saved browser profile INTO this workspace, so this project owns that login from now on. Saved profiles are workspace-scoped - a profile created in another workspace is reported by browser_profiles / browser_profile_find but cannot be driven from here, and this is the one door through that boundary. Two cases: a PRE-PARTITION profile (created before scoping existed, owned by nobody, shown under `unowned`) needs only profile:'<name>'; one owned by another workspace also needs from:'<its workspace path>'. It is a MOVE, never a copy - two workspaces driving one identity's cookies means two Chromes racing the same session and the site invalidating both - so the other workspace loses it. The profile must have no live Chrome: close that Chrome first.",
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: "the saved profile's name, e.g. 'shop-admin'" },
        from: {
          type: 'string',
          description:
            'the workspace that currently owns it (its path, as shown by browser_profiles); omit for an unowned pre-partition profile',
        },
      },
      required: ['profile'],
    },
    run: async (params, caller) => {
      const profile = stringParam(params, 'profile')
      if (!profile)
        throw new ToolInputError('browser_profile_claim needs profile:<the saved browser name>')
      return pretty(
        await refused(() => claimProfile(requireCwd(caller), profile, stringParam(params, 'from'))),
      )
    },
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
        : listing.refs
            .filter((r) => r.port !== null)
            .map((r) => ({ port: r.port as number, dir: r.dir, name: r.profile.name }))
      if (ports.length === 0)
        return "OPEN BROWSER WINDOWS (0): none open on this workspace's saved profiles"
      for (const p of ports) {
        const ledger = p.dir ? readLedger(p.dir) : new Map<string, { chat: string; at: number }>()
        lines.push(`\n${p.name} (debugging port ${p.port}):`)
        const tabs = await pageTabs(p.port)
        if (tabs.length === 0) lines.push('  (no pages)')
        for (const t of tabs) {
          const owner = ledger.get(t.id)
          const who = tabOwnerLabel(owner?.chat, caller)
          lines.push(`  · ${t.title.slice(0, 80)} — ${t.url.slice(0, 160)} [${who}]`)
        }
      }
      return lines.join('\n').trimStart()
    },
  },
  {
    name: 'browser_profile_find',
    description:
      "ASK THIS BEFORE YOU OPEN ANY BROWSER OR ASK ANYONE TO LOG IN. Answers 'which saved browser in this workspace is ALREADY logged in for X?' from the profile index. `for` takes what a person would say: a service word ('gmail', 'cloudflare', 'stripe'), a URL, or an identity. It returns `drivableNow` (the managed profile to pass as profile:'<name>', if one holds that session), every other match ranked with the hosts each one is signed into, and matches in other workspaces as evidence only. Matching is on cookie HOST NAMES (values are never read) plus the profile's name and note. A recorded session is a dated observation, not a promise; if the site still asks for a login, the person must sign in again.",
    inputSchema: {
      type: 'object',
      properties: {
        for: {
          type: 'string',
          description:
            "service word, URL, or identity - 'gmail', 'https://dash.cloudflare.com', 'Example Owner'",
        },
      },
      required: ['for'],
    },
    run: async (params, caller) => {
      const query = stringParam(params, 'for')
      if (!query)
        throw new ToolInputError("browser_profile_find needs for:'<service, url or identity>'")
      return pretty(await findPayload(requireCwd(caller), query))
    },
  },
  {
    name: 'browser_targets',
    description:
      "List every CDP target the browser knows about - open tabs, pages, workers and extension background targets - each with its type, title, URL, and whether it is attached. Use it to confirm a page's service worker registered, or to see what is there before reading a page. Complements browser_frames, which shows in-page iframe topology rather than the target list.",
    inputSchema: { type: 'object', properties: { ...ATTACH_PORT_PROP, ...PROFILE_PROP } },
    run: async (params, caller) => {
      const { port } = await profileRefOrPort(await listProfiles(requireCwd(caller)), params)
      const wsUrl = await cdpVersion(port)
      let res: {
        targetInfos?: { type: string; title?: string; url?: string; attached?: boolean }[]
      }
      try {
        res = await cdpOnce(wsUrl, 'Target.getTargets', { filter: [{}] })
      } catch {
        res = await cdpOnce(wsUrl, 'Target.getTargets', {})
      }
      const rows = (res.targetInfos ?? [])
        .filter((t) => !String(t.url ?? '').startsWith('devtools:'))
        .map((t) => ({
          type: t.type,
          title: (t.title ?? '').slice(0, 80),
          url: (t.url ?? '').slice(0, 160),
          attached: !!t.attached,
        }))
      return rows.length ? pretty(rows) : '(no targets)'
    },
  },
  {
    name: 'browser_navigate',
    description:
      "Open a page in a saved browser (or an attached Chrome) and go to a URL. Reuses the page this chat already has in that browser, so repeated calls move one tab. Answers the page's title and final URL once it has loaded for waitMs (default 1500). Pick the profile first with browser_profile_find or browser_profiles; a profile with a live Chrome is driven as it is.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the address to open, e.g. https://example.com' },
        headed: { type: 'boolean', description: 'launch a visible window if no Chrome is open on this profile yet' },
        waitMs: { type: 'number', description: 'milliseconds to wait after navigating before reading the title; default 1500' },
        ...ATTACH_PORT_PROP,
        ...PROFILE_PROP,
      },
      required: ['url'],
    },
    run: (params, caller) => navigate(params, caller),
  },
  {
    name: 'browser_frames',
    description:
      "List the frame topology of the main page - the main frame plus every cross-origin iframe and popup, each with a text snippet. A debugging aid for 'element not found' when the content sits inside an iframe.",
    inputSchema: { type: 'object', properties: { ...ATTACH_PORT_PROP, ...PROFILE_PROP } },
    run: async (params, caller) => {
      const { port } = await profileRefOrPort(await listProfiles(requireCwd(caller)), params)
      const list = (await (
        await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      ).json()) as {
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
      return pretty([
        { session: page.id.slice(0, 8), type: 'main', url: page.url.slice(0, 50), text },
      ])
    },
  },
]
