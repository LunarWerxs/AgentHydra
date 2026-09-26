// server/src/chat-dossier.ts — ONE query, everything the system knows about a chat.
//
// WHY THIS EXISTS (owner ask, 2026-08-28, verbatim: "so the next time this doesn't take a
// f***ing hour to do what should have taken 3 seconds and one query"): diagnosing "what
// happened to chat X" used to mean hand-walking the stores that each hold a piece of the
// answer — the desktop metadata files (title, archive flag, lineage ids), the marks table
// (done), and the live registry (is a process hosting it right now). This joins them by ANY
// id or title fragment and returns the whole story in one response.
//
// The scan is a FRESH read of every store on purpose — no 15-second cache. A dossier is a
// diagnostic: the caller is usually asking because the world just changed, and a cached
// archive flag is exactly the lie they came here to catch. ~1300 small files, well under a
// second; this endpoint is called by a human-paced investigation, not a hot path.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { chatMatches, collectChats, type DossierChat, lineageIdsOf } from './core/chat-store-scan'
import { db } from './db'
import { readLiveRegistry } from './live-registry'

export type { DossierChat }
// The pure file-scan (which files exist, which ids each answers to) now lives in
// core/chat-store-scan.ts, side-effect-free - see that module's header for why. Re-exported here
// unchanged so every existing caller/test of this module keeps working untouched.
export { chatMatches, collectChats, lineageIdsOf }

export interface DossierMatch extends DossierChat {
  /** Every id this chat answers to — what the marks and live-registry joins run on. */
  lineageIds: string[]
  doneMark: { done: boolean; updatedAt: string } | null
  live: { pid: number; name: string; startedAt: string; cwd: string } | null
}

const iso = (ms: unknown): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null

export interface DossierDeps {
  roots?: Array<{ dir: string; label: string }>
  markFor?: (ids: string[]) => { done: boolean; updatedAt: string } | null
  liveFor?: (ids: string[], chatId?: string | null) => DossierMatch['live']
}

/** Does a live engine belong to THIS copy of the chat? A moved chat keeps its sessionId on the
 *  source and the target alike, so a sessionId match alone lit the SOURCE row with the target's
 *  engine (2026-09-26: a moved chat read `live` on its source while its only engine ran on the
 *  target, so migrate_reconcile called it "source-writing" and --finish would never settle it). The
 *  engine's hostSessionId names the desktop chat hosting it; when it is known it must match. */
export function engineHostedBy(
  host: string | undefined,
  chatId: string | null | undefined,
): boolean {
  return host === undefined || chatId == null || host === chatId
}

function defaultMarkFor(ids: string[]): { done: boolean; updatedAt: string } | null {
  for (const id of ids) {
    // sessionMarkKey stores the claude source bare and other sources prefixed; match both.
    const row = db
      .query<{ done: number; updated_at: number }, [string, string]>(
        'select done, updated_at from session_marks where session_id = ? or session_id like ?',
      )
      .get(id, `%:${id}`)
    if (row) return { done: !!row.done, updatedAt: iso(row.updated_at) ?? String(row.updated_at) }
  }
  return null
}

function defaultLiveFor(ids: string[], chatId?: string | null): DossierMatch['live'] {
  try {
    const live = readLiveRegistry(join(homedir(), '.claude'))
    const hit = live.find(
      (s) => ids.includes(s.sessionId) && engineHostedBy(s.hostSessionId, chatId),
    )
    if (!hit) return null
    return { pid: hit.pid, name: hit.name, startedAt: iso(hit.startedAt) ?? '', cwd: hit.cwd }
  } catch {
    return null
  }
}

/**
 * The one-query answer: every chat matching `q` (title fragment or any lineage id), each with
 * its archive flag as it sits ON DISK RIGHT NOW, its done-mark, and its live process if any.
 */
export function chatDossier(q: string, deps: DossierDeps = {}): { matches: DossierMatch[] } {
  const chats = collectChats(deps.roots)
  const markFor = deps.markFor ?? defaultMarkFor
  const liveFor = deps.liveFor ?? defaultLiveFor
  const matches: DossierMatch[] = []
  for (const c of chats) {
    if (!chatMatches(c, q)) continue
    const lineageIds = lineageIdsOf(c)
    matches.push({
      ...c,
      lineageIds,
      doneMark: markFor(lineageIds),
      live: liveFor(lineageIds, c.chatId),
    })
  }
  // Newest activity first — the chat being asked about is almost always the recent one.
  matches.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
  return { matches }
}

