// web/tests/privacy.test.ts - the privacy-mode mask (web/src/lib/privacy.ts) and the rule for
// instance names (web/src/composables/usePrivacy.ts).
//
// The mask runs over transcript HTML, so it must hide an address and never touch anything else.

import { afterEach, expect, test } from 'bun:test'
import { piiDisplayName } from '../src/composables/usePrivacy'
import { privacyMode } from '../src/composables/useUiPrefs'
import type { CMInstance } from '../src/lib/api'
import { maskEmails } from '../src/lib/privacy'

afterEach(() => {
  privacyMode.value = false
})

test('an address shows only its first letters, and text with none is unchanged', () => {
  const cases: [string, string][] = [
    ['42alpha99@example.com', '4•••@e•••.com'],
    ['a.b@mail.example.co.uk', 'a•••@m•••.uk'],
    ['signed in as jo@x.io today', 'signed in as j•••@x•••.io today'],
    ['jo@x.io and al@y.dev', 'j•••@x•••.io and a•••@y•••.dev'],
    ['npm i @scope/pkg@1.2.3', 'npm i @scope/pkg@1.2.3'],
    ['no address here', 'no address here'],
  ]
  for (const [input, expected] of cases) expect(maskEmails(input)).toBe(expected)
})

test('an instance named after its account is masked whole; a typed label loses only an address', () => {
  const inst = (label: string | null, account: { email: string; name: string } | null) =>
    ({ name: '5claude', label, account }) as Pick<CMInstance, 'name' | 'label' | 'account'>
  const daniel = inst(null, { email: 'daniel@x.io', name: '' })
  const cases: [Pick<CMInstance, 'name' | 'label' | 'account'>, string][] = [
    [inst('Work', { email: 'jo@x.io', name: 'Jo' }), 'Work'],
    [inst('jo@x.io', null), 'j•••@x•••.io'],
    // The handle has no '@' for the address mask to find: it is the account all the same.
    [daniel, 'd•••'],
    [inst(null, { email: 'jo@x.io', name: 'Jo Smith' }), 'J•••'],
    [inst(null, null), '5claude'],
  ]
  privacyMode.value = true
  for (const [i, expected] of cases) expect(piiDisplayName(i)).toBe(expected)
  privacyMode.value = false
  expect(piiDisplayName(daniel)).toBe('daniel')
})
