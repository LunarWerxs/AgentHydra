// The browser pane's side of Desk 2 (contract: shared/browser.ts): the saved Chrome browsers of a chat's workspace
// (the Connections MCP's browser profile store, read only), one profile's Chrome started when none runs, and a live
// view of one of its pages over a websocket. The store reader is browser/store.ts, Chrome's protocol browser/cdp.ts.
//
// Every route and the websocket upgrade is for Desk 2's own page only (browser/guard.ts), after Desk's localOnly
// guard. A request names a profile, never a port: the port comes from that profile folder's DevToolsActivePort.

import type { ServerWebSocket } from 'bun'
import type { Context, Hono } from 'hono'
import { BROWSER_CLOSE, BROWSER_LIVE, BROWSER_OPEN, BROWSER_PAGE, BROWSER_PAGE_CLOSE, BROWSER_PREVIEW, BROWSER_PREVIEW_STREAM, BROWSER_PROFILES, BROWSER_TABS, type BrowserOpened, type BrowserTab, type BrowserPreviewOut } from '@shared/browser'
import { capturePreview, closeBrowser, closePage, firstTab, LaunchError, launchChrome, liveFrame, LiveSession, newPage, pageTabs, parseLiveIn } from '../browser/cdp'
import { notOwnPage } from '../browser/guard'
import { askedTab, TabScope } from '../browser/ownership'
import { previewHub } from '../browser/preview'
import { listProfiles, ofAnotherWorkspace, type ProfileRef } from '../browser/store'
import type { ServerContext } from '../context'

/** The profile `name` as this chat's workspace may use it: its own, or an unowned one that is open. */
async function usable(cwd: string, name: string): Promise<ProfileRef | null> {
  const { refs } = await listProfiles(cwd)
  return refs.find((r) => r.profile.name === name) ?? null
}

interface LiveData {
  port: number
  scope: TabScope | null
  tab: { id: string; url: string; title: string }
  /** The socket asked for one page (?tab=): it follows no other. */
  bound: boolean
}

interface PreviewData {
  port: number
  scope: TabScope | null
}

type Ws = ServerWebSocket<unknown>

const sessions = new WeakMap<object, LiveSession>()
const previews = new WeakMap<object, () => void>()

/** What the chat named in a request may see of the profile: its own pages and unowned ones. No chat named: every page (the person's own servers pane). */
function scopeOf(ctx: ServerContext, ref: ProfileRef, chat: unknown): TabScope | null {
  if (typeof chat !== 'string' || chat === '') return null
  const sessionsOf = ctx.deps.chatSessions as ((id: string) => string[]) | undefined
  return new TabScope(ref.dir, chat, sessionsOf?.(chat) ?? [])
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

async function profilesRoute(c: Context): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  const cwd = c.req.query('cwd')
  if (!cwd) return c.json({ error: 'cwd required' }, 400)
  return c.json((await listProfiles(cwd)).result)
}

/** An open profile: the page this chat should see (none started). */
async function openedTab(ctx: ServerContext, ref: ProfileRef & { port: number }, chat: unknown): Promise<BrowserTab | null> {
  const scope = scopeOf(ctx, ref, chat)
  try {
    return scope ? await scope.pickOrOpen(ref.port) : ((await pageTabs(ref.port).catch(() => []))[0] ?? null)
  } catch {
    return null
  }
}

async function openRoute(c: Context, ctx: ServerContext): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; profile?: unknown; url?: unknown; login?: unknown; chat?: unknown } | null
  if (!nonEmpty(body?.cwd) || !nonEmpty(body.profile)) return c.json({ error: 'cwd and profile required' }, 400)
  const url = nonEmpty(body.url) ? body.url : undefined
  if (url !== undefined && !isHttpUrl(url)) return c.json({ error: 'url must be http or https' }, 400)
  const ref = await usable(body.cwd, body.profile)
  if (!ref) return c.json({ error: `no browser '${body.profile}' for this chat's workspace` }, 404)
  if (ref.port !== null) {
    const opened: BrowserOpened = { profile: ref.profile.name, started: false, tab: await openedTab(ctx, { ...ref, port: ref.port }, body.chat) }
    return c.json(opened)
  }
  // An unowned profile is only for use while it is open somewhere; it is not started from here.
  if (!ref.profile.own) return c.json({ error: `'${body.profile}' belongs to no workspace and is not open` }, 404)
  try {
    const login = body.login === true
    const port = await launchChrome(ref.dir, url, login)
    const first = port === null ? null : await firstTab(port)
    if (first) scopeOf(ctx, ref, body.chat)?.adopt(first.id)
    const opened: BrowserOpened = { profile: ref.profile.name, started: true, tab: first }
    return c.json(opened)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, err instanceof LaunchError ? 503 : 500)
  }
}

