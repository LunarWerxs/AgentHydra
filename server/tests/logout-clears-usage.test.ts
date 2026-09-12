// ⛔ OWNER RULE (Michael, 2026-09-07): *"when I log out... when the account is not logged in, it
// should reset and clear the usage data, session, weekly, five-hour."*
//
// Why this needs pinning rather than trusting the code to stay right: NOT caching the signed-out
// no-data result already looked correct, and was not enough. The PREVIOUS reading stayed in the
// cache, and every usage route serves the cache before it checks anything, so a signed-out row kept
// showing the old account's percentages indefinitely. The bug is an absence - a missing drop - and
// absences do not announce themselves in review.
//
// checkUsageForDesktop reaches real decryption, real process listing and the real accounts cache,
// so it cannot be driven from a unit test without mocking half the daemon. These assert on the
// source instead: narrow, but they fail loudly if either drop is removed, which is the whole
// regression. The paired negative assertion matters just as much - a failed CHECK must keep the
// last good reading, because ignorance is not absence and blanking a row on a network blip would
// be its own bug.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const usageService = readFileSync(join(SRC, 'usage-service.ts'), 'utf8')
const instancesRoute = readFileSync(join(SRC, 'routes', 'instances.ts'), 'utf8')

test('a signed-out DESKTOP instance drops its cached usage', () => {
  expect(usageService).toContain("if (reason === 'logged_out') dropCachedUsage(key)")
})

test('a signed-out CLI instance drops its cached usage', () => {
  expect(usageService).toContain('if (!hasAnyCredential) dropCachedUsage(key)')
})

test('the drop is conditional - a FAILED check must keep the last good reading', () => {
  // The failure this guards against is someone "simplifying" the condition away and clearing the
  // cache on every no-data result. A network blip would then blank every row on the board.
  //
  // GUARDED, not "has `if (` on the same line". That cheaper spelling was a proxy for the real
  // invariant and it went false-red the first time a legitimate drop moved INSIDE a block rather
  // than onto a conditional line - checkUsageForCodex's cached-read path, which drops an entry
  // belonging to a DIFFERENT account and is conditional by virtue of the `else if (!refresh)` it
  // sits in. A guard that fails on correct code gets deleted by the next person in a hurry, and
  // then the regression it existed for ships unnoticed; that is strictly worse than no guard.
  const drops = guardedDrops(usageService)
  expect(drops.length).toBeGreaterThan(0)
  for (const drop of drops) expect(drop.guarded).toBe(true)
})

test('that guard still fails on the regression it exists for', () => {
  // A guard whose only evidence is its own green is not evidence. These two snippets are the
  // before/after of the actual bug: an unconditional drop on a no-data path must be caught, and a
  // drop that a block makes conditional must not be.
  const unconditional = `function check() {
  const key = 'k'
  dropCachedUsage(key)
  return null
}`
  const blockConditional = `function check() {
  const key = 'k'
  if (local.authMode !== 'chatgpt') dropCachedUsage(key)
  else if (!refresh) {
    const cached = getCachedUsage(key)
    if (cached) return cached
    dropCachedUsage(key)
  }
}`
  expect(guardedDrops(unconditional).map((d) => d.guarded)).toEqual([false])
  expect(guardedDrops(blockConditional).map((d) => d.guarded)).toEqual([true, true])
})

/**
 * Every `dropCachedUsage(` call in the source, with whether a condition governs it.
 *
 * Guarded means one of two things: the call's own line carries an `if (`, or the call is lexically
 * inside a block that an `if` / `else` opened. Brace counting is enough here because the only
 * verdict that matters is "could this run unconditionally on a failed check", and a drop sitting at
 * a function's top level is exactly the shape that could.
 */
function guardedDrops(source: string): Array<{ line: string; guarded: boolean }> {
  const out: Array<{ line: string; guarded: boolean }> = []
  // Depth of open `{` blocks, and which of those depths a conditional opened.
  let depth = 0
  const conditionalDepths = new Set<number>()
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('*') || line.startsWith('//')) continue
    const opensConditional = /^\}?\s*(else\b|\bif\s*\()/.test(line) && line.includes('{')
    if (line.includes('dropCachedUsage('))
      out.push({ line, guarded: line.includes('if (') || conditionalDepths.size > 0 })
    for (const ch of raw) {
      if (ch === '{') {
        depth++
        if (opensConditional) conditionalDepths.add(depth)
      } else if (ch === '}') {
        conditionalDepths.delete(depth)
        depth--
      }
    }
  }
  return out
}

test('pressing Log out clears the numbers immediately, not at the next check', () => {
  // The routes serve the cache before checking, so waiting for "the next check" means waiting for
  // the 30-minute sweep - during which the row still shows a signed-out account's quota.
  expect(instancesRoute).toContain('dropCachedUsage(desktopKey(dir))')
})
