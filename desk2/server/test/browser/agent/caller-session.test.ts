import { describe, expect, test } from 'bun:test'
import { callerSession, type CallerSessionDeps } from '../../../src/browser/agent/caller-session'

const deps: CallerSessionDeps = {
  chatSessions: (id) => (id === 'chat-1' ? ['session-current', 'session-earlier'] : []),
  workers: async () => [
    { id: 'worker-1', sessionId: 'worker-session-now' },
    { id: 'worker-2', sessionId: null },
  ],
}

describe('the caller session for the tab ledger', () => {
  test('a Desk chat resolves to its current session, the first one', async () => {
    expect(await callerSession({ chat: 'chat-1' }, deps)).toBe('session-current')
  })

  test('a CliMayte worker resolves to its current sessionId, not an earlier one', async () => {
    expect(await callerSession({ worker: 'worker-1' }, deps)).toBe('worker-session-now')
  })

  test('no id, or an unknown worker, resolves to undefined', async () => {
    expect(await callerSession({}, deps)).toBeUndefined()
    expect(await callerSession({ worker: 'worker-2' }, deps)).toBeUndefined()
    expect(await callerSession({ worker: 'missing' }, deps)).toBeUndefined()
  })
})
