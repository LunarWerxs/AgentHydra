// server/tests/quiet-rewrites.test.ts — storage plan piece 13: files that were rewritten only for a
// field that moves every pass are now written when something real changed. Each test counts writes
// over a simulated hour (a pass every 30 s) and states the contract: unchanged = none, changed = one.

import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '../src/config'
import {
  createCliInstance,
  deleteCliInstance,
  setCliInstanceUsage,
} from '../src/core/cli-instances'
import { quietWriter } from '../src/core/quiet-write'
import { initFileLogging, restoreFileLogging, rotateLog } from '../src/log-file.mjs'
import type { UsageSnapshot } from '../src/types'

const PASS = 30_000
const HOUR = 3_600_000

test('an hour of unchanged passes writes the config once, plus the 10-minute stamp flushes', () => {
  let clock = 1_000_000
  let writes = 0
  const w = quietWriter<{ url: string; lastSyncAt: number | null }, 'lastSyncAt'>(
    () => void writes++,
    'lastSyncAt',
    10 * 60_000,
    () => clock,
  )
  for (let t = 0; t < HOUR; t += PASS) {
    clock += PASS
    w.write({ url: 'u', lastSyncAt: clock })
  }
  // 1 first write + one per 10 minutes (6) at most; was 120.
  expect(writes).toBeLessThanOrEqual(7)
  expect(writes).toBeGreaterThanOrEqual(1)
  expect(w.latest()).toBe(clock)
})

test('a real change writes at once, a stale stamp from a re-read does not roll the memory back', () => {
  let clock = 5_000_000
  const written: Array<{ url: string; lastSyncAt: number | null }> = []
  const w = quietWriter<{ url: string; lastSyncAt: number | null }, 'lastSyncAt'>(
    (v) => void written.push({ ...v }),
    'lastSyncAt',
    600_000,
    () => clock,
  )
  w.write({ url: 'a', lastSyncAt: clock })
  clock += PASS
  expect(w.write({ url: 'a', lastSyncAt: clock })).toBe(false)
  // Another caller re-read the file (old stamp) and changed the url.
  expect(w.write({ url: 'b', lastSyncAt: 1 })).toBe(true)
  expect(written.at(-1)).toEqual({ url: 'b', lastSyncAt: clock })
  // Shutdown flush writes the held stamp only when it is ahead of the disk.
  expect(w.flush()).toBe(false)
  clock += PASS
  w.write({ url: 'b', lastSyncAt: clock })
  expect(w.flush()).toBe(true)
  expect(written.at(-1)?.lastSyncAt).toBe(clock)
})

test('usage readings do not rewrite cli-instances.json; an instance change writes them in', () => {
  const path = join(CONFIG_DIR, 'cli-instances.json')
  const made = createCliInstance(`quiet-${Date.now()}`)
  const id = (made.data as { id: string }).id
  try {
    const old = new Date(2020, 0, 1)
    utimesSync(path, old, old)
    const before = statSync(path).mtimeMs
    for (let i = 0; i < 120; i++)
      setCliInstanceUsage(id, { fiveHour: { utilization: i } } as unknown as UsageSnapshot)
    expect(statSync(path).mtimeMs).toBe(before) // 120 readings, 0 writes (was 120)
    expect(readFileSync(path, 'utf8')).not.toContain('"utilization": 119')
    // An instance change folds the newest reading into the file.
    const second = createCliInstance(`quiet2-${Date.now()}`)
    expect(statSync(path).mtimeMs).not.toBe(before)
    expect(readFileSync(path, 'utf8')).toContain('"utilization": 119')
    deleteCliInstance((second.data as { id: string }).id)
  } finally {
    deleteCliInstance(id)
  }
})

test('rotateLog keeps N gzipped generations and the daemon log rolls while running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-log-'))
  try {
    const log = join(dir, 'daemon.log')
    // Plain helper: five rolls keep three generations.
    for (let i = 0; i < 5; i++) {
      writeFileSync(log, `gen ${i}\n`)
      rotateLog(log, 3)
    }
    const kept = [1, 2, 3, 4].map((n) => existsSync(`${log}.${n}.gz`))
    expect(kept).toEqual([true, true, true, false])
    expect(new TextDecoder().decode(Bun.gunzipSync(readFileSync(`${log}.1.gz`)))).toBe('gen 4\n')

    // Runtime: a 2 KB cap with 20 KB of lines rolls several times and stays bounded.
    const live = join(dir, 'logs', 'daemon.log')
    expect(initFileLogging(dir, { maxBytes: 2048 })).toBe(live)
    for (let i = 0; i < 200; i++) console.log(`line ${i} ${'x'.repeat(80)}`)
    restoreFileLogging()
    expect(existsSync(`${live}.1.gz`)).toBe(true)
    expect(existsSync(`${live}.4.gz`)).toBe(false)
    expect(statSync(live).size).toBeLessThan(4096)
  } finally {
    restoreFileLogging()
    rmSync(dir, { recursive: true, force: true })
  }
})
