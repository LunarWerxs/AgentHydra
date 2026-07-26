import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCodexInstance,
  deleteCodexInstance,
  getCodexInstance,
  listCodexInstances,
  renameCodexInstance,
} from '../src/core/codex-instances'

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
