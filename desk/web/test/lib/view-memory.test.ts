import { expect, test } from 'bun:test'
import { readView, rememberView, restoreView } from '../../src/lib/view-memory'

test('a reload comes back to the chat or screen the window showed, and to the default for anything else', () => {
  const kept = new Map<string, string>()
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) }
  const fallback = { kind: 'chat', id: '' } as const
  expect(restoreView(fallback, storage)).toEqual(fallback)
  rememberView({ kind: 'chat', id: 'c1' }, storage)
  expect(restoreView(fallback, storage)).toEqual({ kind: 'chat', id: 'c1' })
  rememberView({ kind: 'new', cwd: 'C:\\work' }, storage)
  expect(restoreView(fallback, storage)).toEqual({ kind: 'new', cwd: 'C:\\work' })
  expect(readView('{"kind":"settings"}')).toEqual({ kind: 'settings' })
  expect(readView('{"kind":"chat"}')).toBeNull()
  expect(readView('{"kind":"other","id":"x"}')).toBeNull()
  expect(readView('not json')).toBeNull()
})
