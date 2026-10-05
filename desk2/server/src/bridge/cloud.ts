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
  instance_num?: number | null
  effort?: string | null
  /** Claude Code's project folder name: the slug of the folder the session started in (projectSlug). */
  project?: string
}

/** Claude Code's project folder name for a working folder: every character but a letter or digit becomes '-'. */
const projectSlug = (dir: string): string => dir.replace(/[^a-zA-Z0-9]/g, '-')

/** The folder above `dir`, a root keeping its separator ("D:\", "/"); null at the top. */
function parentOf(dir: string): string | null {
  const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
  if (cut < 0) return null
  const up = /[\\/]/.test(dir.slice(0, cut)) ? dir.slice(0, cut) : dir.slice(0, cut + 1)
  return up === dir ? null : up
}

/**
 * The folder a session started in. AgentHydra's `cwd` is the first folder its read of the transcript
 * meets, and it reads only the last 12 MB of a long one (AgentHydra's server/src/sessions.ts,
 * READ_WINDOW_BYTES), so a long session that went into a subfolder carries the subfolder, while Claude
 * Desktop and the desk list show a chat under the folder it started in: the cloud list put the same chat
 * in another group (owner, 2026-10-04: "why does enabling the cloud icon move things around?"). The
 * row's `project` is Claude Code's slug of that start folder: the nearest of the cwd and its parents
 * whose slug matches it is the start folder, ignoring case as Windows folders do. None matching (Claude
 * shortens and hashes a very long slug) or no project: the cwd as it is.
 */
function startFolder(cwd: string | null, project: string | null | undefined): string | null {
  if (!cwd) return null
  if (!project) return cwd
  const want = project.toLowerCase()
  for (let dir: string | null = cwd; dir; dir = parentOf(dir)) if (projectSlug(dir).toLowerCase() === want) return dir
  return cwd
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
  const last = r.cwd || null
  const cwd = startFolder(last, r.project)
  return {
    id: r.session_id,
    title: r.title,
    cwd,
    lastCwd: last !== cwd ? last : null,
    source: r.source,
    instance: r.instance ?? null,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at ?? null,
    messageCount: r.message_count ?? 0,
    dispatched: r.dispatched === true,
    archived: r.archived === true,
    fromPc: r.from_pc || null,
    model: r.model ?? null,
    effort: r.effort ?? null,
    instanceNum: typeof r.instance_num === 'number' ? r.instance_num : null,
  }
}

export function toCloudInstance(i: AhDesktopInstance): CloudInstance {
  return { name: i.name, label: i.label || i.name }
}
