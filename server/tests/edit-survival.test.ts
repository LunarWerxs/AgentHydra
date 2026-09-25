// server/src/edit-survival.ts - how much of what a session wrote is still in its files.
//
// These pin the three ways a plausible version is quietly wrong: scoring a session the moment it
// stops (everything reads 100%), counting the session's OWN later rewrite as its code being thrown
// away, and a row that is never rescanned once its transcript stops changing, which is exactly when
// the measurement comes due.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activityReport,
  analyticsCacheKey,
  refreshAnalytics,
  scanSessionAnalytics,
} from '../src/analytics'
import { db } from '../src/db'
import {
  type AgentWrite,
  fourGramContainment,
  fourGrams,
  liveWrites,
  measureEditSurvival,
  SURVIVAL_MIN_AGE_MS,
} from '../src/edit-survival'

const dir = mkdtempSync(join(tmpdir(), 'ah-edit-survival-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const HOUR = 60 * 60_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const KEPT = 'export function keptHelper(a: number) {\n  return a * 2\n}\n'
const GONE = 'const zebra = [9, 8, 7].map((q) => q ** 3)\n'

let n = 0
function file(text: string): string {
  const path = join(dir, `f${n++}.ts`)
  writeFileSync(path, text, 'utf8')
  return path
}
function transcript(lines: unknown[]): string {
  const path = join(dir, `t${n++}.jsonl`)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')
  return path
}
const edits = (at: string, blocks: Array<{ name: string; input: Record<string, string> }>) => ({
  type: 'assistant',
  timestamp: at,
  message: {
    role: 'assistant',
    content: blocks.map((b) => ({ type: 'tool_use', name: b.name, input: b.input })),
  },
})
const write = (path: string, text: string, extra: Partial<AgentWrite> = {}): AgentWrite => ({
  path,
  text,
  replaced: null,
  whole: false,
  ts: Date.now() - 3 * HOUR,
  ...extra,
})

describe('the 4-gram score', () => {
  test('text still in the file scores 1, text that is gone scores 0', () => {
    const now = fourGrams(`// header\n${KEPT}// footer\n`)
    expect(fourGramContainment(KEPT, now)).toBe(1)
    expect(fourGramContainment(GONE, now)).toBeLessThan(0.3)
  })

  test('a CRLF checkout of LF text is the same text, not a lost edit', () => {
    expect(fourGramContainment(KEPT, fourGrams(KEPT.replace(/\n/g, '\r\n')))).toBe(1)
  })
})

describe('the session rewriting its own code is not a loss', () => {
  test('an edit a later edit consumed, or a later whole-file write replaced, is not scored', () => {
    const p = 'D:/x/a.ts'
    const first = write(p, GONE)
    const rewrite = write(p, KEPT, { replaced: GONE })
    const other = write('D:/x/b.ts', GONE)
    expect(liveWrites([first, rewrite, other])).toEqual([rewrite, other])
    const whole = write(p, KEPT, { whole: true })
    expect(liveWrites([first, whole])).toEqual([whole])
  })
})

describe('measuring against the disk', () => {
  test('a session is not measured until it is old enough; it says when it will be', async () => {
    const ts = Date.now() - 10 * 60_000
    const m = await measureEditSurvival([write(file(KEPT), KEPT, { ts })])
    expect(m.score).toBeNull()
    expect(m.dueAt).toBe(ts + SURVIVAL_MIN_AGE_MS)
  })

  test('scores what is on disk now, weighted by size, skipping missing files and relative paths', async () => {
    const path = file(`${KEPT}// the rest of the file\n`)
    const m = await measureEditSurvival([
      write(path, KEPT),
      write(path, GONE),
      write(join(dir, 'deleted-scratch.ts'), GONE),
      write('relative/a.ts', GONE),
    ])
    expect(m.measured).toBe(2)
    expect(m.dueAt).toBeNull()
    expect(m.score).toBeGreaterThan(0.4)
    expect(m.score).toBeLessThan(0.7)
  })
})

describe('wired into the analytics scan', () => {
  test('a transcript edit is scored against its file and the written text is not kept', async () => {
    const path = file(KEPT)
    const a = await scanSessionAnalytics(
      transcript([
        edits(ago(3 * HOUR), [
          { name: 'Write', input: { file_path: path, content: KEPT } },
          { name: 'Edit', input: { file_path: path, old_string: 'x', new_string: GONE } },
        ]),
      ]),
      'claude',
    )
    expect(a.editSurvival.measured).toBe(2)
    expect(a.editSurvival.score).toBeCloseTo(KEPT.length / (KEPT.length + GONE.length), 1)
    expect(a.writes).toEqual([])
  })

  const tf = (path: string, id: string) =>
    ({
      source: 'claude',
      session_id: id,
      path,
      project: 'survival-project',
      cwd: 'D:/survival',
      mtime_ms: 1_700_000_000_000,
      size_bytes: 4096,
      title: '',
      archived: false,
      created_at: null,
    }) as never

  test('a row whose measurement came due is rescanned although its file did not change', async () => {
    const t = tf(
      transcript([
        edits(ago(10 * 60_000), [
          { name: 'Write', input: { file_path: file(KEPT), content: KEPT } },
        ]),
      ]),
      'bbbbbbbb-0000-4000-8000-000000000001',
    )
    expect((await refreshAnalytics([t], { budgetMs: 5_000, concurrency: 1 })).scanned).toBe(1)
    expect((await refreshAnalytics([t], { budgetMs: 5_000, concurrency: 1 })).skipped).toBe(1)
    db.run('update session_scan_cache set edit_survival_due_at = ? where cache_key = ?', [
      Date.now() - 1,
      analyticsCacheKey(t),
    ])
    expect((await refreshAnalytics([t], { budgetMs: 5_000, concurrency: 1 })).scanned).toBe(1)
  })

  test('a session whose code mostly did not survive is worth a second look', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000002'
    const path = file('// rewritten by hand since\n')
    const t = tf(
      transcript([
        edits(ago(3 * HOUR), [
          { name: 'Edit', input: { file_path: path, old_string: 'a', new_string: KEPT } },
          { name: 'Edit', input: { file_path: path, old_string: 'b', new_string: GONE } },
        ]),
      ]),
      id,
    )
    await refreshAnalytics([t], { budgetMs: 5_000, concurrency: 1 })
    const report = activityReport()
    const row = report.health.find((h) => h.session_id === id)
    expect(row?.editSurvival).toBeLessThan(0.5)
    expect(report.editSurvival.sessions).toBeGreaterThanOrEqual(1)
  })
})
