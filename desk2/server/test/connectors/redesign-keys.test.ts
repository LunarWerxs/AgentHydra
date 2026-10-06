import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyHswarmKeys, fingerprint } from '../../src/connectors/redesign-keys'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A fake HSwarm home: gemini keys 1-8 (3 disabled, 4 resting, 5 struck), anthropic key 1. */
function hswarmHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hswarm-fake-'))
  dirs.push(home)
  mkdirSync(join(home, 'secrets'))
  writeFileSync(join(home, 'secrets', 'gemini_api_keys'), ['# note', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `test-gem-${n}`)].join('\n'))
  writeFileSync(join(home, 'secrets', 'anthropic_api_keys'), 'test-ant-1\n')
  const db = new Database(join(home, 'keys.sqlite'))
  db.run('CREATE TABLE keys (fp TEXT PRIMARY KEY, entry TEXT NOT NULL, rev INTEGER NOT NULL, ts REAL NOT NULL)')
  const put = (key: string, entry: object) => db.run('INSERT INTO keys VALUES (?, ?, 1, 0)', [fingerprint(key), JSON.stringify(entry)])
  put('test-gem-3', { disabled: true })
  put('test-gem-4', { rest_until: Date.now() / 1000 + 3600 })
  put('test-gem-5', { strikes: 2 })
  put('test-gem-1', { last: 'x' })
  db.close()
  return home
}

/** A fake ReDesign: pools with keys, 409 on a duplicate. */
function fakeRedesign(initial: Record<string, string[]> = {}) {
  const pools: Record<string, string[]> = {
    GEMINI_FLASH_API_KEYS: [],
    GEMINI_PRO_API_KEYS: [],
    ANTHROPIC_API_KEYS: [],
    ...initial
  }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/keys')) return Response.json({ pools: Object.entries(pools).map(([pool, k]) => ({ pool, total: k.length })) })
    const { pool, key } = JSON.parse(String(init?.body))
    if (pools[pool].includes(key)) return Response.json({ error: 'exists' }, { status: 409 })
    pools[pool].push(key)
    return Response.json({})
  }) as unknown as typeof fetch
  return { pools, fetchImpl }
}

describe('copyHswarmKeys', () => {
  test('adds up to five ok Gemini keys per pool and one Anthropic key, skipping parked ones', async () => {
    const home = hswarmHome()
    const r = fakeRedesign()
    const out = await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl })
    expect(out.ok).toBe(true)
    expect(out.okInHswarm.gemini).toBe(5)
    expect(r.pools.GEMINI_FLASH_API_KEYS).toHaveLength(5)
    expect(r.pools.GEMINI_PRO_API_KEYS).toHaveLength(5)
    for (const bad of ['test-gem-3', 'test-gem-4', 'test-gem-5']) expect(r.pools.GEMINI_FLASH_API_KEYS).not.toContain(bad)
    expect(r.pools.ANTHROPIC_API_KEYS).toEqual(['test-ant-1'])
  })

  test('running again adds nothing', async () => {
    const home = hswarmHome()
    const r = fakeRedesign()
    await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl })
    const again = await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl })
    expect(again.pools.every((p) => p.added === 0)).toBe(true)
    expect(r.pools.GEMINI_FLASH_API_KEYS).toHaveLength(5)
  })

  test('tops up a pool that has one of the keys already, without a duplicate', async () => {
    const home = hswarmHome()
    const r = fakeRedesign({ GEMINI_FLASH_API_KEYS: ['test-gem-1'] })
    await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl })
    expect(r.pools.GEMINI_FLASH_API_KEYS).toHaveLength(5)
    expect(new Set(r.pools.GEMINI_FLASH_API_KEYS).size).toBe(5)
  })

  test('the result carries counts and fingerprints, never a key value', async () => {
    const home = hswarmHome()
    const r = fakeRedesign()
    const out = await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl })
    const text = JSON.stringify(out)
    expect(text).not.toContain('test-gem')
    expect(text).not.toContain('test-ant')
    expect(out.pools[0].fingerprints[0]).toMatch(/^[0-9a-f]{8}$/)
  })

  test('says so when ReDesign does not answer', async () => {
    const out = await copyHswarmKeys({
      redesignUrl: 'http://x',
      hswarmHome: hswarmHome(),
      fetchImpl: (async () => {
        throw new Error('down')
      }) as unknown as typeof fetch
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('not answering')
  })
})
