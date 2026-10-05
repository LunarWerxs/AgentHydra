import { describe, expect, it } from 'bun:test'
import { sentHere } from '../../src/components/composer/api'

// Sending brings the chat's own transcript to its bottom, and only that one.
describe('sentHere', () => {
  it("a Desk chat's send goes to the transcript shown under that chat's id", () => {
    expect(sentHere({ chatId: 'c1', sessionId: 's1' }, 'c1')).toBe(true)
    expect(sentHere({ chatId: 'c1', sessionId: 's1' }, 'c2')).toBe(false)
  })

  it("an outside session's composer is a stand-in with its own id: its send goes to the transcript shown under the session id", () => {
    expect(sentHere({ chatId: 'ext:s9', sessionId: 's9' }, 's9')).toBe(true)
    expect(sentHere({ chatId: 'ext:s9', sessionId: null }, 's9')).toBe(false)
  })

  it('no detail moves nothing', () => {
    expect(sentHere(null, 'c1')).toBe(false)
    expect(sentHere(undefined, 'c1')).toBe(false)
  })
})
