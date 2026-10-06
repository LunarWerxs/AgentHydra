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

/** A fake HSwarm home: gemini keys 1-8 (3 disabled, 4 resting, 5 struck), anthropic key 1, mistral keys 1-5. */
function hswarmHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hswarm-fake-'))
  dirs.push(home)
  mkdirSync(join(home, 'secrets'))
  writeFileSync(join(home, 'secrets', 'gemini_api_keys'), ['# note', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `test-gem-${n}`)].join('\n'))
  writeFileSync(join(home, 'secrets', 'anthropic_api_keys'), 'test-ant-1\n')
  writeFileSync(join(home, 'secrets', 'mistral_api_keys'), [1, 2, 3, 4, 5].map((n) => `test-mist-${n}`).join('\n'))
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
    MISTRAL_API_KEYS: [],
    ...initial
  }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/keys')) {
      return Response.json({
        pools: Object.entries(pools).map(([pool, k]) => ({
          pool,
          total: k.length,
          entries: k.map((key) => (key.startsWith('dead-') ? { lastError: 'HTTP 429', lastUsedAt: 2, lastSuccessAt: null } : { lastError: null, lastUsedAt: null, lastSuccessAt: null }))
        }))
      })
    }
    const { pool, key } = JSON.parse(String(init?.body))
    if (pools[pool].includes(key)) return Response.json({ error: 'exists' }, { status: 409 })
    pools[pool].push(key)
    return Response.json({})
  }) as unknown as typeof fetch
  return { pools, fetchImpl }
}

const alive = async () => true

describe('copyHswarmKeys', () => {
  test('copies only keys that pass the live check, and keys whose last answer was an error do not fill a pool', async () => {
    const home = hswarmHome()
    const r = fakeRedesign({ GEMINI_FLASH_API_KEYS: ['dead-1', 'dead-2', 'dead-3', 'dead-4', 'dead-5'] })
    const checked: string[] = []
    const checkKey = async (_list: string, key: string) => {
      checked.push(key)
      return key !== 'test-gem-2' && key !== 'test-gem-6'
    }
    const out = await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl, checkKey })
    const flash = out.pools.find((p) => p.pool === 'GEMINI_FLASH_API_KEYS')
    expect(flash?.before).toBe(0)
    expect(flash?.added).toBe(3)
    expect(r.pools.GEMINI_FLASH_API_KEYS).not.toContain('test-gem-2')
    expect(r.pools.GEMINI_PRO_API_KEYS).toEqual(r.pools.GEMINI_FLASH_API_KEYS.filter((k) => !k.startsWith('dead-')))
    // one check per key feeds both Gemini pools
    expect(checked.filter((k) => k === 'test-gem-1')).toHaveLength(1)
    expect(JSON.stringify(out)).not.toContain('test-gem')
  })

  test('adds up to five ok Gemini keys per pool and one Anthropic key, skipping parked ones', async () => {
    const home = hswarmHome()
    const r = fakeRedesign()
    const out = await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl, checkKey: alive })
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
    await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl, checkKey: alive })
    const again = await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl, checkKey: alive })
    expect(again.pools.every((p) => p.added === 0)).toBe(true)
    expect(r.pools.GEMINI_FLASH_API_KEYS).toHaveLength(5)
  })

  test('tops up a pool that has one of the keys already, without a duplicate', async () => {
    const home = hswarmHome()
    const r = fakeRedesign({ GEMINI_FLASH_API_KEYS: ['test-gem-1'] })
    await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl, checkKey: alive })
    expect(r.pools.GEMINI_FLASH_API_KEYS).toHaveLength(5)
    expect(new Set(r.pools.GEMINI_FLASH_API_KEYS).size).toBe(5)
  })

  test('the result carries counts and fingerprints, never a key value', async () => {
    const home = hswarmHome()
    const r = fakeRedesign()
    const out = await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl, checkKey: alive })
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

  test('adds Mistral keys alongside Gemini and Anthropic to reduce provider reliance', async () => {
    const home = hswarmHome()
    const r = fakeRedesign()
    const out = await copyHswarmKeys({ redesignUrl: 'http://x', hswarmHome: home, fetchImpl: r.fetchImpl, checkKey: alive })
    expect(out.ok).toBe(true)
    expect(out.okInHswarm.mistral).toBe(5)
    expect(r.pools.MISTRAL_API_KEYS).toHaveLength(5)
    expect(out.pools.map((p) => p.pool)).toContain('MISTRAL_API_KEYS')
  })
})
