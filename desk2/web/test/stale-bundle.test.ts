import { describe, expect, test } from 'bun:test'
import { entryOf, isStale, mayReload, QUIET_MS } from '../src/lib/stale-bundle'

const page = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script><link rel="stylesheet" crossorigin href="/assets/index-x.css"></head><body></body></html>`

describe('a window that outlived its bundle', () => {
  test('reads the entry script from a built index.html', () => {
    expect(entryOf(page('/assets/index-AbC123.js'))).toBe('/assets/index-AbC123.js')
    expect(entryOf('<html></html>')).toBeNull()
  })

  test('is stale only when the server serves a different entry', () => {
    expect(isStale('/assets/index-old.js', '/assets/index-new.js')).toBe(true)
    expect(isStale('/assets/index-same.js', '/assets/index-same.js')).toBe(false)
    expect(isStale(null, '/assets/index-new.js')).toBe(false)
    expect(isStale('/assets/index-old.js', null)).toBe(false)
  })

  test('reloads out of sight at once, in sight only once no one has touched it for a while', () => {
    const now = 1_000_000
    expect(mayReload(true, now - 1, now)).toBe(true)
    expect(mayReload(false, now - 1000, now)).toBe(false)
    expect(mayReload(false, now - QUIET_MS, now)).toBe(true)
  })
})
