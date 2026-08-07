import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_HOME } from '../src/config'
import { defaultCodexDesktopUserDataDir } from '../src/core/codex-desktop'
import {
  createCodexInstance,
  DEFAULT_CODEX_INSTANCE_ID,
  deleteCodexInstance,
  findCodexInstance,
  getCodexInstance,
  listCodexInstances,
  renameCodexInstance,
} from '../src/core/codex-instances'

// --- discovery of instances this app did not create -----------------------------
//
// Owner-reported 2026-08-07: "I have at least one codex instance, it's running" while the table
// said "No Codex instances found". The list only ever returned rows created THROUGH this app, so a
// perfectly normal Codex Desktop was invisible. These pin the fix.

test('the DEFAULT Codex install is listed even with nothing running', async () => {
  const rows = await listCodexInstances({ listDesktopProcesses: async () => [] })
  const fallback = rows.find((row) => row.id === DEFAULT_CODEX_INSTANCE_ID)
  expect(fallback).toBeDefined()
  expect(fallback?.codexHome).toBe(CODEX_HOME)
  expect(fallback?.isDefault).toBe(true)
  // External: it has no store row, so it must never offer rename/delete.
  expect(fallback?.isExternal).toBe(true)
  expect(fallback?.isDesktopRunning).toBe(false)
  // Its identity is readable off disk whether or not the app is running — the whole reason it is
  // listed when stopped.
  expect(fallback?.account).not.toBeNull()
})

test('the default row reports the profile path the RUNNING process announced', async () => {
  const running = defaultCodexDesktopUserDataDir()
  const rows = await listCodexInstances({
    listDesktopProcesses: async () => [{ desktopUserDataDir: running, pid: 4242 }],
  })
  const fallback = rows.find((row) => row.id === DEFAULT_CODEX_INSTANCE_ID)
  expect(fallback?.isDesktopRunning).toBe(true)
  expect(fallback?.desktopPid).toBe(4242)
})

test('a Codex Desktop running from an unknown profile is listed as external', async () => {
  const dir = join('C:', 'somewhere', 'else', 'myprofile', 'desktop')
  const rows = await listCodexInstances({
    listDesktopProcesses: async () => [{ desktopUserDataDir: dir, pid: 99 }],
  })
  const external = rows.find((row) => row.desktopUserDataDir === dir)
  expect(external).toBeDefined()
  expect(external?.isExternal).toBe(true)
  expect(external?.isDefault).toBe(false)
  expect(external?.desktopPid).toBe(99)
  // <codexHome>/desktop is the layout we impose, so the parent is the inferred CODEX_HOME.
  expect(external?.codexHome).toBe(join('C:', 'somewhere', 'else', 'myprofile'))
})

test('discovery never duplicates an instance this app already manages', async () => {
  const name = `codex-dup-${crypto.randomUUID()}`
  const created = createCodexInstance(name)
  const id = created.data?.id as string
  const codexHome = created.data?.codexHome as string
  try {
    const rows = await listCodexInstances({
      listDesktopProcesses: async () => [
        { desktopUserDataDir: join(codexHome, 'desktop'), pid: 7 },
      ],
    })
    const forHome = rows.filter((row) => row.codexHome === codexHome)
    expect(forHome).toHaveLength(1)
    expect(forHome[0]?.id).toBe(id)
    expect(forHome[0]?.isExternal).toBe(false)
  } finally {
    await deleteCodexInstance(id, name, { listDesktopProcesses: async () => [] })
  }
})

test('discovered rows are readable by id but are not store rows', async () => {
  // The read-only routes resolve through findCodexInstance; every mutating action goes through
  // getCodexInstance, which stays store-only so it cannot act on something it did not create.
  expect(await findCodexInstance(DEFAULT_CODEX_INSTANCE_ID)).not.toBeNull()
  expect(getCodexInstance(DEFAULT_CODEX_INSTANCE_ID)).toBeNull()
  expect(await findCodexInstance('no-such-id')).toBeNull()
})

test('defaultCodexDesktopUserDataDir is the shipped app profile, not our isolated layout', () => {
  // Verified against the running MSIX build on Windows; the point is that it is NOT
  // <CODEX_HOME>/desktop, which is why the default install never matched before.
  const win = defaultCodexDesktopUserDataDir('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })
  expect(win).toBe(join('C:\\Users\\x\\AppData\\Roaming', 'Codex', 'web', 'Codex'))
  expect(win).not.toBe(join(CODEX_HOME, 'desktop'))
  expect(defaultCodexDesktopUserDataDir('darwin', { HOME: '/Users/x' })).toBe(
    join('/Users/x', 'Library', 'Application Support', 'Codex', 'web', 'Codex'),
  )
  expect(defaultCodexDesktopUserDataDir('linux', { HOME: '/home/x' })).toBe(
    join('/home/x', '.config', 'Codex', 'web', 'Codex'),
  )
})

test('Codex instance lifecycle uses isolated CLI/desktop homes and guarded delete', async () => {
  const name = `codex-test-${crypto.randomUUID()}`
  const created = createCodexInstance(name)
  expect(created.ok).toBe(true)
  const id = created.data?.id as string
  const codexHome = created.data?.codexHome as string
  const initial = getCodexInstance(id)
  expect(initial?.loggedIn).toBe(false)
  expect(initial?.desktopUserDataDir).toBe(join(codexHome, 'desktop'))
  expect(initial?.isDesktopRunning).toBe(false)

  writeFileSync(join(codexHome, 'auth.json'), '{}')
  expect(getCodexInstance(id)?.loggedIn).toBe(true)

  const renamed = `${name}-renamed`
  expect(renameCodexInstance(id, renamed).ok).toBe(true)
  const desktopUserDataDir = join(codexHome, 'desktop')
  const runningInstance = (
    await listCodexInstances({
      listDesktopProcesses: async () => [{ desktopUserDataDir, pid: 1234 }],
    })
  ).find((instance) => instance.id === id)
  expect(runningInstance?.name).toBe(renamed)
  expect(runningInstance?.isDesktopRunning).toBe(true)
  expect(runningInstance?.desktopPid).toBe(1234)

  expect((await deleteCodexInstance(id, name)).ok).toBe(false)
  expect(getCodexInstance(id)).not.toBeNull()
  expect(
    (
      await deleteCodexInstance(id, renamed, {
        listDesktopProcesses: async () => [{ desktopUserDataDir, pid: 1234 }],
      })
    ).ok,
  ).toBe(false)
  expect(getCodexInstance(id)).not.toBeNull()
  expect(
    (
      await deleteCodexInstance(id, renamed, {
        listDesktopProcesses: async () => [],
      })
    ).ok,
  ).toBe(true)
  expect(getCodexInstance(id)).toBeNull()
})
