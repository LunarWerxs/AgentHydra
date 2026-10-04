import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initialStatus, nextStatus, notifyReason, statusEventsFor, type StatusEvent, type StatusState } from '../../src/engine/status'

const T = 1_000
const NOW = 5_000

function st(over: Partial<StatusState>): StatusState {
  return { ...initialStatus(), ...over }
}

const working = st({ status: 'working', turnStartedAt: T, activity: 'Bash: ls' })

// [name, from, event, expected fields of the next state]
const cases: [string, StatusState, StatusEvent, Partial<StatusState>][] = [
  // starting
  ['runtimeStarting from closed', st({ status: 'closed', turnStartedAt: T }), { type: 'runtimeStarting' }, { status: 'starting', turnStartedAt: T }],
  ['init after a send: working', st({ status: 'starting', turnStartedAt: T }), { type: 'init', now: NOW }, { status: 'working', turnStartedAt: T }],
  ['init with nothing sent: idle', st({ status: 'starting' }), { type: 'init', now: NOW }, { status: 'idle' }],
  ['init mid-session changes nothing', working, { type: 'init', now: NOW }, { status: 'working', activity: 'Bash: ls' }],
  // userSent
  ['send to idle starts a turn', st({ status: 'idle', unread: true }), { type: 'userSent', now: NOW }, { status: 'working', turnStartedAt: NOW, unread: false, queuedCount: 0 }],
  ['send while working is queued', working, { type: 'userSent', now: NOW }, { status: 'working', queuedCount: 1, turnStartedAt: T }],
  ['send while needs_you is queued', st({ status: 'needs_you', pendingCount: 1 }), { type: 'userSent', now: NOW }, { status: 'needs_you', queuedCount: 1 }],
  ['send to closed starts the runtime', st({ status: 'closed', lastError: 'x' }), { type: 'userSent', now: NOW }, { status: 'starting', turnStartedAt: NOW, lastError: null }],
  ['first send while starting holds the clock', st({ status: 'starting' }), { type: 'userSent', now: NOW }, { status: 'starting', turnStartedAt: NOW, queuedCount: 0 }],
  ['second send while starting queues', st({ status: 'starting', turnStartedAt: T }), { type: 'userSent', now: NOW }, { status: 'starting', turnStartedAt: T, queuedCount: 1 }],
  ['send after stop clears it', st({ status: 'stopped' }), { type: 'userSent', now: NOW }, { status: 'working', turnStartedAt: NOW }],
  ['send after error clears lastError', st({ status: 'error', lastError: 'boom' }), { type: 'userSent', now: NOW }, { status: 'working', lastError: null }],
  ['send while limited retries', st({ status: 'limited', limitResetsAt: 9 }), { type: 'userSent', now: NOW }, { status: 'working', limitResetsAt: null }],
  // session_state_changed
  ['running from idle', st({ status: 'idle' }), { type: 'stateChanged', state: 'running', now: NOW }, { status: 'working', turnStartedAt: NOW }],
  ['running keeps the turn clock', working, { type: 'stateChanged', state: 'running', now: NOW }, { status: 'working', turnStartedAt: T }],
  ['running with a request open stays needs_you', st({ status: 'needs_you', pendingCount: 1, turnStartedAt: T }), { type: 'stateChanged', state: 'running', now: NOW }, { status: 'needs_you' }],
  ['running clears a past limit', st({ status: 'limited', limitResetsAt: 9 }), { type: 'stateChanged', state: 'running', now: NOW }, { status: 'working', limitResetsAt: null }],
  ['requires_action: needs_you and unread', working, { type: 'stateChanged', state: 'requires_action', now: NOW }, { status: 'needs_you', unread: true, turnStartedAt: T }],
  ['idle ends the turn: unread', st({ ...working, pendingCount: 1, queuedCount: 2 }), { type: 'stateChanged', state: 'idle', now: NOW }, { status: 'idle', activity: null, turnStartedAt: null, unread: true, pendingCount: 0, queuedCount: 0 }],
  ['idle after needs_you: unread', st({ status: 'needs_you' }), { type: 'stateChanged', state: 'idle', now: NOW }, { status: 'idle', unread: true }],
  ['idle keeps stopped', st({ status: 'stopped' }), { type: 'stateChanged', state: 'idle', now: NOW }, { status: 'stopped', unread: false }],
  ['idle keeps error', st({ status: 'error', lastError: 'boom', unread: true }), { type: 'stateChanged', state: 'idle', now: NOW }, { status: 'error', lastError: 'boom' }],
  ['idle keeps limited', st({ status: 'limited', limitResetsAt: 9 }), { type: 'stateChanged', state: 'idle', now: NOW }, { status: 'limited', limitResetsAt: 9 }],
  ['idle when already idle stays read', st({ status: 'idle' }), { type: 'stateChanged', state: 'idle', now: NOW }, { status: 'idle', unread: false }],
  ['state changes ignored when closed', st({ status: 'closed' }), { type: 'stateChanged', state: 'running', now: NOW }, { status: 'closed' }],
  // interrupt, error, limit, close
  ['interrupt stops and expires requests', st({ status: 'needs_you', pendingCount: 2, turnStartedAt: T, activity: 'x' }), { type: 'interrupted' }, { status: 'stopped', pendingCount: 0, turnStartedAt: null, activity: null }],
  ['turnError', working, { type: 'turnError', message: 'API Error: 500' }, { status: 'error', lastError: 'API Error: 500', unread: true, turnStartedAt: null, activity: null }],
  ['turnError after a stop stays stopped', st({ status: 'stopped' }), { type: 'turnError', message: 'aborted' }, { status: 'stopped', lastError: null }],
  ['turnError after a limit stays limited', st({ status: 'limited', limitResetsAt: 9 }), { type: 'turnError', message: 'limit' }, { status: 'limited', lastError: null }],
  ['usageLimit', working, { type: 'usageLimit', resetsAt: 9_000 }, { status: 'limited', limitResetsAt: 9_000, unread: true, turnStartedAt: null }],
  ['usageLimit without a time keeps the known one', st({ status: 'limited', limitResetsAt: 9_000 }), { type: 'usageLimit', resetsAt: null }, { limitResetsAt: 9_000 }],
  ['closed', st({ ...working, pendingCount: 1, queuedCount: 1 }), { type: 'closed' }, { status: 'closed', activity: null, turnStartedAt: null, pendingCount: 0, queuedCount: 0 }],
  // requests
  ['request opens: needs_you, counted, unread', working, { type: 'requestOpened' }, { status: 'needs_you', pendingCount: 1, unread: true }],
  ['second request counts up', st({ status: 'needs_you', pendingCount: 1 }), { type: 'requestOpened' }, { status: 'needs_you', pendingCount: 2 }],
  ['request opened while starting', st({ status: 'starting', turnStartedAt: T }), { type: 'requestOpened' }, { status: 'needs_you', pendingCount: 1 }],
  ['one of two answered: still needs_you', st({ status: 'needs_you', pendingCount: 2 }), { type: 'requestClosed' }, { status: 'needs_you', pendingCount: 1 }],
  ['last answered: back to working', st({ status: 'needs_you', pendingCount: 1 }), { type: 'requestClosed' }, { status: 'working', pendingCount: 0 }],
  ['close never goes below zero', st({ status: 'stopped' }), { type: 'requestClosed' }, { status: 'stopped', pendingCount: 0 }],
  // results, activity, viewed
  ['result with queued sends: next turn starts', st({ ...working, queuedCount: 2 }), { type: 'turnEnded', queued: 1, now: NOW }, { status: 'working', queuedCount: 1, turnStartedAt: NOW, activity: null }],
  ['result with none queued', st({ ...working, queuedCount: 1 }), { type: 'turnEnded', queued: 0, now: NOW }, { status: 'working', queuedCount: 0, turnStartedAt: T }],
  ['result without a count changes nothing', st({ ...working, queuedCount: 1 }), { type: 'turnEnded', now: NOW }, { queuedCount: 1 }],
  ['activity while working', working, { type: 'activity', activity: 'Writing' }, { activity: 'Writing' }],
  ['activity ignored when idle', st({ status: 'idle' }), { type: 'activity', activity: 'Writing' }, { activity: null }],
  ['viewed clears unread', st({ status: 'idle', unread: true }), { type: 'viewed' }, { unread: false }],
]

