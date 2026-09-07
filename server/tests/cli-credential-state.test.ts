// cliConfigDirCredentialState decides whether a `claude -p "/usage"` spawn can POSSIBLY
// authenticate. Getting it wrong is expensive in both directions: too eager and the daemon fires a
// ~9s process every 30 seconds forever (the MPC-HELL storm, 2026-09-07); too strict and a working
// account silently stops being read and its quota reads as unknown.
//
// So the rule is: answer 'dead' only on PROOF. These pin every branch, including the ones where
// ignorance must not be mistaken for proof.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliConfigDirCredentialState } from '../src/core/accounts'

const HOUR = 3_600_000

function dirWith(creds: unknown | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-cred-'))
  if (creds !== null) writeFileSync(join(dir, '.credentials.json'), JSON.stringify(creds))
  return dir
}

test('a live access token is usable, so the API path takes it and nothing spawns', () => {
  const dir = dirWith({ claudeAiOauth: { accessToken: 't', expiresAt: Date.now() + HOUR } })
  expect(cliConfigDirCredentialState(dir)).toBe('usable')
})

test('an expired access token with a live refresh token is refreshable - the CLI can fix itself', () => {
  const dir = dirWith({
    claudeAiOauth: {
      accessToken: 't',
      expiresAt: Date.now() - HOUR,
      refreshTokenExpiresAt: Date.now() + HOUR,
    },
  })
  expect(cliConfigDirCredentialState(dir)).toBe('refreshable')
})

test('both tokens expired is DEAD - the exact ambient leftover that caused the storm', () => {
  // expiresAt 0 is not "never expires"; it is an expiry that was never written, and every observed
  // one has been dead. This is byte-for-byte the shape found in ~/.claude on MPC-HELL.
  const dir = dirWith({
    claudeAiOauth: {
      accessToken: 't',
      expiresAt: 0,
      refreshTokenExpiresAt: Date.now() - 30 * 24 * HOUR,
    },
  })
  expect(cliConfigDirCredentialState(dir)).toBe('dead')
})

test('no credentials file is ABSENT, not dead - the spawn may still authenticate from env', () => {
  expect(cliConfigDirCredentialState(dirWith(null))).toBe('absent')
})

test('an unknown refresh expiry is never proof of death', () => {
  // Ignorance is not proof. A file that simply never recorded a refresh expiry must keep working.
  const dir = dirWith({ claudeAiOauth: { accessToken: 't', expiresAt: Date.now() - HOUR } })
  expect(cliConfigDirCredentialState(dir)).toBe('refreshable')
})

test('unreadable, empty, or malformed credentials answer ABSENT, never DEAD', () => {
  const bad = mkdtempSync(join(tmpdir(), 'ah-cred-'))
  writeFileSync(join(bad, '.credentials.json'), '{not json')
  expect(cliConfigDirCredentialState(bad)).toBe('absent')

  const empty = mkdtempSync(join(tmpdir(), 'ah-cred-'))
  writeFileSync(join(empty, '.credentials.json'), '   ')
  expect(cliConfigDirCredentialState(empty)).toBe('absent')

  expect(cliConfigDirCredentialState(dirWith({ claudeAiOauth: { expiresAt: 0 } }))).toBe('absent')
  expect(cliConfigDirCredentialState('')).toBe('absent')
})
