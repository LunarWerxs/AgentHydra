import { expect, test } from 'bun:test'
import { reloadOnChunkFailure } from '../../src/lib/chunk-reload'

function window() {
  const target = new EventTarget() as EventTarget & { location: { reload: () => void }; reloads: number }
  target.reloads = 0
  target.location = { reload: () => void target.reloads++ }
  return target
}

function store() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

test('a failed lazy chunk reloads the window once, then not again inside the guard', () => {
  const win = window()
  let now = 1_000_000
  reloadOnChunkFailure(win, store(), () => now)
  win.dispatchEvent(new Event('vite:preloadError'))
  expect(win.reloads).toBe(1)
  now += 5_000
  win.dispatchEvent(new Event('vite:preloadError'))
  expect(win.reloads).toBe(1)
  now += 60_000
  win.dispatchEvent(new Event('vite:preloadError'))
  expect(win.reloads).toBe(2)
})

test('a dynamic import rejection reloads; an unrelated rejection does not', () => {
  const win = window()
  reloadOnChunkFailure(win, store(), () => 1_000_000)
  const rejection = (message: string) => Object.assign(new Event('unhandledrejection'), { reason: { message } })
  win.dispatchEvent(rejection('boom'))
  expect(win.reloads).toBe(0)
  win.dispatchEvent(rejection('Failed to fetch dynamically imported module: http://127.0.0.1:7798/assets/SettingsView-B5PUK0Jj.js'))
  expect(win.reloads).toBe(1)
})
