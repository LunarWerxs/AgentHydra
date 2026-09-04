// server/src/incidents.ts - failure incidents: signature dedup, ack/resolve lifecycle, and the
// notify-on-first-occurrence-or-reopen suppression that is the whole point of the module.
import { afterAll, beforeEach, expect, test } from 'bun:test'

// Point the db at a scratch dir BEFORE importing anything that touches it - db.ts opens the file on
// import, so the env has to be in place first (same pattern as notify-settings.test.ts).
const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-incidents-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = scratch

const { db } = await import('../src/db')
const {
  ackIncident,
  classifyFailureType,
  countIncidents,
  getIncident,
  listIncidents,
  recordIncident,
  resolveIncident,
  shouldNotifyIncident,
} = await import('../src/incidents')

beforeEach(() => {
  db.exec('delete from incidents')
})

afterAll(() => {
  try {
    require('node:fs').rmSync(scratch, { recursive: true, force: true })
  } catch {
    // scratch dir cleanup is best-effort
  }
})

test('signature is stable across differing timestamps, paths, and ids (dedups as one incident)', async () => {
  const a = await recordIncident({
    scope: 'queue',
    key: '/repo/project-a',
    error:
      'Error at 2026-09-04T12:34:56.789Z in C:\\Users\\jacob\\repo\\src\\run.ts:42 (pid 18234)',
  })
  const b = await recordIncident({
    scope: 'queue',
    key: '/repo/project-a',
    error:
      'Error at 2026-09-04T13:01:02.001Z in C:\\Users\\jacob\\repo\\src\\run.ts:42 (pid 55190)',
  })
  expect(a.isNew).toBe(true)
  expect(b.isNew).toBe(false)
  expect(b.id).toBe(a.id)
  expect(countIncidents()).toBe(1)
})

test('two different errors on the same scope+key open two incidents', async () => {
  const a = await recordIncident({ scope: 'queue', key: '/repo/project-a', error: 'ECONNRESET' })
  const b = await recordIncident({
    scope: 'queue',
    key: '/repo/project-a',
    error: 'permission denied writing to output.json',
  })
  expect(a.id).not.toBe(b.id)
  expect(countIncidents()).toBe(2)
})

test('a repeat bumps count and is suppressed; only the first occurrence (or a reopen) notifies', async () => {
  const first = await recordIncident({ scope: 'queue', key: '/repo/project-b', error: 'boom' })
  expect(first.isNew).toBe(true)
  expect(first.count).toBe(1)
  expect(shouldNotifyIncident(first)).toBe(true)

  const repeat = await recordIncident({ scope: 'queue', key: '/repo/project-b', error: 'boom' })
  expect(repeat.isNew).toBe(false)
  expect(repeat.reopened).toBe(false)
  expect(repeat.count).toBe(2)
  expect(shouldNotifyIncident(repeat)).toBe(false)

  const stored = getIncident(first.id)
  expect(stored?.count).toBe(2)
  expect(stored?.state).toBe('open')
})

test('ack moves open -> acked and is a no-op once already acked or resolved', async () => {
  const { id } = await recordIncident({ scope: 'queue', key: '/repo/project-c', error: 'boom' })
  expect(ackIncident(id)).toBe(true)
  expect(getIncident(id)?.state).toBe('acked')
  expect(ackIncident(id)).toBe(false) // already acked
  expect(resolveIncident(id)).toBe(true)
  expect(ackIncident(id)).toBe(false) // resolved is terminal, ack cannot revive it
})

test('resolve is terminal until the same signature recurs, which reopens it', async () => {
  const { id } = await recordIncident({ scope: 'queue', key: '/repo/project-d', error: 'boom' })
  expect(resolveIncident(id)).toBe(true)
  expect(getIncident(id)?.state).toBe('resolved')
  expect(resolveIncident(id)).toBe(false) // already resolved

  const recurrence = await recordIncident({ scope: 'queue', key: '/repo/project-d', error: 'boom' })
  expect(recurrence.id).toBe(id) // same signature -> same incident, not a new one
  expect(recurrence.isNew).toBe(false)
  expect(recurrence.reopened).toBe(true)
  expect(shouldNotifyIncident(recurrence)).toBe(true) // a reopen pages again, unlike a plain repeat

  const reopened = getIncident(id)
  expect(reopened?.state).toBe('open')
  expect(reopened?.resolved_at).toBeNull()
})

test('a DIFFERENT error on the same scope+key after a resolve mints a NEW incident, not a reopen', async () => {
  const { id: firstId } = await recordIncident({
    scope: 'queue',
    key: '/repo/project-e',
    error: 'boom',
  })
  resolveIncident(firstId)
  const second = await recordIncident({
    scope: 'queue',
    key: '/repo/project-e',
    error: 'a completely different failure',
  })
  expect(second.id).not.toBe(firstId)
  expect(second.isNew).toBe(true)
  expect(second.reopened).toBe(false)
  expect(getIncident(firstId)?.state).toBe('resolved') // untouched by the unrelated new incident
})

test('redaction never leaks a token-like string into the stored error', async () => {
  const { id } = await recordIncident({
    scope: 'queue',
    key: '/repo/project-f',
    error: 'upstream call failed: Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345',
  })
  const stored = getIncident(id)
  expect(stored?.error).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
})

test('listIncidents filters by state and rejects an unknown one', async () => {
  const { id } = await recordIncident({ scope: 'queue', key: '/repo/project-g', error: 'boom' })
  ackIncident(id)
  expect(listIncidents('acked').map((i) => i.id)).toContain(id)
  expect(listIncidents('open').map((i) => i.id)).not.toContain(id)
  expect(listIncidents('bogus' as unknown as 'open')).toEqual([])
})

test('classifyFailureType reads keywords from the RAW error text (not the placeholder-normalized one)', () => {
  expect(classifyFailureType('API Error: 429 Too Many Requests')).toBe('rate_limit')
  expect(classifyFailureType('request timed out after 30s')).toBe('timeout')
  expect(classifyFailureType('401 Unauthorized: invalid token')).toBe('auth')
  expect(classifyFailureType('nothing recognizable here')).toBe('unknown')
})
