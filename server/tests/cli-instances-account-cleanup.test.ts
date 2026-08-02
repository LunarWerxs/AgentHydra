// server/tests/cli-instances-account-cleanup.test.ts — deleting a dispatch account must not leave
// dangling references on CLI instances.
//
// A CLI instance's dispatch account is stored as an id + label copied into the cli-instances JSON
// store (CONFIG_DIR/cli-instances.json), NOT as a foreign key: sqlite owns the accounts table but
// not that file, so `delete from accounts` cannot cascade into it. Before the fix the reference
// simply stayed — the CLI table kept rendering the dead account's label as a badge, and the usage
// path resolved the id to nothing (a 404 from /api/usage?account=<id>, and a silent fall-through to
// "check failed" in the credential chain). Wrong answers, not missing ones.
//
// Two guards, matching the two ways a record goes dangling:
//   clearCliInstanceAccountAssociations — the delete route's eager cleanup, from now on;
//   pruneCliInstanceAccountAssociations — the read path's self-heal for records that ALREADY dangle.
//
// The CLI association was the visible symptom, but it is one of four stores keyed to an account id
// that sqlite cannot cascade into, so the delete route sweeps all four and they are covered here
// together: the association, the monitor opt-out row, the cached usage reading, and the usage
// history series.
//
// CONFIG_DIR and DATA_DIR are both redirected to temp dirs by tests/setup.ts, so every store written
// here is a scratch one; each test still creates and cleans up its own records.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  associateCliInstance,
  clearCliInstanceAccountAssociations,
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  listCliInstances,
  pruneCliInstanceAccountAssociations,
} from '../src/core/cli-instances'
import {
  clearMonitorForAccount,
  monitorEnabledForAccount,
  setMonitorForAccount,
} from '../src/monitor'
import type { UsageSnapshot } from '../src/types'
import { allCachedUsage, dropCachedUsage, setCachedUsage } from '../src/usage-cache'
import { dropUsageHistory, recordUsageSample, usageSamples } from '../src/usage-history'

const ACCOUNT_A = 'acct-aaaa-1111'
const ACCOUNT_B = 'acct-bbbb-2222'

const createdIds: string[] = []

/** A throwaway CLI instance, optionally already associated with `accountId`. */
function makeCliInstance(name: string, accountId?: string, label?: string): string {
  const created = createCliInstance(name)
  expect(created.ok).toBe(true)
  const id = created.data?.id as string
  createdIds.push(id)
  if (accountId) expect(associateCliInstance(id, accountId, label ?? name).ok).toBe(true)
  return id
}

afterEach(() => {
  for (const id of createdIds.splice(0)) {
    try {
      deleteCliInstance(id, getCliInstance(id)?.name ?? '')
    } catch {
      // best-effort; a locked scratch dir must not fail the suite
    }
  }
})

describe('clearCliInstanceAccountAssociations — the account delete route’s cleanup', () => {
  test('an instance associated with the deleted account comes back unassociated', () => {
    const id = makeCliInstance('cleanup-associated', ACCOUNT_A, 'Account A')
    expect(getCliInstance(id)?.associatedAccountLabel).toBe('Account A')

    expect(clearCliInstanceAccountAssociations(ACCOUNT_A)).toEqual([id])

    // Delete-then-list: the label the UI renders as a badge must be gone too, not just the id —
    // a leftover label is exactly the stale name the user kept seeing.
    const listed = listCliInstances().find((i) => i.id === id)
    expect(listed?.associatedAccountId).toBeNull()
    expect(listed?.associatedAccountLabel).toBeNull()
  })

  test('every instance sharing the deleted account is cleared, not just the first', () => {
    const first = makeCliInstance('cleanup-shared-1', ACCOUNT_A)
    const second = makeCliInstance('cleanup-shared-2', ACCOUNT_A)

    expect(clearCliInstanceAccountAssociations(ACCOUNT_A).sort()).toEqual([first, second].sort())

    const listed = listCliInstances()
    expect(listed.find((i) => i.id === first)?.associatedAccountId).toBeNull()
    expect(listed.find((i) => i.id === second)?.associatedAccountId).toBeNull()
  })

  test('an instance on a DIFFERENT account is left untouched', () => {
    const deleted = makeCliInstance('cleanup-deleted-acct', ACCOUNT_A)
    const surviving = makeCliInstance('cleanup-surviving-acct', ACCOUNT_B, 'Account B')

    expect(clearCliInstanceAccountAssociations(ACCOUNT_A)).toEqual([deleted])

    const listed = listCliInstances().find((i) => i.id === surviving)
    expect(listed?.associatedAccountId).toBe(ACCOUNT_B)
    expect(listed?.associatedAccountLabel).toBe('Account B')
  })

  test('deleting an account nothing references writes nothing and reports nothing', () => {
    const id = makeCliInstance('cleanup-unrelated', ACCOUNT_B)

    expect(clearCliInstanceAccountAssociations(ACCOUNT_A)).toEqual([])
    expect(clearCliInstanceAccountAssociations('')).toEqual([])

    expect(getCliInstance(id)?.associatedAccountId).toBe(ACCOUNT_B)
  })

  test('an instance that was never associated survives the sweep intact', () => {
    // The clear must key off the association, not touch every record: name, configDir and the
    // desktop link are all on the same row and none of them belong to the account.
    const id = makeCliInstance('cleanup-never-associated')
    const before = getCliInstance(id)

    clearCliInstanceAccountAssociations(ACCOUNT_A)

    const after = getCliInstance(id)
    expect(after?.name).toBe(before?.name as string)
    expect(after?.configDir).toBe(before?.configDir as string)
    expect(after?.associatedAccountId).toBeNull()
  })
})

