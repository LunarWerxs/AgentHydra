// server/src/new-chat-opening.ts - the one place that decides the opening text of a chat the
// orchestrator is starting.
//
// THE BUG THIS EXISTS FOR. `newChatModel` and `newChatEffort` reach the CLI as real flags
// (`--model`, `--effort`), so they take effect wherever a launch is composed and they have always
// worked. Ultracode has no flag and no settings key. The ONLY way to ask for it is the literal
// word in the prompt text, and until 2026-08-27 nothing in this codebase ever put it there.
//
// So `orch_new_chat_ultracode` was stored, read back, patched over the HTTP API and MCP, and
// rendered as a toggle whose own hint reads "Prepends the 'ultracode' opt-in keyword to every
// orchestrator-started chat, so it runs in exhaustive mode" - while the only thing carrying that
// out was a line of prose in docs/orchestrate-command.md asking the reviewer to remember. An audit
// of all six spawn paths (launch-terminal, seed-desktop, the auto-resume monitor, the prompt
// catalogue, the headless dispatch queue, the reviewer's own native delivery) found zero code
// sites that concatenated the word. The owner noticed from the outside: new chats came up on the
// right model at max effort with no ultracode, which is exactly the signature of two settings that
// are flags and one that is not.
//
// ONE DEFINITION, for the reason pickPlacement() is one definition. A policy spelled out at three
// call sites is free to drift at all three, and this one had already drifted into prose.
//
// Its own module rather than a function in orchestrator.ts because orchestrator.ts imports
// session-launch.ts, so the dependency has to run the other way. It reads the settings table
// directly, the same way placements.ts does.

import { getSetting } from './db'

/** The db key. Owned here now, so the default cannot disagree between reader and writer. */
export const NEW_CHAT_ULTRACODE_KEY = 'orch_new_chat_ultracode'

/** ON unless explicitly switched off, matching db.ts's seeded default of '1'. */
export function newChatUltracodeEnabled(): boolean {
  return getSetting(NEW_CHAT_ULTRACODE_KEY) !== '0'
}

/**
 * Already asking for exhaustive mode?
 *
 * Word-boundary matched, so "ultracoded" or a path fragment does not count, and deliberately
 * case-insensitive because the keyword is not case-sensitive to the CLI. The reviewer's rubric
 * still tells it to prepend the keyword itself when delivering natively, and a chip's text can
 * carry the word for its own reasons; either way the answer is to leave the prompt alone rather
 * than say it twice.
 */
function alreadyOptedIn(prompt: string): boolean {
  return /\bultracode\b/i.test(prompt)
}

/**
 * The opening text for a NEW orchestrator-started chat.
 *
 * Returns the prompt unchanged when the setting is off, when it already asks for ultracode, or
 * when there is no prompt to speak of. Never call this for a RESUME: continuing an existing thread
 * is not starting a chat, and the keyword belongs to the turn it is written on.
 */
export function newChatOpening(prompt: string): string {
  if (!prompt.trim()) return prompt
  if (!newChatUltracodeEnabled()) return prompt
  if (alreadyOptedIn(prompt)) return prompt
  // Its own line and its own paragraph: the keyword is an opt-in marker, not part of the request,
  // and running it into the first sentence makes both harder to read.
  return `ultracode\n\n${prompt}`
}
