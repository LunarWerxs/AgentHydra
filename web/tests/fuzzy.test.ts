// web/src/lib/fuzzy.ts - the fzf-style scorer behind the session search box.
//
// Pins the three things the plain includes() filter it replaced could not do: an abbreviation that
// is only a subsequence still matches, the best match sorts ahead of list order, and the matched
// characters come back as runs the list can bold. Plus the limits that keep it a filter: a
// non-subsequence and a query with one unmatched term still match nothing.

import { describe, expect, test } from 'bun:test'
import { fuzzyMatch, highlightRuns, matchFields, rankByQuery } from '../src/lib/fuzzy'

describe('fuzzyMatch', () => {
  test('an abbreviation matches as a subsequence, with its positions', () => {
    const m = fuzzyMatch('Codex session', 'cdxsess')
    expect(m).not.toBeNull()
    const positions = m?.positions ?? []
    expect(positions).toHaveLength(7)
    expect(positions.map((p) => 'codex session'[p]).join('')).toBe('cdxsess')
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test('a pattern that is not a subsequence does not match', () => {
    expect(fuzzyMatch('Codex session', 'sessx')).toBeNull()
  })
})

describe('rankByQuery', () => {
  test('a contiguous word-start hit outranks a scattered one listed before it', () => {
    const rows = ['status: exports saved safely', 'unrelated', 'Session list']
    const ranked = rankByQuery(rows, 'sess', (t) => ({ primary: t })).map((r) => r.row)
    expect(ranked).toEqual(['Session list', 'status: exports saved safely'])
  })
})

describe('matchFields', () => {
  test('every space-separated term must match', () => {
    expect(matchFields({ primary: 'Codex session' }, 'cdx zzz')).toBeNull()
    expect(matchFields({ primary: 'Codex session' }, 'cdx sess')).not.toBeNull()
  })

  test('a hit in a secondary field ranks the row but highlights nothing', () => {
    const m = matchFields({ primary: 'Fix bug', secondary: ['/home/dev/quickdictate'] }, 'qdict')
    expect(m).not.toBeNull()
    expect(m?.positions).toEqual([])
  })
})

describe('highlightRuns', () => {
  test('splits the text into matched and plain runs', () => {
    expect(highlightRuns('abc', [0, 1])).toEqual([
      { text: 'ab', hit: true },
      { text: 'c', hit: false },
    ])
  })
})
