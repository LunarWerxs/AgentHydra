// server/tests/sessions-incremental-parse.test.ts — a growing transcript is read from where the last
// read stopped (2026-09-28: whole-file re-reads cost 186 MB/min and a quarter of a core), and the
// answer must be exactly what a from-scratch parse of the same bytes gives. A rewrite, which is not
// an append, must be parsed from scratch.
//
// Each "fresh" comparison scans the same path under another session id, so it has no fold state
// and reads the whole file. The scratch sqlite behind the persisted cache is the suite's.
import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanMeta } from '../src/sessions'
import type { TranscriptFile } from '../src/transcript'

type ScannedMeta = NonNullable<Awaited<ReturnType<typeof scanMeta>>>

function record(role: 'user' | 'assistant', text: string, minute: number, uuid = ''): string {
  const timestamp = `2024-09-28T12:${String(minute).padStart(2, '0')}:00Z`
  return `${JSON.stringify({ type: role, uuid: uuid || undefined, message: { role, content: text }, timestamp })}\n`
}

const FIELDS = [
  'title',
  'message_count',
  'created_at',
  'last_activity_at',
  'last_role',
  'last_text_preview',
  'substantive_turns',
  'thread_key',
  'ended_because',
  'limit_stop',
] as const
const pick = (m: ScannedMeta | null) =>
  m ? Object.fromEntries(FIELDS.map((f) => [f, m[f]])) : null

test('a grown transcript resumes where it stopped and matches a full parse; a rewrite re-parses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-meta-inc-'))
  try {
    const path = join(dir, 'growing.jsonl')
    const tf = (id: string): TranscriptFile => {
      const s = statSync(path)
      return {
        session_id: id,
        source: 'claude',
        path,
        project: 'D--meta-inc',
        mtime_ms: s.mtimeMs,
        size_bytes: s.size,
        archived: false,
      }
    }
    let fresh = 0
    const same = async () => {
      const resumed = await scanMeta(tf('growing'))
      expect(pick(resumed)).toEqual(pick(await scanMeta(tf(`fresh-${++fresh}`))))
      return resumed
    }

    writeFileSync(
      path,
      record('user', 'first title', 0, 'u-1') + record('assistant', 'first answer', 1),
    )
    expect((await same())?.message_count).toBe(2)

    // Half a record lands without its newline: skipped until it is whole, as a full parse skips it.
    const next = record('user', 'second question', 2)
    appendFileSync(path, next.slice(0, 20))
    expect((await same())?.message_count).toBe(2)

    appendFileSync(path, next.slice(20) + record('assistant', 'second answer', 3))
    const grown = await same()
    expect(grown?.message_count).toBe(4)
    expect(grown?.last_text_preview).toBe('second answer')
    expect(grown?.thread_key).toBe('u-1')

    // A last record with no trailing newline at all still counts once it parses.
    appendFileSync(path, record('user', 'third question', 4).trimEnd())
    expect((await same())?.message_count).toBe(5)

    // Rewritten, longer: the bytes before the old read position changed, so nothing is resumed.
    writeFileSync(
      path,
      record('user', 'rewritten title', 5, 'u-2') +
        record('assistant', 'x'.repeat(800), 6) +
        record('user', 'tail', 7),
    )
    const rewritten = await same()
    expect(rewritten?.title).toBe('rewritten title')
    expect(rewritten?.message_count).toBe(3)
    expect(rewritten?.thread_key).toBe('u-2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
