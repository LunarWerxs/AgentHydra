import { describe, expect, test } from 'bun:test'
import { emptyListText } from '../../src/components/sidebar/logic'

describe('an empty list names the filter that empties it', () => {
  test('switching the filter with Active only on and no active chats says Active only is why', () => {
    expect(emptyListText({ searching: false, hiddenOut: false, activeOnly: true, filter: 'all' })).toBe('No active sessions')
    expect(emptyListText({ searching: false, hiddenOut: false, activeOnly: true, filter: 'archived' })).toBe('No active archived sessions')
  })

  test('the Archived filter alone still says so', () => {
    expect(emptyListText({ searching: false, hiddenOut: false, activeOnly: false, filter: 'archived' })).toBe('No archived sessions')
  })

  test('a search and hidden groups keep their own words', () => {
    expect(emptyListText({ searching: true, hiddenOut: true, activeOnly: true, filter: 'all' })).toBe('No matching sessions')
    expect(emptyListText({ searching: false, hiddenOut: true, activeOnly: false, filter: 'active' })).toBe('Every group here is hidden')
  })
})
