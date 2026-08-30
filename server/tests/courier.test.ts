// server/tests/courier.test.ts - the courier pinned to its PROVEN transport: pending ledger
// rows delivered through the composer actuator, a grace window before the courier races the
// surfacing AI, honest held/unroutable lanes, plan mode that types nothing, and a per-pass cap.
//
// The scheduler-arming transport this file used to test is GONE: a scheduler-fired session is
// flagged unattended and the app refuses send_message there, so it could never deliver.
import { expect, test } from 'bun:test'
import {
  COURIER_GRACE_MS,
  COURIER_MAX_PER_PASS,
  type CourierDeps,
  courierPass,
} from '../src/courier'
import type { CourierDeliveryAttempt } from '../src/courier-deliver'
import type { FleetInstanceEntry } from '../src/fleet-instances'

const T0 = Date.parse('2026-08-30T12:00:00Z')

function inst(over: Partial<FleetInstanceEntry> = {}): FleetInstanceEntry {
  return {
    num: 3,
    name: 'work',
    label: null,
    dir: 'C:/Users/x/.claude-instances/work',
    ref: 'desktop:C:/Users/x/.claude-instances/work',
    isRunning: true,
    pid: 123,
    loginUuid: 'uuid-1',
    signedIn: true,
    account: null,
    ...over,
  }
}

function row(
  over: Partial<{
    session_id: string
    prompt: string
    instance_ref: string | null
    staged_at: number
  }> = {},
) {
  return {
    session_id: 's-1',
    prompt: 'resume order',
    instance_ref: 'desktop:C:/Users/x/.claude-instances/work',
    staged_at: T0 - COURIER_GRACE_MS - 1_000,
    ...over,
  }
}

function harness(opts: {
  pending: ReturnType<typeof row>[]
  instances: FleetInstanceEntry[]
  homeFor?: (sid: string) => Promise<string | null>
  outcome?: CourierDeliveryAttempt['outcome']
}) {
  const delivered: Array<{ sessionId: string; prompt: string }> = []
  let serialized = 0
  const deps: CourierDeps = {
    nowMs: T0,
    pending: () => opts.pending,
    instancesList: async () => opts.instances,
    homeFor: opts.homeFor ?? (async () => null),
    serialize: (fn) => {
      serialized++
      return fn()
    },
    deliverRows: async (d = {}) => {
      const rows = (d.pending ?? (() => []))()
      const capped = rows.slice(0, d.max ?? COURIER_MAX_PER_PASS)
      for (const r of capped) delivered.push({ sessionId: r.session_id, prompt: r.prompt })
      return capped.map((r) => ({
        sessionId: r.session_id,
        title: 'A chat',
        instanceDir: (r.instance_ref ?? '').slice('desktop:'.length),
        outcome: opts.outcome ?? ('delivered' as const),
        detail: 'DELIVERED',
      }))
    },
  }
  return { deps, delivered, serializedCount: () => serialized }
}

test('a due pending row is delivered through the composer actuator', async () => {
  const h = harness({ pending: [row()], instances: [inst()] })
  const rep = await courierPass({ act: true }, h.deps)
  expect(h.delivered).toEqual([{ sessionId: 's-1', prompt: 'resume order' }])
  expect(rep.attempts[0]?.outcome).toBe('delivered')
  expect(rep.dryRun).toBe(false)
  expect(rep.instancesTouched).toBe(1)
})

test('a row inside its grace window is HELD - the courier never races the surfacing AI', async () => {
  const h = harness({ pending: [row({ staged_at: T0 - 30_000 })], instances: [inst()] })
  const rep = await courierPass({ act: true }, h.deps)
  expect(h.delivered).toEqual([])
  expect(rep.held[0]?.reason).toContain('the courier is the fallback')
  expect(rep.attempts.length).toBe(0)
})

test('a CLOSED instance holds the row - the composer needs a running window', async () => {
  const h = harness({ pending: [row()], instances: [inst({ isRunning: false, pid: null })] })
  const rep = await courierPass({ act: true }, h.deps)
  expect(h.delivered).toEqual([])
  expect(rep.held[0]?.reason).toContain('is closed')
})

test('plan mode names what WOULD be delivered and types nothing', async () => {
  const h = harness({ pending: [row()], instances: [inst()] })
  const rep = await courierPass({ act: false }, h.deps)
  expect(h.delivered).toEqual([])
  expect(rep.dryRun).toBe(true)
  expect(rep.attempts[0]?.outcome).toBe('planned')
  expect(h.serializedCount()).toBe(0)
})

test('act mode runs inside the process-wide act lock; planning does not take it', async () => {
  const h = harness({ pending: [row()], instances: [inst()] })
  await courierPass({ act: false }, h.deps)
  expect(h.serializedCount()).toBe(0)
  await courierPass({ act: true }, h.deps)
  expect(h.serializedCount()).toBe(1)
})

test('unroutable lanes stay honest: no home, foreign ref, unknown instance, signed out', async () => {
  const signedOut = inst({
    num: 7,
    dir: 'C:/i/out',
    ref: 'desktop:C:/i/out',
    signedIn: false,
    loginUuid: null,
  })
  const h = harness({
    pending: [
      row({ session_id: 'no-home', instance_ref: null }),
      row({ session_id: 'foreign', instance_ref: 'cli:whatever' }),
      row({ session_id: 'unknown', instance_ref: 'desktop:C:/i/vanished' }),
      row({ session_id: 'dead-account', instance_ref: 'desktop:C:/i/out' }),
    ],
    instances: [inst(), signedOut],
  })
  const rep = await courierPass({ act: true }, h.deps)
  expect(h.delivered).toEqual([])
  expect(rep.unroutable.map((u) => u.sessionId).sort()).toEqual([
    'dead-account',
    'foreign',
    'no-home',
    'unknown',
  ])
  expect(rep.unroutable.find((u) => u.sessionId === 'dead-account')?.reason).toContain('signed out')
})

test('a null instance_ref resolves through the both-shapes home lookup', async () => {
  const i = inst()
  const h = harness({
    pending: [row({ instance_ref: null })],
    instances: [i],
    homeFor: async () => i.dir,
  })
  const rep = await courierPass({ act: true }, h.deps)
  expect(h.delivered.length).toBe(1)
  expect(rep.unroutable.length).toBe(0)
})

test('a case/slash-variant instance_ref still resolves to the same instance', async () => {
  const h = harness({
    pending: [row({ instance_ref: String.raw`desktop:c:\users\x\.claude-instances\WORK` })],
    instances: [inst()],
  })
  const rep = await courierPass({ act: true }, h.deps)
  expect(h.delivered.length).toBe(1)
  expect(rep.unroutable.length).toBe(0)
})

test('the per-pass cap is passed down, so one tick can never spray the fleet', async () => {
  const many = Array.from({ length: 12 }, (_, i) => row({ session_id: `s-${i}` }))
  const h = harness({ pending: many, instances: [inst()] })
  const rep = await courierPass({ act: true }, { ...h.deps, max: 3 })
  expect(h.delivered.length).toBe(3)
  expect(rep.attempts.length).toBe(3)
})

test('a refusing actuator is reported verbatim - the row stays pending for the ledger', async () => {
  const h = harness({ pending: [row()], instances: [inst()], outcome: 'wrong-chat' })
  const rep = await courierPass({ act: true }, h.deps)
  expect(rep.attempts[0]?.outcome).toBe('wrong-chat')
})
