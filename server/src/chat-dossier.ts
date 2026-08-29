// server/src/chat-dossier.ts — ONE query, everything the system knows about a chat.
//
// WHY THIS EXISTS (owner ask, 2026-08-28, verbatim: "so the next time this doesn't take a
// f***ing hour to do what should have taken 3 seconds and one query"): diagnosing "what
// happened to chat X" used to mean hand-walking four stores that each hold a quarter of the
// answer — the desktop metadata files (title, archive flag, lineage ids), the orchestrator
// ledger (every proposal that ever touched it, and who decided), the marks table (done),
// and the live registry (is a process hosting it right now). This joins all four by ANY id
// or title fragment and returns the whole story in one response.
//
// The scan is a FRESH read of every store on purpose — no 15-second cache. A dossier is a
// diagnostic: the caller is usually asking because the world just changed, and a cached
// archive flag is exactly the lie they came here to catch. ~1300 small files, well under a
// second; this endpoint is called by a human-paced investigation, not a hot path.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultClaudeUserDataDir, instancesRoot } from './core/paths'
import { db } from './db'
import { readLiveRegistry } from './orchestrator'

/** One chat's full metadata row, read straight off disk (superset of SessionMeta: the cached
 *  scan drops lineage and timestamps, and lineage ids are the whole point here). */
export interface DossierChat {
  instance: string
  metaPath: string
  metaMtime: string | null
  chatId: string | null
  cliSessionId: string | null
  /** Continuations this chat rolled through (auto-compact keeps the chat, rolls the id).
   *  A ledger row can name ANY of these and still be about this chat. */
  priorCliSessionIds: string[]
  title: string | null
  cwd: string | null
  createdAt: string | null
  lastActivityAt: string | null
  archived: boolean
  permissionMode: string | null
}

export interface DossierMatch extends DossierChat {
  /** Every id this chat answers to — what the ledger/marks/kv joins run on. */
  lineageIds: string[]
  doneMark: { done: boolean; updatedAt: string } | null
  live: { pid: number; name: string; startedAt: string; cwd: string } | null
  ledger: Array<Record<string, unknown>>
  /** orchestrator_kv rows whose key or value names this chat (wl: states, holds). */
  kv: Array<{ key: string; value: string }>
}

const iso = (ms: unknown): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null

function scanStoreFull(userDataDir: string, label: string, out: DossierChat[]): void {
  const dir = join(userDataDir, 'claude-code-sessions')
  if (!existsSync(dir)) return
  const glob = new Bun.Glob('*/*/local_*.json')
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
    try {
      const path = join(dir, rel)
      const meta = JSON.parse(readFileSync(path, 'utf8'))
      const chatId = rel.slice(rel.lastIndexOf('local_'), -'.json'.length) || null
      out.push({
        instance: label,
        metaPath: path,
        metaMtime: ((): string | null => {
          try {
            return new Date(statSync(path).mtimeMs).toISOString()
          } catch {
            return null
          }
        })(),
        chatId,
        cliSessionId:
          typeof meta?.cliSessionId === 'string' && meta.cliSessionId ? meta.cliSessionId : null,
        priorCliSessionIds: Array.isArray(meta?.priorCliSessionIds)
          ? meta.priorCliSessionIds.filter((x: unknown) => typeof x === 'string')
          : [],
        title: typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : null,
        cwd: typeof meta?.cwd === 'string' && meta.cwd ? meta.cwd : null,
        createdAt: iso(meta?.createdAt),
        lastActivityAt: iso(meta?.lastActivityAt),
        archived: !!meta?.isArchived,
        permissionMode: typeof meta?.permissionMode === 'string' ? meta.permissionMode : null,
      })
    } catch {
      /* unreadable metadata file: skip it */
    }
  }
}

