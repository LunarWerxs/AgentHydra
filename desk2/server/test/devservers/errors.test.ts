// devservers/errors.ts on a temp errors.ndjson: one entry per distinct error with its count and times, dismiss and
// clear remove exactly what they name, and the store is read back from its file after a restart.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type ErrorInfo, ErrorStore } from '../../src/devservers/errors'

const dirs: string[] = []
const errorsFile = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'devs-errors-'))
  dirs.push(d)
  return path.join(d, 'devservers', 'errors.ndjson')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const server = (localId: string): ErrorInfo => ({ processId: `p1.${localId}`, localId, processName: localId, projectId: 'p1', projectName: 'Example', cwd: 'C:/Users/me/site' })
const clock = () => {
  let t = 1000
  return () => (t += 1000)
}

test('the same error twice is one entry with count 2 and a later lastSeen', () => {
  const store = new ErrorStore(errorsFile(), clock())
  // Printed at two different times: the time of day is not part of what makes it the same error.
  const a = store.record(server('web'), 'stderr', 'Error: listen EADDRINUSE 127.0.0.1:4173 at 10:15:02')
  const b = store.record(server('web'), 'stderr', 'Error: listen EADDRINUSE 127.0.0.1:4173 at 10:15:09')
  expect(a).not.toBeNull()
  expect(b).toBe(a)
  const list = store.list('p1.web')
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ count: 2, firstSeen: 2000, lastSeen: 3000 })
  // Written now, so the debounced save cannot recreate the temp folder after it is removed.
  store.flush()
})

test('dismissing hides one entry, clearing one server leaves the others, and both last across a reopen', () => {
  const file = errorsFile()
  const store = new ErrorStore(file, clock())
  const gone = store.record(server('web'), 'stderr', 'TypeError: x is not a function')!
  store.record(server('web'), 'stderr', 'ReferenceError: y is not defined')
  store.record(server('api'), 'crash', 'exited with code 1')
  store.record(server('docs'), 'stderr', 'Error: cannot find module example')
  expect(store.dismiss(gone)).toBe(true)
  expect(store.list('p1.web').map((e) => e.sample)).toEqual(['ReferenceError: y is not defined'])
  store.clear('p1.api')
  expect(store.count('p1.api')).toBe(0)
  store.flush()

  const reopened = new ErrorStore(file, clock())
  expect(reopened.list().map((e) => [e.processId, e.sample])).toEqual([
    ['p1.docs', 'Error: cannot find module example'],
    ['p1.web', 'ReferenceError: y is not defined'],
  ])
})