// --- listing -------------------------------------------------------------------------------
//
// WHY THIS LIVES BESIDE THE DOSSIER (2026-09-06): the dossier answers "tell me about THIS chat"
// and it was, until now, the only read of the desktop chat store that a caller could reach.
// "What chats does this account hold?" had no answer at all. list_sessions could be pointed at
// an instance, but it returns the full 27-field session row per chat — 117KB for a 206-chat
// account, refused by an agent's token cap before a single row was read — and the only cheap
// count available was move_chats(dry_run), a MUTATING tool used as a read. So a migration began
// by hand-globbing the private store, and hand-globbing is exactly how the isArchived/archived
// mismatch above produced a confidently wrong answer.
//
// It reuses collectChats/chatMatches rather than re-walking the store: one owner of that read.

/** One chat, in the smallest shape that still answers "should I move this one?". */
export interface ChatListRow {
  instance: string
  chatId: string | null
  sessionId: string | null
  title: string | null
  /** Both names, for the reason spelled out on DossierChat.isArchived. */
  archived: boolean
  isArchived: boolean
  lastActivityAt: string | null
  cwd: string | null
  /** The chat's effort level and ultracode flag as its record holds them (DossierChat). */
  effort: string | null
  ultracode: boolean | null
  /** An engine process is hosting this chat RIGHT NOW — the one thing that decides whether a
   *  move will be refused, and the reason a caller had to attempt the move to find out. */
  live: boolean
  livePid: number | null
  /** AgentHydra's own done-mark on any id in this chat's lineage: handed off or already
   *  migrated. The migrate route refuses a done chat as superseded, so a move planned from this
   *  list leaves these out rather than collecting a column of refusals. */
  done: boolean
  /** ⛔ ON DISK, NOT IN THE APP: filed under an account this profile is no longer signed into,
   *  so the desktop app does not show it (see DossierChat.staleLogin). Null = the signed-in
   *  account is unknown. A move to this same instance RE-HOMES such a chat into the signed-in
   *  account's folder instead of answering "already lives here". */
  staleLogin: boolean | null
}

export interface ChatListResult {
  rows: ChatListRow[]
  /** Chats matching the filter BEFORE limit/offset — so a capped page never reads as the whole set. */
  total: number
  /** The whole account, unfiltered by archive scope: the "how big is this thing" answer. */
  counts: {
    all: number
    unarchived: number
    archived: number
    live: number
    /** Unarchived chats filed under an account the profile is no longer signed into: present on
     *  disk, INVISIBLE in the app. Anything above zero is chats the owner has lost sight of. */
    staleLogin: number
  }
  /** Every instance label the scan saw, so a mistyped `instance` is obvious rather than empty. */
  instances: string[]
}

export interface ListChatsOptions {
  /** Directory label(s) of the desktop instance(s) to list. Omit for every instance. */
  instances?: string[]
  /** 'hide' (default) drops archived chats, 'only' keeps just those, 'include' keeps both. */
  archived?: 'hide' | 'include' | 'only'
  /** Optional title / id fragment, matched exactly as the dossier matches. */
  q?: string
  limit?: number
  offset?: number
}

/**
 * Every id each LIVE engine's chat answers to, keyed by the engine's own session id
 * (2026-09-17). The orchestrator reads liveness for the whole fleet in one call, and a bare
 * session id is not enough for that: a chat that rolled its cli id has an old transcript row
 * under the OLD id while its engine runs under the NEW one, so the old row read as "not live"
 * unless something walked the lineage. This is that walk, done once on the side that owns the
 * chat store, with the same rule the dossier's `live` field uses - a chat is live when any id
 * in its lineage is a registered engine - so the two answers cannot disagree.
 *
 * Archived chats are included on purpose: an extra alias can only make a row read MORE live,
 * never less, and "not live" is the verdict that lets something act on a chat.
 */
