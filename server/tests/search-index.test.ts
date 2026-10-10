// server/tests/search-index.test.ts — the conversation index (server/src/search-index.ts).
//
// The index is an ACCELERATOR, never a source of truth, and every test here is really testing one
// of three promises: it holds conversation and not tool output (that is why it is 12 MB and not
// 200 MB), it stays in step with files that change, and it never answers when it cannot answer
// properly — a cold, damaged or unusable index returns null so the caller scans instead.
//
// Fixtures are hand-written JSONL in a temp dir: no real session data, no secrets.

import { Database } from 'bun:sqlite'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  conversationText,
  dropSearchIndex,
  type IndexableFile,
  queryUsableByIndex,
  refreshSearchIndex,
  SEGMENT_CHARS,
  searchIndexCandidates,
  searchIndexCoverage,
  searchIndexPath,
  searchIndexStatus,
  segmentBody,
  setSearchIndexClockForTests,
  setSearchIndexPathForTests,
  toMatchExpression,
  upkeepSearchIndex,
} from '../src/search-index'
import { dedupeKey } from '../src/session-locator'

// The keys the index answers with; which rung answered is pinned in the ladder tests below.
const candidateKeys = (query: string) => searchIndexCandidates(query)?.keys ?? null

// The index keys rows by dedupeKey (audit AH-35), not a bare `${source}:${id}`. These fixtures
// never set `tool`, so it defaults to `source` and this resolves to the same identity every test
// below already expected — computed via the real function rather than a hand-typed string, so a
// future change to dedupeKey's shape cannot silently desync the assertions from the code.
const claudeKey = (id: string) => dedupeKey({ source: 'claude', session_id: id, path: '' })

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'agh-search-index-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  dropSearchIndex()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const turn = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    type: role,
    timestamp: '2024-08-13T10:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  })

const codexItem = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    type: 'response_item',
    timestamp: '2024-08-13T10:00:00.000Z',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  })

const toolResult = (text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2024-08-13T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', content: text }] },
  })

let dir: string
beforeEach(() => {
  dir = scratch()
  setSearchIndexPathForTests(join(dir, 'index.db'))
})

/** Write a transcript and describe it the way the daemon's own file index would. */
function session(id: string, lines: string[]): IndexableFile {
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  const st = statSync(path)
  return { session_id: id, source: 'claude', path, mtime_ms: st.mtimeMs, size_bytes: st.size }
}

describe('conversationText', () => {
  test('keeps what was said', () => {
    const text = conversationText(
      [turn('user', 'where is the postcode validator'), turn('assistant', 'in checkout')].join(
        '\n',
      ),
    )
    expect(text).toContain('postcode validator')
    expect(text).toContain('in checkout')
  })

  // The entire size argument rests on this: tool output is 88% of the text, and skipping it is
  // what keeps the index at 12 MB instead of 200 MB.
  test('drops tool output, which is the whole reason the index is small', () => {
    const text = conversationText(
      [turn('user', 'run the tests'), toolResult('SECRET_TOOL_OUTPUT_MARKER all 214 passed')].join(
        '\n',
      ),
    )
    expect(text).toContain('run the tests')
    expect(text).not.toContain('SECRET_TOOL_OUTPUT_MARKER')
  })

  test('drops thinking blocks and survives malformed lines', () => {
    const text = conversationText(
      [
        '{not json',
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'PRIVATE_REASONING' },
              { type: 'text', text: 'the visible answer' },
            ],
          },
        }),
        JSON.stringify({ type: 'queue-operation', op: 'dequeue' }),
      ].join('\n'),
    )
    expect(text).toBe('the visible answer')
  })

  test('reads a Codex rollout: what was said, without the context the runtime sends as user blocks', () => {
    const text = conversationText(
      [
        codexItem('user', '<environment_context>RUNTIME_CONTEXT_MARKER</environment_context>'),
        codexItem('user', 'where is the postcode validator'),
        codexItem('assistant', 'in checkout'),
      ].join('\n'),
    )
    expect(text).toBe('where is the postcode validator\nin checkout')
  })

  test('keeps a plain-string message and adds nothing for a message with no content list or a Codex non-message', () => {
    const text = conversationText(
      [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'a plain string message' },
        }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'shell' },
        }),
      ].join('\n'),
    )
    expect(text).toBe('a plain string message')
  })
})

