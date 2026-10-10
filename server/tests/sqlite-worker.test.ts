// server/src/core/sqlite-worker.ts — a query on another product's database, run off the daemon's thread.
//
// These pin what a caller can rely on: rows come back from a real file, a bad query rejects, a query
// that outlives the deadline rejects instead of pending forever with the next query answered by a fresh
// worker, and three deaths in a row stop respawning until the cool-down has passed.

import { Database } from 'bun:sqlite'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queryInWorker, setSqliteWorkerLimitsForTests } from '../src/core/sqlite-worker'

const dir = mkdtempSync(join(tmpdir(), 'ah-sqlite-worker-'))
// A SLOW query keeps the file open on its thread after its worker is let go, until it ends by itself,
// and Windows refuses to delete an open file: the folder goes once the last of them has finished.
afterAll(async () => {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (tries >= 100 || (code !== 'EBUSY' && code !== 'EPERM')) throw err
      await Bun.sleep(200)
    }
  }
}, 30_000)
// Other test files in the same run share this module: they get the production limits back.
afterEach(() => setSqliteWorkerLimitsForTests())

// Seconds of work that then ends by itself. A query that never ends would keep its thread spinning
// after the worker is let go (terminate cannot interrupt a native SQLite step) for the rest of the run.
const SLOW =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 30000000) SELECT count(*) FROM c'

const file = join(dir, 'store.db')
const seed = new Database(file)
seed.run('CREATE TABLE t (n INTEGER)')
seed.run('INSERT INTO t VALUES (1), (2)')
seed.close()

const rows = 'SELECT n FROM t ORDER BY n'

describe('queryInWorker', () => {
  test('returns the rows of a real database file', async () => {
    expect(await queryInWorker<{ n: number }>(file, rows)).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('rejects a query error with the database message', async () => {
    await expect(queryInWorker(file, 'SELECT * FROM missing_table')).rejects.toThrow(
      /missing_table/,
    )
  })

  // Regression: before the deadline, a query that hung kept its caller's promise pending forever.
  test('a query that outlives the deadline rejects, and the next query is answered', async () => {
    setSqliteWorkerLimitsForTests({ deadlineMs: 200 })
    await expect(queryInWorker(file, SLOW)).rejects.toThrow(/timed out/)
    expect(await queryInWorker<{ n: number }>(file, rows)).toEqual([{ n: 1 }, { n: 2 }])
  }, 30_000)

  test('three deaths in a row stop respawning until the cool-down has passed', async () => {
    setSqliteWorkerLimitsForTests({ deadlineMs: 200, coolDownMs: 1_500 })
    for (let i = 0; i < 3; i++) await expect(queryInWorker(file, SLOW)).rejects.toThrow(/timed out/)
    await expect(queryInWorker(file, rows)).rejects.toThrow(/cooling down/)
    await Bun.sleep(1_600)
    expect(await queryInWorker<{ n: number }>(file, rows)).toEqual([{ n: 1 }, { n: 2 }])
  }, 30_000)
})
