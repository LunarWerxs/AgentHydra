// useMoveAllChats — move every active chat on one desktop instance to another. Split out of
// InstancesView.vue because it is one self-contained feature end to end: the destination list, the
// count-then-confirm step, and the two-pass move all share the same job shape and the same toast.
//
// The instance-level version of the session list's migrate: every chat on this account that is
// not archived and not marked done, moved to one other account in one confirmed action. Done rows
// are skipped because the server refuses them as superseded, so leaving them in would trade one
// confirmation for a column of error toasts.
//
// ⛔ A LIVE CHAT IS NOT SKIPPED. It is stopped and then moved, which is what a person-driven move
// means (web/tests/move-chats.test.ts pins it, and moveChatsConfirmBody now leads with it). The
// submenu's "not running" switch is about DESTINATION ACCOUNTS and nothing else; the two got read
// as one thing (owner, 2026-09-09: "does it only move chats that aren't actively running?").
//
// And a closed destination is NOT opened first. The line that used to sit here said it was, on the
// grounds that "the import has to land in a running app" - true until the server grew its cold
// landing (desktop-sessions.ts), which writes the chat straight into the closed account's store,
// settings intact, for the app to find at its next start. See the note above prepareMoveAll.

import type { Ref } from 'vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { ChatListRow, CMInstance } from '@/lib/api'
import { getInstanceChats, getSession, migrateSession, settleMovedChat } from '@/lib/api'
import { displayName } from '@/lib/instance-appearance'
import {
  type MovableChat,
  type MovePlan,
  moveTargets,
  planMove,
  profileLabel,
  stillShownLine,
  stoppedServers,
  warnOnUnloadWhile,
} from '@/lib/move-chats'
import { requestSessionJump } from '@/lib/session-jump'

type Translate = (key: string, named?: Record<string, unknown>) => string

interface MoveAllJob {
  from: CMInstance
  to: CMInstance
  plan: MovePlan
}

/** What a move-all has done so far, filled by the two passes and read by the summary toast. */
interface MoveAllTally {
  landed: Array<{ sessionId: string; name: string }>
  failed: string[]
  // Moved, but an old account's app still lists it (the server says which account and why).
  stillShown: string[]
  // Other chats' preview servers an at-limit old account's archive stopped, and where first.
  stopped: number
  stoppedOn: string
}

