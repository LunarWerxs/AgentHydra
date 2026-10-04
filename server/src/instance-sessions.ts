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
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { collectChats, collectChatsAsync, type DossierChat } from './core/chat-store-scan'
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
  /** Every transcript id this chat has RETIRED. The desktop app rolls a chat onto a new
   *  cliSessionId when it compacts, and records the old one here - the app's own word that those
   *  transcripts are this conversation's past, not other chats. Empty for a chat that never rolled
   *  and for an imported chat (the import writes a fresh record; the lineage then survives only in
   *  the archived tombstone the migration left behind, which is why retired claims are collected
   *  from EVERY file, not only the winner of setPreferred). */
  priorCliSessionIds: string[]
  /** The effort the app runs this chat at (`effort` in the record), null when it keeps none. A
   *  per-session setting the user can change in the app, so it is the app's own word on the chat. */
  effort: string | null
}

/** One retired-id claim: the transcript it rolled onto, and whether the row that said so is a
 *  tombstone. Archived-ness only decides a CONFLICT (two rows naming different successors for one
 *  id); a tombstone's claim stands on its own, see SessionMeta.priorCliSessionIds. */
interface RetiredClaim {
  to: string
  archived: boolean
}

const TTL_MS = 15_000

interface ScanIndex {
  at: number
  map: Map<string, SessionMeta>
  origins: OriginRow[]
  retired: Map<string, RetiredClaim>
}
let cache: ScanIndex | null = null

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
  effort: string | null
}

/**
 * Index one chat under one key, resolving the case where TWO profiles both carry it.
 *
 * That collision is routine, not exotic: a migrate ARCHIVES the source profile's metadata rather
 * than deleting it, so the moment a chat is moved, two stores describe it. This used to be a plain
 * `map.set`, which meant last-scanned-wins over a `readdirSync` ordering nobody controls - so the
 * winner was usually the stale ARCHIVED copy on the old account, and the live chat on its new
 * account vanished from every `archived: 'hide'` listing while the dashboard cheerfully attributed
 * it to the account it had just left. Measured 2026-08-28: 13 migrated chats, all reported as
 * archived on the source, all actually live on the target.
 *
 * Preference order, most decisive first:
 *   1. a LIVE entry beats an ARCHIVED one - an archived pointer is a tombstone, not a location;
 *   2. otherwise the more recently written file wins, the best available proxy for "the profile
 *      that actually touched this chat last";
 *   3. and on an exact tie, the lower path wins - NOT because that is meaningful, but because the
 *      alternative is scan order. Equal mtimes are real (two files stamped in one operation) and
 *      so is a stat that throws for both, and falling through to "keep whatever was visited
 *      first" would let a chat's reported account flip between two 15-second scans with nothing
 *      about it having changed. An arbitrary answer is tolerable; an unstable one is not.
 *
 * The `statSync` only runs on an actual collision, so the common single-entry path is unchanged.
 */
function setPreferred(map: Map<string, SessionMeta>, key: string, entry: SessionMeta): void {
  const existing = map.get(key)
  if (!existing) {
    map.set(key, entry)
    return
  }
  if (existing.archived !== entry.archived) {
    if (existing.archived) map.set(key, entry)
    return
  }
  const mtime = (p: string): number => {
    try {
      return statSync(p).mtimeMs
    } catch {
      return 0
    }
  }
  const a = mtime(entry.path)
  const b = mtime(existing.path)
  if (a > b || (a === b && entry.path.localeCompare(existing.path) < 0)) map.set(key, entry)
}

/** One chat-store record as this index keeps it, plus its (cwd, createdAt) origin when it has one.
 *  The record is read by core/chat-store-scan.ts, the one reader of these files. */
