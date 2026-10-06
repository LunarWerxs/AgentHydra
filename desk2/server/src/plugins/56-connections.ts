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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import {
  CONNECTIONS_COMPANIES,
  CONNECTIONS_DEFAULT,
  CONNECTIONS_SIGNIN,
  CONNECTIONS_SWITCH,
  CONNECTIONS_WORKSPACE,
  type ConnectionsCompany,
  type ConnectionsDefaultSet,
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
  if (!j || identity?.signedIn !== true) return { signedIn: false, company: null, scope: null, bypassPermissions: null }
  const bypassPermissions = typeof j.bypassPermissions === 'boolean' ? j.bypassPermissions : null
  const pin = companyOf(j.chatPin ?? j.pinnedForThisChat)
  if (pin) return { signedIn: true, company: pin, scope: 'chat', bypassPermissions }
  const folder = companyOf(j.company)
  return { signedIn: true, company: folder, scope: folder ? 'folder' : null, bypassPermissions }
}

/** One folder's default for new chats: the workspace, when it was set, and the sessions it has already been applied to (or skipped). */
export interface FolderDefault {
  companyId: string
  name: string
  setAt: number
  applied: string[]
}

export const folderKey = (cwd: string): string => cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Desk's own per-folder default workspaces: <home>/connections-defaults.json, { [folderKey]: FolderDefault }. */
export class DefaultsStore {
  private data: Record<string, FolderDefault> = {}
  constructor(private file: string) {
    try {
      if (existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8')) ?? {}
    } catch {
      this.data = {}
    }
  }
  get(cwd: string): FolderDefault | null {
    return this.data[folderKey(cwd)] ?? null
  }
  set(cwd: string, company: ConnectionsCompany, now = Date.now()): void {
    this.data[folderKey(cwd)] = { companyId: company.companyId, name: company.name, setAt: now, applied: [] }
    this.save()
  }
  clear(cwd: string): void {
    delete this.data[folderKey(cwd)]
    this.save()
  }
  markApplied(cwd: string, sessionId: string): void {
    const d = this.get(cwd)
    if (!d || d.applied.includes(sessionId)) return
    d.applied.push(sessionId)
    this.save()
  }
  private save(): void {
    mkdirSync(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`)
    renameSync(tmp, this.file)
  }
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const client =
    (ctx.deps.connections as ConnectionsClient | undefined) ??
    new ConnectionsClient(mainConfigFile(ctx.deps.mainClaudeJson as string | null | undefined, ctx.deps.agentHydraMcp))
  ctx.onStop(() => client.closeAll())
  const defaults = new DefaultsStore(join(ctx.home, 'connections-defaults.json'))
  const cache = new Map<string, { at: number; value: ConnectionsWorkspace }>()

  /** The chat's folder, Claude session id and creation time, asked of the engine's own route. */
  async function target(chat: string): Promise<CallTarget & { createdAt: number | null }> {
    const res = await app.request(`/api/chats/${encodeURIComponent(chat)}`)
    if (!res.ok) throw new HttpError(404, 'no such chat')
    const c = (await res.json()) as { cwd?: unknown; sessionId?: unknown; createdAt?: unknown }
    const cwd = str(c.cwd)
    if (!cwd) throw new HttpError(404, 'that chat has no folder')
    return { cwd, sessionId: str(c.sessionId), createdAt: typeof c.createdAt === 'number' ? c.createdAt : null }
  }

  /**
   * The folder's default for new chats, applied once: a chat created after the default was set is pinned to it the first
   * time it is read with a session id, unless it already has a pin. Either way the session is recorded, so a later change
   * by hand (even clearing the pin) is never overridden, and chats older than the default are never touched.
   */
  async function applyDefault(t: Awaited<ReturnType<typeof target>>, seen: ConnectionsWorkspace): Promise<ConnectionsWorkspace> {
    const d = defaults.get(t.cwd)
    if (!d || !t.sessionId || !seen.signedIn || t.createdAt === null || t.createdAt <= d.setAt || d.applied.includes(t.sessionId)) return seen
    defaults.markApplied(t.cwd, t.sessionId)
    if (seen.scope === 'chat') return seen
    try {
      await client.call(t, 'connections_use_workspace', { company: d.companyId })
    } catch {
      return seen
    }
    return workspaceOf(await client.call(t, 'connections_whoami'))
  }

  /** What the page gets: the cached whoami reading with the folder's default laid over it (that changes without a re-read). */
  const withDefault = (value: ConnectionsWorkspace, cwd: string): ConnectionsWorkspace => {
    const d = defaults.get(cwd)
    return d ? { ...value, defaultCompanyId: d.companyId } : value
  }

  const workspace = async (chat: string, fresh = false): Promise<ConnectionsWorkspace> => {
    const t = await target(chat)
    const hit = cache.get(chat)
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return withDefault(hit.value, t.cwd)
    const value = await applyDefault(t, workspaceOf(await client.call(t, 'connections_whoami')))
    cache.set(chat, { at: Date.now(), value })
    return withDefault(value, t.cwd)
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
    CONNECTIONS_DEFAULT,
    route(async (req) => {
      const b = (await req.json().catch(() => null)) as Partial<ConnectionsDefaultSet> | null
      const chat = str(b?.chat)
      if (!chat || (b?.company !== null && !str(b?.company))) throw new HttpError(400, 'chat and company required')
      const t = await target(chat)
      if (b?.company === null) defaults.clear(t.cwd)
      else {
        const list = jsonAnswer(await client.call(t, 'connections_list_companies'))
        const all = (Array.isArray(list?.companies) ? list.companies : []).map(companyOf).filter((c): c is ConnectionsCompany => c !== null)
        const want = b?.company as string
        const found = all.find((c) => [c.companyId, c.projectId, c.name].includes(want))
        if (!found) throw new HttpError(404, 'no such workspace')
        defaults.set(t.cwd, found)
      }
      // Only the default changed: no chat's pin or folder binding was written.
      return workspace(chat)
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
