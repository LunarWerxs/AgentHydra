import { describe, expect, test } from 'bun:test'
import type { CliMayteWorker } from '@shared/protocol'
import { firstLine, reuseWorkers, workersOfChat } from '../../src/bridge/climayte'
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

describe('workersOfChat on a long list', () => {
  /** What matching did before the list was indexed: every worker tested on its own, up its chain. */
  function reference(all: CliMayteWorker[], chat: { sessionId: string | null; workerId?: string | null; workerIds?: string[] }): string[] {
    const workers = all.filter((w) => !w.pc)
    const byId = new Map(workers.map((w) => [w.id, w]))
    const own = chat.workerId ? byId.get(chat.workerId) : undefined
    const sessions = new Set<string>()
    for (const s of [chat.sessionId, own?.sessionId, ...(own?.sessions ?? [])]) if (s) sessions.add(s)
    const known = new Set(chat.workerIds ?? [])
    const belongs = (w: CliMayteWorker, path: Set<string>): boolean => {
      if (w.id === chat.workerId) return false
      if (path.has(w.id)) return false
      path.add(w.id)
      let yes = known.has(w.id) || (w.originSessionId !== null && sessions.has(w.originSessionId))
      if (!yes && w.originWorkerId) {
        const parent = byId.get(w.originWorkerId)
        yes = w.originWorkerId === chat.workerId || (parent ? belongs(parent, path) : known.has(w.originWorkerId))
      }
      path.delete(w.id)
      return yes
    }
    return workers.filter((w) => belongs(w, new Set())).map((w) => w.id)
  }

  test('finds the same workers as testing each one, for chats of every shape', () => {
    let seed = 7
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const ids = Array.from({ length: 60 }, (_, i) => `w${i}`)
    const sessions = Array.from({ length: 12 }, (_, i) => `s${i}`)
    const workers = ids.map((id) =>
      worker({
        id,
        pc: next(9) === 0 ? 'another PC' : undefined,
        sessionId: sessions[next(sessions.length)]!,
        sessions: next(3) === 0 ? [sessions[next(sessions.length)]!] : [],
        originSessionId: next(3) === 0 ? null : sessions[next(sessions.length)]!,
        originWorkerId: next(2) === 0 ? ids[next(ids.length + 6)] ?? 'gone' : null,
      }),
    )
    for (let i = 0; i < 80; i++) {
      const chat = {
        sessionId: next(5) === 0 ? null : sessions[next(sessions.length)]!,
        workerId: next(2) === 0 ? ids[next(ids.length)]! : null,
        workerIds: next(3) === 0 ? [ids[next(ids.length)]!, 'gone'] : [],
      }
      expect(workersOfChat(workers, chat).map((w) => w.id)).toEqual(reference(workers, chat))
    }
  })
})

describe('reuseWorkers', () => {
  test('keeps the very objects (and the list) of workers that did not change', () => {
    const a = worker({ id: 'a' })
    const b = worker({ id: 'b', sessions: ['x', 'y'], eta: { minutes: 3, at: 5, tookS: null } })
    const prev = [a, b]
    const same = reuseWorkers(prev, [{ ...a }, { ...b, sessions: ['x', 'y'], eta: { minutes: 3, at: 5, tookS: null } }])
    expect(same).toBe(prev)
    const moved = { ...b, status: 'done', active: false }
    const out = reuseWorkers(prev, [{ ...a }, moved])
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(a)
    expect(out[1]).toEqual(moved)
  })
})

describe('firstLine', () => {
  const old = (s: string | null | undefined): string | null => (s ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? null
  test('is the first non-blank line, cut at 300, as splitting the whole task gave', () => {
    const samples = ['', '\n\n', '   \n\t\n', 'one', '\n  two  \nthree', 'a\r\nb', 'x'.repeat(400), '\n\n' + 'y'.repeat(310) + '\nz', ' \n \nlast', 'tail\n']
    for (const s of samples) expect(firstLine(s)).toBe(old(s))
    expect(firstLine(null)).toBeNull()
    expect(firstLine(undefined)).toBeNull()
  })
})
