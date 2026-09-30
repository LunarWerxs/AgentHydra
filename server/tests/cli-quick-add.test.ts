// server/tests/cli-quick-add.test.ts — the Quick add code box takes the page's final code only.
//
// Owner, 2026-09-30: the 6-digit code from the sign-in email was pasted into Quick add's box, which
// wrote it to the CLI's code prompt, and the sign-in quietly went nowhere. The CLI wants the long
// "code#state" the sign-in page ends on; the email code belongs on the page. So a short all-digit
// entry is refused with a message saying where it goes, before anything reaches the CLI.
import { expect, test } from 'bun:test'
import { submitQuickAddCode } from '../src/core/cli-quick-add'

test('the email code is refused with where it belongs, before any flow is looked up', () => {
  const r = submitQuickAddCode('no-such-flow', ' 343725 ')
  expect(r.ok).toBe(false)
  expect(r.message).toContain('code from your email')
})

test('a long page code still goes through to the flow lookup', () => {
  expect(submitQuickAddCode('no-such-flow', 'abcDEF123#state456')).toEqual({
    ok: false,
    message: 'No such sign-in.',
  })
})
