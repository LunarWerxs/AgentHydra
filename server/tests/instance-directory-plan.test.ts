// server/tests/instance-directory-plan.test.ts - the plan the instance directory shows
// (server/src/core/instance-ref.ts listAllInstances).
//
// The directory is what list_instance_numbers answers and where list_usage takes each row's plan
// from. A CLI instance linked to no desktop has only its own login to say what plan it is on; read
// through the desktop link alone, 35 of 56 surveyed accounts showed plan null (2026-10-06), so no
// caller could filter either list by plan.

import { afterAll, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCliInstance, deleteCliInstance } from '../src/core/cli-instances'
import { listAllInstances } from '../src/core/instance-ref'

const created: { id: string; name: string }[] = []

afterAll(() => {
  for (const { id, name } of created) deleteCliInstance(id, name)
})

test("a CLI instance linked to no desktop shows its own login's plan", async () => {
  const name = `plan-${crypto.randomUUID().slice(0, 8)}`
  const made = createCliInstance(name)
  expect(made.ok).toBe(true)
  const id = made.data?.id as string
  created.push({ id, name })
  // The non-secret fields a real `/login` writes beside its token; no token is needed to read them.
  writeFileSync(
    join(made.dir as string, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
    }),
  )

  const row = (await listAllInstances()).find((r) => r.ref === `cli:${id}`)
  expect(row?.plan).toBe('Max 5×')
  // listAllInstances reads this machine's desktop fleet too; a cold process scan can take seconds.
}, 20_000)
