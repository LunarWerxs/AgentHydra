// server/tests/extra-usage.test.ts - the guard that keeps paid extra usage from ever being billed.
//
// At the owner boundary: real CLI instances, a real registry file where the CLI writes one, a real
// child process standing in for a session, and the guard's own timer entry point. What it proves:
// on an account that bills past its limit and is at the line, the session is killed; an account
// that cannot bill keeps its session; and the "Allow paid extra usage" setting switches it all off.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCliInstance, deleteCliInstance } from '../src/core/cli-instances'
import { guardExtraUsage } from '../src/extra-usage'
import { setProviderSettings } from '../src/provider-settings'
import type { UsageSnapshot } from '../src/types'
import { setCachedUsage } from '../src/usage'
import { cliKey } from '../src/usage-service'

const created: { id: string; name: string }[] = []
const children: ReturnType<typeof Bun.spawn>[] = []

afterAll(() => {
  for (const p of children) p.kill()
  for (const { id, name } of created) deleteCliInstance(id, name)
  setProviderSettings({ allowExtraUsage: false })
})

/** A CLI account with one live "session" (a child process registered where the CLI registers its
 *  own) and a usage reading at 99% of its 5-hour window. */
function accountWithSession(name: string, extraUsage: boolean): ReturnType<typeof Bun.spawn> {
  const made = createCliInstance(name)
  expect(made.ok).toBe(true)
  const id = made.data?.id as string
  created.push({ id, name })
  const proc = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  children.push(proc)
  const sessions = join(made.dir as string, 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, `${proc.pid}.json`),
    JSON.stringify({ pid: proc.pid, sessionId: crypto.randomUUID(), cwd: import.meta.dir }),
  )
  const snap: UsageSnapshot = {
    account: name,
    session: {
      pct: 99,
      resets: '',
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    weekAll: { pct: 40, resets: '', resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    weekModel: null,
    extraUsage,
    capturedAt: new Date().toISOString(),
    source: 'api',
  }
  setCachedUsage(cliKey(id), snap)
  return proc
}

const alive = (p: ReturnType<typeof Bun.spawn>): boolean => p.exitCode === null && !p.killed

describe('the extra-usage guard', () => {
  test('kills a session on an account that would bill, only while extra usage is not allowed', async () => {
    const billing = accountWithSession('xu-bills', true)
    const capped = accountWithSession('xu-stops', false)

    setProviderSettings({ allowExtraUsage: true })
    expect(await guardExtraUsage()).toEqual([])
    expect(alive(billing)).toBe(true)

    setProviderSettings({ allowExtraUsage: false })
    const stopped = await guardExtraUsage()
    expect(stopped.map((s) => s.pids)).toEqual([[billing.pid]])
    await Promise.race([billing.exited, Bun.sleep(5_000)])
    expect(alive(billing)).toBe(false)
    expect(alive(capped)).toBe(true)
    // Real child processes, and the race above alone may wait 5 s: bun's 5 s default cannot hold it.
  }, 20_000)
})
