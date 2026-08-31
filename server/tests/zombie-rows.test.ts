// server/tests/zombie-rows.test.ts - the rows the owner sees and the gate does not.
//
// Measured on the live fleet 2026-08-31: the owner reported ~10 chats in one account's sidebar
// while a whole-fleet sweep reported six chats total. Both were reading honestly, from different
// sources. Two chats in that account were flagged archived on disk - so every sweep filtered them
// out - while the running app went on rendering them, because the app holds its list in memory
// and only the UI click removes a row. A failed click therefore strands a chat somewhere nothing
// can reach: archived, so never re-gated; rendered, so still the owner's problem.
import { expect, test } from 'bun:test'
import { reconcileRenderedRows, zombieCandidates } from '../src/zombie-rows'

const row = (sessionId: string, title: string | null, archived: boolean) => ({
  sessionId,
  title,
  archived,
  path: `C:/store/local_${sessionId}.json`,
})

test('a rendered row that disk calls archived is a zombie; a live one is not', () => {
  const rendered = [
    'More options for Fix 54 tests with dates hardcoded into them',
    'More options for Burn down the fleet',
    'Filter',
  ]
  const rows = [
    row('s-zombie', 'Fix 54 tests with dates hardcoded into them', true),
    row('s-live', 'Burn down the fleet', false),
    // Archived AND not on screen: correctly gone, nothing to do.
    row('s-gone', 'Something already cleared', true),
  ]
  expect(zombieCandidates(rendered, rows).map((z) => z.sessionId)).toEqual(['s-zombie'])
})

test('the localized more-options prefix cannot break the match', () => {
  // Found live on a German app: matching an English prefix made archive silently inert for
  // chats in plain view. The title is the invariant; the phrase in front of it is not.
  const rows = [row('s1', 'Fix 54 tests', true)]
  expect(zombieCandidates(['Weitere Optionen für Fix 54 tests'], rows)).toHaveLength(1)
  expect(zombieCandidates(['More options for Fix 54 tests'], rows)).toHaveLength(1)
  expect(zombieCandidates(['Fix 54 tests'], rows)).toHaveLength(1)
})

test('a generic or missing title never matches - a generic row could be any chat', () => {
  expect(
    zombieCandidates(
      ['More options for General coding session'],
      [row('s1', 'General coding session', true)],
    ),
  ).toEqual([])
  expect(zombieCandidates(['More options for x'], [row('s2', null, true)])).toEqual([])
})

test('duplicate rows for one chat yield ONE candidate, not two clicks at the same chat', () => {
  // A re-surfaced chat writes a second metadata file under the same session id - the exact case
  // that made a chat undeliverable earlier tonight. Archiving it twice is not better.
  const rows = [row('dup', 'Burn down the fleet', true), row('dup', 'Burn down the fleet', true)]
  expect(zombieCandidates(['More options for Burn down the fleet'], rows)).toHaveLength(1)
})

// ⛔ AN UNREADABLE SIDEBAR IS NOT AN EMPTY ONE. Measured: two of four running instances returned
// zero rows from a read that plainly had not worked. Counting those as clean would rebuild the
// same lie - a report saying everything is fine because nothing could be checked.
test('an instance whose sidebar cannot be read is reported UNREAD, never as clean', async () => {
  const archived: string[] = []
  const r = await reconcileRenderedRows(
    [
      { dir: 'C:/i/readable', name: 'readable', isRunning: true },
      { dir: 'C:/i/broken', name: 'broken', isRunning: true },
      { dir: 'C:/i/closed', name: 'closed', isRunning: false },
    ],
    {
      list: async (dir) =>
        dir.endsWith('readable')
          ? { ok: true, titles: ['More options for Ghost chat'] }
          : { ok: false, titles: [], why: 'the sidebar read returned nothing at all' },
      scan: () => [row('s-ghost', 'Ghost chat', true)],
      archive: async (_dir, id) => {
        archived.push(id)
        return { clicked: true, verified: true }
      },
    },
  )
  expect(archived).toEqual(['s-ghost'])
  expect(r.rows[0]?.action).toBe('cleared')
  // The broken one is named. The CLOSED one is not - a closed app renders nothing by definition.
  expect(r.unreadInstances.map((u) => u.instance)).toEqual(['broken'])
})

test('an archive that does not stick is reported still-rendered, never as cleared', async () => {
  const r = await reconcileRenderedRows([{ dir: 'C:/i/a', name: 'a', isRunning: true }], {
    list: async () => ({ ok: true, titles: ['More options for Stuck chat'] }),
    scan: () => [row('s-stuck', 'Stuck chat', true)],
    archive: async () => ({ clicked: false, verified: false, reason: 'kebab not found' }),
  })
  expect(r.rows[0]?.action).toBe('still-rendered')
  expect(r.rows[0]?.why).toContain('kebab not found')
})

test('the per-pass cap reports what it skipped instead of implying it was clean', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`s${i}`, `Chat ${i}`, true))
  const r = await reconcileRenderedRows([{ dir: 'C:/i/a', name: 'a', isRunning: true }], {
    list: async () => ({ ok: true, titles: rows.map((x) => `More options for ${x.title}`) }),
    scan: () => rows,
    archive: async () => ({ clicked: true, verified: true }),
    maxPerPass: 2,
  })
  expect(r.rows.filter((x) => x.action === 'cleared')).toHaveLength(2)
  expect(r.rows.filter((x) => x.action === 'over-cap')).toHaveLength(3)
})
