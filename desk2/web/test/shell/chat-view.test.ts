import { describe, it, expect } from 'bun:test'
import { chatViewOf, type View } from '@/components/shell/logic'

const chats = [
  { id: 'c1', sessionId: 'sess-own' },
  { id: 'c2', sessionId: null }
]

describe('chatViewOf', () => {
  it("opens an outside view of one of Desk's own chats' sessions as that chat", () => {
    expect(chatViewOf({ kind: 'external', id: 'sess-own' }, chats)).toEqual({ kind: 'chat', id: 'c1' })
  })

  it('leaves a session that is not a Desk chat as an outside session', () => {
    const v: View = { kind: 'external', id: 'sess-other' }
    expect(chatViewOf(v, chats)).toBe(v)
  })

  it('passes every other view through', () => {
    for (const v of [{ kind: 'chat', id: 'c1' }, { kind: 'new', cwd: 'C:/Users/me/app' }, { kind: 'elsewhere' }, { kind: 'settings' }] as View[]) {
      expect(chatViewOf(v, chats)).toBe(v)
    }
  })
})