function metaOf(c: DossierChat): { entry: SessionMeta; origin: OriginRow | null } {
  const id = c.cliSessionId
  const entry: SessionMeta = {
    instance: c.instance,
    archived: c.archived,
    permissionMode: c.permissionMode,
    path: c.metaPath,
    title: c.title,
    // The filename IS the app's chat id, which is what lets a caller address this chat at all.
    chatId: c.chatId,
    cliSessionId: id,
    priorCliSessionIds: c.priorCliSessionIds.filter((p) => !!p && p !== id),
    effort: c.effort,
  }
  // Back to the record's own epoch ms: chat-store-scan carries it as ISO, which is exact to the ms.
  const createdAt = c.createdAt ? Date.parse(c.createdAt) : Number.NaN
  const origin =
    c.cwd && Number.isFinite(createdAt)
      ? { instance: c.instance, archived: c.archived, cwd: c.cwd, createdAt, effort: c.effort }
      : null
  return { entry, origin }
}

/** Record every retired-id claim this file makes. A live row's claim beats an archived row's
 *  when they disagree about one id; otherwise first seen stands, so the answer cannot flip
 *  between two scans over nothing having changed (the same reason setPreferred breaks its ties
 *  deterministically). */
function recordRetiredClaims(
  retired: Map<string, RetiredClaim>,
  id: string,
  prior: string[],
  archived: boolean,
): void {
  for (const p of prior) {
    const have = retired.get(p)
    if (!have || (have.archived && !archived)) retired.set(p, { to: id, archived })
  }
}

/** File one parsed entry under BOTH of its lookup keys. A chat IMPORTED into the app is filed as
 *  `local_<cliSessionId>.json`, so its filename IS the session id; a chat CREATED in the app is
 *  filed under the app's own id and names the session only INSIDE, as cliSessionId. Indexing both
 *  means every lookup resolves from cache whichever shape it meets - and a chat that has rolled
 *  onto a new cliSessionId is still findable by the original id its filename kept. */
function indexSessionEntry(map: Map<string, SessionMeta>, entry: SessionMeta): void {
  if (entry.cliSessionId) setPreferred(map, entry.cliSessionId, entry)
  const fileId = entry.chatId?.slice('local_'.length)
  // The FILENAME key deliberately keeps its original first-wins rule rather than adopting
  // setPreferred. It exists so a chat that has rolled onto a new cliSessionId is still
  // reachable by the id its filename kept, which means it can legitimately point at a
  // DIFFERENT chat's key - and letting it overwrite there would mix two conversations up.
  // The duplicate-profile collision this commit fixes happens on the cliSessionId key above,
  // so nothing is lost by leaving this one alone.
  if (fileId && !map.has(fileId)) map.set(fileId, entry)
}

/** The index over every chat-store record: lookups by id, origins, and retired-id claims. */
function indexOf(chats: DossierChat[], at: number): ScanIndex {
  const map = new Map<string, SessionMeta>()
  const origins: OriginRow[] = []
  const retired = new Map<string, RetiredClaim>()
  for (const c of chats) {
    const { entry, origin } = metaOf(c)
    if (entry.cliSessionId)
      recordRetiredClaims(retired, entry.cliSessionId, entry.priorCliSessionIds, entry.archived)
    indexSessionEntry(map, entry)
    if (origin) origins.push(origin)
  }
  return { at, map, origins, retired }
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
    // Two chats of one account born together may sit at different efforts: then neither is this
    // transcript's, and null is the honest answer (the join names the account, not the setting).
    if (found && found.effort !== row.effort) found.effort = null
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
      priorCliSessionIds: [],
      effort: row.effort,
    }
  }
  return found
}

/** Map of CLI transcript session id -> { instance label, archived }. Single scan; both
 *  instanceSessionMap() below and the archived lookup in sessions.ts derive from this. */
export function sessionMetaMap(): Map<string, SessionMeta> {
  return scanAll().map
}