describe('an index from before Codex text was read', () => {
  // Such an index held each Codex row with none of its words, and at the rollout's own mtime and size it
  // would never have been read again: every Codex session it claimed to cover stayed unfindable.
  test('reads its Codex sessions again', async () => {
    const path = join(dir, 'rollout.jsonl')
    writeFileSync(path, `${codexItem('user', 'the quokka migration plan')}\n`)
    const st = statSync(path)
    const rollout: IndexableFile = {
      session_id: 'codex-old',
      source: 'codex',
      path,
      mtime_ms: st.mtimeMs,
      size_bytes: st.size,
    }
    await refreshSearchIndex([rollout])
    setSearchIndexPathForTests(searchIndexPath()) // let go of the file, to make it what the old code left
    const old = new Database(searchIndexPath())
    old.exec('delete from conv')
    old.exec("delete from meta where k = 'codex_text'")
    old.close()

    await refreshSearchIndex([rollout])
    expect(candidateKeys('quokka')).toEqual(
      new Set([dedupeKey({ source: 'codex', session_id: 'codex-old', path: '' })]),
    )
  })
})

describe('query translation', () => {
  test('a regex search never uses the index', () => {
    expect(queryUsableByIndex('^foo.*bar$', true)).toBe(false)
    expect(queryUsableByIndex('foo', false)).toBe(true)
  })

  test('a multi-word query becomes one phrase, so word order and adjacency still mean something', () => {
    expect(toMatchExpression('rate limit')).toBe('"rate limit"')
  })

  test('FTS operator syntax is quoted into inertness rather than parsed', () => {
    // Unquoted, each of these is an FTS5 operator and would either error or silently mean
    // something the user did not type.
    expect(toMatchExpression('foo OR bar')).toBe('"foo or bar"')
    expect(toMatchExpression('NEAR(a b)')).toBe('"near a b"')
    expect(toMatchExpression('-flag*')).toBe('"flag"')
  })

  test('a query of pure punctuation cannot be answered by the index', () => {
    expect(toMatchExpression('  ***  ')).toBeNull()
    expect(candidateKeys('***')).toBeNull()
  })
})

