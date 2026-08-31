// server/src/headless-policy.ts - this machine does not run a chat nobody can see. Ever.
//
// OWNER LAW, 2026-08-27, restated flatly 2026-08-31: "I have zero interest of you ever using
// headless." There is no setting for it any more. There is no incident escape hatch. A headless
// chat is not a supported mode that happens to be off; it is a thing this program does not do.
//
// WHAT THIS REPLACES. A narrower guard stood at the same chokepoint from 2026-08-26, enforcing
// SURFACE PURITY: it asked whether the thread already lived in a Claude Desktop app and refused a
// headless run only for those. That guard was answering the wrong question. It could not tell "no
// desktop home" from "I could not find one", and treated both as permission, so an orphaned CLI
// thread, a migrate-on-limit resume, or a scheduled run all became conversations running in a
// process the owner cannot watch. The property being banned is INVISIBLE, not cross-surface.
//
// ⛔ AND INVISIBLE MEANS INVISIBLE, however it got that way. Measured 2026-08-31: automation had
// been stacking console windows on the owner's screen, so the launcher was changed to hide them -
// and that produced sessions running in windows nobody could see, in no app, indistinguishable
// from the thing this file exists to forbid. It passed every check here because it never touched
// this chokepoint. The lesson is that the ban is a PROPERTY of the running chat, not a code path:
// if a person cannot open it and read it, it is headless, whatever the mechanism is called.
//
// WHAT RUNS INSTEAD, both built and proven: a turn delivered natively into a chat's own app
// (measured working 2026-08-26), and importing a finished session into a desktop app so it lands
// as a real chat the owner can see and continue. Work that automation wants started belongs in a
// desktop app, not in a process.
//
// NOT COVERED, deliberately: the `/usage` probe in usage.ts. It also spawns `claude -p`, and it is
// not a chat - it asks the CLI a question and reads a number back, then deletes the transcript. It
// never reaches the dispatch chokepoint, and banning it would cost the fleet its quota readings
// for nothing. "Headless chat" means a conversation, not every child process.

/**
 * Always false. Kept as a function rather than deleted at the call sites so the refusal stays a
 * single named decision that a reader can find, and so no future caller can reintroduce headless
 * by flipping a setting - there is no setting to flip.
 */
export function headlessRunsAllowed(): false {
  return false
}

/** What a refused run records, so the queue row says why rather than merely failing. */
export const NO_HEADLESS_REASON =
  'no-headless: AgentHydra does not run chats you cannot see (owner law, 2026-08-27, restated ' +
  '2026-08-31 - there is no setting for this). Continue this thread in its desktop app, or land ' +
  'it in one via import. Nothing was run.'
