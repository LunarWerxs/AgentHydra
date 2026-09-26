// server/src/move-source-settle.ts - retiring a moved chat's OLD rows the way its app would, so
// the account it left stops showing it NOW rather than at that app's next restart.
//
// ⛔ THE UI MOVE ONLY EVER WROTE A DISK FLAG (owner report, 2026-09-26: "it never archives them
// ... all it does is copy those chats to another account. They're still in the old one"). The
// Instances "Move chats to account" menu and the Sessions migrate both go through
// POST /api/sessions/:id/migrate, and that route settled the source with archiveDesktopChat alone.
// A RUNNING app holds its chat list in memory and re-saves its own copy of each record, so the flag
// changed nothing on screen, the reassert watcher gave up after ten minutes, and the chat sat in
// the old sidebar looking unmoved. Worse, the disk now said "archived" while the app said "here",
// so the next move from that account read the store, found nothing unarchived, and answered
// "No chats to move" for chats the owner was looking at.
//
// The orchestrator's mover never had this gap (migrate_chat.py _settle_source) and neither does
// POST /desktop-archive: both ask the running app first. This is the same order, for /migrate:
//   · closed app   -> the flag. The app reads its store at boot, so the flag is the whole job.
//   · running app  -> the app's native session manager (claude-native-archive.ts). A verified
//                     result is the app's own archive: row gone, record written by the app.
//   · native REFUSED or unconfirmed -> nothing else is tried, per the runbook (AGENTS.md: a native
//                     refusal must never trigger a disk-flag edit or a UI fallback). The chat stays
//                     visibly on BOTH accounts, reported, and the store agrees with the screen:
//                     archiving the leftover in that app is durable, and a later move from that
//                     account still finds the chat instead of answering "No chats to move".
//   · native UNAVAILABLE (not configured, or prefer-native with no debugger) -> the guarded
//                     legacy path: the app's own Archive control, read back. If that does not
//                     settle it, NO flag under the running app: that flag is the reported bug
//                     itself (hides nothing, and the next move finds nothing). The record stays as
//                     the screen shows it, reported as still shown, and is queued to be flagged
//                     once that app is closed (move-retire-on-close.ts).
//   · a record filed under a PREVIOUS login of a running profile -> the flag. The app renders only
//                     the signed-in account's folder, so it never loaded that record and cannot
//                     save over the flag, and no click or native archive can find it on screen.
//
// A source account AT ITS USAGE WALL is archived over other chats' preview servers, each one
// named (owner's standing order, 2026-09-26; migrate_chat's usage_full applies it for the MCP
// mover). usageAtWall below is that test for the web's moves.

import type { NativeArchiveOutcome } from './claude-native-archive'
import type { UsageSnapshot } from './types'
import type { UiArchiveOutcome } from './ui-archive'

/** One profile's leftover, and what became of it. */
export interface SourceSettle {
  profile: string
  /** Which route retired it: the app's native manager, its own Archive control, or the flag. */
  via: 'native' | 'ui' | 'flag'
  /** This call changed the record: the app archived it, or the flag was written. */
  changed: boolean
  /** The account still shows the chat (now if the app runs, at its next start if it is closed). */
  stillShown: boolean
  /** The record already said archived before this move touched it (an older move's leftover). */
  alreadyArchived?: boolean
  /** The account was at its usage wall, so the archive went ahead over other chats' servers. */
  atLimit?: boolean
  /** What that at-limit archive stopped which another chat owned (native-program). */
  stoppedBystanders?: unknown[]
  /** Queued to be archived once that app is closed (move-retire-on-close.ts). */
  retiresOnClose?: boolean
  reason?: string
}