describe('nextStatus', () => {
  for (const [name, from, event, expected] of cases) {
    test(name, () => {
      expect(nextStatus(from, event)).toMatchObject(expected)
    })
  }

  test('a whole turn: send, tool permission, answer, finish, look', () => {
    let s = initialStatus('closed')
    const seen: string[] = []
    const events: StatusEvent[] = [
      { type: 'userSent', now: 1 },
      { type: 'runtimeStarting' },
      { type: 'init', now: 2 },
      { type: 'stateChanged', state: 'running', now: 2 },
      { type: 'requestOpened' },
      { type: 'stateChanged', state: 'requires_action', now: 3 },
      { type: 'requestClosed' },
      { type: 'stateChanged', state: 'running', now: 4 },
      { type: 'turnEnded', queued: 0, now: 5 },
      { type: 'stateChanged', state: 'idle', now: 5 },
      { type: 'viewed' },
    ]
    for (const e of events) {
      s = nextStatus(s, e)
      seen.push(s.status)
    }
    expect(seen).toEqual(['starting', 'starting', 'working', 'working', 'needs_you', 'needs_you', 'working', 'working', 'working', 'idle', 'idle'])
    expect(s.unread).toBe(false)
    expect(s.turnStartedAt).toBeNull()
  })
})

describe('notifyReason', () => {
  const cases: [string, Partial<StatusState>, Partial<StatusState>, ReturnType<typeof notifyReason>][] = [
    ['finished', { status: 'working' }, { status: 'idle' }, 'finished'],
    ['finished after needs_you', { status: 'needs_you' }, { status: 'idle' }, 'finished'],
    ['needs you', { status: 'working' }, { status: 'needs_you' }, 'needs_you'],
    ['error', { status: 'working' }, { status: 'error' }, 'error'],
    ['limited', { status: 'working' }, { status: 'limited' }, 'limited'],
    ['a stop is his own doing', { status: 'working' }, { status: 'stopped' }, null],
    ['no change', { status: 'needs_you' }, { status: 'needs_you' }, null],
    ['closed to idle is not a finish', { status: 'starting' }, { status: 'idle' }, null],
  ]
  for (const [name, a, b, want] of cases) test(name, () => expect(notifyReason(st(a), st(b))).toBe(want))
})

