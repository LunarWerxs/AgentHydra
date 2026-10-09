// server/src/core/chat-store-scan.ts — the pure, side-effect-free half of the desktop chat store
// read: which chat-store files exist, and which ids each one answers to.
//
// Split out of chat-dossier.ts (2026-09-07) so a caller that only needs "what does the chat store
// say about this id" never pulls in `./db`. That module OPENS A REAL SQLITE HANDLE AS AN
// IMPORT-TIME SIDE EFFECT the instant it is imported (see db.ts's own header comment) — fine for
// chat-dossier.ts's own callers, which already run inside the daemon that owns that handle, but
// wrong for core/self-identity.ts, which runs inside the per-session MCP stdio process and must
// stay import-time side-effect-free (see that module's header). chat-dossier.ts re-exports
// everything here unchanged, so its own callers and tests are untouched by the split.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readLoginUuid } from './login-state'
import { mapPool } from './map-pool'
import { defaultClaudeUserDataDir, instancesRoot } from './paths'
import { type StatStamp, stampOf, unchangedSince } from './stat-stamp'

/** One chat's full metadata row, read straight off disk (superset of SessionMeta: the cached
 *  scan drops lineage and timestamps, and lineage ids are the whole point here). */
export interface DossierChat {
  instance: string
  metaPath: string
  metaMtime: string | null
  chatId: string | null
  cliSessionId: string | null
  /** Continuations this chat rolled through (auto-compact keeps the chat, rolls the id).
   *  A mark can be filed under ANY of these and still be about this chat. */
  priorCliSessionIds: string[]
  /** The chat that started this one (Claude Desktop's `spawnedFrom.sessionId`): the parent's own
   *  `local_<id>`, the same form as its chatId. Null when the record names no parent. */
  spawnedFrom: string | null
  title: string | null
  cwd: string | null
  createdAt: string | null
  lastActivityAt: string | null
  /** Claude Desktop's unread dot: a turn finished after the app last had the chat in focus (`lastFocusedAt`). */
  unread: boolean
  archived: boolean
  /** ⛔ THE SAME FLAG UNDER THE NAME THE STORE ITSELF USES, and it is not redundant.
   *  `archived` is this API's name for it; the metadata file on disk calls it `isArchived`.
   *  An agent that read the documented name straight off the store got every chat wrong -
   *  206 of them came back undefined, which reads as "not archived", when 205 were archived,
   *  and nothing errored (field mismatch found 2026-09-06). Emitting both means the name in
   *  the answer is also the name in the file, so a hand-check cannot silently invert. */
  isArchived: boolean
  permissionMode: string | null
  /** The effort the app runs this chat at (`effort` in the record: low..max), null when unset. */
  effort: string | null
  /** `sessionSettings.ultracode` - true on, false off, null when the record never set it. A move
   *  carries this and `effort` from the source, so both are shown on every row (owner,
   *  2026-09-26: a moved chat must keep the effort level it had). */
  ultracode: boolean | null
  /** The `<accountUuid>` folder this record is filed under (the first path segment below
   *  `claude-code-sessions`). */
  accountUuid: string | null
  /** The account this profile is signed into RIGHT NOW (config.json `lastKnownAccountUuid`),
   *  null when signed out or unreadable. */
  loginUuid: string | null
  /** ⛔ THE RECORD IS ON DISK BUT THE APP DOES NOT SHOW IT. True when the profile is signed into
   *  a different account than the one this record is filed under: the desktop app renders only
   *  the signed-in account's folder, so a re-login hides every chat filed under the previous one
   *  while its record (and every tool that globbed the whole store) still said "unarchived, on
   *  this instance". #12, 2026-09-18: four chats moved in at 22:16Z, the profile was re-logged
   *  into another account at 22:50Z, and the chats vanished while list_chats, chat_dossier and
   *  move_chats ("nothing to do: already lives here") all reported them present. Null when the
   *  signed-in account is unknown, which is NOT the same as false. */
  staleLogin: boolean | null
}

const iso = (ms: unknown): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null

/** One field off a parsed metadata record. JSON.parse hands back `unknown`-shaped data; the
 *  helpers below narrow it, so a malformed record yields nulls instead of a bad row. */
function metaField(meta: unknown, key: string): unknown {
  return (meta as Record<string, unknown> | null | undefined)?.[key]
}

/** A non-empty string field, or null. */
function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Any string field (empty included), or null - the store's own `permissionMode` may be ''. */
function anyText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** A trimmed, non-empty string field, or null. */
function trimmedText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text : null
}

/** The string members of a list field, or [] when the field is not a list. */
function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x: unknown) => typeof x === 'string') : []
}