export interface SettleDeps {
  /** Profiles among `roots` whose store carries the session (session-launch desktopChatCarriers). */
  carriers: (sessionId: string, roots: string[]) => string[]
  /** The record's flag on disk in one profile; null when it cannot be read. */
  diskArchived: (profile: string, sessionId: string) => boolean | null
  isRunning: (profile: string) => Promise<boolean>
  native: (
    profile: string,
    sessionId: string,
    opts: { leavingCliSessionIds: string[]; sourceAtLimit?: boolean },
  ) => Promise<NativeArchiveOutcome>
  /** The account is at its usage wall right now (usageAtWall over its cached reading). */
  atLimit?: (profile: string) => boolean
  /** archiveDesktopChat(sessionId, true, [profile]). */
  flag: (
    sessionId: string,
    profile: string,
  ) => Promise<{ hits: Array<{ profile: string; changed: boolean }> } | null>
  /** The record sits in the folder of the account the profile is signed into now, so the app
   *  renders it (session-launch findVisibleChatMetaPath). Absent: every record counts as shown. */
  shown?: (profile: string, sessionId: string) => boolean
  /** Queue the old copy to be flagged once its app is closed (move-retire-on-close.ts). */
  retireOnClose: (profile: string, sessionId: string) => void
  /** The app's own Archive control, bounded (desktop-sessions uiArchiveWithinBudget). */
  ui: (profile: string, sessionId: string) => Promise<UiArchiveOutcome>
}

/**
 * Retire every leftover of a moved chat in `roots` - the caller's archiveRootsForMove(target), so
 * the account it just landed on is never among them. `leaving` names the CLI ids of the other
 * chats this same move is taking off these profiles: without it the native archive refuses a
 * chat whose working directory has a SIBLING's preview server running, and a batch of chats in
 * one repo (the usual shape of an account move) left every source row on screen (2026-09-26).
 *
 * `closedOnly` settles only what needs no running app (a closed profile, or a record under a
 * previous login) and skips the rest: a batch's first pass, whose running sources wait for the
 * second pass to know every chat that landed. Nothing there depends on `leaving`, and settling it
 * at once means an interrupted batch leaves nothing flagged-but-shown behind.
 *
 * Never throws; every profile it visits gets a row.
 */
