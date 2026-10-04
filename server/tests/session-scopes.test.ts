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

// server/src/sessions.ts - the title match the list route applies over every session before its cap.
import { titleMatchTier } from '../src/sessions'

test('title match: substring beats letters-in-order, title beats folder and id', () => {
  const row = (title: string, cwd = 'C:/work/app', id = 'a1b2') => ({ title, cwd, session_id: id })
  expect(titleMatchTier('auth', row('Fix the Auth bug'))).toBe(0)
  expect(titleMatchTier('app', row('Fix login'))).toBe(1)
  expect(titleMatchTier('fxlg', row('Fix login'))).toBe(2)
  expect(titleMatchTier('wkpp', row('Other'))).toBe(3)
  expect(titleMatchTier('zzz', row('Fix login'))).toBeNull()
})
