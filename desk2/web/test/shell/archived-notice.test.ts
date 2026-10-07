import { describe, it, expect } from 'bun:test'
import { archivedNotice } from '@/components/shell/logic'

describe('archivedNotice', () => {
  it('an archived chat unarchives that chat', () => {
    expect(archivedNotice({ kind: 'chat', id: 'c1' }, { id: 'c1', archived: true }, null)).toEqual({ kind: 'chat', id: 'c1', patch: { archived: false } })
  })
  it('an archived outside session unarchives that session', () => {
    expect(archivedNotice({ kind: 'external', id: 's1' }, null, { id: 's1', archived: true })).toEqual({ kind: 'external', id: 's1', patch: { archived: false } })
  })
  it('shows nothing for a chat or session that is not archived', () => {
    expect(archivedNotice({ kind: 'chat', id: 'c1' }, { id: 'c1', archived: false }, null)).toBeNull()
    expect(archivedNotice({ kind: 'external', id: 's1' }, null, { id: 's1', archived: false })).toBeNull()
  })
  it('shows nothing on the new-session screen or Settings', () => {
    expect(archivedNotice({ kind: 'new' }, null, null)).toBeNull()
    expect(archivedNotice({ kind: 'settings' }, { id: 'c1', archived: true }, { id: 's1', archived: true })).toBeNull()
  })
})
