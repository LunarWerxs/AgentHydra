import { describe, expect, test } from 'bun:test'
import { matchesSearch, searchTerms, searchText } from './instance-filter'

// The Instances header's search: what a typed word finds on a row.
describe('instance search', () => {
  const row = searchText(171, 'Work CLI', 'Example Owner <owner@example.com>', null, 'Max 20×', 'cli')
  const find = (query: string) => matchesSearch(row, searchTerms(query))

  test('finds a row by its number, with or without the #', () => {
    expect(find('171')).toBe(true)
    expect(find('#171')).toBe(true)
    expect(find('#172')).toBe(false)
  })

  test('finds a plan typed with an x for the ×, and an account by part of its address', () => {
    expect(find('20x')).toBe(true)
    expect(find('owner@example')).toBe(true)
  })

  test('needs every word, in any order and any case', () => {
    expect(find('max WORK')).toBe(true)
    expect(find('max pro')).toBe(false)
  })

  test('an empty box finds every row, and a row with nothing to search is found only by it', () => {
    expect(find('   ')).toBe(true)
    expect(matchesSearch(undefined, searchTerms(''))).toBe(true)
    expect(matchesSearch(undefined, searchTerms('171'))).toBe(false)
  })
})