/** `sessionSettings.ultracode` as a boolean, or null when the record never set it. */
function ultracodeOf(meta: unknown): boolean | null {
  const flag = metaField(metaField(meta, 'sessionSettings'), 'ultracode')
  return typeof flag === 'boolean' ? flag : null
}

/** The parent chat's local id from `spawnedFrom.sessionId`, or null when the record names none. */
function spawnedFromOf(meta: unknown): string | null {
  return nonEmptyText(metaField(metaField(meta, 'spawnedFrom'), 'sessionId'))
}

/** Unread as the app shows it: the last activity is newer than the last time the app focused the chat. */
function unreadOf(meta: unknown): boolean {
  const activity = metaField(meta, 'lastActivityAt')
  const focused = metaField(meta, 'lastFocusedAt')
  return typeof activity === 'number' && typeof focused === 'number' && activity > focused
}

/** Everything a row takes from its own FILE. The rest (the scan's label, the profile's current
 *  login) belongs to the scan, so a re-login is seen without the record file changing. */
type RecordFields = Omit<DossierChat, 'instance' | 'loginUuid' | 'staleLogin'>

/** One store record's fields, parsed from its text. Throws on a half-written file, so the
 *  caller's per-record skip still covers it (and caches nothing). */
function recordFields(path: string, rel: string, text: string, mtimeMs: number): RecordFields {
  const meta = JSON.parse(text)
  return {
    metaPath: path,
    metaMtime: new Date(mtimeMs).toISOString(),
    chatId: rel.slice(rel.lastIndexOf('local_'), -'.json'.length) || null,
    cliSessionId: nonEmptyText(metaField(meta, 'cliSessionId')),
    priorCliSessionIds: textList(metaField(meta, 'priorCliSessionIds')),
    spawnedFrom: spawnedFromOf(meta),
    title: trimmedText(metaField(meta, 'title')),
    cwd: nonEmptyText(metaField(meta, 'cwd')),
    createdAt: iso(metaField(meta, 'createdAt')),
    lastActivityAt: iso(metaField(meta, 'lastActivityAt')),
    unread: unreadOf(meta),
    archived: !!metaField(meta, 'isArchived'),
    isArchived: !!metaField(meta, 'isArchived'),
    permissionMode: anyText(metaField(meta, 'permissionMode')),
    effort: nonEmptyText(metaField(meta, 'effort')),
    ultracode: ultracodeOf(meta),
    // Bun's glob yields native separators on Windows, so split on both.
    accountUuid: rel.split(/[\\/]/)[0] || null,
  }
}

/** A parsed record and the stat that proves the file has not changed since it was read
 *  (core/stat-stamp.ts, which also holds the racily-clean rule). */
interface CachedRecord {
  stamp: StatStamp
  fields: RecordFields
}

/**
 * ⛔ WHY THE SCAN KEEPS WHAT IT PARSED (2026-09-27). This read ran 3,395 readFileSync + JSON.parse
 * calls on the daemon's ONE thread for every caller - 1.2-1.4 s measured, blocking - and it is
 * on the hot path: `/api/sessions/live?lineage=1` (the orchestrator's liveness index), `/api/chats`
 * (every per-chat resolve) and the dossier, which a migrate_batch polls in a loop. Health probes
 * went unanswered while it ran, and the tray watchdog tree-kills a daemon that misses three of
 * them 5 s apart: move_chats killed the daemon, and its own migrate_batch child with it, eight
 * times in nine minutes on 2026-09-27.
 *
 * It is NOT a time-based cache. Every record is still stat'ed on every scan and re-read the moment
 * its mtime, ctime or size moves, so an archive flag flipped a millisecond ago is read as flipped
 * (the dossier's whole reason to exist, chat-dossier.ts). Only a record whose stat is unchanged,
 * and whose file was already a second old when it was read, skips the read and the parse, which
 * were ~85% of the scan's cost.
 *
 * Keyed by store dir, then by record path; each scan of a store replaces that store's map with the
 * records it found, so a deleted chat leaves the cache with its file.
 */
const recordCache = new Map<string, Map<string, CachedRecord>>()

const RECORD_GLOB = '*/*/local_*.json'

/** One record as a row: its file's fields, plus what the scan knows (label, current login). */
function chatRow(label: string, fields: RecordFields, loginUuid: string | null): DossierChat {
  const accountUuid = fields.accountUuid
  return {
    instance: label,
    ...fields,
    priorCliSessionIds: [...fields.priorCliSessionIds],
    loginUuid,
    staleLogin:
      loginUuid && accountUuid ? accountUuid.toLowerCase() !== loginUuid.toLowerCase() : null,
  }
}

