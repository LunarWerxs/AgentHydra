// server/src/title-sweep.ts - keep every desktop chat's NAME real on disk, for as long as the
// daemon runs, so no chat ends up living under "General coding session" for the rest of its life.
//
// THE BUG THIS CLOSES (owner, 2026-09-09: "does the flipping thing seriously transfer the chats
// with the stupid name general coding session?"). A moved chat's real title is written once, into
// a store the running target app is holding in memory with the title unset; the app's first
// re-save of that chat blanks it, and the app renders a blank title as its own generic label.
// reassertChatTitle (session-launch.ts) fights that re-save for ten minutes after the move, which
// covers the window where the chat is most likely to be woken - and that is exactly the same shape
// as the permission stamp, whose short watcher needed this standing floor underneath it for
// precisely the reason automation-stamp-sweep.ts's header sets out: a chat the owner opens eleven
// minutes later wakes, re-saves, and there is nothing left to correct it.
//
// AND THE FLOOR ALREADY EXISTED, CALLED FROM NOWHERE BUT ITS OWN TEST - the second time that has
// been true in this codebase (automation-stamp-sweep.ts opens with the same sentence about
// reassertAutomationStamps). sweepUntitledDesktopChats is the v1 orchestrator's "title janitor";
// its doc comment still says "Runs from the watcher tick" and CHANGELOG.md still claims the watcher
// hands the scanner's real title to any desktop entry that has none. Both stopped being true on
// 2026-08-29, when the v1 orchestrator subsystem was retired whole and this function survived only
// because it happens to live in session-launch.ts, a file kept for unrelated reasons. It was never
// rewired. This module is that wiring, and it is deliberately a caller and nothing else: the
// janitor itself is unchanged and keeps the test it always had.
//
// WHY IT SWEEPS CLOSED PROFILES TOO, unlike the stamp sweep. A closed app cannot re-save, so its
// store cannot drift - but it can already BE wrong, from a clobber that happened while it was open,
// and a closed store is the one place a repair sticks the instant it is written. So this walks
// every profile; the stamp sweep's running-only narrowing is right for drift and wrong for damage.

import { sweepUntitledDesktopChats } from './session-launch'
import { listSessions } from './sessions'

/** Slower than the automation stamp sweep's minute on purpose. This is the floor beneath
 *  reassertChatTitle's ten-minute watch, not a race with the app: it costs a session listing plus
 *  one directory walk per profile, and nothing it repairs is time-critical. */
export const TITLE_SWEEP_MS = 5 * 60_000

/** How many of the newest sessions the index is asked for. The janitor can only rename a chat the
 *  scanner has a real name for, and a name it does not have in the newest 1000 it will not have at
 *  1001 either. */
const TITLE_LOOKUP_LIMIT = 1000

export interface TitleSweepDeps {
  /** session id -> the best title the transcript scanner knows, for every session it can see. */
  lookupTitles: () => Promise<Map<string, string>>
  /** The janitor. Injected so a test drives this module without a real chat store. */
  sweep: (lookupTitle: (cliSessionId: string) => string | null) => {
    fixed: number
    profiles: string[]
    renamed: Array<{ sessionId: string; title: string }>
  }
  log?: (msg: string) => void
}

/**
 * The scanner's title for every session it can see, as a plain map.
 *
 * ⛔ NOT CIRCULAR, and the precedence is what makes it safe. The session index resolves a title
 * custom > ai > store > turn > id (sessions.ts resolveTitleSource), so `store` - the desktop
 * record this sweep is about to rewrite - is only the THIRD term. In the failure this exists for
 * the store title is blank, which is exactly when the index falls through to the turn-derived
 * name; feeding that back is new information, not an echo. When the record is fine the janitor
 * skips it before ever asking. And a row whose title is only its own id is refused by the janitor
 * (`better === sid`), so an unnamed session cannot be renamed to a uuid.
 */
async function scannerTitles(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  // 'include', not 'hide': an archived chat with a generic name is still a chat the owner may
  // unarchive, and the janitor decides for itself which records to touch.
  const rows = await listSessions({
    limit: TITLE_LOOKUP_LIMIT,
    archived: 'include',
    source: 'claude',
  })
  for (const r of rows) {
    const t = r.title?.trim()
    // Whatever the scanner offers, verbatim; every judgement about whether it is a REAL name
    // belongs to the janitor, which owns the one definition of generic (chat-title.ts).
    if (t) out.set(r.session_id, t)
  }
  return out
}

const defaultDeps: TitleSweepDeps = {
  lookupTitles: scannerTitles,
  sweep: (lookupTitle) => sweepUntitledDesktopChats(lookupTitle),
  log: (msg) => console.log(msg),
}

/** One pass. Returns how many chats were renamed, which is also what the log line says when it is
 *  not zero. Non-throwing by the same rule as its sibling: a tick that fails is a tick skipped,
 *  never a daemon down. */
export async function runTitleSweepOnce(deps: TitleSweepDeps = defaultDeps): Promise<number> {
  let titles: Map<string, string>
  try {
    titles = await deps.lookupTitles()
  } catch {
    return 0
  }
  // Nothing to offer means nothing to do - and sweeping with an empty map would walk every store
  // to discover that, once every five minutes, forever.
  if (titles.size === 0) return 0
  try {
    const swept = deps.sweep((sid) => titles.get(sid) ?? null)
    if (swept.fixed > 0)
      deps.log?.(
        `[agenthydra] named ${swept.fixed} desktop chat(s) the app had left generic: ${swept.renamed
          .slice(0, 5)
          .map((r) => r.title)
          .join(', ')}${swept.fixed > 5 ? ', …' : ''}`,
      )
    return swept.fixed
  } catch {
    // a contended or half-written store says nothing about the next tick
    return 0
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startTitleSweep(): void {
  if (timer) return
  // Same shape as automation-stamp-sweep.ts's timer, for the same reason: this process exits on an
  // unhandled rejection, so a repeating timer must not be able to let one escape.
  timer = setInterval(() => {
    runTitleSweepOnce().catch((err) => console.error('[agenthydra] title sweep error:', err))
  }, TITLE_SWEEP_MS)
}

export function stopTitleSweep(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
