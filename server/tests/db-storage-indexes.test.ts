// server/src/db.ts - the storage migration (docs/STORAGE-PLAN.md piece 10).
// The sessions list and the edits cap rely on these indexes; a fresh file must come up with them,
// in incremental auto-vacuum mode, stamped with the schema version.

import { describe, expect, test } from 'bun:test'
import { db, reclaimFreePages } from '../src/db'

const names = () =>
  db
    .query<{ name: string }, []>("select name from sqlite_master where type = 'index'")
    .all()
    .map((r) => r.name)
const one = (sql: string) => Object.values(db.query<Record<string, number>, []>(sql).get() ?? {})[0]

describe('db storage migration', () => {
  test('hot-query indexes exist and the dead ones are gone', () => {
    const have = names()
    expect(have).toContain('idx_scan_cache_thread')
    expect(have).toContain('idx_scan_cache_limit')
    expect(have).toContain('idx_session_edits_ts_id')
    expect(have).not.toContain('idx_session_edits_ts')
    expect(have).not.toContain('session_stats_gone')
  })

  test('the thread_key list read is served by the partial index', () => {
    const plan = db
      .query<{ detail: string }, []>(
        'explain query plan select cache_key, thread_key from session_scan_cache where thread_key is not null and scan_version >= 1',
      )
      .all()
      .map((r) => r.detail)
      .join(' ')
    expect(plan).toContain('idx_scan_cache_thread')
  })

  test('versioned, incremental auto-vacuum, and reclaiming is safe', () => {
    // 2 since piece 12 (usage_samples); a fresh file runs every step and ends on the newest.
    expect(one('pragma user_version')).toBe(2)
    expect(one('pragma auto_vacuum')).toBe(2)
    expect(reclaimFreePages()).toBeGreaterThanOrEqual(0)
  })
})
