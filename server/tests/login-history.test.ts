// server/tests/login-history.test.ts — an account's identity outlives the profile it was cached on.
//
// instances-cache.json drops a profile's identity the moment its login changes (the stale-login
// guard, a logout), which is right for the row and used to erase the only record of who that
// account was. #75 (2026-09-28) switched accounts and read "(unknown account)" with no trace of
// where its previous login went. These pin the two halves of the fix: the login history still
// names the account a profile was on before, and an account identified on one profile names it on
// another.
//
// CCMANAGERUI_HOME is redirected to a temp dir by tests/setup.ts, so the real cache and the
// known-accounts store written here are throwaway.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { resolveAccount } from '../src/core/accounts'
import { instanceNumberFor } from '../src/core/instance-numbers'
import { readLoginHistory } from '../src/core/login-history'
import { accountsCacheFile, normalizeInstancePath } from '../src/core/paths'

const OLD = '33333333-cccc-4ccc-8ccc-333333333333'
const NEW = '44444444-dddd-4ddd-8ddd-444444444444'
const ELSEWHERE = '55555555-eeee-4eee-8eee-555555555555'

const tmpDirs: string[] = []

function profile(signedInto: string | null): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'cmui-login-history-'))
  tmpDirs.push(dir)
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(signedInto ? { lastKnownAccountUuid: signedInto } : {}),
  )
  return dir
}

/** One chat record filed under `account` in the profile's chat store, last touched at `at`. */
function chat(dir: string, account: string, id: string, at: Date): void {
  const orgDir = join(dir, 'claude-code-sessions', account, 'org-1')
  mkdirSync(orgDir, { recursive: true })
  const file = join(orgDir, `local_${id}.json`)
  writeFileSync(file, '{}')
  utimesSync(file, at, at)
}

/** An identity cached for `dir` the way a live resolve before the known-accounts store left it. */
function cached(dir: string, uuid: string, email: string): void {
  const file = accountsCacheFile()
  const cache: Record<string, unknown> = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : {}
  cache[normalizeInstancePath(dir)] = {
    email,
    name: null,
    plan: 'max',
    rateLimitTier: 'default_claude_max_5x',
    uuid,
    orgUuid: 'org-1',
    orgName: null,
    resolvedAt: new Date().toISOString(),
  }
  writeFileSync(file, JSON.stringify(cache))
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('login history', () => {
  test('names the account a profile was on before it signed into another', async () => {
    const dir = profile(NEW)
    chat(dir, OLD, 'a', new Date('2026-09-28T04:57:00Z'))
    chat(dir, NEW, 'b', new Date('2026-09-28T06:34:00Z'))
    cached(dir, OLD, 'before@example.com')
    const movedToDir = profile(OLD)
    chat(movedToDir, OLD, 'c', new Date('2026-09-28T07:00:00Z'))
    const movedTo = instanceNumberFor('desktop', movedToDir)

    // The stale-login guard drops OLD's identity from this profile's cache...
    expect((await resolveAccount(dir, { noNetwork: true })).email).toBeNull()

    // ...but the history still says who was here, current login first, and where OLD went.
    const { entries, loginState } = readLoginHistory(dir)
    expect(loginState).toBe('signed-in')
    expect(entries.map((e) => [e.accountUuid, e.current, e.email, e.signedInOn, e.usedOn])).toEqual(
      [
        [NEW, true, null, [], []],
        [OLD, false, 'before@example.com', [movedTo], [movedTo]],
      ],
    )
    expect(entries[1].lastSeenAt).toBe('2026-09-28T04:57:00.000Z')
    expect(entries[1].chats).toBe(1)
  })

  test('an account identified on one profile is named on another it signs into', async () => {
    cached(profile(ELSEWHERE), ELSEWHERE, 'shared@example.com')
    const dir = profile(ELSEWHERE)

    const account = await resolveAccount(dir, { noNetwork: true })

    expect(account.email).toBe('shared@example.com')
    expect(account.status).toBe('cache')
  })
})
