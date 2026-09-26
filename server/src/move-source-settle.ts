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
//                     legacy path /desktop-archive uses: flag, reassert watcher, the app's own
//                     Archive control, read back.

import type { NativeArchiveOutcome } from './claude-native-archive'
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
    opts: { leavingCliSessionIds: string[] },
  ) => Promise<NativeArchiveOutcome>
  /** archiveDesktopChat(sessionId, true, [profile]). */
  flag: (
    sessionId: string,
    profile: string,
  ) => Promise<{ hits: Array<{ profile: string; changed: boolean }> } | null>
  /** Fire-and-forget reassertChatArchive for a running app. */
  watch: (profile: string, sessionId: string) => void
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
 * Never throws; every profile gets a row.
 */
export async function settleMovedSource(
  sessionId: string,
  roots: string[],
  leaving: string[],
  deps: SettleDeps,
): Promise<SourceSettle[]> {
  const out: SourceSettle[] = []
  const others = leaving.filter((id) => id !== sessionId)
  for (const profile of deps.carriers(sessionId, roots)) {
    try {
      out.push(await settleOne(sessionId, profile, others, deps))
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
): Promise<SourceSettle> {
  const alreadyArchived = deps.diskArchived(profile, sessionId) === true
  const running = await deps.isRunning(profile).catch(() => false)
  if (!running) {
    const hit = (await deps.flag(sessionId, profile).catch(() => null))?.hits?.[0]
    return {
      profile,
      via: 'flag',
      changed: hit?.changed === true,
      stillShown: !hit && !alreadyArchived,
      ...(alreadyArchived ? { alreadyArchived } : {}),
      ...(!hit && !alreadyArchived ? { reason: 'the archive flag could not be written' } : {}),
    }
  }

  const native = await deps.native(profile, sessionId, { leavingCliSessionIds: leaving })
  if (native.kind === 'result') {
    const done = native.ok && native.verified
    return {
      profile,
      via: 'native',
      changed: done && native.changed,
      // A record the store already called archived is an older move's leftover. An unconfirmed
      // native answer about it says nothing about THIS move, and calling it "still shown" would
      // flag every chat that ever lived on a now-unreachable account.
      stillShown: !done && !alreadyArchived,
      ...(alreadyArchived ? { alreadyArchived } : {}),
      ...(done ? {} : { reason: nativeReason(native.reason) }),
    }
  }

  // Native is unavailable for this profile: the same guarded legacy path /desktop-archive takes.
  const hit = (await deps.flag(sessionId, profile).catch(() => null))?.hits?.[0]
  if (hit?.changed) deps.watch(profile, sessionId)
  const ui = await deps.ui(profile, sessionId)
  return {
    profile,
    via: ui.verified ? 'ui' : 'flag',
    changed: ui.clicked || hit?.changed === true,
    stillShown: !ui.verified && !alreadyArchived,
    ...(alreadyArchived ? { alreadyArchived } : {}),
    ...(ui.verified ? {} : { reason: ui.reason ?? native.reason }),
  }
}
