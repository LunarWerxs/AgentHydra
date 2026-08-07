// web/tests/instance-appearance.test.ts — what an instance is CALLED (web/src/lib/instance-appearance.ts).
//
// The precedence is the whole point and it is load-bearing: an explicit label the user typed beats
// everything, then the account the profile is actually signed into, and only then the folder name.
// The folder is last because it is the one that lies — the machine this was built against had a
// folder named `claude` signed into 6claude@lunarwerx.com, and two folders (3claude/4claude) whose
// accounts were the other way round. Nothing detects that drift, so the folder cannot be trusted
// ahead of a resolved identity.
//
// displayName() takes Pick<CMInstance, 'name' | 'label' | 'account'>, so instances are built by hand
// here rather than going through the API — these are pure functions over three fields.

import { describe, expect, test } from 'bun:test'
import type { CMAccount } from '../../server/src/core/shared'
import { accountName, displayName, loginChanged } from '../src/lib/instance-appearance'

/** A CMAccount is 12 fields and these functions read exactly two — build from a base so each test
 *  states only the field it is actually about. */
function account(patch: Partial<CMAccount> = {}): CMAccount {
  return {
    status: 'live',
    email: null,
    name: null,
    plan: null,
    rateLimitTier: null,
    orgType: null,
    planLabel: null,
    accountUuid: null,
    orgUuid: null,
    orgName: null,
    source: 'live',
    label: '(unknown account)',
    ...patch,
  }
}

/** The logged-out shape resolveAccount() really returns: a non-empty label, but no identity behind
 *  it (server/src/core/accounts.ts). The label must NOT become a name. */
const LOGGED_OUT = account({ status: 'loggedout', label: '(not logged in)' })

describe('accountName', () => {
  test('prefers the profile name', () => {
    expect(accountName(account({ name: 'LunarWerx', email: 'lunawerx@gmail.com' }))).toBe(
      'LunarWerx',
    )
  })

  test("falls back to the email's local part when there is no name", () => {
    expect(accountName(account({ email: '6claude@lunarwerx.com' }))).toBe('6claude')
  })

  test('is null for null/undefined, and for an account carrying no identity', () => {
    expect(accountName(null)).toBeNull()
    expect(accountName(undefined)).toBeNull()
    expect(accountName(account())).toBeNull()
    // Logged out resolves with a LABEL but no identity — the label is not a name.
    expect(accountName(LOGGED_OUT)).toBeNull()
  })

  test('treats a whitespace-only name as absent and moves on to the email', () => {
    expect(accountName(account({ name: '   ', email: '5claude@lunarwerx.com' }))).toBe('5claude')
  })

  test('is null when the email is whitespace-only or has no local part', () => {
    expect(accountName(account({ email: '   ' }))).toBeNull()
    expect(accountName(account({ email: '@lunarwerx.com' }))).toBeNull()
  })

  test('handles an email-shaped string with no @ by using the whole thing', () => {
    expect(accountName(account({ email: 'not-an-email' }))).toBe('not-an-email')
  })
})

describe('loginChanged', () => {
  const A = 'aaaa-1111'
  const B = 'bbbb-2222'

  test('is true when the instance is signed into a different account than the one shown', () => {
    expect(loginChanged({ loginUuid: B, account: account({ accountUuid: A }) })).toBe(true)
  })

  test('is false while the shown identity still matches the login', () => {
    expect(loginChanged({ loginUuid: A, account: account({ accountUuid: A }) })).toBe(false)
  })

  test('is false whenever either side is unknown', () => {
    // Nothing resolved yet — already being chased, so this must not also count as drift.
    expect(loginChanged({ loginUuid: A, account: null })).toBe(false)
    expect(loginChanged({ loginUuid: A, account: account({ accountUuid: null }) })).toBe(false)
    // Signed out (or an unreadable config.json): no uuid to disagree with.
    expect(loginChanged({ loginUuid: null, account: account({ accountUuid: A }) })).toBe(false)
    expect(loginChanged({ loginUuid: null, account: LOGGED_OUT })).toBe(false)
  })
})

describe('displayName', () => {
  test('an explicit label wins over both the account and the folder', () => {
    const name = displayName({
      name: '3claude',
      label: 'My Main',
      account: account({ name: '4claude', email: '4claude@lunarwerx.com' }),
    })
    expect(name).toBe('My Main')
  })

  test('the account beats the folder — the real 6claude-in-a-folder-called-claude case', () => {
    const name = displayName({
      name: 'claude',
      label: null,
      account: account({ email: '6claude@lunarwerx.com' }),
    })
    expect(name).toBe('6claude')
  })

  test('the folder name is the last resort, not the first choice', () => {
    expect(displayName({ name: 'work', label: null, account: null })).toBe('work')
    // Logged out is still "no identity" — fall through to the folder rather than showing a label
    // that reads "(not logged in)" as if it were the instance's name.
    expect(displayName({ name: 'work', label: null, account: LOGGED_OUT })).toBe('work')
  })

  test('a whitespace-only label does not shadow the account', () => {
    const name = displayName({
      name: 'folder',
      label: '   ',
      account: account({ name: 'LunarWerx' }),
    })
    expect(name).toBe('LunarWerx')
  })

  test('a label is trimmed rather than shown with its padding', () => {
    expect(displayName({ name: 'folder', label: '  Spaced  ', account: null })).toBe('Spaced')
  })

  test('two instances on one account share a name — the dir is what disambiguates them', () => {
    const shared = account({ name: '4claude', email: '4claude@lunarwerx.com' })
    expect(displayName({ name: 'a', label: null, account: shared })).toBe('4claude')
    expect(displayName({ name: 'b', label: null, account: shared })).toBe('4claude')
  })
})
