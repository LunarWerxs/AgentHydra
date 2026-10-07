// The browser pane's side of Desk 2 (contract: shared/browser.ts): the saved Chrome browsers of a chat's workspace
// (the Connections MCP's browser profile store, read only), one profile's Chrome started when none runs, and a live
// view of one of its pages over a websocket. The store reader is browser/store.ts, Chrome's protocol browser/cdp.ts.
//
// Every route and the websocket upgrade is for Desk 2's own page only (browser/guard.ts), after Desk's localOnly
// guard. A request names a profile, never a port: the port comes from that profile folder's DevToolsActivePort.

import type { Context, Hono } from 'hono'
import { BROWSER_CLOSE, BROWSER_LIVE, BROWSER_OPEN, BROWSER_PAGE, BROWSER_PAGE_CLOSE, BROWSER_PREVIEW, BROWSER_PREVIEW_STREAM, BROWSER_PROFILES, BROWSER_TABS, type BrowserOpened, type BrowserPreviewOut } from '@shared/browser'
import { capturePreview, closeBrowser, closePage, firstTab, LaunchError, launchChrome, liveFrame, LiveSession, newPage, pageTabs, parseLiveIn } from '../browser/cdp'
import { notOwnPage } from '../browser/guard'
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
  tab: { id: string; url: string; title: string }
  /** The socket asked for one page (?tab=): it follows no other. */
  bound: boolean
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const sessions = new WeakMap<object, LiveSession>()

  app.get(BROWSER_PROFILES, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    const cwd = c.req.query('cwd')
    if (!cwd) return c.json({ error: 'cwd required' }, 400)
    return c.json((await listProfiles(cwd)).result)
  })

  app.post(BROWSER_OPEN, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; profile?: unknown; url?: unknown; login?: unknown } | null
    if (typeof body?.cwd !== 'string' || body.cwd === '' || typeof body.profile !== 'string' || body.profile === '')
      return c.json({ error: 'cwd and profile required' }, 400)
    const url = typeof body.url === 'string' && body.url !== '' ? body.url : undefined
    if (url !== undefined) {
      let ok = false
      try {
        const u = new URL(url)
        ok = u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        // floor-ok: not a URL, refused below
      }
      if (!ok) return c.json({ error: 'url must be http or https' }, 400)
    }
    const ref = await usable(body.cwd, body.profile)
    if (!ref) return c.json({ error: `no browser '${body.profile}' for this chat's workspace` }, 404)
    if (ref.port !== null) {
      const tab = (await pageTabs(ref.port).catch(() => []))[0] ?? null
      const opened: BrowserOpened = { profile: ref.profile.name, started: false, tab }
      return c.json(opened)
    }
    // An unowned profile is only for use while it is open somewhere; it is not started from here.
    if (!ref.profile.own) return c.json({ error: `'${body.profile}' belongs to no workspace and is not open` }, 404)
    try {
      const login = body.login === true
      const port = await launchChrome(ref.dir, url, login)
      const opened: BrowserOpened = { profile: ref.profile.name, started: true, tab: port === null ? null : await firstTab(port) }
      return c.json(opened)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, err instanceof LaunchError ? 503 : 500)
    }
  })

  // Closing a saved browser's pane tab closes its Chrome: the Browser cards then read the profile as not open and stop.
  app.post(BROWSER_CLOSE, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; profile?: unknown } | null
    if (typeof body?.cwd !== 'string' || body.cwd === '' || typeof body.profile !== 'string' || body.profile === '')
      return c.json({ error: 'cwd and profile required' }, 400)
    const ref = await usable(body.cwd, body.profile)
    if (!ref) return c.json({ error: `no browser '${body.profile}' for this chat's workspace` }, 404)
    if (!ref.profile.own) return c.json({ error: `'${body.profile}' belongs to no workspace` }, 404)
    try {
      return c.json({ closed: ref.port !== null && (await closeBrowser(ref.dir)) })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  app.get(BROWSER_TABS, async (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    const cwd = c.req.query('cwd')
    const profile = c.req.query('profile')
    if (!cwd || !profile) return c.json({ error: 'cwd and profile required' }, 400)
    const ref = await usable(cwd, profile)
    if (!ref) return c.json({ error: `no browser '${profile}' for this chat's workspace` }, 404)
    if (ref.port === null) return c.json({ error: `'${profile}' is not open` }, 409)
    try {
      return c.json(await pageTabs(ref.port))
    } catch {
      return c.json({ error: `'${profile}' did not answer` }, 502)
    }
  })

  // One page of an open profile: a new one opened at an address, or one closed. Neither touches the other pages or the Chrome.
  const pageRoute = async (c: Context, need: 'url' | 'tab') => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return { fail: c.json({ error: why }, 403) }
    const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; profile?: unknown; url?: unknown; tab?: unknown } | null
    const arg = body?.[need]
    if (typeof body?.cwd !== 'string' || body.cwd === '' || typeof body.profile !== 'string' || body.profile === '' || typeof arg !== 'string' || arg === '')
      return { fail: c.json({ error: `cwd, profile and ${need} required` }, 400) }
    const ref = await usable(body.cwd, body.profile)
    if (!ref) return { fail: c.json({ error: `no browser '${body.profile}' for this chat's workspace` }, 404) }
    if (ref.port === null) return { fail: c.json({ error: `'${body.profile}' is not open` }, 409) }
    return { port: ref.port, arg }
  }
  app.post(BROWSER_PAGE, async (c) => {
    const r = await pageRoute(c, 'url')
    if (r.fail) return r.fail
    let ok = false
    try {
      const u = new URL(r.arg)
      ok = u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      // floor-ok: not a URL, refused below
    }
    if (!ok) return c.json({ error: 'url must be http or https' }, 400)
    try {
      const tab = await newPage(r.port, r.arg)
      return tab ? c.json(tab) : c.json({ error: 'the browser did not open a page' }, 502)
    } catch {
      return c.json({ error: 'the browser did not answer' }, 502)
    }
  })
  app.post(BROWSER_PAGE_CLOSE, async (c) => {
    const r = await pageRoute(c, 'tab')
    if (r.fail) return r.fail
    try {
      return c.json({ closed: await closePage(r.port, r.arg) })
    } catch {
      return c.json({ error: 'the browser did not answer' }, 502)
    }
  })

  // A small JPEG of what the profile's page shows now (the transcript Browser card's live preview). Never starts a Chrome.
  app.get(BROWSER_PREVIEW, async (c) => {
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
      const frame = liveFrame(ref.port)
      if (frame) return new Response(new Uint8Array(frame), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } })
      const tab = await LiveSession.pick(ref.port, null)
      if (!tab) return c.json({ error: `'${profile}' has no page open` }, 404)
      const jpeg = await capturePreview(ref.port, tab.id)
      return new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } })
    } catch {
      return c.json({ error: `'${profile}' did not answer` }, 502)
    }
  })

  // The Browser card's stream: frames only, at most ~5 a second, shared with the pane's live view; nothing the card sends is read.
  const previews = new WeakMap<object, () => void>()
  ctx.wsRoute<{ port: number }>(BROWSER_PREVIEW_STREAM, {
    async accept(req) {
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
      return { data: { port: ref.port } }
    },
    open(ws, data) {
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
        }),
      )
    },
    message() {
      // Input is never forwarded from the card.
    },
    close(ws) {
      previews.get(ws)?.()
      previews.delete(ws)
    },
  })

  ctx.wsRoute<LiveData>(BROWSER_LIVE, {
    async accept(req) {
      const why = notOwnPage(req.headers)
      if (why) return Response.json({ error: why }, { status: 403 })
      const q = new URL(req.url).searchParams
      const cwd = q.get('cwd')
      const profile = q.get('profile')
      if (!cwd || !profile) return Response.json({ error: 'cwd and profile required' }, { status: 400 })
      const ref = await usable(cwd, profile)
      if (!ref) return Response.json({ error: `no browser '${profile}' for this chat's workspace` }, { status: 404 })
      if (ref.port === null) return Response.json({ error: `'${profile}' is not open` }, { status: 409 })
      const tab = await LiveSession.pick(ref.port, q.get('tab')).catch(() => null)
      if (!tab) return Response.json({ error: 'that page is not open' }, { status: 404 })
      return { data: { port: ref.port, tab, bound: !!q.get('tab') } }
    },
    open(ws, data) {
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
      )
      sessions.set(ws, session)
      session.start(data.tab).catch(() => {
        ws.send(JSON.stringify({ type: 'closed', reason: 'the page could not be shown' }))
        ws.close()
      })
    },
    message(ws, _data, message) {
      const msg = typeof message === 'string' ? parseLiveIn(message) : null
      if (msg) sessions.get(ws)?.input(msg).catch(() => {
        // floor-ok: input to a page that just went away is dropped
      })
    },
    close(ws) {
      sessions.get(ws)?.close()
      sessions.delete(ws)
    },
  })
}
