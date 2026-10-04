// server/tests/session-branch.test.ts - "copy up to here into a new chat" (server/src/session-branch.ts).
//
// A real transcript file in a temp folder, in the CLI's own line shapes. A branch the CLI cannot
// resume (a tool call cut off from its result, lines still under the old session id) or a branch
// that touches the original chat are the failures this guards.

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { branchSession } from '../src/session-branch'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const OLD = '11111111-1111-4111-8111-111111111111'
const line = (uuid: string, type: 'user' | 'assistant', content: unknown) =>
  JSON.stringify({ type, uuid, sessionId: OLD, message: { role: type, content } })

const LINES = [
  line('u1', 'user', 'Fix the build'),
  line('a1', 'assistant', [{ type: 'text', text: 'Looking.' }]),
  line('a2', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
  // A reply written while the tool call above is still open.
  line('a3', 'assistant', [{ type: 'text', text: 'Running it now.' }]),
  line('u2', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  line('a4', 'assistant', [{ type: 'text', text: 'Fixed.' }]),
  line('u3', 'user', 'Now ship it'),
]

function transcript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'branch-'))
  dirs.push(dir)
  const path = join(dir, `${OLD}.jsonl`)
  writeFileSync(path, `${LINES.join('\n')}\n`)
  return path
}

const read = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

test('a branch holds the chat up to the reply, under its own id and title, beside the original', () => {
  const path = transcript()
  const made = branchSession(path, 'a1', 'Build fix (branch)')
  expect(made).not.toBeNull()
  if (!made) return
  expect(dirname(made.path)).toBe(dirname(path))
  const lines = read(made.path)
  expect(lines.map((l) => l.uuid ?? l.type)).toEqual(['u1', 'a1', 'custom-title'])
  expect(lines.every((l) => l.sessionId === made.sessionId)).toBe(true)
  expect(lines.at(-1)?.customTitle).toBe('Build fix (branch)')
  expect(readFileSync(path, 'utf8')).toBe(`${LINES.join('\n')}\n`)
})

test('a tool call made before the cut keeps its result', () => {
  const made = branchSession(transcript(), 'a3', 'x')
  expect(made && read(made.path).map((l) => l.uuid ?? l.type)).toEqual([
    'u1',
    'a1',
    'a2',
    'a3',
    'u2',
    'custom-title',
  ])
})

test('a reply that is not in the chat makes nothing', () => {
  const path = transcript()
  expect(branchSession(path, 'not-there', 'x')).toBeNull()
})
