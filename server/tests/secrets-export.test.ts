// server/src/secrets.ts + session-resume.ts — the guardrail and the terminal hand-off.
//
// The secret tests pin two things that are easy to get subtly wrong and impossible to notice: that
// a redacted value cannot be reconstructed from what is left, and that a /g regex reused across
// calls does not skip every other match (the classic `lastIndex` bug — a scanner that silently
// finds half the secrets is worse than none, because the count reads as authoritative).
//
// The resume tests pin the argv for all three platforms from whichever one is running, the same way
// server/tests/transcript-open.test.ts does for the editor launch, including the two details that
// have already caused real bugs in this repo: `start`'s mandatory empty title argument, and keeping
// the window alive after the CLI exits.

import { describe, expect, test } from 'bun:test'
import { containsHighConfidenceSecret, redactSecrets, scanSecrets } from '../src/secrets'
import { buildResumePlan } from '../src/session-resume'

const AWS = 'AKIAIOSFODNN7EXAMPLE'
const TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz012345'
const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

describe('what counts as a secret', () => {
  test('the formats that are unmistakable are found', () => {
    expect(containsHighConfidenceSecret(`key=${AWS}`)).toBe(true)
    expect(containsHighConfidenceSecret(`use ${TOKEN} for now`)).toBe(true)
    expect(containsHighConfidenceSecret(`token ${GH}`)).toBe(true)
    expect(containsHighConfidenceSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true)
  })

  test('ordinary text is not a secret, which is the whole point of "high confidence"', () => {
    expect(containsHighConfidenceSecret('my password is hunter2')).toBe(false)
    expect(containsHighConfidenceSecret('a'.repeat(64))).toBe(false)
    expect(containsHighConfidenceSecret('sk-short')).toBe(false)
  })

  test('a repeated call finds the same thing, so a shared regex cannot skip matches', () => {
    const text = `${AWS} and ${AWS}`
    expect(scanSecrets(text)).toHaveLength(2)
    expect(scanSecrets(text)).toHaveLength(2)
    expect(containsHighConfidenceSecret(text)).toBe(true)
    expect(containsHighConfidenceSecret(text)).toBe(true)
  })

  test('findings come back in the order they appear', () => {
    const hits = scanSecrets(`first ${GH} then ${AWS}`)
    expect(hits.map((h) => h.kind)).toEqual(['github-token', 'aws-access-key-id'])
  })
})

describe('redaction keeps the shape and loses the value', () => {
  test('a token is identifiable but not usable', () => {
    const [hit] = scanSecrets(TOKEN)
    expect(hit?.redacted.startsWith('sk-')).toBe(true)
    expect(hit?.redacted).not.toContain('abcdefghij')
    expect(hit?.redacted.length).toBeLessThan(TOKEN.length)
  })

  test('a private key header keeps nothing at all', () => {
    const [hit] = scanSecrets('-----BEGIN RSA PRIVATE KEY-----')
    expect(hit?.redacted).toBe('[redacted private-key]')
  })

  test('redactSecrets rewrites in place and counts what it replaced', () => {
    const r = redactSecrets(`before ${AWS} middle ${GH} after`)
    expect(r.redacted).toBe(2)
    expect(r.text).toContain('before ')
    expect(r.text).toContain(' middle ')
    expect(r.text).toContain(' after')
    expect(r.text).not.toContain(AWS)
    expect(r.text).not.toContain(GH)
  })

  test('text with nothing in it is returned unchanged', () => {
    const r = redactSecrets('nothing to see')
    expect(r).toEqual({ text: 'nothing to see', redacted: 0 })
  })
})

describe('reopening a session in a terminal', () => {
  const ID = '4d1f0f6e-0000-4000-8000-000000000001'

  test('windows keeps start\u2019s empty title argument, and keeps the window open', () => {
    const plan = buildResumePlan('win32', ID, 'C:\\bin\\claude.exe', 'D:\\work')
    // ['cmd','/c','start','', 'cmd','/k', …] — dropping the '' makes start treat the quoted path
    // as a window TITLE and open an empty console instead.
    expect(plan.argv.slice(0, 6)).toEqual(['cmd', '/c', 'start', '', 'cmd', '/k'])
    expect(plan.argv[6]).toContain('--resume')
    expect(plan.argv[6]).toContain(ID)
  })

  test('a path with spaces is quoted, an ordinary one is not', () => {
    expect(buildResumePlan('win32', ID, 'C:\\Program Files\\claude.exe', null).command).toContain(
      '"C:\\Program Files\\claude.exe"',
    )
    expect(buildResumePlan('linux', ID, 'claude', null).command.startsWith('claude ')).toBe(true)
  })

  test('macOS drives Terminal.app and cds into the working directory when there is one', () => {
    const plan = buildResumePlan('darwin', ID, 'claude', '/Users/me/app')
    expect(plan.argv[0]).toBe('osascript')
    expect(plan.argv[2]).toContain('Terminal')
    expect(plan.argv[2]).toContain('/Users/me/app')
  })

  test('linux keeps the shell alive after the CLI exits', () => {
    const plan = buildResumePlan('linux', ID, 'claude', null)
    expect(plan.argv[0]).toBe('x-terminal-emulator')
    expect(plan.argv.at(-1)).toContain('exec bash')
  })

  test('an unknown platform still hands back the command, only the launch is unavailable', () => {
    const plan = buildResumePlan('aix', ID, 'claude', null)
    expect(plan.argv).toEqual([])
    expect(plan.command).toBe(`claude --resume ${ID}`)
  })
})
