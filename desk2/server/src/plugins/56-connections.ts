// The Connections chip's side of Desk 2 (contract: shared/connectors.ts, "The Connections chip"): which Connections
// workspace a chat's Connections tools act as, the workspaces to pick from, switching it, and starting the browser
// sign-in. It asks the person's own Connections MCP server (connectors/connections-client.ts) through its local
// tools: connections_whoami, connections_list_companies, connections_use_workspace (this chat alone, keyed by the
// chat's Claude session id), connections_switch_workspace (the whole folder) and connections_signin.
//
// A chat's workspace is read from whoami: its `chatPin` when the chat has one (scope 'chat'), else the folder's
// company (scope 'folder'), else null. Reads are cached 30 s per chat and dropped by a switch. Answers are never
// logged; only the few fields the page needs leave this file. Desk's localOnly guard runs first on every route and
// each route is for Desk 2's own page only (own-page.ts).
// Numbered 56 so it registers before 57-connectors, whose POST /api/connectors/:id/:action would otherwise answer
// these POST routes ("no action switch") first.
// ctx.deps may carry `connections` (a ConnectionsClient over a fake loader) and `mainClaudeJson` (the config to read).

import type { Hono } from 'hono'
import {
  CONNECTIONS_COMPANIES,
  CONNECTIONS_SIGNIN,
  CONNECTIONS_SWITCH,
  CONNECTIONS_WORKSPACE,
  type ConnectionsCompany,
  type ConnectionsSignin,
  type ConnectionsSwitch,
  type ConnectionsWorkspace
} from '@shared/connectors'
import { notOwnPage } from '../own-page'
import { ConnectionsClient, type CallTarget, ConnectionsError, jsonAnswer } from '../connectors/connections-client'
import type { ServerContext } from '../context'
import { mainConfigFile } from '../engine/chat-runtime'

export const CACHE_MS = 30_000

class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 502 | 503,
    message: string
  ) {
    super(message)
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** A company as the chip shows it, from a whoami or list entry; null when it has no usable id and name. */
export function companyOf(v: unknown): ConnectionsCompany | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const projectId = str(o.projectId) ?? undefined
  const companyId = str(o.companyId) ?? projectId ?? null
  const name = str(o.name)
  if (!companyId || !name) return null
  return projectId ? { companyId, projectId, name } : { companyId, name }
}

