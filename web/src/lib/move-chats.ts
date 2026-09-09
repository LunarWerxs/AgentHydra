// web/src/lib/move-chats.ts - the pure half of "Move chats to account" on an Instances row:
// which destinations the submenu offers, and which of an account's chats the move will take.
//
// THE CHATS COME FROM THE ACCOUNT'S OWN STORE (/api/chats, the read the "Chats" dialog makes),
// never from the session list. That list is scoped by the instance NAME a transcript's desktop
// record happens to carry (the default install's is `default`, not its folder name), keeps ONE
// preferred record per session id across every profile (a chat that ever lived on two accounts
// is attributed to whichever file is newer), and drops a transcript with no substantive turn -
// three ways for a chat plainly sitting on the account to be missing from the plan, which is how
// "Move chats to account" came to move some of an account's chats and report the rest as never
// having existed (2026-09-08). The store is what the app itself reads, so the plan, the "Chats"
// dialog and the sidebar all agree on what is there.

import type { ChatListRow } from '@/lib/api'

/**
 * Destinations for a move FROM `from`: every other instance, running first, then by name.
 * Closed instances are offered only when `showClosed`. The usual destination is an account whose
 * app is open, and on a fleet of twenty accounts the closed majority buried the few that were
 * (owner, 2026-09-08); the switch is off by default and is not remembered across page loads.
 */
export function moveTargets<T extends { dir: string; isRunning: boolean }>(
  instances: readonly T[],
  from: T,
  showClosed: boolean,
  label: (i: T) => string,
): T[] {
  return instances
    .filter((i) => i.dir !== from.dir && (showClosed || i.isRunning))
    .sort((a, b) => Number(b.isRunning) - Number(a.isRunning) || label(a).localeCompare(label(b)))
}

/** A store row the migrate route can act on: it has a CLI transcript to import. */
export type MovableChat = ChatListRow & { sessionId: string }

export interface MovePlan {
  /** The chats the move will attempt, in the order the store listed them (newest first). */
  chats: MovableChat[]
  /** Done-marked (handed off / already migrated): the route refuses these as superseded. */
  skippedDone: number
  /** No CLI transcript behind the record: nothing to import, so nothing the route can move. */
  skippedNoSession: number
}

/**
 * Which of an account's chats a move can take. Archived rows never move (owner rule
 * 2026-09-05: a move touches unarchived chats only), and every other exclusion is COUNTED so the
 * confirm dialog can say what stays behind and why, rather than presenting a plan that is
 * silently shorter than the account.
 */
export function planMove(rows: readonly ChatListRow[]): MovePlan {
  const chats: MovableChat[] = []
  let skippedDone = 0
  let skippedNoSession = 0
  for (const row of rows) {
    if (row.isArchived) continue
    if (row.done) {
      skippedDone++
      continue
    }
    if (!row.sessionId) {
      skippedNoSession++
      continue
    }
    chats.push({ ...row, sessionId: row.sessionId })
  }
  return { chats, skippedDone, skippedNoSession }
}