describe('refresh and query', () => {
  test('indexes sessions and finds them by word and by phrase', async () => {
    const files = [
      session('a', [turn('user', 'the postcode validator accepts an empty value')]),
      session('b', [turn('assistant', 'I hit a rate limit and backed off')]),
      session('c', [turn('user', 'completely unrelated conversation')]),
    ]
    const r = await refreshSearchIndex(files)
    expect(r.indexed).toBe(3)

    expect(candidateKeys('postcode')).toEqual(new Set([claudeKey('a')]))
    expect(candidateKeys('rate limit')).toEqual(new Set([claudeKey('b')]))
    // Out of order is not the phrase, but both words are present, so the all-words rung finds it.
    expect(candidateKeys('limit rate')).toEqual(new Set([claudeKey('b')]))
  })

  test('matching is case-insensitive, so the index over-selects and never under-selects', async () => {
    await refreshSearchIndex([session('a', [turn('user', 'WindowsHide must be set')])])
    expect(candidateKeys('windowshide')).toEqual(new Set([claudeKey('a')]))
    expect(candidateKeys('WINDOWSHIDE')).toEqual(new Set([claudeKey('a')]))
  })

  test('text inside a tool result is not findable, which is the documented limit', async () => {
    await refreshSearchIndex([
      session('a', [turn('user', 'run it'), toolResult('the needle is in here')]),
    ])
    expect(candidateKeys('needle')).toEqual(new Set())
  })

  test('a changed transcript is re-indexed, and the old text stops matching', async () => {
    const first = session('a', [turn('user', 'original wording')])
    await refreshSearchIndex([first])
    expect(candidateKeys('original')).toEqual(new Set([claudeKey('a')]))

    // Same session id, new content: what the daemon sees when a session is carried on.
    writeFileSync(first.path, `${turn('user', 'replacement wording')}\n`)
    const st = statSync(first.path)
    const changed: IndexableFile = { ...first, mtime_ms: st.mtimeMs, size_bytes: st.size }
    const r = await refreshSearchIndex([changed])
    expect(r.indexed).toBe(1)
    expect(candidateKeys('replacement')).toEqual(new Set([claudeKey('a')]))
    expect(candidateKeys('original')).toEqual(new Set()) // no stale ghost
  })

  test('an unchanged transcript is not re-read on the next pass', async () => {
    const files = [session('a', [turn('user', 'stable content')])]
    expect((await refreshSearchIndex(files)).indexed).toBe(1)
    expect((await refreshSearchIndex(files)).indexed).toBe(0)
  })

  test('a session that disappears is dropped from the index', async () => {
    const a = session('a', [turn('user', 'first')])
    const b = session('b', [turn('user', 'second')])
    await refreshSearchIndex([a, b])
    expect(candidateKeys('second')).toEqual(new Set([claudeKey('b')]))

    const r = await refreshSearchIndex([a]) // b is gone from the store
    expect(r.removed).toBe(1)
    expect(candidateKeys('second')).toEqual(new Set())
  })

  test('upkeep shrinks an index that deletions bloated, and search still answers', async () => {
    const big = 'filler '.repeat(4000)
    const files = Array.from({ length: 12 }, (_, i) =>
      session(`s${i}`, [turn('user', `${big} keepword${i}`)]),
    )
    for (const f of files)
      await refreshSearchIndex([f, ...files.filter((g) => g !== f)].slice(0, 12))
    await refreshSearchIndex(files.slice(0, 1)) // drops 11 sessions
    const before = statSync(searchIndexPath()).size
    const r = upkeepSearchIndex()
    expect(r).not.toBeNull()
    expect(r?.vacuumed || r?.freeRatio === 0).toBe(true)
    expect(statSync(searchIndexPath()).size).toBeLessThan(before)
    expect(candidateKeys('keepword0')).toEqual(new Set([claudeKey('s0')]))
    // Thirteen refreshes of 12 bodies: 6.4 s on the GitHub Windows runner (2026-10-04), past bun's 5 s.
  }, 30_000)

  test('coverage reports what is current, so a stale index can stand aside', async () => {
    const a = session('a', [turn('user', 'hello')])
    const b = session('b', [turn('user', 'world')])
    await refreshSearchIndex([a])
    expect(searchIndexCoverage([a, b])).toEqual({ covered: 1, stale: 1 })
    await refreshSearchIndex([a, b])
    expect(searchIndexCoverage([a, b])).toEqual({ covered: 2, stale: 0 })
  })

  test('a failed open is a cooldown, not a latch: the index comes back once the cause clears', async () => {
    // The GitHub Windows runner (2026-09-12) had exactly this shape: one open of a fresh file
    // failed (6.6 s, a scanner still holding it), and the old permanent latch then answered
    // "0 covered, all stale" for the rest of the process. Here the cause is a missing parent
    // directory, which sqlite cannot create; it clears the moment the directory exists.
    let clock = 1_000_000
    setSearchIndexClockForTests(() => clock)
    try {
      const parent = join(dir, 'not-yet')
      setSearchIndexPathForTests(join(parent, 'index.db'))
      const a = session('a', [turn('user', 'hello')])
      await refreshSearchIndex([a])
      expect(searchIndexCoverage([a])).toEqual({ covered: 0, stale: 1 })

      mkdirSync(parent) // the cause is gone...
      await refreshSearchIndex([a])
      expect(searchIndexCoverage([a])).toEqual({ covered: 0, stale: 1 }) // ...but the cooldown holds

      clock += 31_000
      await refreshSearchIndex([a])
      expect(searchIndexCoverage([a])).toEqual({ covered: 1, stale: 0 }) // and then it recovers
    } finally {
      setSearchIndexClockForTests(null)
    }
  })

  test('an unreadable transcript is skipped rather than failing the pass', async () => {
    const good = session('a', [turn('user', 'readable')])
    const missing: IndexableFile = {
      session_id: 'ghost',
      source: 'claude',
      path: join(dir, 'does-not-exist.jsonl'),
      mtime_ms: 1,
      size_bytes: 1,
    }
    const r = await refreshSearchIndex([good, missing])
    expect(r.indexed).toBe(1)
    expect(candidateKeys('readable')).toEqual(new Set([claudeKey('a')]))
  })

  test('a budget stops a pass part-way and reports the backlog, newest first', async () => {
    const files = Array.from({ length: 40 }, (_, i) =>
      session(`s${i}`, [turn('user', `session number ${i}`)]),
    )
    const r = await refreshSearchIndex(files, { budgetMs: -1 }) // already expired
    expect(r.indexed).toBe(0)
    expect(r.remaining).toBe(40)
  })
})

