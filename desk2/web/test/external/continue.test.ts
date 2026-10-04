import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountInfo, AccountRef } from '@shared/protocol'
import { continueLine, knownResumeAccount } from '../../src/components/external/logic'

const account = (id: string, label: string): AccountInfo => ({
  id,
  label,
  configDir: `C:/cli/${id}`,
  email: null,
  plan: null,
  signedIn: true,
  fiveHourPct: null,
  weeklyPct: null,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  inUse: false
})

const sue = account('cli-35', '#35 sue (Max 20x)')
const eek = account('cli-68', '#68 eek <eek@example.com> (Pro)')
const landing: AccountRef = { id: 'cli-132', label: '#132 bob (Pro)', configDir: 'C:/cli/cli-132', number: 132 }
const defaultLogin: AccountRef = { id: 'default', label: 'Default login', configDir: null }

describe('the line over an outside session’s composer, before its first message', () => {
  test('held by a CLI instance: it continues in place there', () => {
    const s = { accountId: 'cli-35' }
    expect(continueLine(s, knownResumeAccount(s, [sue, eek], undefined, null))).toBe('Continues in place on #35 sue.')
  })

  test('held by none: a copy on the account it lands on; the original stays', () => {
    const s = { accountId: null }
    expect(continueLine(s, knownResumeAccount(s, [sue, eek], undefined, landing))).toBe('Continues as a copy on #132 bob. The original stays as it is.')
  })

  test('an account picked in the title bar wins, and moving off the holder makes it a copy (never an email)', () => {
    expect(continueLine({ accountId: null }, knownResumeAccount({ accountId: null }, [sue, eek], 'cli-35', landing))).toBe('Continues as a copy on #35 sue. The original stays as it is.')
    expect(continueLine({ accountId: 'cli-35' }, knownResumeAccount({ accountId: 'cli-35' }, [sue, eek], 'cli-68', null))).toBe('Continues as a copy on #68 eek. The original stays as it is.')
    // Auto is no account of its own: the landing again
    expect(knownResumeAccount({ accountId: null }, [sue], 'auto', landing)).toEqual(landing)
  })

  test('landing on the default login, it says no account has room (the server refuses it)', () => {
    expect(continueLine({ accountId: null }, defaultLogin)).toBe('No account has room to continue this session now.')
  })

  test('the default login picked in the title bar is where it goes, not a lack of room', () => {
    expect(continueLine({ accountId: null }, defaultLogin, true)).toBe('Continues as a copy on Default login. The original stays as it is.')
  })

  test('held by a signed-out CLI instance: not in place there, a copy where it lands', () => {
    const out = { ...sue, signedIn: false }
    const s = { accountId: 'cli-35' }
    expect(knownResumeAccount(s, [out, eek], undefined, landing)).toEqual(landing)
    expect(continueLine(s, knownResumeAccount(s, [out, eek], undefined, landing))).toBe('Continues as a copy on #132 bob. The original stays as it is.')
    // nothing until the landing is known, never "in place" on the signed-out login
    expect(knownResumeAccount(s, [out, eek], undefined, null)).toBeNull()
  })

  test('the landing is asked again when the accounts arrive or a sign-in changes', () => {
    const view = readFileSync(join(import.meta.dir, '../../src/components/external/ExternalSessionView.vue'), 'utf8')
    expect(view).toContain('src.accounts.value.map((a) => `${a.id}:${a.signedIn}`)')
    expect(view).toContain('!holderOf({ accountId: owner }, src.accounts.value)')
  })

  test('nothing while the account is not known yet', () => {
    expect(knownResumeAccount({ accountId: null }, [sue], undefined, null)).toBeNull()
    expect(continueLine({ accountId: null }, null)).toBe('')
  })
})