/**
 * Retired transcript id -> the id its chat rolled onto, by the desktop's own record.
 *
 * WHY THE SESSION LIST NEEDS THIS AS WELL AS THE CONTINUATION DETECTOR. The detector
 * (session-continuations.ts) knows a continuation by the compaction marker among a transcript's
 * first records. The desktop app rolls a chat another way: it opens the new transcript by REPLAYING
 * the retained history into it and only then writes the marker, so the marker sits hundreds of
 * records deep (1,501 on the chat this was measured on, 2026-09-03) and the detector never meets
 * it. One chat, "RusTor", was three rows under two titles - the owner's "compacted chats become
 * multiple entries". The app's metadata already states the lineage; this is that statement, keyed
 * the way sessions.ts applies it. Same single scan as everything else here.
 */
export function retiredSessionIds(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, claim] of scanAll().retired) out.set(id, claim.to)
  return out
}

/** The same single scan, seen from the other side: every metadata row's (cwd, createdAt). */
function originRows(): OriginRow[] {
  return scanAll().origins
}

/** Every instance resolveInstanceByOrigin can name: it only ever returns an origin row's instance,
 *  so a scope outside this set can never be reached through the origin join. */
export function originInstances(): Set<string> {
  return new Set(originRows().map((row) => row.instance))
}

/** Drop the 15s scan cache. Tests that WRITE a metadata fixture and then ask about it need this:
 *  a cached answer from before the write is stale by construction, and the surface-purity guard
 *  (dispatch.ts) consults this map on a hot path, so the TTL is not something to shorten. A
 *  background refresh already under way is disowned too: it began before the write. */
export function invalidateSessionMetaCache(): void {
  cache = null
  generation++
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

/**
 * The index, stale-while-revalidate.
 *
 * ⛔ WHY NOT A BLOCKING RESCAN AT EXPIRY (2026-09-27). This index used to read and parse every
 * metadata file itself, 3,397 of them, 1.2 s on the daemon's only thread, every 15 s that anything
 * asked - and the analytics warm asks once per session it stores, so under load it ran on the
 * clock. It now derives from the chat-store scan (core/chat-store-scan.ts), which re-reads only a
 * changed record; and past the TTL a caller gets the index it already had while an async scan
 * (pooled stats, never holding the loop) replaces it. Only the very first call, or the first after
 * invalidateSessionMetaCache, scans synchronously: it has nothing to answer from.
 */
function scanAll(): ScanIndex {
  const now = performance.now()
  if (cache && now - cache.at < TTL_MS) return cache
  if (cache) {
    void refreshInBackground()
    return cache
  }
  cache = indexOf(collectChats(), now)
  return cache
}

let refreshing: Promise<void> | null = null
/** Bumped by invalidateSessionMetaCache, so a refresh that began before it never lands after it. */
let generation = 0

/**
 * Build the index without blocking, for boot (index.ts). With nothing cached, the first lookup
 * scans synchronously - 3,397 records read and parsed cold, 1.7 s on the daemon's only thread -
 * and at boot the first asker was the analytics warm, one lookup per session it stores.
 */
export function warmSessionMetaIndex(): Promise<void> {
  return cache ? Promise.resolve() : refreshInBackground()
}

function refreshInBackground(): Promise<void> {
  if (refreshing) return refreshing
  const gen = generation
  const started = performance.now()
  refreshing = collectChatsAsync()
    .then((chats) => {
      // A sync scan that ran meanwhile is newer than this one; keep it.
      if (gen === generation && (!cache || cache.at < started)) cache = indexOf(chats, started)
    })
    .catch(() => {
      /* keep the index we have; the next expiry tries again */
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
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
/** The user-data dir an instance LABEL names ('default' | an ~/.claude-instances dir name).
 *  The inverse of the labels scanAll assigns, shared so agent-chat tracking and the ref
 *  resolution below cannot disagree about the mapping. */
export function instanceDirForLabel(label: string): string {
  return label === 'default' ? defaultClaudeUserDataDir() : join(instancesRoot(), label)
}

export function instanceRefForSession(sessionId: string): string | null {
  const label = sessionMetaMap().get(sessionId)?.instance
  if (!label) return null
  const dir = instanceDirForLabel(label)
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