describe('statusEventsFor', () => {
  const m = (x: unknown) => x as SDKMessage
  test('session_state_changed', () => {
    expect(statusEventsFor(m({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' }), NOW)).toEqual([
      { type: 'stateChanged', state: 'requires_action', now: NOW },
    ])
  })
  test('rejected rate limit, seconds to ms', () => {
    expect(statusEventsFor(m({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_791_086_400 } }), NOW)).toEqual([
      { type: 'usageLimit', resetsAt: 1_791_086_400_000 },
    ])
    expect(statusEventsFor(m({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), NOW)).toEqual([])
  })
  test('error result: turnError then turnEnded', () => {
    expect(statusEventsFor(m({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], queued_turn_count: 0 }), NOW)).toEqual([
      { type: 'turnError', message: 'boom' },
      { type: 'turnEnded', queued: 0, now: NOW },
    ])
  })
  test('success result only ends the turn', () => {
    expect(statusEventsFor(m({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }), NOW)).toEqual([{ type: 'turnEnded', queued: undefined, now: NOW }])
  })
  test('init and other messages', () => {
    expect(statusEventsFor(m({ type: 'system', subtype: 'init' }), NOW)).toEqual([{ type: 'init', now: NOW }])
    expect(statusEventsFor(m({ type: 'stream_event' }), NOW)).toEqual([])
  })
})