// Closing a saved browser's pane tab closes its Chrome: the Browser cards then read the profile as not open and stop.
async function closeRoute(c: Context): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; profile?: unknown } | null
  if (!nonEmpty(body?.cwd) || !nonEmpty(body.profile)) return c.json({ error: 'cwd and profile required' }, 400)
  const ref = await usable(body.cwd, body.profile)
  if (!ref) return c.json({ error: `no browser '${body.profile}' for this chat's workspace` }, 404)
  if (!ref.profile.own) return c.json({ error: `'${body.profile}' belongs to no workspace` }, 404)
  try {
    return c.json({ closed: ref.port !== null && (await closeBrowser(ref.dir)) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
  }
}

async function tabsRoute(c: Context, ctx: ServerContext): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  const cwd = c.req.query('cwd')
  const profile = c.req.query('profile')
  if (!cwd || !profile) return c.json({ error: 'cwd and profile required' }, 400)
  const ref = await usable(cwd, profile)
  if (!ref) return c.json({ error: `no browser '${profile}' for this chat's workspace` }, 404)
  if (ref.port === null) return c.json({ error: `'${profile}' is not open` }, 409)
  try {
    const tabs = await pageTabs(ref.port)
    return c.json(scopeOf(ctx, ref, c.req.query('chat'))?.visible(tabs) ?? tabs)
  } catch {
    return c.json({ error: `'${profile}' did not answer` }, 502)
  }
}

type PageArgs = { fail: Response } | { fail?: undefined; port: number; arg: string; scope: TabScope | null }

// One page of an open profile: a new one opened at an address, or one closed. Neither touches the other pages or the Chrome.
async function pageArgs(c: Context, ctx: ServerContext, need: 'url' | 'tab'): Promise<PageArgs> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return { fail: c.json({ error: why }, 403) }
  const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; profile?: unknown; url?: unknown; tab?: unknown; chat?: unknown } | null
  const arg = body?.[need]
  if (!nonEmpty(body?.cwd) || !nonEmpty(body.profile) || !nonEmpty(arg)) return { fail: c.json({ error: `cwd, profile and ${need} required` }, 400) }
  const ref = await usable(body.cwd, body.profile)
  if (!ref) return { fail: c.json({ error: `no browser '${body.profile}' for this chat's workspace` }, 404) }
  if (ref.port === null) return { fail: c.json({ error: `'${body.profile}' is not open` }, 409) }
  return { port: ref.port, arg, scope: scopeOf(ctx, ref, body.chat) }
}

async function newPageRoute(c: Context, ctx: ServerContext): Promise<Response> {
  const r = await pageArgs(c, ctx, 'url')
  if (r.fail) return r.fail
  if (!isHttpUrl(r.arg)) return c.json({ error: 'url must be http or https' }, 400)
  try {
    const tab = await newPage(r.port, r.arg)
    if (tab) r.scope?.adopt(tab.id)
    return tab ? c.json(tab) : c.json({ error: 'the browser did not open a page' }, 502)
  } catch {
    return c.json({ error: 'the browser did not answer' }, 502)
  }
}

async function closePageRoute(c: Context, ctx: ServerContext): Promise<Response> {
  const r = await pageArgs(c, ctx, 'tab')
  if (r.fail) return r.fail
  try {
    if (r.scope?.isOther(await pageTabs(r.port), r.arg)) return c.json({ error: 'that page belongs to another chat' }, 403)
    return c.json({ closed: await closePage(r.port, r.arg) })
  } catch {
    return c.json({ error: 'the browser did not answer' }, 502)
  }
}

const jpeg = (bytes: Buffer): Response => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } })

// A small JPEG of what the profile's page shows now (the transcript Browser card's live preview). Never starts a Chrome.
async function previewRoute(c: Context, ctx: ServerContext): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers)
  if (why) return c.json({ error: why }, 403)
  const cwd = c.req.query('cwd')
  const profile = c.req.query('profile')
  if (!cwd || !profile) return c.json({ error: 'cwd and profile required' }, 400)
  const listing = await listProfiles(cwd)
  const ref = listing.refs.find((r) => r.profile.name === profile)
  if (!ref) return c.json({ error: `no browser '${profile}' for this chat's workspace` }, ofAnotherWorkspace(listing, profile) ? 403 : 404)
  if (ref.port === null) return c.json({ error: `'${profile}' is not open` }, 404)
  try {
    // A page the pane is showing live already streams frames: answer from the newest, never a second capture.
    const scope = scopeOf(ctx, ref, c.req.query('chat'))
    const frame = liveFrame(ref.port, scope?.key ?? '')
    if (frame) return jpeg(frame)
    const tab = scope ? scope.best(await pageTabs(ref.port)) : await LiveSession.pick(ref.port, null)
    if (!tab) return c.json({ error: `'${profile}' has no page of this chat open` }, 404)
    return jpeg(await capturePreview(ref.port, tab.id))
  } catch {
    return c.json({ error: `'${profile}' did not answer` }, 502)
  }
}

