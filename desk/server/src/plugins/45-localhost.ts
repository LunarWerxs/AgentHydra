// The globe button's routes (SPEC "Localhost"): GET /api/localhost lists the dev servers on this machine and
// what the chat's folder can start; POST /api/localhost/start|stop|restart and GET /api/localhost/log drive
// the ones Desk or DevWebUI manage. Behind the server's loopback guard like every route.

import type { Context, Hono } from 'hono'
import type { ServerContext } from '../context'
import { ChatStore } from '../engine/store'
import { checkCwd, ChatError } from '../engine/chat-manager'
import { checkLocalPath } from '../engine/reveal'
import { RecentFolders } from '../folders/recent'
import { join } from 'node:path'
import { Localhost, NotFound, StopRefused, type LocalhostDeps } from '../localhost'

function folderParam(raw: unknown, required: boolean): string | null {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ChatError(400, 'folder is required')
    return null
  }
  if (typeof raw !== 'string') throw new ChatError(400, 'folder must be a string')
  checkLocalPath(raw, 'folder')
  return checkCwd(raw)
}

function answer(c: Context, run: () => Promise<unknown>): Promise<Response> {
  return run().then(
    (value) => c.json(value as object),
    (err) => {
      if (err instanceof ChatError) return c.json({ error: err.message }, err.status)
      if (err instanceof StopRefused) return c.json({ error: err.message }, 409)
      if (err instanceof NotFound) return c.json({ error: err.message }, 404)
      throw err
    },
  )
}

async function json(c: Context): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw new ChatError(400, 'the body must be JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatError(400, 'the body must be a JSON object')
  return body as Record<string, unknown>
}

function idParam(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[\w:.-]{1,140}$/.test(raw)) throw new ChatError(400, 'id is required')
  return raw
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const deps = (ctx.deps.localhost as LocalhostDeps | undefined) ?? {}
  const knownFolders = () => {
    try {
      const chats = new ChatStore(ctx.home).loadChats()
      return [...new Set([...chats.map((c) => c.cwd), ...new RecentFolders(join(ctx.home, 'folders.json')).list(chats)])]
    } catch {
      return []
    }
  }
  const lh = new Localhost(ctx.home, { knownFolders, ...deps })

  app.get('/api/localhost', (c) => answer(c, () => lh.state(folderParam(c.req.query('folder'), false), c.req.query('all') === '1')))

  app.post('/api/localhost/start', (c) =>
    answer(c, async () => {
      const b = await json(c)
      return lh.start(folderParam(b.folder, true)!, idParam(b.id))
    }),
  )

  app.post('/api/localhost/stop', (c) =>
    answer(c, async () => {
      const b = await json(c)
      if (typeof b.pid === 'number' && Number.isInteger(b.pid)) return lh.stop({ pid: b.pid })
      const id = idParam(b.id)
      return lh.stop({ folder: id.startsWith('devwebui:') ? undefined : folderParam(b.folder, true)!, id })
    }),
  )

  app.post('/api/localhost/restart', (c) =>
    answer(c, async () => {
      const b = await json(c)
      const id = idParam(b.id)
      return lh.restart(id.startsWith('devwebui:') ? '' : folderParam(b.folder, true)!, id)
    }),
  )

  app.get('/api/localhost/log', (c) =>
    answer(c, async () => {
      const id = idParam(c.req.query('id'))
      const lines = Math.min(400, Math.max(1, Number(c.req.query('lines')) || 80))
      return lh.log(id.startsWith('devwebui:') ? '' : folderParam(c.req.query('folder'), true)!, id, lines)
    }),
  )
}