function newMoveAllTally(): MoveAllTally {
  return { landed: [], failed: [], stillShown: [], stopped: 0, stoppedOn: '' }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** One chat's landing. Returns the failure line, or null when it landed. */
async function landOneChat(
  row: MovableChat,
  targetRef: string,
  name: string,
): Promise<string | null> {
  try {
    // The record's own title is the name this list showed, and one of the two names the
    // route accepts as the chat's current one. A record with no title of its own is
    // confirmed by the session list's title for it - the route's other current name -
    // fetched only for that row. A chat neither store can name is refused by the route.
    const confirmTitle = row.title?.trim() || (await getSession(row.sessionId, 'claude')).title
    const r = await migrateSession(row.sessionId, targetRef, { confirmTitle, deferSettle: true })
    return r.ok ? null : `${name}: ${r.error ?? 'failed'}`
  } catch (e) {
    return `${name}: ${errorText(e)}`
  }
}

// PASS ONE, every landing. Serial on purpose: each migrate may stop a live run and wait for it,
// and the desktop app takes imports one at a time anyway. The old copies are left in place
// (deferSettle) until every landing is known, for the reason pass two gives.
async function landAllChats(
  chats: MovableChat[],
  targetRef: string,
  id: string,
  t: Translate,
  tally: MoveAllTally,
) {
  for (const [i, row] of chats.entries()) {
    toast.loading(t('instances.moveChatsProgress', { done: i + 1, n: chats.length }), { id })
    const name = row.title || t('instances.chatsNoTitle')
    const failure = await landOneChat(row, targetRef, name)
    if (failure) tally.failed.push(failure)
    else tally.landed.push({ sessionId: row.sessionId, name })
  }
}

async function settleOneChat(
  c: { sessionId: string; name: string },
  targetRef: string,
  leaving: string[],
  profileName: (profile: string) => string,
  tally: MoveAllTally,
) {
  const r = await settleMovedChat(c.sessionId, targetRef, leaving)
  const line = r.ok ? stillShownLine(r.sourceSettle, profileName) : (r.error ?? 'failed')
  if (line) tally.stillShown.push(`${c.name} (${line})`)
  const halted = r.ok ? stoppedServers(r.sourceSettle) : null
  if (halted) {
    tally.stopped += halted.n
    tally.stoppedOn ||= profileName(halted.profile)
  }
}

// PASS TWO, the old copies, archived through the old account's own app. `leaving` is exactly
// the chats that landed: the app's archive of one chat stops a sibling's preview server only
// when that sibling is named as leaving too, and naming the whole plan let it stop the server
// of a chat whose own move then failed and stayed (review, 2026-09-26). Without the list at
// all, a batch of chats in one repo, the usual shape, left every old row on screen.
async function settleAllChats(
  targetRef: string,
  id: string,
  t: Translate,
  profileName: (profile: string) => string,
  tally: MoveAllTally,
) {
  const leaving = tally.landed.map((c) => c.sessionId)
  for (const [i, c] of tally.landed.entries()) {
    toast.loading(t('instances.moveChatsSettling', { done: i + 1, n: tally.landed.length }), { id })
    try {
      await settleOneChat(c, targetRef, leaving, profileName, tally)
    } catch (e) {
      tally.stillShown.push(`${c.name} (${errorText(e)})`)
    }
  }
}

/** The "still shown" and "stopped servers" tails the summary toast appends, each '' when empty. */
function moveAllNotes(t: Translate, tally: MoveAllTally) {
  const { stillShown, stopped, stoppedOn } = tally
  // A chat that moved but still sits in an old sidebar is the exact complaint this batch used to
  // produce silently (owner, 2026-09-26). Say so, naming the account and the first reason.
  const shownNote = stillShown.length
    ? ` ${t('instances.moveChatsStillShown', { n: stillShown.length })} ${stillShown[0] ?? ''}`
    : ''
  const stoppedNote = stopped
    ? ` ${t('instances.moveChatsStoppedServers', { account: stoppedOn, n: stopped })}`
    : ''
  return { shownNote, stoppedNote }
}

function reportMoveAll(
  job: MoveAllJob,
  id: string,
  t: Translate,
  instLabel: (i: CMInstance) => string,
  tally: MoveAllTally,
) {
  const { landed, failed, stillShown, stopped } = tally
  if (failed.length) console.warn('[agenthydra] move all chats: some could not be moved', failed)
  if (stillShown.length)
    console.warn(
      '[agenthydra] move all chats: moved, but still listed on an old account',
      stillShown,
    )
  const ok = landed.length
  const summary = t('instances.moveChatsDone', {
    ok,
    n: job.plan.chats.length,
    to: instLabel(job.to),
  })
  const { shownNote, stoppedNote } = moveAllNotes(t, tally)
  // Say WHY, not "see the console": the first refusal's own words, and an error rather than a
  // warning when nothing moved at all (sixteen 400s once read as a warning with a zero in it).
  if (failed.length)
    (ok === 0 ? toast.error : toast.warning)(
      `${summary} ${t('instances.moveChatsSomeFailed', { failed: failed.length })} ${failed[0] ?? ''}${shownNote}${stoppedNote}`,
      {
        id,
      },
    )
  else if (stillShown.length || stopped)
    toast.warning(`${summary}${shownNote}${stoppedNote}`, { id })
  else toast.success(summary, { id })
}

export function useMoveAllChats(deps: {
  instances: Ref<CMInstance[]>
  /** Closes whichever row menu is open; the count starts from a menu item. */
  closeRowMenu: () => void
  /** The counts beside "Chats" changed on both accounts. */
  onMoved: () => void
}) {
  const { t } = useI18n()
  const moveAll = ref<MoveAllJob | null>(null)
  const moveAllBusy = ref(false)
  warnOnUnloadWhile(moveAllBusy)
  // Closed destinations are hidden from the submenu until asked for, and asked for afresh on every
  // page load (owner, 2026-09-08: off by default). One switch shared by every row's submenu.
  const moveShowClosed = ref(false)
  // The same name the table shows: label, else the account's name, else the folder. `label ?? name`
  // skipped the middle step and offered "5claude" for the row everyone knows as apebrain.
  const instLabel = (i: CMInstance) => displayName(i)
  /** A server profile path, named the way the table names its row. */
  const profileName = (profile: string) => profileLabel(profile, deps.instances.value, instLabel)
  const moveTargetsFor = (from: CMInstance) =>
    moveTargets(deps.instances.value, from, moveShowClosed.value, instLabel)

  // A closed destination is NOT started: the server lands each chat straight in that instance's
  // store, settings intact, and the app finds them there when it next starts. That is the whole
  // point of moving to a closed account, and it is the one landing that needs no restart afterwards.
  async function prepareMoveAll(from: CMInstance, to: CMInstance) {
    // One count at a time. The submenu item is disabled while busy, but a second click can still
    // arrive through a reopened menu, and two overlapping counts share one toast id - the first's
    // dismiss then races the second's loading toast and one of them is left on screen (seen live).
    if (moveAllBusy.value) return
    deps.closeRowMenu()
    moveAllBusy.value = true
    const id = `move-all-${from.dir}`
    try {
      toast.loading(t('instances.moveChatsCounting'), { id })
      // The account's OWN chat store - the same read the "Chats" dialog makes - never the session
      // list, which is scoped by a recorded instance name and by one preferred record per id and
      // so came up short (planMove's header has the three ways). `desktop:<dir>` is the one
      // spelling two similarly named accounts cannot share.
      const got = await getInstanceChats(`desktop:${from.dir}`, 'hide', 1000)
      const plan = planMove(got.rows)
      toast.dismiss(id)
      if (plan.chats.length === 0) {
        toast.info(t('instances.moveChatsNone', { from: instLabel(from) }))
        return
      }
      moveAll.value = { from, to, plan }
    } catch {
      toast.error(t('instances.moveChatsFailed', { from: instLabel(from) }), { id })
    } finally {
      moveAllBusy.value = false
    }
  }

  async function runMoveAll() {
    const job = moveAll.value
    if (!job) return
    moveAll.value = null
    moveAllBusy.value = true
    const id = `move-all-${job.from.dir}`
    const targetRef = `desktop:${job.to.dir}`
    const tally = newMoveAllTally()
    try {
      await landAllChats(job.plan.chats, targetRef, id, t, tally)
      await settleAllChats(targetRef, id, t, profileName, tally)
    } finally {
      moveAllBusy.value = false
      deps.onMoved()
    }
    reportMoveAll(job, id, t, instLabel, tally)
  }

  /** A chat in the move list, clicked: close the dialog and land on that chat in Sessions, filtered
   *  to it and selected. The tab switch happens in App.vue; the select happens in SessionsView. */
  function openChatFromMoveDialog(row: ChatListRow) {
    if (!row.sessionId) return
    moveAll.value = null
    requestSessionJump({ session_id: row.sessionId, source: 'claude' })
  }

  return {
    moveAll,
    moveAllBusy,
    moveShowClosed,
    instLabel,
    moveTargetsFor,
    prepareMoveAll,
    runMoveAll,
    openChatFromMoveDialog,
  }
}