async function acceptPreview(req: Request, ctx: ServerContext): Promise<Response | { data: PreviewData }> {
  const why = notOwnPage(req.headers)
  if (why) return Response.json({ error: why }, { status: 403 })
  const q = new URL(req.url).searchParams
  const cwd = q.get('cwd')
  const profile = q.get('profile')
  if (!cwd || !profile) return Response.json({ error: 'cwd and profile required' }, { status: 400 })
  const listing = await listProfiles(cwd)
  const ref = listing.refs.find((r) => r.profile.name === profile)
  if (!ref) return Response.json({ error: `no browser '${profile}' for this chat's workspace` }, { status: ofAnotherWorkspace(listing, profile) ? 403 : 404 })
  if (ref.port === null) return Response.json({ error: `'${profile}' is not open` }, { status: 409 })
  return { data: { port: ref.port, scope: scopeOf(ctx, ref, q.get('chat')) } }
}

function openPreview(ws: Ws, data: PreviewData): void {
  const send = (msg: BrowserPreviewOut): void => {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // floor-ok: a socket closing mid-send is dropped by its close handler
    }
  }
  previews.set(
    ws,
    previewHub.subscribe(data.port, {
      send: (f) => send({ type: 'frame', data: f.data, width: f.width, height: f.height }),
      closed: (reason) => {
        send({ type: 'closed', reason })
        ws.close()
      },
      backed: () => ws.getBufferedAmount() > 512 * 1024,
    }, data.scope ?? undefined),
  )
}

/** The page a live socket shows: the one asked for (?tab=), else this chat's pick. */
async function liveTab(port: number, scope: TabScope | null, asked: string | null): Promise<BrowserTab | null | { error: string; status: number }> {
  try {
    if (!asked) return scope ? await scope.pickOrOpen(port) : await LiveSession.pick(port, null)
    const got = await askedTab(port, scope, asked)
    return 'error' in got ? got : got.tab
  } catch {
    return null
  }
}

async function acceptLive(req: Request, ctx: ServerContext): Promise<Response | { data: LiveData }> {
  const why = notOwnPage(req.headers)
  if (why) return Response.json({ error: why }, { status: 403 })
  const q = new URL(req.url).searchParams
  const cwd = q.get('cwd')
  const profile = q.get('profile')
  if (!cwd || !profile) return Response.json({ error: 'cwd and profile required' }, { status: 400 })
  const ref = await usable(cwd, profile)
  if (!ref) return Response.json({ error: `no browser '${profile}' for this chat's workspace` }, { status: 404 })
  if (ref.port === null) return Response.json({ error: `'${profile}' is not open` }, { status: 409 })
  const scope = scopeOf(ctx, ref, q.get('chat'))
  const asked = q.get('tab')
  const tab = await liveTab(ref.port, scope, asked)
  if (tab && 'error' in tab) return Response.json({ error: tab.error }, { status: tab.status })
  if (!tab) return Response.json({ error: 'that page is not open' }, { status: 404 })
  return { data: { port: ref.port, scope, tab, bound: !!asked } }
}

function openLive(ws: Ws, data: LiveData): void {
  const session = new LiveSession(
    data.port,
    (msg) => {
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        // floor-ok: a socket closing mid-send is dropped by its close handler
      }
    },
    () => ws.close(),
    data.bound,
    data.scope,
  )
  sessions.set(ws, session)
  session.start(data.tab).catch(() => {
    ws.send(JSON.stringify({ type: 'closed', reason: 'the page could not be shown' }))
    ws.close()
  })
}

function liveMessage(ws: Ws, message: string | Buffer): void {
  const msg = typeof message === 'string' ? parseLiveIn(message) : null
  if (msg) sessions.get(ws)?.input(msg).catch(() => {
    // floor-ok: input to a page that just went away is dropped
  })
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  app.get(BROWSER_PROFILES, (c) => profilesRoute(c))
  app.post(BROWSER_OPEN, (c) => openRoute(c, ctx))
  app.post(BROWSER_CLOSE, (c) => closeRoute(c))
  app.get(BROWSER_TABS, (c) => tabsRoute(c, ctx))
  app.post(BROWSER_PAGE, (c) => newPageRoute(c, ctx))
  app.post(BROWSER_PAGE_CLOSE, (c) => closePageRoute(c, ctx))
  app.get(BROWSER_PREVIEW, (c) => previewRoute(c, ctx))

  // The Browser card's stream: frames only, at most ~5 a second, shared with the pane's live view; nothing the card sends is read.
  ctx.wsRoute<PreviewData>(BROWSER_PREVIEW_STREAM, {
    accept: (req) => acceptPreview(req, ctx),
    open: openPreview,
    message() {
      // Input is never forwarded from the card.
    },
    close(ws) {
      previews.get(ws)?.()
      previews.delete(ws)
    },
  })

  ctx.wsRoute<LiveData>(BROWSER_LIVE, {
    accept: (req) => acceptLive(req, ctx),
    open: openLive,
    message: (ws, _data, message) => liveMessage(ws, message),
    close(ws) {
      sessions.get(ws)?.close()
      sessions.delete(ws)
    },
  })
}
