// server/src/session-scopes.ts - the source scope's "everything but" spelling. The Sessions sidebar
// hides HSwarm by default and must still show 'foreign' tool rows, which no ticked list can name.
import { expect, test } from 'bun:test'
import { parseSourceScope } from '../src/session-scopes'

test('-zswarm means every source but HSwarm, foreign included', () => {
  const got = parseSourceScope('-zswarm')
  expect(got?.has('zswarm')).toBe(false)
  expect(got?.has('foreign')).toBe(true)
  expect(got?.has('claude')).toBe(true)
})

test('named sources and absent/all keep their meaning', () => {
  expect([...(parseSourceScope('claude,codex') ?? [])]).toEqual(['claude', 'codex'])
  expect(parseSourceScope(undefined)).toBeUndefined()
  expect(parseSourceScope('all')).toBeUndefined()
  expect(parseSourceScope('none')?.size).toBe(0)
})