// The ladder: phrase, then all words, then typo repair, then any word. Each test pins one rung's
// boundary through the public search function, the only thing a caller can observe.
describe('retrieval ladder', () => {
  test('words that are all in a session but not adjacent still find it', async () => {
    await refreshSearchIndex([
      session('a', [turn('user', 'the postcode validator accepts an empty value')]),
      session('b', [turn('user', 'completely unrelated conversation')]),
    ])
    expect(candidateKeys('empty postcode')).toEqual(new Set([claudeKey('a')]))
    expect(searchIndexCandidates('empty postcode')?.relaxed).toEqual({
      rung: 'all-words',
      words: ['empty', 'postcode'],
    })
  })

  // Regression: a one-letter typo found nothing, because the whole query was one phrase and a
  // misspelt word is in no phrase. The repaired hit has to come from the index's own word list.
  test('a one-letter typo of a word in the index finds the session that has the real word', async () => {
    await refreshSearchIndex([
      session('a', [turn('user', 'WindowsHide must be set')]),
      session('c', [turn('user', 'completely unrelated conversation')]),
    ])
    expect(candidateKeys('windowsshide')).toEqual(new Set([claudeKey('a')]))
    expect(searchIndexCandidates('windowsshide')?.relaxed).toEqual({
      rung: 'repaired',
      words: ['windowshide'],
    })
  })

  // Regression for the ordering: typo repair must run before OR, or the common word "common" in
  // every session would drown the one session that holds the repaired "zebra".
  test('a typo beside a common word ranks the repaired hit, not OR noise', async () => {
    await refreshSearchIndex([
      session('a', [turn('user', 'the zebra crossing is common in notes')]),
      session('b', [turn('user', 'common notes')]),
      session('c', [turn('user', 'common notes again')]),
      session('d', [turn('user', 'common words here')]),
    ])
    expect(candidateKeys('zebre common')).toEqual(new Set([claudeKey('a')]))
  })

  // The phrase rung must keep an exact phrase from being widened by the looser rungs: the AND rung
  // would also return the session where the two words are present but reversed.
  test('an exact phrase answers alone, before the all-words rung widens it', async () => {
    await refreshSearchIndex([
      session('a', [turn('user', 'rate limit is hit often')]),
      session('b', [turn('user', 'the limit sets the rate')]),
    ])
    expect(candidateKeys('rate limit')).toEqual(new Set([claudeKey('a')]))
    expect(searchIndexCandidates('rate limit')?.relaxed).toBeNull()
  })

  test('a case-sensitive search keeps to the phrase', async () => {
    await refreshSearchIndex([session('a', [turn('user', 'the limit sets the rate')])])
    expect(searchIndexCandidates('rate limit', { exact: true })).toEqual({
      keys: new Set(),
      relaxed: null,
    })
  })
})

describe('status and deletion', () => {
  test('status reports the file, and the file is exactly one file', async () => {
    await refreshSearchIndex([session('a', [turn('user', 'hello')])])
    const s = searchIndexStatus()
    expect(s.exists).toBe(true)
    expect(s.sessions).toBe(1)
    expect(s.sizeBytes).toBeGreaterThan(0)
    expect(s.builtAt).toBeGreaterThan(0)
    // A WAL sidecar would make "just delete the file" a corruption bug.
    expect(() => statSync(`${searchIndexPath()}-wal`)).toThrow()
  })

  test('deleting it leaves nothing behind, and it rebuilds from the transcripts', async () => {
    const files = [session('a', [turn('user', 'rebuildable')])]
    await refreshSearchIndex(files)
    expect(dropSearchIndex()).toBe(true)
    expect(searchIndexStatus().exists).toBe(false)
    expect(() => statSync(searchIndexPath())).toThrow()

    await refreshSearchIndex(files)
    expect(candidateKeys('rebuildable')).toEqual(new Set([claudeKey('a')]))
  })

  test('an empty store gives an empty index, not an error', async () => {
    const r = await refreshSearchIndex([])
    expect(r.indexed).toBe(0)
    expect(searchIndexCoverage([])).toEqual({ covered: 0, stale: 0 })
  })
})

describe('segmented bodies', () => {
  test('a body over the segment size is found by words in any segment, including across a cut', () => {
    const filler = 'alpha '.repeat(Math.ceil((SEGMENT_CHARS * 2.5) / 6))
    const segs = segmentBody(`first ${filler} middle needle word ${filler} lastonly`)
    expect(segs.length).toBeGreaterThan(2)
    expect(segs.every((s) => s.length <= SEGMENT_CHARS)).toBe(true)
    expect(segs.some((s) => s.includes('lastonly'))).toBe(true)
    expect(segs.some((s) => s.includes('needle word'))).toBe(true)
  })
})

describe('incremental append', () => {
  test('a grown transcript is extended from its indexed offset; a rewritten one is rebuilt', async () => {
    const f1 = session('grow', [turn('user', 'alphaonly'), turn('assistant', 'reply')])
    await refreshSearchIndex([f1])
    appendFileSync(f1.path, `${turn('assistant', 'betaappended')}\n`)
    const st = statSync(f1.path)
    const f2 = { ...f1, mtime_ms: st.mtimeMs, size_bytes: st.size }
    const r = await refreshSearchIndex([f2])
    expect(r.indexed).toBe(1)
    expect(candidateKeys('betaappended')?.has(claudeKey('grow'))).toBe(true)
    expect(candidateKeys('alphaonly')?.has(claudeKey('grow'))).toBe(true)
    // Same size or smaller is not an append: the old words must go.
    writeFileSync(f1.path, `${turn('user', 'gammarewritten')}\n`)
    const st2 = statSync(f1.path)
    await refreshSearchIndex([{ ...f1, mtime_ms: st2.mtimeMs + 1, size_bytes: st2.size }])
    expect(candidateKeys('alphaonly')?.has(claudeKey('grow')) ?? false).toBe(false)
    expect(candidateKeys('gammarewritten')?.has(claudeKey('grow'))).toBe(true)
  })
})
