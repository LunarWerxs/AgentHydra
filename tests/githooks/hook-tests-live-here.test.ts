// tests/githooks/hook-tests-live-here.test.ts - no test file may sit under .githooks/.
//
// `bun test` does not descend into dot-directories. The AH-24 kit-sync hook suite was written at
// .githooks/tests/check-kit-sync-staged.test.ts on 2026-09-06, passed whenever someone named it by
// path, and was never once collected by `bun run test` or CI: a green suite that had two fewer
// tests in it than the tree suggested. Found 2026-09-12 when two more hook suites were about to be
// parked beside it. All three live here now, and this guard fails the moment one goes back.

import { expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../repo-root'

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

function testFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...testFilesUnder(full))
    else if (TEST_FILE.test(entry.name)) out.push(full)
  }
  return out
}

test('no test file hides under .githooks/ where bun test would never collect it', () => {
  expect(testFilesUnder(join(REPO_ROOT, '.githooks'))).toEqual([])
})
