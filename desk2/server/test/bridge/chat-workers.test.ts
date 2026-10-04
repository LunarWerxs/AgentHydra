import { describe, expect, test } from 'bun:test'
import { workersOfChat } from '../../src/bridge/climayte'
import { worker } from '../engine/manager/fakes'

describe('workersOfChat', () => {
  test('a sub-worker dispatched under the chat worker\'s old session still counts after a handoff', () => {
    const workers = [
      worker({ id: 'chat-worker', sessionId: 'new-session', sessions: ['old-session', 'new-session'] }),
      worker({ id: 'sub', originSessionId: 'old-session' }),
      worker({ id: 'stranger', originSessionId: 'elsewhere' }),
    ]
    const mine = workersOfChat(workers, { sessionId: 'new-session', workerId: 'chat-worker' })
    expect(mine.map((w) => w.id)).toEqual(['sub'])
  })

  test('a worker of a worker belongs through the chain, and a cycle does not hang', () => {
    const workers = [
      worker({ id: 'chat-worker', sessionId: 's1' }),
      worker({ id: 'a', originWorkerId: 'chat-worker', originSessionId: 's1' }),
      worker({ id: 'b', originWorkerId: 'a' }),
      worker({ id: 'c', originWorkerId: 'b' }),
      worker({ id: 'x', originWorkerId: 'y' }),
      worker({ id: 'y', originWorkerId: 'x' }),
    ]
    expect(workersOfChat(workers, { sessionId: 's1', workerId: 'chat-worker' }).map((w) => w.id).sort()).toEqual(['a', 'b', 'c'])
  })

  test('workers matched before still count when their parent left the list', () => {
    const workers = [worker({ id: 'b', originWorkerId: 'gone' })]
    expect(workersOfChat(workers, { sessionId: 's1' })).toEqual([])
    expect(workersOfChat(workers, { sessionId: 's1', workerIds: ['gone'] }).map((w) => w.id)).toEqual(['b'])
  })
})
