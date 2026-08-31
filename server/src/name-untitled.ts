// server/src/name-untitled.ts - IF A CHAT HAS NO REAL NAME, NAME IT. No judgement, no lane, no
// AI in the path: a rule, and the code that runs it every tick.
//
// WHY THIS FILE EXISTS AT ALL. The rule was already written. `sweepUntitledDesktopChats` has sat
// in session-launch.ts complete and correct, and a grep on 2026-08-31 found it called from
// NOWHERE in the server - a janitor nobody ever ran. Its own return type documents the follow-up
// it was designed for ("naming them lets the caller hand the ones in running instances to the
// reviewer, which renames through the app instantly"), and that caller was never written either.
// So the owner kept seeing chats called "General coding session" while the codebase contained a
// function whose entire job was to prevent exactly that. A rule with no runner is not a rule.
//
// TWO WRITES, BOTH NEEDED, and this is the part that made it non-obvious. A desktop app holds its
// chat list in MEMORY and re-saves it; a title written to the metadata file is a hint the app
// honours at its next restart and ignores until then. So naming on disk alone leaves the sidebar
// unchanged and looks like nothing happened. For a RUNNING instance the durable channel is the
// app's own Rename, driven through the UI - which is why this does both, in that order.
//
// ⛔ IT NEVER INVENTS A NAME. resolveAutomatedTitle returns null when the transcript offers no
// real title, and null means LEFT ALONE. A chat named by guesswork is worse than one named
// "Untitled": the generic name is at least honest about knowing nothing.

import { isGenericChatTitle, resolveAutomatedTitle } from './chat-title'
import { sweepUntitledDesktopChats } from './session-launch'
import { uiRenameChat } from './ui-archive'

export interface NamedChat {
  sessionId: string
  profile: string
  title: string
  /** Whether the running app was made to show it, not merely the file on disk. */
  onScreen: boolean
  why: string
}

export interface NameReport {
  /** Chats given a real name this pass. */
  named: NamedChat[]
  /** Untitled chats the transcript could not name - reported, never guessed at. */
  unnameable: number
}

export interface NameDeps {
  sweep?: typeof sweepUntitledDesktopChats
  lookup?: (sessionId: string) => Promise<string | null>
  rename?: typeof uiRenameChat
  /** Profile dirs whose app is RUNNING, so the on-screen rename is worth attempting. */
  runningProfiles?: string[]
  /** Most app renames to drive in one pass; each is a real UI interaction. */
  maxPerPass?: number
}

/**
 * Name every untitled desktop chat, on disk and - where the app is running - on screen.
 *
 * Deterministic end to end: the input is "this chat has no real name", the output is a name
 * derived from its own transcript or nothing at all.
 */
export async function nameUntitledChats(deps: NameDeps = {}): Promise<NameReport> {
  const sweep = deps.sweep ?? sweepUntitledDesktopChats
  const lookup = deps.lookup ?? ((id: string) => resolveAutomatedTitle(id, null))
  const rename = deps.rename ?? uiRenameChat
  const running = new Set((deps.runningProfiles ?? []).map((p) => p.toLowerCase()))
  const cap = deps.maxPerPass ?? 8

  // sweepUntitledDesktopChats takes a SYNCHRONOUS lookup, and the real title source is async, so
  // the titles are resolved first and handed over as a map. Doing it the other way round would
  // mean either blocking inside the walk or losing the async source entirely.
  const pending: string[] = []
  sweep((id) => {
    pending.push(id)
    return null // nothing named on this pass; this one only collects the ids
  })

  const titles = new Map<string, string>()
  let unnameable = 0
  for (const id of pending) {
    const t = await lookup(id)
    // Null means the transcript offers no real name. LEAVE IT: a guessed name is worse than an
    // honest generic one, because it looks like knowledge.
    if (t && !isGenericChatTitle(t)) titles.set(id, t.trim())
    else unnameable++
  }

  const applied = sweep((id) => titles.get(id) ?? null)

  const named: NamedChat[] = []
  let screenWrites = 0
  for (const r of applied.renamed) {
    const onDiskOnly = !running.has(r.profile.toLowerCase())
    if (onDiskOnly) {
      named.push({
        sessionId: r.sessionId,
        profile: r.profile,
        title: r.title,
        onScreen: false,
        why: 'named on disk; that app is not running, so it will show the name when it next starts',
      })
      continue
    }
    if (screenWrites >= cap) {
      named.push({
        sessionId: r.sessionId,
        profile: r.profile,
        title: r.title,
        onScreen: false,
        why: `named on disk; the per-pass rename cap of ${cap} is spent, so the sidebar catches up next pass`,
      })
      continue
    }
    screenWrites++
    // The app renders an unnamed chat under its own generic label, so THAT is the row to aim at -
    // not the name we just wrote to disk, which the running app has not read.
    const res = await rename(r.profile, 'General coding session', r.title)
    named.push({
      sessionId: r.sessionId,
      profile: r.profile,
      title: r.title,
      onScreen: res.ok,
      why: res.ok
        ? "renamed through the app's own control, so the sidebar shows it now"
        : `named on disk, but the app rename did not take: ${res.detail}`,
    })
  }
  return { named, unnameable }
}