function scanStoreFull(userDataDir: string, label: string, out: DossierChat[]): void {
  const dir = join(userDataDir, 'claude-code-sessions')
  if (!existsSync(dir)) return
  // Read once per profile, not per record: one config.json per store, and every record in the
  // store is judged against the same answer.
  const loginUuid = readLoginUuid(userDataDir)
  const previous = recordCache.get(dir)
  const current = new Map<string, CachedRecord>()
  for (const rel of new Bun.Glob(RECORD_GLOB).scanSync({ cwd: dir, onlyFiles: true })) {
    try {
      const path = join(dir, rel)
      const st = statSync(path)
      let rec = previous?.get(rel)
      if (!rec || !unchangedSince(rec.stamp, st)) {
        const readAt = Date.now()
        rec = {
          stamp: stampOf(st, readAt),
          fields: recordFields(path, rel, readFileSync(path, 'utf8'), st.mtimeMs),
        }
      }
      current.set(rel, rec)
      out.push(chatRow(label, rec.fields, loginUuid))
    } catch {
      /* unreadable metadata file (deleted mid-scan, half-written): skip it, cache nothing */
    }
  }
  recordCache.set(dir, current)
}

/** How many record stats are in flight at once in the async scan. */
const STAT_WIDTH = 16

/**
 * scanStoreFull without holding the event loop: the same records, rows and cache.
 *
 * ⛔ WHY (2026-09-27). Even fully cached, the sync scan is a stat per record - 3,397 of them, 351 ms
 * measured - and `/api/sessions/live?lineage=1` and `/api/chats` ran it on the daemon's only
 * thread for every call. Two callers polling together (the orchestrator's liveness pass and a
 * migrate_batch) left /api/health waiting behind back-to-back scans, and the tray watchdog kills a
 * daemon that misses three probes. Here the stats run on the thread pool, 16 at a time: 89 ms for
 * the same store, and the loop never waits more than a few ms.
 */
async function scanStoreFullAsync(
  userDataDir: string,
  label: string,
  out: DossierChat[],
): Promise<void> {
  const dir = join(userDataDir, 'claude-code-sessions')
  if (!existsSync(dir)) return
  const loginUuid = readLoginUuid(userDataDir)
  const previous = recordCache.get(dir)
  const rels: string[] = []
  try {
    for await (const rel of new Bun.Glob(RECORD_GLOB).scan({ cwd: dir, onlyFiles: true }))
      rels.push(rel)
  } catch {
    return
  }
  const recs = await mapPool(rels, STAT_WIDTH, async (rel): Promise<CachedRecord | null> => {
    try {
      const path = join(dir, rel)
      const st = await stat(path)
      const rec = previous?.get(rel)
      if (rec && unchangedSince(rec.stamp, st)) return rec
      const readAt = Date.now()
      return {
        stamp: stampOf(st, readAt),
        fields: recordFields(path, rel, await readFile(path, 'utf8'), st.mtimeMs),
      }
    } catch {
      return null // same skip as the sync scan: deleted mid-scan or half-written
    }
  })
  const current = new Map<string, CachedRecord>()
  rels.forEach((rel, i) => {
    const rec = recs[i]
    if (!rec) return
    current.set(rel, rec)
    out.push(chatRow(label, rec.fields, loginUuid))
  })
  recordCache.set(dir, current)
}

type StoreRoot = { dir: string; label: string }

/** The default profile and every isolated instance profile, unless a caller names its own. */
function storeRoots(roots?: StoreRoot[]): StoreRoot[] {
  if (roots) return roots
  const out: StoreRoot[] = [{ dir: defaultClaudeUserDataDir(), label: 'default' }]
  const root = instancesRoot()
  try {
    if (existsSync(root))
      for (const e of readdirSync(root, { withFileTypes: true }))
        if (e.isDirectory()) out.push({ dir: join(root, e.name), label: e.name })
  } catch {
    /* an unreadable instances root lists the default profile alone */
  }
  return out
}

/** Every desktop chat on the machine, fresh from disk. Injectable roots for tests.
 *  Blocks for a stat per record; a caller that can await should use collectChatsAsync. */
export function collectChats(roots?: StoreRoot[]): DossierChat[] {
  const out: DossierChat[] = []
  for (const t of storeRoots(roots)) scanStoreFull(t.dir, t.label, out)
  return out
}

/** collectChats, answered without holding the event loop. Same rows, same freshness. */
export async function collectChatsAsync(roots?: StoreRoot[]): Promise<DossierChat[]> {
  const out: DossierChat[] = []
  for (const t of storeRoots(roots)) await scanStoreFullAsync(t.dir, t.label, out)
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