/** The workspace a whoami answer says the chat acts as. A signed-out machine answers in words, not JSON. */
export function workspaceOf(answer: string): ConnectionsWorkspace {
  const j = jsonAnswer(answer)
  const identity = j?.identity as { signedIn?: unknown } | undefined
  if (!j || identity?.signedIn !== true) return { signedIn: false, company: null, scope: null }
  const pin = companyOf(j.chatPin ?? j.pinnedForThisChat)
  if (pin) return { signedIn: true, company: pin, scope: 'chat' }
  const folder = companyOf(j.company)
  return { signedIn: true, company: folder, scope: folder ? 'folder' : null }
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const client =
    (ctx.deps.connections as ConnectionsClient | undefined) ??
    new ConnectionsClient(mainConfigFile(ctx.deps.mainClaudeJson as string | null | undefined, ctx.deps.agentHydraMcp))
  ctx.onStop(() => client.closeAll())
  const cache = new Map<string, { at: number; value: ConnectionsWorkspace }>()

  /** The chat's folder and Claude session id, asked of the engine's own route. */
  async function target(chat: string): Promise<CallTarget> {
    const res = await app.request(`/api/chats/${encodeURIComponent(chat)}`)
    if (!res.ok) throw new HttpError(404, 'no such chat')
    const c = (await res.json()) as { cwd?: unknown; sessionId?: unknown }
    const cwd = str(c.cwd)
    if (!cwd) throw new HttpError(404, 'that chat has no folder')
    return { cwd, sessionId: str(c.sessionId) }
  }

  const workspace = async (chat: string, fresh = false): Promise<ConnectionsWorkspace> => {
    const hit = cache.get(chat)
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value
    const value = workspaceOf(await client.call(await target(chat), 'connections_whoami'))
    cache.set(chat, { at: Date.now(), value })
    return value
  }

  /** Runs a route body: refuses another page, answers an HttpError as its status, a dead server as 503. */
  const route = (run: (req: Request, query: (k: string) => string | undefined) => Promise<unknown>) => async (c: import('hono').Context) => {
    const why = notOwnPage(c.req.raw.headers, "the Connections chip's API")
    if (why) return c.json({ error: why }, 403)
    if (!client.available()) return c.json({ error: 'Connections is not installed on this machine' }, 503)
    try {
      return c.json((await run(c.req.raw, (k) => c.req.query(k))) as object)
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
      if (err instanceof ConnectionsError) return c.json({ error: err.message }, 503)
      throw err
    }
  }

  app.get(
    CONNECTIONS_WORKSPACE,
    route(async (_req, q) => {
      const chat = q('chat')
      if (!chat) throw new HttpError(400, 'chat required')
      return workspace(chat)
    })
  )

  app.get(
    CONNECTIONS_COMPANIES,
    route(async (_req, q) => {
      const chat = q('chat')
      // Any folder will do for the list; the chat's own is used when the page names it.
      const t = chat ? await target(chat) : { cwd: process.cwd(), sessionId: null }
      const j = jsonAnswer(await client.call(t, 'connections_list_companies'))
      const list = Array.isArray(j?.companies) ? j.companies : []
      return { companies: list.map(companyOf).filter((c): c is ConnectionsCompany => c !== null) }
    })
  )

  app.post(
    CONNECTIONS_SWITCH,
    route(async (req) => {
      const b = (await req.json().catch(() => null)) as Partial<ConnectionsSwitch> | null
      const chat = str(b?.chat)
      if (!chat || (b?.scope !== 'chat' && b?.scope !== 'folder') || (b.company !== null && !str(b.company))) throw new HttpError(400, 'chat, company and scope required')
      const t = await target(chat)
      if (b.scope === 'chat') {
        if (!t.sessionId) throw new HttpError(409, "this chat has no Claude session yet: send a message first, or switch the whole folder's workspace instead")
        await client.call(t, 'connections_use_workspace', b.company === null ? { clear: true } : { company: b.company })
      } else {
        if (b.company === null) throw new HttpError(400, "a folder's workspace cannot be cleared here: pick one, or switch this chat alone")
        await client.call(t, 'connections_switch_workspace', { company: b.company, remember: false })
      }
      cache.delete(chat)
      // Folder switches move every chat of the folder: their cached answers are as old as this one.
      if (b.scope === 'folder') for (const k of [...cache.keys()]) cache.delete(k)
      const now = await workspace(chat, true)
      // The tools answer a refusal in words, so what the chat acts as now is the proof the switch took.
      const want = b.company
      const took = want === null ? now.scope !== 'chat' : now.company !== null && [now.company.companyId, now.company.projectId, now.company.name].includes(want)
      if (!took) throw new HttpError(502, 'Connections did not switch the workspace')
      return now
    })
  )

  app.post(
    CONNECTIONS_SIGNIN,
    route(async (req) => {
      const chat = str(((await req.json().catch(() => null)) as { chat?: unknown } | null)?.chat)
      const t = chat ? await target(chat) : { cwd: process.cwd(), sessionId: null }
      const text = await client.call(t, 'connections_signin')
      cache.clear()
      const url = text.match(/https?:\/\/[^\s)"'<>]+/)?.[0] ?? null
      const out: ConnectionsSignin = { url, opened: url !== null && /also opened it|opened it for you/i.test(text), signedIn: url === null && /already signed in|signed in/i.test(text) }
      return out
    })
  )
}
