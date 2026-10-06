// The browser pane's side of Desk 2 (contract: shared/browser.ts): the saved Chrome browsers of a chat's workspace
// (the Connections MCP's browser profile store, read only), one profile's Chrome started when none runs, and a live
// view of one of its pages over a websocket. The store reader is browser/store.ts, Chrome's protocol browser/cdp.ts.
//
// Every route and the websocket upgrade is for Desk 2's own page only (browser/guard.ts), after Desk's localOnly
// guard. A request names a profile, never a port: the port comes from that profile folder's DevToolsActivePort.

import type { Hono } from 'hono'
import { BROWSER_LIVE, BROWSER_OPEN, BROWSER_PREVIEW, BROWSER_PROFILES, BROWSER_TABS, type BrowserOpened } from '@shared/browser'
import { capturePreview, firstTab, LaunchError, launchChrome, LiveSession, pageTabs, parseLiveIn } from '../browser/cdp'
import { notOwnPage } from '../browser/guard'
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
      const tab = await LiveSession.pick(ref.port, null)
      if (!tab) return c.json({ error: `'${profile}' has no page open` }, 404)
      const jpeg = await capturePreview(ref.port, tab.id)
      return new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } })
    } catch {
      return c.json({ error: `'${profile}' did not answer` }, 502)
    }
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
      return { data: { port: ref.port, tab } }
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
