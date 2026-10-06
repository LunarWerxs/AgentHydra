import { expect, test } from 'bun:test'
import type { FreeInstance, FreeThread } from '@desk/shared/free-instances'
import { freeThreadRow } from './free-threads'

test('Free threads keep account identity and use a separate detail transport', () => {
  const thread: FreeThread = { id: 'account/chat', instanceId: 'account', provider: 'chatgpt', chatId: 'chat', title: 'Example private task', status: 'done', createdAt: 1, updatedAt: 2, error: null }
  const instance: FreeInstance = { id: 'account', num: 2, provider: 'chatgpt', name: 'Example account', autoName: false, loggedIn: true, checkedAt: 1, lastSignedInAt: 1, lastActiveAt: null, usage: null }
  const row = freeThreadRow(thread, instance)
  expect(row.id).toBe('free:account/chat')
  expect(row.account).toBe('#2 Example account')
  expect(row.free).toBe(thread)
  expect(row.sessionId).toBeNull()
  expect(row.accountId).toBeNull()
  expect(row.model).toContain('Temporary')
})
