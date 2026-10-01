// server/tests/cli-logout.test.ts - signing a Claude CLI instance out (server/src/core/cli-logout.ts).
//
// At the owner boundary: a real CLI instance with a login file, and a real child process registered
// where the CLI registers its sessions. A logout under a running session would be written back by
// that session's next token refresh, so it must refuse then, and remove the login otherwise.

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCliInstance, deleteCliInstance } from '../src/core/cli-instances'
import { logoutCliInstance } from '../src/core/cli-logout'

const created: { id: string; name: string }[] = []
const children: ReturnType<typeof Bun.spawn>[] = []

afterAll(() => {
  for (const p of children) p.kill()
  for (const { id, name } of created) deleteCliInstance(id, name)
})

describe('logoutCliInstance', () => {
  test('refuses while a session runs on the instance, then removes the login once it has quit', () => {
    const name = `cli-logout-${crypto.randomUUID().slice(0, 8)}`
    const made = createCliInstance(name)
    expect(made.ok).toBe(true)
    const id = made.data?.id as string
    created.push({ id, name })
    const dir = made.dir as string
    const credentials = join(dir, '.credentials.json')
    writeFileSync(credentials, '{"claudeAiOauth":{}}')

    const session = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    children.push(session)
    const registry = join(dir, 'sessions', `${session.pid}.json`)
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    writeFileSync(
      registry,
      JSON.stringify({ pid: session.pid, sessionId: crypto.randomUUID(), cwd: process.cwd() }),
    )

    const refused = logoutCliInstance(id)
    expect(refused.ok).toBe(false)
    expect(existsSync(credentials)).toBe(true)

    rmSync(registry)
    const done = logoutCliInstance(id)
    expect(done.ok).toBe(true)
    expect(existsSync(credentials)).toBe(false)
    // A real child process: a cold box can take seconds to start it, past bun's 5 s default.
  }, 20_000)
})
