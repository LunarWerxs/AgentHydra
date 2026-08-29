// server/src/headless-policy.ts - whether this machine may run a chat nobody can see.
//
// OWNER LAW, 2026-08-27: "We should never have any headless chats. No headless."
//
// WHAT THIS REPLACES. A narrower guard stood at the same chokepoint from 2026-08-26, enforcing
// SURFACE PURITY: it asked whether the thread already lived in a Claude Desktop app and refused a
// headless run only for those. That guard was answering the wrong question. It could not tell "no
// desktop home" from "I could not find one", and treated both as permission, so an orphaned CLI
// thread, a migrate-on-limit resume, or a scheduled run all became conversations running in a
// process the owner cannot watch. The property being banned is INVISIBLE, not cross-surface. A
// chat nobody can see is the thing that was never wanted, whichever surface it started on.
//
// WHAT RUNS INSTEAD is already built and proven, which is what makes this affordable: the reviewer
// delivers a turn natively into the chat's own app (measured working 2026-08-26), and
// launchTerminalSession opens a visible window for work with no app to go back to. Neither is a
// future extension; both are load-bearing today.
//
// NOT COVERED, deliberately: the `/usage` probe in usage.ts. It also spawns `claude -p`, and it is
// not a chat - it asks the CLI a question and reads a number back, then deletes the transcript. It
// never reaches the dispatch chokepoint, and banning it would cost the fleet its quota readings
// for nothing. "Headless chat" means a conversation, not every child process.

import { getSetting } from './db'

/**
 * The escape hatch, and it is OFF unless someone deliberately sets it.
 *
 * It exists so a machine mid-incident can be unblocked without a rebuild, not because headless is
 * a supported mode. Note the polarity: absence reads as FALSE here, the opposite of most settings
 * in this codebase, because the safe default for a ban is that the ban applies. A fresh install,
 * a wiped settings table and an unknown value all mean no headless.
 */
export const HEADLESS_ALLOWED_KEY = 'dispatch_allow_headless'

export function headlessRunsAllowed(): boolean {
  return getSetting(HEADLESS_ALLOWED_KEY) === '1'
}

/** What a refused run records, so the queue row says why rather than merely failing. */
export const NO_HEADLESS_REASON =
  'no-headless: AgentHydra does not run chats you cannot see (owner law, 2026-08-27). ' +
  'Continue this thread in its app, or open it in a visible terminal. Nothing was run.'
