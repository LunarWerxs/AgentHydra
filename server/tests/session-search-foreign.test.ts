// server/tests/session-search-foreign.test.ts — body search over the stores that are not JSONL.
//
// THE SILENT MISS. searchOneFile streams a transcript line by line and JSON.parses each line, which
// is exactly right for Claude and Codex and exactly wrong for the fourth reader: a Grok store is a
// directory of JSON, a VS Code Copilot store is one big JSON document, a Kimi store is neither. Not
// one of those lines parses as a record, so every one was skipped and the file reported ZERO
// matches — and because these rows were already in the sweep (only OpenCode is excluded), the
// session was listed, searched, and declared clean. Measured on a real store before the fix: a
// 9-line Copilot workspace yielded 0 parseable lines and 0 displayable events.
//
// A confident zero is the worst answer a search can give, because the caller stops looking. So:
// ask the adapter, exactly as the transcript view and the exporter already do.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchOneFile } from '../src/session-search'
import type { TranscriptFile } from '../src/transcript'

const root = mkdtempSync(join(tmpdir(), 'agenthydra-foreign-search-'))
const write = (path: string, body: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

// A Grok session: a directory whose chat_history.jsonl is what its adapter reads. Grok's file
// HAPPENS to be JSONL, which makes it the sharpest fixture available — the old line-streaming path
// would parse these lines fine and still return nothing, because eventToTailEventsForSource routes
// `foreign` to the Claude converter and a Grok record carries none of the shapes it looks for.
const dir = join(root, 'grok', '019f0672-8107-7070-b2e9-4f2e909c3421')
write(
  join(dir, 'summary.json'),
  JSON.stringify({
    info: { id: '019f0672', cwd: 'D:\\Projects\\Thing' },
    session_summary: 'Checkpoint history',
    created_at: '2026-06-27T00:19:55.279871Z',
    updated_at: '2026-06-27T00:21:55.595173800Z',
  }),
)
write(
  join(dir, 'chat_history.jsonl'),
  [
    JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: 'summarise the checkpoints' }],
    }),
    JSON.stringify({
      type: 'assistant',
      content: 'Checkpoint 1 is the oldest.',
      model_id: 'grok-build',
    }),
  ].join('\n'),
)

const tf: TranscriptFile = {
  session_id: '019f0672-8107-7070-b2e9-4f2e909c3421',
  source: 'foreign',
  tool: 'grok',
  path: join(dir, 'chat_history.jsonl'),
  project: 'Thing',
  cwd: 'D:\\Projects\\Thing',
  mtime_ms: Date.now(),
  size_bytes: 0,
  archived: false,
}

const substring = (needle: string) => (hay: string) =>
  hay.toLowerCase().indexOf(needle.toLowerCase())
const NO_DEADLINE = performance.now() + 60_000

test('a foreign session is searched through its adapter, not as JSONL', async () => {
  const { hit } = await searchOneFile(tf, substring('checkpoint'), 5, NO_DEADLINE)
  // Both turns mention it: the user's question and the assistant's answer.
  expect(hit?.match_count).toBe(2)
  expect(hit?.source).toBe('foreign')
  expect(hit?.session_id).toBe(tf.session_id)
  expect(hit?.snippets[0]?.toLowerCase()).toContain('checkpoint')
})

test('the row carries the cwd the index already knew, not a re-derived one', () => {
  // A foreign adapter has no per-event `cwd` to sniff the way a Claude transcript does, so the only
  // honest source is the index row. Falling through to `project` would print an opaque key.
  return searchOneFile(tf, substring('checkpoint'), 5, NO_DEADLINE).then(({ hit }) => {
    expect(hit?.cwd).toBe('D:\\Projects\\Thing')
  })
})

test('a genuine miss is still a miss', async () => {
  const { hit, stoppedEarly } = await searchOneFile(tf, substring('kubernetes'), 5, NO_DEADLINE)
  expect(hit).toBeNull()
  // Never "we ran out of time": an adapter reads the whole conversation in one call, so a zero here
  // is a real zero and the caller is entitled to trust it.
  expect(stoppedEarly).toBe(false)
})

test('a store whose layout has moved on contributes nothing rather than throwing', async () => {
  const missing = { ...tf, path: join(root, 'grok', 'does-not-exist') }
  const { hit } = await searchOneFile(missing, substring('checkpoint'), 5, NO_DEADLINE)
  expect(hit).toBeNull()
})
