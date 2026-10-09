// server/tests/climayte-stopped.test.ts — a stopped worker stays stopped for a ping: the ping's text waits
// in its queue, and only the owner's next message revives it.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteRun,
  climayteSend,
  setCliMayteAccountsProvider,
} from '../src/climayte'
import { workers } from '../src/climayte-core'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-stopped-'))

beforeAll(() => {
  mkdirSync(scratch, { recursive: true })
  setCliMayteAccountsProvider(() => [])
})
afterAll(() => {
  climayteCancel({ group: 'stopped-test' })
  setCliMayteAccountsProvider(null)
  rmSync(scratch, { recursive: true, force: true })
})

test("a ping to a stopped worker is held, and the owner's next message revives it", () => {
  const id =
    climayteRun({ group: 'stopped-test', tasks: [{ prompt: 'work', cwd: scratch }] }).workers[0]
      ?.id ?? ''
  const w = workers.get(id)
  if (!w) throw new Error('no worker made')
  expect(climayteCancel({ id }).cancelled).toEqual([id])

  expect(climayteSend(id, 'a ping', { ping: true }).ok).toBe(true)
  expect(w.status).toBe('cancelled')
  expect(w.pending).toEqual(['a ping'])

  expect(climayteSend(id, 'from the owner').ok).toBe(true)
  expect(w.status).not.toBe('cancelled')
  expect(w.pending).toEqual(['a ping', 'from the owner'])
})
