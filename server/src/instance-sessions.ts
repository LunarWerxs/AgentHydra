// Safety constraints for this scan:
// - Match Desktop metadata to transcripts ONLY by cliSessionId, never the metadata filename/title.
// - Scan both the default Desktop store and every isolated instance store.
// - Never use claude://resume as a "refresh" for a live session. It is a lossy one-way import that
//   rewrites the shared transcript without thinking blocks and creates a duplicate Desktop chat.
// - Desktop's lastActivityAt does not reliably advance for externally appended turns, so it cannot
//   support an honest "stale in Desktop" warning.
//
// server/src/instance-sessions.ts — which Claude Desktop instance did a session run in?
//
// Every desktop install keeps per-session metadata at
// `<user-data-dir>/claude-code-sessions/<org>/<user>/local_*.json`, and its
// `cliSessionId` names the CLI transcript in the SHARED `~/.claude/projects` store
// (all instances write transcripts to the same place; only the metadata is per
// instance). Scanning those small files gives a transcript-id -> instance-label map:
// isolated instances label as their `~/.claude-instances/<name>` dir name, the
// default (non-isolated) install labels as "default", and anything unmapped is a
// plain CLI / unknown session. The same files also carry `isArchived`, Claude
// Desktop's own archive flag, so one scan gives both the label and that.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultClaudeUserDataDir, instancesRoot } from './core/paths'
import { AMBIENT_RUN_AS } from './types'

/** Per-session metadata read out of Claude Desktop's own local_*.json files. */
export interface SessionMeta {
  instance: string
  archived: boolean
}

const TTL_MS = 15_000
let cache: { at: number; map: Map<string, SessionMeta>; origins: OriginRow[] } | null = null

/**
 * One metadata file reduced to WHERE and WHEN its conversation started.
 *
 * The fallback below joins on these two facts, and only these two. See resolveInstanceByOrigin.
 */
interface OriginRow {
  instance: string
  archived: boolean
  cwd: string
  createdAt: number
}

function scanStore(
  userDataDir: string,
  label: string,
  map: Map<string, SessionMeta>,
  origins: OriginRow[],
): void {
  const dir = join(userDataDir, 'claude-code-sessions')
  if (!existsSync(dir)) return
  const glob = new Bun.Glob('*/*/local_*.json')
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, rel), 'utf8'))
      const id = meta?.cliSessionId
      const archived = !!meta.isArchived
      if (typeof id === 'string' && id) map.set(id, { instance: label, archived })
      if (typeof meta?.cwd === 'string' && meta.cwd && typeof meta?.createdAt === 'number')
        origins.push({ instance: label, archived, cwd: meta.cwd, createdAt: meta.createdAt })
    } catch {
      /* unreadable metadata file: skip it */
    }
  }
}

/** How far apart the two records of one conversation's birth may be and still be the same birth.
 *  Desktop stamps `createdAt` as it opens the chat and the CLI stamps the first turn a moment
 *  later, so this is the width of that handoff, not a tolerance for guessing. */
const ORIGIN_SKEW_MS = 2000

/**
 * The instance for a transcript Desktop has no `cliSessionId` for, or null.
 *
 * WHY A SECOND JOIN EXISTS AT ALL, given the rule at the top of this file. That rule bans matching
 * on the metadata's FILENAME or TITLE, and it should: two chats in the same project are routinely
 * called the same thing, so a title match attributes one account's work to another. This is a
 * different key. A working directory plus a millisecond-precision creation timestamp is not a
 * label, it is a coincidence that does not happen — and where it somehow did, this returns null
 * rather than choosing, so the failure mode is "unknown", never "wrong".
 *
 * WHY IT IS NEEDED. Measured on a real store: 64 of the newest 400 Claude sessions had no metadata
 * row under their own id, every one of them launched from Desktop. 19 were recoverable this way,
 * with ZERO ambiguous matches. The other 45 have no Desktop record anywhere on disk — grep-verified
 * across every store it keeps — so they are genuinely unattributable and the UI says so out loud.
 */
