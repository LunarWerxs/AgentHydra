import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCodexInstance,
  deleteCodexInstance,
  getCodexInstance,
} from '../src/core/codex-instances'
import { logoutCodexInstance } from '../src/core/codex-logout'

// --- Codex logout guard -------------------------------------------------------------
//
// A running Codex refreshes and re-saves auth.json, so a logout written under it is silently undone.
// These pin the guard: remove auth.json only when the desktop is KNOWN to be stopped, refuse when it
// runs AND when the process scan fails, and never touch the rest of the home (config.toml).

const name = `codex-logout-${crypto.randomUUID()}`
const created = createCodexInstance(name)
const id = created.data?.id as string
const codexHome = created.data?.codexHome as string
const authPath = join(codexHome, 'auth.json')
const configPath = join(codexHome, 'config.toml')

function seed() {
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(authPath, '{}')
  writeFileSync(configPath, 'model = "x"\n')
}

afterAll(async () => {
  await deleteCodexInstance(id, name, { listDesktopProcesses: async () => [] })
})

test('a stopped desktop is signed out and keeps config.toml', async () => {
  seed()
  const result = await logoutCodexInstance(id, {
    scanDesktopProcesses: async () => ({ ok: true, runtimes: [] }),
  })
  expect(result.ok).toBe(true)
  expect(existsSync(authPath)).toBe(false)
  expect(existsSync(configPath)).toBe(true)
})

test('a running desktop refuses and keeps auth.json', async () => {
  seed()
  const desktopUserDataDir = getCodexInstance(id)?.desktopUserDataDir as string
  const result = await logoutCodexInstance(id, {
    scanDesktopProcesses: async () => ({ ok: true, runtimes: [{ desktopUserDataDir, pid: 4242 }] }),
  })
  expect(result.ok).toBe(false)
  expect(existsSync(authPath)).toBe(true)
})

test('a failed process scan refuses and keeps auth.json', async () => {
  seed()
  const result = await logoutCodexInstance(id, {
    scanDesktopProcesses: async () => ({ ok: false, reason: 'x' }),
  })
  expect(result.ok).toBe(false)
  expect(existsSync(authPath)).toBe(true)
})
