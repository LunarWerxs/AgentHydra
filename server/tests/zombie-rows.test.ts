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

test('the localized more-options prefix is derived, not assumed', () => {
  // Found live on a German app: matching an English prefix made archive silently inert for
  // chats in plain view. The title is the invariant; the phrase in front of it is not - so the
  // prefix is derived from whatever decorates SEVERAL different chats.
  const rows = [row('s1', 'Fix 54 tests', true), row('s2', 'Burn down the fleet', true)]
  const de = ['Weitere Optionen für Fix 54 tests', 'Weitere Optionen für Burn down the fleet']
  expect(
    zombieCandidates(de, rows)
      .map((z) => z.sessionId)
      .sort(),
  ).toEqual(['s1', 's2'])
  const en = ['More options for Fix 54 tests', 'More options for Burn down the fleet']
  expect(
    zombieCandidates(en, rows)
      .map((z) => z.sessionId)
      .sort(),
  ).toEqual(['s1', 's2'])
})

// ⛔ THE SIDEBAR IS NOT ALL CHATS. Measured live: an effort selector rendering 'Effort: Ultracode'
// matched a chat genuinely titled 'Ultracode' under a bare endsWith, and the archive then refused
// as ambiguous on every single pass - a permanent phantom in the report. The real chat prefix is
// the one decorating SEVERAL different chats; a control decorates one value.
test('UI chrome that merely ends with a chat title is not a chat row', () => {
  const rows = [
    row('s-ultra', 'Ultracode', true),
    row('s-a', 'Fix 54 tests', true),
    row('s-b', 'Burn down the fleet', true),
  ]
  const rendered = [
    'Effort: Ultracode',
    'Effort: Ultracode',
    'More options for Fix 54 tests',
    'More options for Burn down the fleet',
  ]
  // Only the two real chat rows; the effort selector is chrome, whatever it ends with.
  expect(
    zombieCandidates(rendered, rows)
      .map((z) => z.sessionId)
      .sort(),
  ).toEqual(['s-a', 's-b'])
})

test('with no prefix decorating several chats, only exact-title rows count', () => {
  const rows = [row('s1', 'Fix 54 tests', true)]
  expect(zombieCandidates(['Fix 54 tests'], rows)).toHaveLength(1)
  // One decorated row for one title proves nothing about what the decoration means.
  expect(zombieCandidates(['Effort: Fix 54 tests'], rows)).toHaveLength(0)
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
  const rows = [
    row('dup', 'Burn down the fleet', true),
    row('dup', 'Burn down the fleet', true),
    row('other', 'A second chat', true),
  ]
  const rendered = ['More options for Burn down the fleet', 'More options for A second chat']
  expect(zombieCandidates(rendered, rows).filter((z) => z.sessionId === 'dup')).toHaveLength(1)
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
          ? { ok: true, titles: ['More options for Ghost chat', 'More options for Second chat'] }
          : { ok: false, titles: [], why: 'the sidebar read returned nothing at all' },
      scan: () => [row('s-ghost', 'Ghost chat', true), row('s-second', 'Second chat', false)],
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
    list: async () => ({
      ok: true,
      titles: ['More options for Stuck chat', 'More options for Another chat'],
    }),
    scan: () => [row('s-stuck', 'Stuck chat', true), row('s-other', 'Another chat', false)],
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

// ⛔ ZERO RUNNING APPS IS NOT A CLEAN FLEET. The first cut of the sweep wiring fell back to an
// empty instance list when its optional dep was absent - which it always was in the daemon - so
// the reconcile looked at nothing, found nothing, reported nothing unread, and read as clean.
// That is the exact lie this lane was built to remove, reproduced inside the fix for it. It
// shipped for one live run before the numbers gave it away: renderedSeen 0, unread none.
test('no running instances reconciles nothing and must not look clean', async () => {
  const r = await reconcileRenderedRows(
    [{ dir: 'C:/i/closed', name: 'closed', isRunning: false }],
    {
      list: async () => {
        throw new Error('must not be called for a closed instance')
      },
      scan: () => [],
      archive: async () => ({ clicked: false, verified: false }),
    },
  )
  // A closed app renders nothing by definition, so it is not "unread" - but nothing was
  // measured either, and renderedSeen says so honestly.
  expect(r.rows).toEqual([])
  expect(r.renderedSeen).toBe(0)
})

// ⛔ A TITLE IS NOT AN IDENTITY. Measured live: two retired chats named 'Orchestrate' were
// reported stranded on every pass, matched against the single rendered 'Orchestrate' row - which
// belonged to the RUNNING orchestrator session. The archive then refused, correctly and forever.
// The detection was the wrong half: nothing was stuck, so nothing should have been claimed.
test('a rendered row whose title is also carried by a LIVE chat is not a zombie', () => {
  const rows = [
    row('s-old-1', 'Orchestrate', true),
    row('s-old-2', 'Orchestrate', true),
    row('s-running', 'Orchestrate', false), // the live session, same name
    row('s-real', 'Fix 54 tests', true),
    row('s-anchor', 'Another chat', false),
  ]
  const rendered = [
    'More options for Orchestrate',
    'More options for Fix 54 tests',
    'More options for Another chat',
  ]
  // Only the genuinely stranded one. The Orchestrate row is the live chat's own row.
  expect(zombieCandidates(rendered, rows).map((z) => z.sessionId)).toEqual(['s-real'])
})
