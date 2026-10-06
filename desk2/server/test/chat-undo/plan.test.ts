// chat-undo/plan.ts on fabricated transcripts in a temp folder: what is ready, what is refused, and what is written.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyUndo, lineChange, planUndo } from '../../src/chat-undo/plan'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'chat-undo-'))
  dirs.push(d)
  return d
}

let n = 0
/** One tool call and its result as two transcript lines. */
function call(tool: string, input: Record<string, unknown>, result: Record<string, unknown>, error = false): string {
  const id = `t${++n}`
  return [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] }, toolUseResult: result })
  ].join('\n')
}

test('an edited file goes back, a created one is deleted, and the counts are the chat net change', () => {
  const cwd = folder()
  writeFileSync(join(cwd, 'a.txt'), 'one\nTWO\nthree\nfour\n')
  writeFileSync(join(cwd, 'new.txt'), 'hello\n')
  const log = [
    call('Edit', { file_path: join(cwd, 'a.txt'), old_string: 'two', new_string: 'TWO' }, { originalFile: 'one\ntwo\nthree\n' }),
    call('Edit', { file_path: join(cwd, 'a.txt'), old_string: 'three\n', new_string: 'three\nfour\n' }, { originalFile: 'one\nTWO\nthree\n' }),
    call('Write', { file_path: join(cwd, 'new.txt'), content: 'hello\n' }, { type: 'create', originalFile: null })
  ].join('\n')
  const plan = planUndo(log, cwd)
  expect(plan.files).toEqual([
    { path: 'a.txt', added: 2, removed: 1, kind: 'restore', state: 'ready' },
    { path: 'new.txt', added: 1, removed: 0, kind: 'delete', state: 'ready' }
  ])
  expect(applyUndo(log, cwd, ['a.txt', 'new.txt'])).toEqual({ done: ['a.txt', 'new.txt'], skipped: [] })
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
})

test('a file someone else changed since the chat wrote it is flagged and never written', () => {
  const cwd = folder()
  writeFileSync(join(cwd, 'a.txt'), 'one\nTWO\nby someone else\n')
  const log = call('Edit', { file_path: join(cwd, 'a.txt'), old_string: 'two', new_string: 'TWO' }, { originalFile: 'one\ntwo\n' })
  expect(planUndo(log, cwd).files[0]).toMatchObject({ path: 'a.txt', state: 'changed' })
  expect(applyUndo(log, cwd, ['a.txt']).skipped).toHaveLength(1)
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\nTWO\nby someone else\n')
})

test('files the chat did not change are never listed, failed calls do not count, and outside paths are refused', () => {
  const cwd = folder()
  const other = folder()
  writeFileSync(join(cwd, 'untouched.txt'), 'x\n')
  writeFileSync(join(cwd, 'failed.txt'), 'x\n')
  writeFileSync(join(other, 'out.txt'), 'y\n')
  const log = [
    call('Edit', { file_path: join(cwd, 'failed.txt'), old_string: 'x', new_string: 'z' }, {}, true),
    call('Write', { file_path: join(other, 'out.txt'), content: 'y\n' }, { type: 'update', originalFile: 'old\n' }),
    call('NotebookEdit', { notebook_path: join(cwd, 'n.ipynb') }, {})
  ].join('\n')
  const files = planUndo(log, cwd).files
  expect(files.map((f) => [f.state, f.path.endsWith('out.txt')])).toEqual([
    ['unknown', true],
    ['unknown', false]
  ])
  expect(applyUndo(log, cwd, ['untouched.txt', 'failed.txt']).done).toEqual([])
  expect(readFileSync(join(other, 'out.txt'), 'utf8')).toBe('y\n')
})

test('a CRLF file is put back with its CRLF endings, and a chat that made no net change lists nothing', () => {
  const cwd = folder()
  writeFileSync(join(cwd, 'w.txt'), 'a\r\nB\r\n')
  writeFileSync(join(cwd, 'same.txt'), 'a\n')
  const log = [
    call('Edit', { file_path: join(cwd, 'w.txt'), old_string: 'b', new_string: 'B' }, { originalFile: 'a\nb\n' }),
    call('Edit', { file_path: join(cwd, 'same.txt'), old_string: 'a', new_string: 'b' }, { originalFile: 'a\n' }),
    call('Edit', { file_path: join(cwd, 'same.txt'), old_string: 'b', new_string: 'a' }, { originalFile: 'b\n' })
  ].join('\n')
  expect(planUndo(log, cwd).files.map((f) => f.path)).toEqual(['w.txt'])
  applyUndo(log, cwd, ['w.txt'])
  expect(readFileSync(join(cwd, 'w.txt'), 'utf8')).toBe('a\r\nb\r\n')
})

test('a nested new file is deleted and its parent folder stays', () => {
  const cwd = folder()
  mkdirSync(join(cwd, 'sub'))
  writeFileSync(join(cwd, 'sub', 'x.txt'), 'x\n')
  const log = call('Write', { file_path: join(cwd, 'sub', 'x.txt'), content: 'x\n' }, { type: 'create', originalFile: null })
  expect(applyUndo(log, cwd, ['sub/x.txt']).done).toEqual(['sub/x.txt'])
  expect(existsSync(join(cwd, 'sub'))).toBe(true)
})

test('lineChange counts what a change adds and removes', () => {
  expect(lineChange('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 })
  expect(lineChange('', 'a\nb\n')).toEqual({ added: 2, removed: 0 })
})
