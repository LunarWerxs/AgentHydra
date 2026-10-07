import { expect, test } from 'bun:test'
import { readScreen, readView, rememberScreen, rememberView, restoreScreen, restoreView } from '../../src/lib/view-memory'

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

test('a reload also comes back to the AgentHydra pane, the Dev servers page, the Settings page and the view under Settings, each kept apart', () => {
  const kept = new Map<string, string>()
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) }
  expect(restoreScreen(storage)).toEqual({})
  rememberScreen({ under: { kind: 'chat', id: 'c1' } }, storage)
  rememberScreen({ hydra: { cloud: true } }, storage)
  rememberScreen({ section: 'free' }, storage)
  rememberScreen({ dev: true }, storage)
  expect(restoreScreen(storage)).toEqual({ under: { kind: 'chat', id: 'c1' }, hydra: { cloud: true }, dev: true, section: 'free' })
  rememberScreen({ hydra: undefined, dev: undefined }, storage)
  expect(restoreScreen(storage)).toEqual({ under: { kind: 'chat', id: 'c1' }, section: 'free' })
  expect(readScreen('{"under":{"kind":"settings"},"hydra":{},"dev":1,"section":3}')).toEqual({ hydra: { cloud: false } })
  expect(readScreen('not json')).toEqual({})
})
