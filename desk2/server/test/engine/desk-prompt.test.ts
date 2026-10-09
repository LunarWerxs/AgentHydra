import { describe, expect, test } from 'bun:test'
import { BROWSER } from '../../src/engine/desk-prompt'

describe('browser paragraph', () => {
  test('names the browser MCP tools directly', () => {
    expect(BROWSER).toContain('browser_profile_find')
    expect(BROWSER).toContain('browser_navigate')
  })

  test('no longer routes browser calls through the connections MCP', () => {
    expect(BROWSER).not.toContain('connections_execute')
  })
})
