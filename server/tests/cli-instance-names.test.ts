// server/tests/cli-instance-names.test.ts — a CLI instance AgentHydra named is named after its account.
//
// The contract (core/cli-instances.ts nameCliInstancesByAccount, run by the desktop pairing's minute pass,
// and hydrate): an instance pairing made ("<desktop label> (CLI)") is renamed to the email its login is
// signed in as, and every read carries that email and the account's name for the window's hover (owner,
// 2026-10-09: "Those at least need to show their email address, and then ... the account name when I hover
// over it"). A name a person gave, or one with no desktop behind it, is never touched. CONFIG_DIR is a temp
// folder (tests/setup.ts); the login files are invented.

import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  linkCliInstanceToDesktop,
  nameCliInstancesByAccount,
  renameCliInstance,
} from '../src/core/cli-instances'

const made: string[] = []
afterAll(() => {
  for (const id of made) deleteCliInstance(id, getCliInstance(id)?.name ?? '')
})

/** A CLI instance signed in as `email`, linked to a desktop folder when `desktop` is given. */
function signedIn(name: string, email: string, desktop?: string): string {
  const id = randomUUID()
  expect(createCliInstance(name, { id }).ok).toBe(true)
  made.push(id)
  const dir = getCliInstance(id)!.configDir
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.credentials.json'), '{}')
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, fullName: 'Example Owner' } }),
  )
  if (desktop) expect(linkCliInstanceToDesktop(id, desktop, 'Example Desk').ok).toBe(true)
  return id
}

test('a paired instance takes its account email as its name; a person-given or unpaired name stays', () => {
  const paired = signedIn(
    'Example Desk (CLI)',
    'Owner@Example.com',
    'C:/Users/me/.claude-instances/desk-a',
  )
  const renamed = signedIn(
    'Example Desk (CLI)',
    'second@example.com',
    'C:/Users/me/.claude-instances/desk-b',
  )
  expect(renameCliInstance(renamed, 'Mine (CLI)').ok).toBe(true)
  const solo = signedIn('Solo (CLI)', 'third@example.com')

  const ids = nameCliInstancesByAccount()
  expect(ids).toContain(paired)
  expect(ids).not.toContain(renamed)
  expect(getCliInstance(paired)).toMatchObject({
    name: 'owner@example.com',
    accountEmail: 'owner@example.com',
    accountName: 'Example Owner',
  })
  expect(getCliInstance(renamed)?.name).toBe('Mine (CLI)')
  expect(getCliInstance(solo)?.name).toBe('Solo (CLI)')
  // Every read names the account, whatever the instance is called.
  expect(getCliInstance(solo)).toMatchObject({
    accountEmail: 'third@example.com',
    accountName: 'Example Owner',
  })

  // The name follows the account when the login signs in as another one; a second pass with nothing new is quiet.
  writeFileSync(
    join(getCliInstance(paired)!.configDir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'next@example.com', displayName: 'Example Next' },
    }),
  )
  expect(nameCliInstancesByAccount()).toEqual([paired])
  expect(getCliInstance(paired)).toMatchObject({
    name: 'next@example.com',
    accountName: 'Example Next',
  })
  expect(nameCliInstancesByAccount()).toEqual([])
})
