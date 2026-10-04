// The failure ledger's classifier, over the real messages of 2026-10-04 (emails masked), and its masking.

import { expect, test } from 'bun:test'
import { classifyFailure } from '../../src/engine/failures'
import { maskEmails } from '../../src/engine/diagnostics'

test('the classifier names the cause of each real failure', () => {
  const cases: [string, ReturnType<typeof classifyFailure>, Parameters<typeof classifyFailure>[1]?][] = [
    ['Failed to authenticate: OAuth session expired', 'auth_expired'],
    ['Your organization has disabled Claude subscription access for Claude Code', 'org_disabled'],
    ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null', 'interrupted'],
    ['Claude usage limit reached. Your limit will reset at 3pm', 'usage_limit'],
    ['pictures cannot be sent', 'refused_send'],
    ['Hook branch-guard.mjs (SessionStart) failed: timed out after 10s', 'hook_timeout'],
    ['Hook origin-drift-tripwire.mjs (SessionStart) failed (exit 1): boom', 'hook_failed'],
    ['fetch failed: ECONNRESET', 'network'],
    ['Tool use concurrency issues: invalid request body', 'unknown'],
    ['The worker failed.', 'worker_failed', 'worker_failed'],
  ]
  for (const [text, cause, fallback] of cases) expect(classifyFailure(text, fallback)).toBe(cause)
})

test('emails are masked', () => {
  expect(maskEmails('login for someone@example.com failed, see a.b+c@mail.example.org')).toBe('login for <email> failed, see <email>')
})
