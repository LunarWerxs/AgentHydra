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
        isArchived: !!meta?.isArchived,
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