export async function settleMovedSource(
  sessionId: string,
  roots: string[],
  leaving: string[],
  deps: SettleDeps,
  opts: { closedOnly?: boolean } = {},
): Promise<SourceSettle[]> {
  const out: SourceSettle[] = []
  const others = leaving.filter((id) => id !== sessionId)
  for (const profile of deps.carriers(sessionId, roots)) {
    try {
      const row = await settleOne(sessionId, profile, others, deps, opts.closedOnly === true)
      if (row) out.push(row)
    } catch (e) {
      out.push({
        profile,
        via: 'flag',
        changed: false,
        stillShown: true,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out
}

/**
 * The native refusal, with what a person can do about the commonest one. A profile set to
 * native-only whose app was started some other way than AgentHydra's Open has no debugger, so
 * its refusal reads "Inspector discovery unavailable at ..." - true, and no help to someone
 * looking at a chat that did not leave. Both remedies are theirs to take: the app's own Archive
 * on that row is durable (the store and the screen agree it is unarchived), and an Open through
 * AgentHydra starts the debugger so the next move needs neither.
 */
function nativeReason(reason: string | undefined): string {
  const said = reason ?? 'the native archive was not verified'
  return said.startsWith('Inspector discovery unavailable')
    ? `${said} - that app was not opened through AgentHydra, so it has no native control. Archive the chat in that app's sidebar, or reopen the account from AgentHydra so the next move can do it.`
    : said
}

async function settleOne(
  sessionId: string,
  profile: string,
  leaving: string[],
  deps: SettleDeps,
  closedOnly: boolean,
): Promise<SourceSettle | null> {
  const alreadyArchived = deps.diskArchived(profile, sessionId) === true
  const running = await deps.isRunning(profile).catch(() => false)
  // Under a previous login the running app never loaded the record: a flag is safe there, and it
  // is the only route that can reach it. It is not on screen either way, so never "still shown".
  const hidden = running && deps.shown?.(profile, sessionId) === false
  if (!running || hidden) {
    const hit = (await deps.flag(sessionId, profile).catch(() => null))?.hits?.[0]
    const failed = !hit && !alreadyArchived
    return {
      profile,
      via: 'flag',
      changed: hit?.changed === true,
      stillShown: failed && !hidden,
      ...(alreadyArchived ? { alreadyArchived } : {}),
      ...(failed ? { reason: 'the archive flag could not be written' } : {}),
    }
  }
  if (closedOnly) return null

  const atLimit = deps.atLimit?.(profile) === true
  const native = await deps.native(profile, sessionId, {
    leavingCliSessionIds: leaving,
    ...(atLimit ? { sourceAtLimit: true } : {}),
  })
  if (native.kind === 'result') {
    const done = native.ok && native.verified
    return {
      profile,
      via: 'native',
      changed: done && native.changed,
      ...(atLimit ? { atLimit } : {}),
      ...(native.stoppedBystanders?.length ? { stoppedBystanders: native.stoppedBystanders } : {}),
      // A record the store already called archived is an older move's leftover. An unconfirmed
      // native answer about it says nothing about THIS move, and calling it "still shown" would
      // flag every chat that ever lived on a now-unreachable account.
      stillShown: !done && !alreadyArchived,
      ...(alreadyArchived ? { alreadyArchived } : {}),
      ...(done ? {} : { reason: nativeReason(native.reason) }),
    }
  }

  // Native is unavailable for this profile: the app's own Archive control FIRST, the flag only if
  // that does not settle it. The order is the point (review, 2026-09-26): uiArchiveChat confirms a
  // click by reading the record's flag, so a flag written beforehand confirmed ITSELF - a row the
  // sidebar never rendered, or a click that did not take, read as settled while the chat sat in
  // the old sidebar. migrate_chat's settle clicks first for the same reason.
  const ui = await deps.ui(profile, sessionId)
  if (ui.verified)
    return {
      profile,
      via: 'ui',
      changed: ui.clicked,
      stillShown: false,
      ...(alreadyArchived ? { alreadyArchived } : {}),
    }
  const why = ui.reason ?? native.reason ?? 'the app did not archive it'
  // An older leftover the store already calls archived needs nothing queued.
  if (alreadyArchived)
    return { profile, via: 'ui', changed: false, stillShown: false, alreadyArchived, reason: why }
  // ⛔ NO FLAG UNDER THE RUNNING APP (review, 2026-09-26). It hid nothing on screen and made the
  // next move from this account answer "No chats to move" - the owner's report, recreated. The
  // record stays as the screen shows it, and is flagged once the app is closed.
  deps.retireOnClose(profile, sessionId)
  return {
    profile,
    via: 'ui',
    changed: false,
    stillShown: true,
    retiresOnClose: true,
    reason: `${why}. AgentHydra archives it there once that app is closed; until then it stays listed there and can still be moved.`,
  }
}

/** How full is too full: the owner's order names 98% of either bucket. */
const WALL_PCT = 98
/** A reading older than this says nothing about now: the orchestrator reads a two-minute-old
 *  survey; the web's cache is refreshed by the usage sweep, so this allows one missed sweep. */
const WALL_MAX_AGE_MS = 15 * 60_000

/**
 * Is this account at its usage wall right now? Either the 5-hour or the weekly all-models bucket
 * at WALL_PCT or more, on a reading captured in the last WALL_MAX_AGE_MS, in a window that has not
 * reset since. Anything missing, old, reset or unparseable answers false: an unverified reading is
 * never grounds to archive over another chat's server (migrate_chat.usage_full, same rule).
 */
export function usageAtWall(snap: UsageSnapshot | null | undefined, now = Date.now()): boolean {
  if (!snap) return false
  const captured = Date.parse(snap.capturedAt)
  if (!Number.isFinite(captured) || now - captured > WALL_MAX_AGE_MS || captured > now + 60_000)
    return false
  return [snap.session, snap.weekAll].some((limit) => {
    if (!limit || typeof limit.pct !== 'number' || limit.pct < WALL_PCT) return false
    const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
    return !(Number.isFinite(resets) && resets <= now)
  })
}
