// web/src/lib/home-charts.ts usableNow: the Instances landing's headline, "N of M accounts usable now".
// The count is a promise about who can take work right now, so the reset rule, an unread window and
// a signed-out account are the contract.
import { expect, test } from 'bun:test'
import { usableNow } from './home-charts'

const NOW = Date.now()
const HOUR = 3_600_000
/** A window `pct` used that resets `inHours` from NOW (negative: it already has). */
const win = (pct: number, inHours: number) => ({
  pct,
  resetsAt: new Date(NOW + inHours * HOUR).toISOString(),
})

test('usable now: either window used up holds an account back until it resets; no reading does not', () => {
  const counts = usableNow(
    [
      { signedIn: true, session: win(40, 2), week: win(60, 48) }, // usable
      { signedIn: true, session: win(100, 2), week: win(10, 48) }, // 5-hour used up
      { signedIn: true, session: win(5, 2), week: win(100, 48) }, // week used up
      { signedIn: true, session: win(100, -1), week: win(30, 48) }, // 5-hour already reset: usable
      { signedIn: true, session: null, week: undefined }, // never read: usable
      { signedIn: false, session: win(0, 2), week: win(0, 48) }, // signed out: never counted
    ],
    NOW,
  )
  expect(counts).toEqual({ signedIn: 5, spent: 2, usable: 3 })
})