describe('the other stores keyed to a deleted account', () => {
  // Everything the delete route now sweeps alongside the CLI association. Each of these is keyed by
  // an id that can never be asked for again, and none is reachable by a sqlite cascade.
  const snapshot = (pct: number, at: string): UsageSnapshot => ({
    account: 'Account A',
    session: null,
    weekAll: { pct, resets: 'Aug 9, 3:59am', resetsAt: '2026-08-09T03:59:00.000Z' },
    weekModel: null,
    capturedAt: at,
    source: 'api',
  })

  test('dropCachedUsage forgets the account’s reading and leaves every other key alone', () => {
    setCachedUsage(`acct:${ACCOUNT_A}`, snapshot(42, '2026-08-01T00:00:00.000Z'))
    setCachedUsage(`acct:${ACCOUNT_B}`, snapshot(7, '2026-08-01T00:00:00.000Z'))

    dropCachedUsage(`acct:${ACCOUNT_A}`)

    expect(allCachedUsage()[`acct:${ACCOUNT_A}`]).toBeUndefined()
    expect(allCachedUsage()[`acct:${ACCOUNT_B}`]?.weekAll?.pct).toBe(7)
    dropCachedUsage(`acct:${ACCOUNT_B}`)
  })

  test('dropUsageHistory drops the whole series, not just the newest sample', () => {
    recordUsageSample(`acct:${ACCOUNT_A}`, snapshot(10, '2026-08-01T00:00:00.000Z'))
    recordUsageSample(`acct:${ACCOUNT_A}`, snapshot(20, '2026-08-01T01:00:00.000Z'))
    recordUsageSample(`acct:${ACCOUNT_B}`, snapshot(30, '2026-08-01T01:00:00.000Z'))
    expect(usageSamples(`acct:${ACCOUNT_A}`)).toHaveLength(2)

    dropUsageHistory(`acct:${ACCOUNT_A}`)

    expect(usageSamples(`acct:${ACCOUNT_A}`)).toHaveLength(0)
    expect(usageSamples(`acct:${ACCOUNT_B}`)).toHaveLength(1)
    dropUsageHistory(`acct:${ACCOUNT_B}`)
  })

  test('dropping a key that was never stored is a no-op, not a throw', () => {
    expect(() => dropCachedUsage('acct:never-existed')).not.toThrow()
    expect(() => dropUsageHistory('acct:never-existed')).not.toThrow()
  })

  test('clearMonitorForAccount removes the opt-out so a reused id starts from the default', () => {
    setMonitorForAccount(ACCOUNT_A, false)
    setMonitorForAccount(ACCOUNT_B, false)
    expect(monitorEnabledForAccount(ACCOUNT_A)).toBe(false)

    clearMonitorForAccount(ACCOUNT_A)

    // Absent row = follow the global switch, which is the right default for a fresh account.
    expect(monitorEnabledForAccount(ACCOUNT_A)).toBe(true)
    expect(monitorEnabledForAccount(ACCOUNT_B)).toBe(false)
    clearMonitorForAccount(ACCOUNT_B)
  })
})

describe('pruneCliInstanceAccountAssociations — the read path’s self-heal', () => {
  test('a reference to an account that no longer exists is dropped at read time', () => {
    // Simulates a record that went dangling BEFORE the delete route cleaned up: the association is
    // on disk and the account is not in the live table.
    const id = makeCliInstance('prune-dangling', ACCOUNT_A, 'Ghost Account')

    expect(pruneCliInstanceAccountAssociations([ACCOUNT_B])).toEqual([id])

    const listed = listCliInstances().find((i) => i.id === id)
    expect(listed?.associatedAccountId).toBeNull()
    expect(listed?.associatedAccountLabel).toBeNull()
  })

  test('a reference to an account that DOES exist is kept', () => {
    const id = makeCliInstance('prune-live', ACCOUNT_A, 'Account A')

    expect(pruneCliInstanceAccountAssociations([ACCOUNT_A, ACCOUNT_B])).toEqual([])

    expect(getCliInstance(id)?.associatedAccountLabel).toBe('Account A')
  })

  test('no accounts at all clears every association (empty is a real answer, not "unknown")', () => {
    const id = makeCliInstance('prune-no-accounts', ACCOUNT_A)

    expect(pruneCliInstanceAccountAssociations([])).toEqual([id])

    expect(getCliInstance(id)?.associatedAccountId).toBeNull()
  })

  test('accepts a Set as well as an array (the route passes whichever is cheapest)', () => {
    const kept = makeCliInstance('prune-set-kept', ACCOUNT_A)
    const dropped = makeCliInstance('prune-set-dropped', ACCOUNT_B)

    expect(pruneCliInstanceAccountAssociations(new Set([ACCOUNT_A]))).toEqual([dropped])

    expect(getCliInstance(kept)?.associatedAccountId).toBe(ACCOUNT_A)
    expect(getCliInstance(dropped)?.associatedAccountId).toBeNull()
  })
})
