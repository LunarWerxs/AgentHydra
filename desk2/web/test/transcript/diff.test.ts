import { describe, expect, test } from 'bun:test'
import { allAdded, collapseContext, diffLines, splitLines, toolDiff } from '../../src/components/transcript/lib/diff'

const show = (d: ReturnType<typeof diffLines>) =>
  d.lines.map((l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text)

describe('diffLines', () => {
  test('one changed line between unchanged context', () => {
    const d = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(show(d)).toEqual([' a', '-b', '+B', ' c'])
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
  })

  test('line numbers follow each side', () => {
    const d = diffLines('a\nb\nc', 'a\nx\ny\nc')
    expect(d.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['ctx', 3, 4],
    ])
  })

  test('an insertion in the middle keeps the moved lines as context', () => {
    const d = diffLines('one\ntwo\nthree\nfour', 'one\ntwo\nNEW\nthree\nfour')
    expect(show(d)).toEqual([' one', ' two', '+NEW', ' three', ' four'])
  })

  test('interleaved changes show removals before additions in each run', () => {
    const d = diffLines('k\na\nb\nk2', 'k\nA\nB\nk2')
    expect(show(d)).toEqual([' k', '-a', '-b', '+A', '+B', ' k2'])
  })

  test('identical text has no changes; empty to text is all added', () => {
    expect(diffLines('x\ny', 'x\ny').added).toBe(0)
    expect(show(diffLines('', 'p\nq'))).toEqual(['+p', '+q'])
    expect(show(diffLines('p\nq', ''))).toEqual(['-p', '-q'])
  })

  test('CRLF and LF compare equal; a trailing newline adds no empty line', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(diffLines('a\r\nb', 'a\nb').added).toBe(0)
  })
})

describe('collapseContext', () => {
  test('long unchanged runs fold into one gap', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const nu = old.replace('l10', 'L10')
    const rows = collapseContext(diffLines(old, nu).lines, 2)
    expect(rows[0]).toBeNull()
    expect(rows[rows.length - 1]).toBeNull()
    expect(rows.filter((r) => r !== null).map((r) => r!.text)).toEqual(['l8', 'l9', 'l10', 'L10', 'l11', 'l12'])
  })
})

describe('toolDiff', () => {
  test('Write is every line added, Edit diffs old_string to new_string', () => {
    expect(toolDiff('Write', { content: 'a\nb\n' })).toEqual(allAdded('a\nb'))
    expect(toolDiff('Edit', { old_string: 'x', new_string: 'y' })!.lines.map((l) => l.type)).toEqual(['del', 'add'])
  })

  test('MultiEdit sums every edit', () => {
    const d = toolDiff('MultiEdit', {
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c\nd', new_string: 'c' },
      ],
    })!
    expect(d.added).toBe(1)
    expect(d.removed).toBe(2)
  })

  test('other tools have no diff', () => {
    expect(toolDiff('Bash', { command: 'ls' })).toBeNull()
  })
})
