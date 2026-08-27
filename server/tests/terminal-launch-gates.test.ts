// server/tests/terminal-launch-gates.test.ts - the two ways a launched terminal hangs forever.
//
// Both were hit trying to start the orchestrator's reviewer on 2026-08-27, and both are invisible
// from the API: the endpoint returned ok:true, a window opened, and the session never joined the
// live registry. A hang that reports success is worse than a refusal, because nothing anywhere
// says the launch did not take.
//
//   1. FOLDER TRUST. The CLI asks "Is this a project you created or one you trust?" and blocks.
//      Trust is recorded per project path as a LITERAL KEY, so one folder can be recorded twice
//      and disagree with itself: this machine had D:\PublicProjects true and D:/PublicProjects
//      false. 61 of 114 projects there read as untrusted.
//   2. PER-COMMAND APPROVAL. Past trust, the session still stops on each shell command unless it
//      was started in a mode that does not ask.
//
// The rule the tests below hold down is the one that keeps the first fix honest: mirroring an
// existing YES is normalization, granting a new one is not, and this code must never do the second.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTerminalLaunchPlan, ensureProjectTrusted } from '../src/session-launch'

const cfgDir = (projects: Record<string, unknown>): string => {
  const d = mkdtempSync(join(tmpdir(), 'ah-trust-'))
  writeFileSync(join(d, '.claude.json'), JSON.stringify({ projects }))
  return d
}
const readProjects = (d: string) =>
  JSON.parse(readFileSync(join(d, '.claude.json'), 'utf8')).projects

test('an unattended window can ask for a permission mode, and otherwise does not', () => {
  const withMode = buildTerminalLaunchPlan(
    'win32',
    'C:\\claude.exe',
    'C:\\p.txt',
    'sonnet',
    'high',
    null,
    'bypassPermissions',
  )
  expect(withMode.command).toContain('--permission-mode bypassPermissions')
  expect(withMode.command).toContain('--model sonnet')

  // Opt-in only: a caller that does not ask keeps the CLI's own default rather than silently
  // being handed a mode that runs every tool with no approval.
  const plain = buildTerminalLaunchPlan('win32', 'C:\\claude.exe', 'C:\\p.txt', 'sonnet')
  expect(plain.command).not.toContain('--permission-mode')
})

test('a folder already trusted under the exact key is left alone', () => {
  const d = cfgDir({ 'D:\\Work': { hasTrustDialogAccepted: true } })
  const r = ensureProjectTrusted('D:\\Work', d)
  expect(r.trusted).toBe(true)
  expect(r.mirrored).toBe(false)
})

test('a YES recorded under another spelling of the same folder is mirrored, not re-asked', () => {
  // The exact shape found on the owner's machine: one folder, two records, disagreeing.
  const d = cfgDir({
    'D:\\PublicProjects': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
    'D:/PublicProjects': { hasTrustDialogAccepted: false },
  })
  const r = ensureProjectTrusted('D:/PublicProjects', d)
  expect(r.trusted).toBe(true)
  expect(r.mirrored).toBe(true)

  // Every spelling now agrees, so whichever key the CLI looks up finds the yes.
  const p = readProjects(d)
  expect(p['D:/PublicProjects'].hasTrustDialogAccepted).toBe(true)
  expect(p['D:\\PublicProjects'].hasTrustDialogAccepted).toBe(true)
  // Mirroring must not discard what the existing record carried.
  expect(p['D:\\PublicProjects'].allowedTools).toEqual(['Bash'])
})

test('trailing separators and case are the same folder, not different ones', () => {
  const d = cfgDir({ 'D:\\Repo\\': { hasTrustDialogAccepted: true } })
  const r = ensureProjectTrusted('d:/REPO', d)
  expect(r.trusted).toBe(true)
  expect(readProjects(d)['d:/REPO'].hasTrustDialogAccepted).toBe(true)
})

test('IT NEVER GRANTS TRUST NOBODY GAVE', () => {
  // The whole safety argument for touching this file at all is that it only ever copies a
  // decision the owner already made. A launcher that answered the security question itself would
  // be worse than one that hangs, because the hang is at least visible.
  const known = cfgDir({ 'D:\\Untrusted': { hasTrustDialogAccepted: false } })
  const a = ensureProjectTrusted('D:\\Untrusted', known)
  expect(a.trusted).toBe(false)
  expect(a.reason).toBe('folder-not-trusted')
  expect(readProjects(known)['D:\\Untrusted'].hasTrustDialogAccepted).toBe(false)

  const unknown = cfgDir({ 'D:\\Other': { hasTrustDialogAccepted: true } })
  const b = ensureProjectTrusted('D:\\NeverSeen', unknown)
  expect(b.trusted).toBe(false)
  expect(b.reason).toBe('folder-unknown')
  // And it did not invent a record for it.
  expect(readProjects(unknown)['D:\\NeverSeen']).toBeUndefined()
})

test('a missing or unreadable CLI config refuses rather than guessing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ah-trust-none-'))
  expect(ensureProjectTrusted('D:\\Work', empty).reason).toBe('no-cli-config')

  const broken = mkdtempSync(join(tmpdir(), 'ah-trust-bad-'))
  writeFileSync(join(broken, '.claude.json'), '{ not json')
  expect(ensureProjectTrusted('D:\\Work', broken).reason).toBe('cli-config-unreadable')
})
