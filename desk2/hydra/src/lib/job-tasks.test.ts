// A job's task lines add up to its summary: queued tasks the results do not list still get a line.
import { expect, test } from 'bun:test'
import { missingQueued } from './job-tasks'

test('missingQueued: the summary count minus the queued tasks already listed, never below zero', () => {
  expect(missingQueued({ ok: 2, running: 1, pending: 3 }, [{ status: 'ok' }, { status: 'running' }])).toBe(3)
  expect(missingQueued({ pending: 3 }, [{ status: 'pending' }])).toBe(2)
  expect(missingQueued({ pending: 1 }, [{ status: 'pending' }, { status: 'pending' }])).toBe(0)
  expect(missingQueued(undefined, [])).toBe(0)
})