/** Every desktop chat on the machine, fresh from disk. Injectable roots for tests. */
export function collectChats(roots?: Array<{ dir: string; label: string }>): DossierChat[] {
  const out: DossierChat[] = []
  const targets =
    roots ??
    [{ dir: defaultClaudeUserDataDir(), label: 'default' }].concat(
      ((): Array<{ dir: string; label: string }> => {
        const root = instancesRoot()
        try {
          if (!existsSync(root)) return []
          return readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => ({ dir: join(root, e.name), label: e.name }))
        } catch {
          return []
        }
      })(),
    )
  for (const t of targets) scanStoreFull(t.dir, t.label, out)
  return out
}

export function lineageIdsOf(c: DossierChat): string[] {
  const ids = new Set<string>()
  if (c.cliSessionId) ids.add(c.cliSessionId)
  for (const p of c.priorCliSessionIds) ids.add(p)
  // The filename's own id: an imported chat is filed as local_<cliSessionId>, an app-created
  // chat under the app's id — either way the filename id is an address something may have used.
  if (c.chatId?.startsWith('local_')) ids.add(c.chatId.slice('local_'.length))
  return [...ids]
}

/** Case-insensitive: does this chat answer to the query, by title or any lineage id? */
export function chatMatches(c: DossierChat, q: string): boolean {
  const needle = q.toLowerCase()
  if (c.title?.toLowerCase().includes(needle)) return true
  if (c.chatId?.toLowerCase().includes(needle)) return true
  return lineageIdsOf(c).some((id) => id.toLowerCase().includes(needle))
}

export interface DossierDeps {
  roots?: Array<{ dir: string; label: string }>
  ledgerFor?: (ids: string[]) => Array<Record<string, unknown>>
  markFor?: (ids: string[]) => { done: boolean; updatedAt: string } | null
  kvFor?: (ids: string[]) => Array<{ key: string; value: string }>
  liveFor?: (ids: string[]) => DossierMatch['live']
}

function defaultLedgerFor(ids: string[]): Array<Record<string, unknown>> {
  if (ids.length === 0) return []
  const ph = ids.map(() => '?').join(',')
  return db
    .query<Record<string, unknown>, string[]>(
      `select * from orchestrator_proposals where session_id in (${ph}) order by proposed_at desc`,
    )
    .all(...ids)
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

function defaultKvFor(ids: string[]): Array<{ key: string; value: string }> {
  if (ids.length === 0) return []
  const rows = db
    .query<{ key: string; value: string }, []>('select key, value from orchestrator_kv')
    .all()
  return rows.filter((r) => ids.some((id) => r.key.includes(id) || r.value?.includes(id)))
}

function defaultLiveFor(ids: string[]): DossierMatch['live'] {
  try {
    const live = readLiveRegistry(join(homedir(), '.claude'))
    const hit = live.find((s) => ids.includes(s.sessionId))
    if (!hit) return null
    return { pid: hit.pid, name: hit.name, startedAt: iso(hit.startedAt) ?? '', cwd: hit.cwd }
  } catch {
    return null
  }
}

/**
 * The one-query answer: every chat matching `q` (title fragment or any lineage id), each with
 * its archive flag as it sits ON DISK RIGHT NOW, its done-mark, its live process if any, every
 * ledger row that ever touched its lineage, and the kv state that names it.
 */
export function chatDossier(q: string, deps: DossierDeps = {}): { matches: DossierMatch[] } {
  const chats = collectChats(deps.roots)
  const ledgerFor = deps.ledgerFor ?? defaultLedgerFor
  const markFor = deps.markFor ?? defaultMarkFor
  const kvFor = deps.kvFor ?? defaultKvFor
  const liveFor = deps.liveFor ?? defaultLiveFor
  const matches: DossierMatch[] = []
  for (const c of chats) {
    if (!chatMatches(c, q)) continue
    const lineageIds = lineageIdsOf(c)
    matches.push({
      ...c,
      lineageIds,
      doneMark: markFor(lineageIds),
      live: liveFor(lineageIds),
      ledger: ledgerFor(lineageIds),
      kv: kvFor(lineageIds),
    })
  }
  // Newest activity first — the chat being asked about is almost always the recent one.
  matches.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
  return { matches }
}
