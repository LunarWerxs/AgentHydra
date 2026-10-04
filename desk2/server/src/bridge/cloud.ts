// Hydra Desk 2's cloud list: AgentHydra's whole session list (GET /api/sessions), the one its Sessions
// tab shows, with the PC each chat came from. The chat sync (AgentHydra core/desktop-chat-sync.ts) copies
// the other PC's Desktop chats here and AgentHydra marks them `from_pc`; every other row is this PC's.

import type { CloudInstance, CloudSession } from '@shared/protocol'
import type { AhDesktopInstance } from './client'

/** The list scopes passed through to AgentHydra, in its own spelling (web/src/lib/api.ts getSessions). */
export const CLOUD_SCOPES = ['period', 'source', 'instance', 'archived', 'dispatched', 'ratelimited', 'othersPass', 'title'] as const
/** AgentHydra caps one page at 500. */
export const CLOUD_LIMIT = 500
/** A wide list over a big store takes AgentHydra a few seconds. */
export const CLOUD_TIMEOUT_MS = 20_000

/** The fields of an AgentHydra session row the cloud list reads. */
export interface AhCloudRow {
  session_id: string
  title: string
  cwd: string | null
  source: string
  instance: string | null
  last_activity_at: number
  created_at: number | null
  message_count: number
  dispatched?: boolean
  archived?: boolean
  from_pc?: string
  model?: string | null
}

/** AgentHydra's query string for the scopes the window asked for; anything else it sent is dropped. */
export function cloudQuery(asked: (key: string) => string | undefined): string {
  const q = new URLSearchParams({ limit: String(CLOUD_LIMIT) })
  for (const key of CLOUD_SCOPES) {
    const v = asked(key)
    if (v) q.set(key, v)
  }
  if (!q.has('period')) q.set('period', '24h')
  return q.toString()
}

export function toCloudSession(r: AhCloudRow): CloudSession {
  return {
    id: r.session_id,
    title: r.title,
    cwd: r.cwd || null,
    source: r.source,
    instance: r.instance ?? null,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at ?? null,
    messageCount: r.message_count ?? 0,
    dispatched: r.dispatched === true,
    archived: r.archived === true,
    fromPc: r.from_pc || null,
    model: r.model ?? null,
  }
}

export function toCloudInstance(i: AhDesktopInstance): CloudInstance {
  return { name: i.name, label: i.label || i.name }
}
