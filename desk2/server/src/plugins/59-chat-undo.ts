// GET /api/chats/:id/file-undo: the files this chat changed (Edit, Write, MultiEdit) with +/- each and whether each is
// safe to put back; POST { paths }: puts the ready ones back. The truth is the chat's own transcript (chat-undo/plan.ts).
// Own page only. The chat is read from the engine's own route, as the Connections plugin does.

import { readFileSync } from 'node:fs'
import type { Hono } from 'hono'
import type { ChatUndoRequest } from '@shared/connectors'
import type { ServerContext } from '../context'
import { claudeProjectRoots, findSessionJsonl } from '../bridge/session-jsonl'
import { applyUndo, planUndo } from '../chat-undo/plan'
import { notOwnPage } from '../own-page'

const WHAT = "the chat's file undo"

export default function plugin(app: Hono, _ctx: ServerContext): void {
  /** The chat's transcript text and folder, or an { error, status }. */
  async function load(id: string): Promise<{ jsonl: string; cwd: string } | { error: string; status: 404 | 422 }> {
    const res = await app.request(`/api/chats/${encodeURIComponent(id)}`)
    if (!res.ok) return { error: 'no such chat', status: 404 }
    const chat = (await res.json()) as { cwd?: unknown; sessionId?: unknown; account?: { configDir?: unknown } }
    if (typeof chat.cwd !== 'string' || !chat.cwd) return { error: 'that chat has no folder', status: 422 }
    if (typeof chat.sessionId !== 'string') return { error: 'this chat has not run yet, so it changed nothing', status: 422 }
    const dir = typeof chat.account?.configDir === 'string' ? chat.account.configDir : null
    const file = findSessionJsonl(chat.sessionId, claudeProjectRoots(dir ? [dir] : []), chat.cwd)
    if (!file) return { error: "the chat's transcript was not found", status: 422 }
    try {
      return { jsonl: readFileSync(file, 'utf8'), cwd: chat.cwd }
    } catch {
      return { error: "the chat's transcript could not be read", status: 422 }
    }
  }

  app.get('/api/chats/:id/file-undo', async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const got = await load(c.req.param('id'))
    if ('error' in got) return c.json({ error: got.error }, got.status)
    return c.json(planUndo(got.jsonl, got.cwd))
  })

  app.post('/api/chats/:id/file-undo', async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const body = (await c.req.json().catch(() => null)) as Partial<ChatUndoRequest> | null
    const paths = Array.isArray(body?.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : []
    if (!paths.length) return c.json({ error: 'no files to undo' }, 400)
    const got = await load(c.req.param('id'))
    if ('error' in got) return c.json({ error: got.error }, got.status)
    return c.json(applyUndo(got.jsonl, got.cwd, paths))
  })
}