export function resolveInstanceByOrigin(cwd: string, createdAt: number | null): SessionMeta | null {
  if (!cwd || createdAt === null) return null
  const rows = originRows()
  const needle = cwd.toLowerCase()
  let found: SessionMeta | null = null
  for (const row of rows) {
    if (Math.abs(row.createdAt - createdAt) > ORIGIN_SKEW_MS) continue
    if (row.cwd.toLowerCase() !== needle) continue
    // A second candidate naming a DIFFERENT instance makes this ambiguous, and an ambiguous
    // account is worse than no account: the whole point of the chip is knowing whose quota paid.
    if (found && found.instance !== row.instance) return null
    found ??= { instance: row.instance, archived: row.archived }
  }
  return found
}

/** Map of CLI transcript session id -> { instance label, archived }. Single scan; both
 *  instanceSessionMap() below and the archived lookup in sessions.ts derive from this. */
export function sessionMetaMap(): Map<string, SessionMeta> {
  return scanAll().map
}

/** The same single scan, seen from the other side: every metadata row's (cwd, createdAt). */
function originRows(): OriginRow[] {
  return scanAll().origins
}

function scanAll(): { map: Map<string, SessionMeta>; origins: OriginRow[] } {
  const now = performance.now()
  if (cache && now - cache.at < TTL_MS) return cache

  const map = new Map<string, SessionMeta>()
  const origins: OriginRow[] = []
  scanStore(defaultClaudeUserDataDir(), 'default', map, origins)
  const root = instancesRoot()
  try {
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) scanStore(join(root, entry.name), entry.name, map, origins)
      }
    }
  } catch {
    /* best-effort: an unreadable instances root just means no labels */
  }
  cache = { at: now, map, origins }
  return cache
}

/** Map of CLI transcript session id -> instance label ("default" | instance dir name). */
export function instanceSessionMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const [id, meta] of sessionMetaMap()) map.set(id, meta.instance)
  return map
}

/**
 * The dispatch `instance_ref` ('desktop:<user-data-dir>') for the desktop instance a session
 * belongs to, or null when it belongs to none (a plain CLI transcript, or an instance dir that has
 * since been deleted).
 *
 * This is the missing half of the pinning design. Every instance runs a DIFFERENT Anthropic
 * account, but all of them write transcripts to the SHARED `~/.claude/projects` store, so a resume
 * dispatched with no `instance_ref` runs on whatever the ambient CLI login happens to be — a
 * different account than the chat was having its conversation with. Observed 2026-07-27: two
 * resumes of a `temp1` chat (account at 22% weekly) died on "You've hit your weekly limit" because
 * they went out as the ambient `~/.claude` login, which was genuinely maxed. Nothing was wrong with
 * the chat's own account; it was never asked.
 */
export function instanceRefForSession(sessionId: string): string | null {
  const label = sessionMetaMap().get(sessionId)?.instance
  if (!label) return null
  const dir = label === 'default' ? defaultClaudeUserDataDir() : join(instancesRoot(), label)
  // dispatch.ts fails a run pre-launch when a pinned dir is gone; resolving to a dead dir here
  // would turn "we picked this for you" into that failure, so an unusable label stays unpinned.
  return existsSync(dir) ? `desktop:${dir}` : null
}

/**
 * What `instance_ref` should a NEW queue item be stored with, given what its creator asked for?
 *
 * Four cases, in order — the ordering is the whole contract:
 *   · AMBIENT_RUN_AS      → null. The one way to say "ambient" and MEAN it.
 *   · an explicit ref     → itself. A named instance always wins; nothing is inferred over it.
 *   · an account_id, or a NEW chat → null. A pasted-credential account is an explicit choice too,
 *     and a new chat has no transcript yet, so there is no instance to inherit from.
 *   · anything else (a resume that said nothing) → the session's own desktop instance.
 *
 * Separated from the route handler so all four are testable without an HTTP round trip, and
 * injectable so the test doesn't need a real instance store on disk.
 */
export function resolveRunAsRef(
  body: { instance_ref?: unknown; account_id?: unknown; new_chat?: unknown },
  sessionId: string,
  lookup: (id: string) => string | null = instanceRefForSession,
): string | null {
  if (body.instance_ref === AMBIENT_RUN_AS) return null
  if (typeof body.instance_ref === 'string' && body.instance_ref) return body.instance_ref
  if (body.account_id || body.new_chat) return null
  return lookup(sessionId)
}
