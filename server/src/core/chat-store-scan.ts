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
import { join } from 'node:path'
import { readLoginUuid } from './login-state'
import { defaultClaudeUserDataDir, instancesRoot } from './paths'

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
  title: string | null
  cwd: string | null
  createdAt: string | null
  lastActivityAt: string | null
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

/** The file's mtime as ISO, or null when stat cannot read it (deleted mid-scan, permissions). */
function metaMtimeIso(path: string): string | null {
  try {
    return new Date(statSync(path).mtimeMs).toISOString()
  } catch {
    return null
  }
}

/** One store record -> one DossierChat row. Throws on an unreadable/half-written file, exactly as
 *  the inlined reader did, so the caller's per-record skip still covers it. */
function chatRecordFromFile(
  dir: string,
  rel: string,
  label: string,
  loginUuid: string | null,
): DossierChat {
  const path = join(dir, rel)
  // Bun's glob yields native separators on Windows, so split on both.
  const accountUuid = rel.split(/[\\/]/)[0] || null
  const meta = JSON.parse(readFileSync(path, 'utf8'))
  const chatId = rel.slice(rel.lastIndexOf('local_'), -'.json'.length) || null
  return {
    instance: label,
    metaPath: path,
    metaMtime: metaMtimeIso(path),
    chatId,
    cliSessionId: nonEmptyText(metaField(meta, 'cliSessionId')),
    priorCliSessionIds: textList(metaField(meta, 'priorCliSessionIds')),
    title: trimmedText(metaField(meta, 'title')),
    cwd: nonEmptyText(metaField(meta, 'cwd')),
    createdAt: iso(metaField(meta, 'createdAt')),
    lastActivityAt: iso(metaField(meta, 'lastActivityAt')),
    archived: !!metaField(meta, 'isArchived'),
    isArchived: !!metaField(meta, 'isArchived'),
    permissionMode: anyText(metaField(meta, 'permissionMode')),
    effort: nonEmptyText(metaField(meta, 'effort')),
    ultracode: ultracodeOf(meta),
    accountUuid,
    loginUuid,
    staleLogin:
      loginUuid && accountUuid ? accountUuid.toLowerCase() !== loginUuid.toLowerCase() : null,
  }
}

function scanStoreFull(userDataDir: string, label: string, out: DossierChat[]): void {
  const dir = join(userDataDir, 'claude-code-sessions')
  if (!existsSync(dir)) return
  const glob = new Bun.Glob('*/*/local_*.json')
  // Read once per profile, not per record: one config.json per store, and every record in the
  // store is judged against the same answer.
  const loginUuid = readLoginUuid(userDataDir)
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
    try {
      out.push(chatRecordFromFile(dir, rel, label, loginUuid))
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
