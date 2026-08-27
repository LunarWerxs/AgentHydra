// tests/new-chat-opening.test.ts - proving the ultracode opt-in is WIRED, not merely stored.
//
// The bug this file exists for is not a wrong answer, it is a setting that had no answer at all.
// `orch_new_chat_ultracode` was written by the HTTP API, the MCP tool and a toggle in the settings
// UI whose hint reads "Prepends the 'ultracode' opt-in keyword to every orchestrator-started
// chat", and it was read back into the feed so the UI could render itself. Nothing else ever
// touched it. An audit of all six spawn paths on 2026-08-27 found zero code sites that
// concatenated the word into any prompt, and the owner found the same thing from the outside:
// chats came up on the right model at max effort with the opt-in silently doing nothing.
//
// It rotted BECAUSE it was untestable-looking. Its two siblings, newChatModel and newChatEffort,
// are real CLI flags, so their wiring is visible in the argv every launch builds. Ultracode has no
// flag and no settings key; the only place it can live is the prompt text. So the guard has to be
// exactly this: flip the setting and prove the OUTPUT changes.

import { expect, test } from 'bun:test'
import { getSetting, setSetting } from '../server/src/db'
import {
  NEW_CHAT_ULTRACODE_KEY,
  newChatOpening,
  newChatUltracodeEnabled,
} from '../server/src/new-chat-opening'

/** Run `fn` with the opt-in forced to a known state, then put the setting back. */
function withOptIn<T>(on: boolean, fn: () => T): T {
  const before = getSetting(NEW_CHAT_ULTRACODE_KEY)
  setSetting(NEW_CHAT_ULTRACODE_KEY, on ? '1' : '0')
  try {
    return fn()
  } finally {
    setSetting(NEW_CHAT_ULTRACODE_KEY, before)
  }
}

test('the opt-in is ON unless explicitly switched off', () => {
  // Matches db.ts's seeded default of '1'. An unset key must not read as off, or a fresh install
  // would silently ship the behaviour the toggle promises to have on.
  withOptIn(true, () => expect(newChatUltracodeEnabled()).toBe(true))
  withOptIn(false, () => expect(newChatUltracodeEnabled()).toBe(false))
  const before = getSetting(NEW_CHAT_ULTRACODE_KEY)
  setSetting(NEW_CHAT_ULTRACODE_KEY, '')
  try {
    expect(newChatUltracodeEnabled()).toBe(true)
  } finally {
    setSetting(NEW_CHAT_ULTRACODE_KEY, before)
  }
})

// THE ONE THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. Before the fix, this returned the prompt
// unchanged for every input and every setting value, because nothing read the setting at all.
test('a new chat opens with the keyword when the opt-in is on', () => {
  const out = withOptIn(true, () => newChatOpening('Ship the parser.'))
  expect(out).not.toBe('Ship the parser.')
  expect(out.startsWith('ultracode')).toBe(true)
  expect(out).toContain('Ship the parser.')
})

test('the prompt is untouched when the opt-in is off', () => {
  expect(withOptIn(false, () => newChatOpening('Ship the parser.'))).toBe('Ship the parser.')
})

test('a prompt that already asks for ultracode is not made to ask twice', () => {
  // The reviewer's rubric prepends the feed's `newChatPrefix` on its own native deliveries, and a
  // chip's text can carry the word for its own reasons. Either way, saying it again is noise.
  const already = 'ultracode\n\nShip the parser.'
  expect(withOptIn(true, () => newChatOpening(already))).toBe(already)
  const midSentence = 'Run this in ULTRACODE mode please.'
  expect(withOptIn(true, () => newChatOpening(midSentence))).toBe(midSentence)
})

test('a word merely containing the keyword is not mistaken for the opt-in', () => {
  // Word-boundary matched: "ultracoded" is not a request for ultracode, and treating it as one
  // would silently drop the opt-in from a chat that asked for it.
  const out = withOptIn(true, () => newChatOpening('Explain how ultracoded works.'))
  expect(out.startsWith('ultracode\n\n')).toBe(true)
})

test('an empty prompt stays empty rather than becoming a bare keyword', () => {
  // A launch with no prompt is a caller error or a deliberate no-op; either way "ultracode" alone
  // is not a task, and sending it would start a chat whose whole first turn is an opt-in marker.
  expect(withOptIn(true, () => newChatOpening(''))).toBe('')
  expect(withOptIn(true, () => newChatOpening('   '))).toBe('   ')
})

test('the keyword goes on its own line, so it is a marker and not part of the request', () => {
  const out = withOptIn(true, () => newChatOpening('Ship the parser.'))
  expect(out.split('\n')[0]).toBe('ultracode')
})
