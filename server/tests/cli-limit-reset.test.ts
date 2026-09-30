// server/tests/cli-limit-reset.test.ts — reading the CLI's /limit-reset answer off its screen.
//
// The CLI draws with cursor moves, so the screen text AgentHydra reads has its spaces missing and
// other screen content run into the answer. The first real run (2026-09-30, instance #83) came
// back as "resetisn'tavailablerightnow.◐ medium · /effort" and was shown to the owner verbatim.
// These pin that such text still maps to the right outcome, a clean sentence and a readable date.
import { expect, test } from 'bun:test'
import { classifyLimitResetScreen, dateAfter } from '../src/core/cli-limit-reset'

test('the real space-less "not available" screen maps to unavailable with a clean sentence', () => {
  const hit = classifyLimitResetScreen(
    "❯ /limit-reset \n  ⎿  Asession-limitresetisn'tavailablerightnow. · ← for agents◐ medium · /effort",
  )
  expect(hit?.outcome).toBe('unavailable')
  expect(hit?.say).toBe("A reset isn't available for this account right now.")
})

test('a spent weekly reset maps to used, and its date is respaced', () => {
  const screen = '⎿  Weeklyresetused·availableagainOct7,6pm · ← for agents'
  expect(classifyLimitResetScreen(screen)?.outcome).toBe('used')
  expect(dateAfter(screen)).toBe('Oct 7, 6pm')
})

test('a reset that went through maps to reset', () => {
  const screen =
    '⎿  Session limit reset · next reset available Oct 14 · your weekly limit still applies'
  expect(classifyLimitResetScreen(screen)?.outcome).toBe('reset')
  expect(dateAfter(screen)).toBe('Oct 14')
})
