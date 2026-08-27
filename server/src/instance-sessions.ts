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
  /** The metadata file itself. Carried so every writer (archive, rename, automation stamp) can
   *  locate a chat from this ONE cached scan instead of walking the store again: six functions
   *  each did their own walk, and after the both-shapes fix each walk read every file in the
   *  store, which turned the 10-minute janitor into an 8.5-second stall. */
  path: string
  /** The chat's display name, or null when the app has not given it one. */
  title: string | null
  /** The transcript id recorded INSIDE the file. Differs from the key when the entry was found
   *  by filename - which is exactly how a chat that has rolled onto a new transcript is still
   *  reachable by the id its filename kept. */
  cliSessionId: string | null
  /** THE ID THE APP'S OWN TOOLS TAKE (`local_<...>`), which is the metadata FILENAME and not
   *  always `local_<cliSessionId>`. An imported chat is filed under the session id, so the two
   *  agree; a chat the APP created is filed under the app's own id, and 98.7% of this fleet is
   *  that shape. Anyone addressing a chat - send_message, rename, archive, a relay - must use
   *  THIS, and the reviewer landed 0 of 4 deliveries on 2026-08-27 by constructing the other
   *  one. Null only for the row-derived fallback below, which has no file to name. */
  chatId: string | null
  /** The app's per-chat automation posture. 'bypassPermissions' runs unattended; anything else
   *  (the app creates imported chats as 'acceptEdits') raises an approval prompt for at least
   *  some tools, which under the zero-click law is a silent deadlock rather than a safeguard.
   *  Free to collect: this scan already parses every metadata file. */
  permissionMode: string | null
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
      const path = join(dir, rel)
      const meta = JSON.parse(readFileSync(path, 'utf8'))
      const id = meta?.cliSessionId
      const archived = !!meta.isArchived
      const permissionMode = typeof meta.permissionMode === 'string' ? meta.permissionMode : null
      const title = typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : null
      // The filename IS the app's chat id. It was already being computed below purely as a
      // second lookup key and then discarded; keeping it is what lets a caller address this
      // chat at all.
      const chatId = rel.slice(rel.lastIndexOf('local_'), -'.json'.length) || null
      const entry: SessionMeta = {
        instance: label,
        archived,
        permissionMode,
        path,
        title,
        chatId,
        cliSessionId: typeof id === 'string' && id ? id : null,
      }
      // TWO KEYS, one scan. A chat IMPORTED into the app is filed as `local_<cliSessionId>.json`,
      // so its filename IS the session id; a chat CREATED in the app is filed under the app's own
      // id and names the session only INSIDE, as cliSessionId. Indexing both means every lookup
      // resolves from cache whichever shape it meets - and a chat that has rolled onto a new
      // cliSessionId is still findable by the original id its filename kept.
      if (typeof id === 'string' && id) map.set(id, entry)
      const fileId = rel.slice(rel.lastIndexOf('local_') + 'local_'.length, -'.json'.length)
      if (fileId && !map.has(fileId)) map.set(fileId, entry)
      if (typeof meta?.cwd === 'string' && meta.cwd && typeof meta?.createdAt === 'number')
        origins.push({ instance: label, archived, cwd: meta.cwd, createdAt: meta.createdAt })
    } catch {
      /* unreadable metadata file: skip it */
    }
  }
}

/**
 * How far apart the two records of one conversation's birth may be and still be the same birth.
 *
 * MEASURED, NOT GUESSED, and the measurement is the only reason a number this large is safe. The
 * check that matters is not "how many does it recover" but "does it ever contradict an account we
 * already know", so every width below was run against the ~300 sessions Desktop DOES link by id:
 *
 *     2s → recovers 19, 140 known rows cross-checked, 0 wrong
 *    60s → recovers 32, 305 known rows cross-checked, 0 wrong, 0 ambiguous
 *    90s → recovers 33, 303 cross-checked, 0 wrong, 0 ambiguous
 *   120s → ambiguity appears (2 origins claimed by two accounts)
 *   240s → the join starts being WRONG (2 rows contradict their known account)
 *
 * So there is a plateau and then a cliff, and this sits at the top of the plateau with the first
 * ambiguity 2x away and the first wrong answer 4x away. Do not raise it without re-running that
 * cross-check: past the cliff this stops being a link and becomes a guess.
 *
 * Why the gap is seconds rather than milliseconds at all: Desktop stamps `createdAt` when it opens
 * the chat, and the CLI stamps its first turn only once the model has been reached, which on a cold
 * start is a real wait.
 */
const ORIGIN_SKEW_MS = 60_000

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
 * WHY IT IS NEEDED, and what those sessions ARE. Measured on a real store: 64 of the newest 400
 * Claude sessions had no metadata row under their own id, every one launched from Desktop. Reading
 * them showed why. None was a subagent; three were continuations of a compacted chat; the rest were
 * started from a queued prompt, and 27 were a SECOND COPY of a conversation already in the list —
 * same folder, same minute, and (checked by message uuid) 93-100% of the smaller transcript's
 * messages present in the larger. Desktop keeps its record pointing at one copy, so the other has
 * no id to be found by, and it is the other copy the user sees with no account against it.
 *
 * That is exactly what this join recovers: the copy Desktop forgot, matched to the copy it
 * remembers, by where and when the conversation began. 51 of the 64 come back. The remaining 13
 * have no Desktop record anywhere on disk — grep-verified across every store it keeps — so
 * "unknown" is the true answer there, and the UI says so rather than leaving a gap.
 *
 * NOTE the three twin pairs that share a TITLE and share no messages at all. They are different
 * conversations that happen to be called the same thing, which is the whole reason the rule at the
 * top of this file bans matching on titles, and the reason this one does not.
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
    // The origin join answers WHOSE account ran this, from (cwd, created-instant) alone; it
    // never sees a metadata row for this session, so the automation posture is genuinely
    // unknown here rather than absent.
    found ??= {
      instance: row.instance,
      archived: row.archived,
      permissionMode: null,
      path: '',
      title: null,
      chatId: null,
      cliSessionId: null,
    }
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

/** Drop the 15s scan cache. Tests that WRITE a metadata fixture and then ask about it need this:
 *  a cached answer from before the write is stale by construction, and the surface-purity guard
 *  (dispatch.ts) consults this map on a hot path, so the TTL is not something to shorten. */
export function invalidateSessionMetaCache(): void {
  cache = null
}

/**
 * One chat's desktop metadata, from the cached index, matching EITHER on-disk shape.
 *
 * This is what every archive/rename/residency lookup should ask, rather than walking the store
 * itself. Returns null for a session the store does not carry - and for a caller that must be
 * certain (a write, or a test driving injected roots), the walkers in session-launch.ts still
 * exist as the uncached second opinion.
 */
export function findDesktopChat(sessionId: string): SessionMeta | null {
  return sessionMetaMap().get(sessionId) ?? null
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
