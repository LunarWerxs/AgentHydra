// The tab tools: browser_tab and browser_close. Each answers the text Connections' engine gives (browser.mjs switchTab :1502,
// browserActionTab :3576, browserActionClose :3138, releaseOwnTabs :578), over the same CDP calls. A Chrome another chat
// still holds a live tab in is never closed under it: only the leaving chat's tabs close.

import { closeBrowser, closePage, liveBrowser, pageTabs } from '../cdp'
import { dropPage, ownPage } from '../ledger'
import { readLedger } from '../ownership'
import { listProfiles } from '../store'
import type { ToolCaller, ToolReply } from './contract'
import { ToolInputError } from './errors'
import { adopt, attachPortParam, forgetPage, profileFolder, resolveBrowser } from './navigate'
import type { ToolDef } from './registry'

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

async function tab(params: Record<string, unknown>, caller: ToolCaller): Promise<ToolReply> {
  const browser = await resolveBrowser(params, caller)
  const me = caller.session
  const asked = String(params.match ?? '')
  const match = asked.trim().toLowerCase()
  const ledger: Map<string, { chat: string }> = browser.dir ? readLedger(browser.dir) : new Map()
  const tabs = await pageTabs(browser.port)
  const hit = (t: { url: string; title: string }) =>
    !match || t.url.toLowerCase().includes(match) || t.title.toLowerCase().includes(match)
  const ownerOf = (id: string) => ledger.get(id)?.chat
  const page =
    tabs.find((t) => Boolean(me) && ownerOf(t.id) === me && hit(t)) ?? tabs.find((t) => !ownerOf(t.id) && hit(t))
  if (!page) {
    const foreign = match ? tabs.find((t) => hit(t) && Boolean(ownerOf(t.id)) && ownerOf(t.id) !== me) : undefined
    if (foreign)
      throw new ToolInputError(
        `the tab matching "${asked}" (${foreign.url.slice(0, 80)}) is another chat's tab; this chat drives only its own tabs or unowned ones.`,
      )
    throw new ToolInputError(match ? `no tab matching: ${asked}` : 'no page tab')
  }
  adopt(browser, caller, page.id)
  if (browser.dir && me) ownPage(browser.dir, page.id, me)
  return `tab → ${page.title} | ${page.url}`
}

async function othersHoldTabs(dir: string, me: string | undefined): Promise<boolean> {
  const live = await liveBrowser(dir)
  if (!live) return false
  const ledger = readLedger(dir)
  const tabs = await pageTabs(live.port).catch(() => [])
  return tabs.some((t) => {
    const owner = ledger.get(t.id)?.chat
    return Boolean(owner) && owner !== me
  })
}

async function releaseProfile(dir: string, caller: ToolCaller): Promise<boolean> {
  const me = caller.session
  const own = new Set([...readLedger(dir)].filter(([, row]) => Boolean(me) && row.chat === me).map(([id]) => id))
  const remembered = forgetPage(dir, caller)
  if (remembered) own.add(remembered)
  if (!own.size) return false
  const live = await liveBrowser(dir)
  if (live) await Promise.allSettled([...own].map((id) => closePage(live.port, id)))
  for (const id of own) dropPage(dir, id)
  if (!(await othersHoldTabs(dir, me))) await closeBrowser(dir).catch(() => false)
  return true
}

async function close(params: Record<string, unknown>, caller: ToolCaller): Promise<string> {
  const attachPort = attachPortParam(params.attachPort)
  const profile = String(params.profile ?? '').trim()
  let closed = 0
  if (attachPort) {
    closed = forgetPage(`attach:${attachPort}`, caller) ? 1 : 0
  } else if (profile) {
    closed = (await releaseProfile(await profileFolder(profile, caller.cwd), caller)) ? 1 : 0
  } else {
    if (!caller.cwd) throw new ToolInputError('the call needs the chat folder (caller.cwd) to pick its workspace')
    const { refs } = await listProfiles(caller.cwd)
    for (const ref of refs) if (await releaseProfile(ref.dir, caller)) closed++
  }
  return closed ? `browser closed (${closed} profile${closed === 1 ? '' : 's'})` : 'no open browser'
}

export const TAB_TOOLS: ToolDef[] = [
  {
    name: 'browser_tab',
    description:
      "Switch which TAB of the open browser the tools drive - match is a substring of the tab's URL or title (omit to take the first tab). Use when one signed-in window holds several sites, one per tab.",
    inputSchema: {
      type: 'object',
      properties: { match: { type: 'string' }, ...ATTACH_PORT_PROP, ...PROFILE_PROP },
    },
    run: tab,
  },
  {
    name: 'browser_close',
    description:
      "Close a browser and free it. Pass profile:'<name>' to close just that saved browser, or attachPort to DETACH one specific attached session (never closes the user's own browser); omit both to close every open one. Profiles persist on disk either way - closing never logs anything out. To hand a window to a human for a bot check, use browser_handoff.",
    inputSchema: { type: 'object', properties: { ...ATTACH_PORT_PROP, ...PROFILE_PROP } },
    run: close,
  },
]
