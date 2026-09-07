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
  const dropLines = usageService.split('\n').filter((l) => l.includes('dropCachedUsage('))
  expect(dropLines.length).toBeGreaterThan(0)
  for (const line of dropLines) expect(line).toContain('if (')
})

test('pressing Log out clears the numbers immediately, not at the next check', () => {
  // The routes serve the cache before checking, so waiting for "the next check" means waiting for
  // the 30-minute sweep - during which the row still shows a signed-out account's quota.
  expect(instancesRoute).toContain('dropCachedUsage(desktopKey(dir))')
})