export function liveLineage(
  liveSessionIds: string[],
  chats: DossierChat[] = collectChats(),
): Map<string, string[]> {
  const live = new Set(liveSessionIds)
  const out = new Map<string, Set<string>>()
  for (const id of live) out.set(id, new Set([id]))
  for (const c of chats) {
    const ids = lineageIdsOf(c)
    for (const id of ids) {
      if (!live.has(id)) continue
      const aliases = out.get(id)
      for (const alias of ids) aliases?.add(alias)
    }
  }
  return new Map([...out].map(([id, aliases]) => [id, [...aliases]]))
}

/** Session ids with a live engine, read ONCE. The dossier's per-chat liveFor re-reads the
 *  registry for every chat it returns, which is right for one chat and quadratic for 206. */
function liveIndex(): { pids: Map<string, number>; hosts: Map<string, string> } {
  const pids = new Map<string, number>()
  const hosts = new Map<string, string>()
  try {
    for (const s of readLiveRegistry(join(homedir(), '.claude'))) {
      pids.set(s.sessionId, s.pid)
      if (s.hostSessionId) hosts.set(s.sessionId, s.hostSessionId)
    }
  } catch {
    /* no registry: every chat reports live:false, which is what "unknown" already looked like */
  }
  return { pids, hosts }
}

export function listChats(
  opts: ListChatsOptions = {},
  deps: DossierDeps & { liveIds?: Map<string, number>; liveHosts?: Map<string, string> } = {},
): ChatListResult {
  const chats = collectChats(deps.roots)
  const index = deps.liveIds ? null : liveIndex()
  const live = deps.liveIds ?? index?.pids ?? new Map<string, number>()
  const hosts = deps.liveHosts ?? index?.hosts ?? new Map<string, string>()
  const livePidOf = (c: DossierChat): number | undefined =>
    lineageIdsOf(c)
      .map((id) => (engineHostedBy(hosts.get(id), c.chatId) ? live.get(id) : undefined))
      .find((p) => p !== undefined)
  const markFor = deps.markFor ?? defaultMarkFor
  const scope = opts.archived ?? 'hide'
  const wanted = opts.instances?.length ? new Set(opts.instances) : null
  const q = opts.q?.trim()

  const instances = [...new Set(chats.map((c) => c.instance))].sort()
  const scoped = wanted ? chats.filter((c) => wanted.has(c.instance)) : chats
  // The counts describe the SCOPED account in full — they are deliberately not narrowed by the
  // archive scope or by `q`, because "206 total, 1 unarchived" is the answer that stops a caller
  // reading "1 row" as "this account is empty".
  const counts = {
    all: scoped.length,
    unarchived: scoped.filter((c) => !c.isArchived).length,
    archived: scoped.filter((c) => c.isArchived).length,
    live: scoped.filter((c) => livePidOf(c) !== undefined).length,
    staleLogin: scoped.filter((c) => !c.isArchived && c.staleLogin === true).length,
  }

  const matched = scoped
    .filter((c) => (scope === 'hide' ? !c.isArchived : scope === 'only' ? c.isArchived : true))
    .filter((c) => !q || chatMatches(c, q))
    // Newest first, with an UNDATED chat last rather than first. The dossier sorts on
    // (x ?? ''), which is right there - it returns the handful of chats matching one query -
    // and wrong for a list, where an empty string beats every real ISO timestamp and would
    // put the chats we know least about at the top of the page a caller reads first.
    .sort((a, b) => {
      const at = a.lastActivityAt
      const bt = b.lastActivityAt
      if (at === bt) return 0
      if (!at) return 1
      if (!bt) return -1
      return bt.localeCompare(at)
    })

  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000))
  const rows = matched.slice(offset, offset + limit).map((c): ChatListRow => {
    const lineage = lineageIdsOf(c)
    const pid = livePidOf(c)
    return {
      instance: c.instance,
      chatId: c.chatId,
      sessionId: c.cliSessionId,
      title: c.title,
      archived: c.archived,
      isArchived: c.isArchived,
      lastActivityAt: c.lastActivityAt,
      cwd: c.cwd,
      effort: c.effort,
      ultracode: c.ultracode,
      live: pid !== undefined,
      livePid: pid ?? null,
      done: markFor(lineage)?.done === true,
      staleLogin: c.staleLogin,
    }
  })

  return { rows, total: matched.length, counts, instances }
}
