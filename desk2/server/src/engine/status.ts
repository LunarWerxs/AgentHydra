// The chat status machine (SPEC "The engine" -> Status). Pure: nextStatus(state, event) -> state.
// The SDK's session_state_changed (running / idle / requires_action) drives it, plus local facts:
// interrupt, turn error, usage limit, runtime closed, and the user's own sends.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatStatus, ChatSummary } from '@shared/protocol'

/**
 * Put this in query()'s options.env. Without it the CLI marks session_state_changed sdk_host_only and
 * the SDK swallows it (sdk.mjs sets CLAUDE_CODE_SDK_READS_SESSION_STATE and drops those frames), so
 * the host never sees running / idle / requires_action.
 */
export const SESSION_STATE_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } as const

export type StatusState = Pick<
  ChatSummary,
  'status' | 'activity' | 'turnStartedAt' | 'lastError' | 'limitResetsAt' | 'unread' | 'pendingCount' | 'queuedCount'
>

export type StatusEvent =
  | { type: 'runtimeStarting' }
  | { type: 'init'; now: number }
  | { type: 'stateChanged'; state: 'running' | 'idle' | 'requires_action'; now: number }
  | { type: 'interrupted' }
  | { type: 'turnError'; message: string }
  | { type: 'usageLimit'; resetsAt: number | null }
  | { type: 'closed' }
  | { type: 'userSent'; now: number }
  /** A permission / question / plan request opened (canUseTool) or was answered, skipped or expired. */
  | { type: 'requestOpened' }
  | { type: 'requestClosed' }
  /** A result arrived; queued = result.queued_turn_count (sends still waiting, each starts a turn). */
  | { type: 'turnEnded'; queued?: number; now: number }
  | { type: 'activity'; activity: string | null }
  /** Jacob looked at the chat. */
  | { type: 'viewed' }

export function initialStatus(status: ChatStatus = 'closed'): StatusState {
  return {
    status,
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pendingCount: 0,
    queuedCount: 0,
  }
}

/** A turn is in flight: a send now is queued behind it. */
export function isBusy(status: ChatStatus): boolean {
  return status === 'working' || status === 'needs_you'
}

/** Statuses an SDK 'idle' does not overwrite: they say why the turn ended. */
const STICKY_END: ChatStatus[] = ['stopped', 'error', 'limited']

/** The turn is over: no activity, no clock, no open requests. */
function ended(s: StatusState, status: ChatStatus): StatusState {
  return { ...s, status, activity: null, turnStartedAt: null, pendingCount: 0 }
}

export function nextStatus(s: StatusState, e: StatusEvent): StatusState {
  switch (e.type) {
    case 'runtimeStarting':
      return { ...s, status: 'starting', activity: null, pendingCount: 0 }

    case 'init':
      // system/init opens every turn; only the runtime's first one moves it out of 'starting'.
      if (s.status !== 'starting') return s
      return s.turnStartedAt !== null ? { ...s, status: 'working' } : { ...s, status: 'idle' }

    case 'userSent':
      if (isBusy(s.status)) return { ...s, queuedCount: s.queuedCount + 1 }
      if (s.status === 'starting') {
        // The first message waits for the runtime; any further one queues behind it.
        return s.turnStartedAt === null ? { ...s, turnStartedAt: e.now, unread: false } : { ...s, queuedCount: s.queuedCount + 1 }
      }
      if (s.status === 'closed') {
        return { ...s, status: 'starting', activity: null, turnStartedAt: e.now, lastError: null, limitResetsAt: null, unread: false }
      }
      return { ...s, status: 'working', activity: null, turnStartedAt: e.now, lastError: null, limitResetsAt: null, unread: false }

    case 'stateChanged':
      if (s.status === 'closed') return s
      if (e.state === 'running') {
        return {
          ...s,
          status: s.pendingCount > 0 ? 'needs_you' : 'working',
          turnStartedAt: s.turnStartedAt ?? e.now,
          lastError: null,
          limitResetsAt: null,
        }
      }
      if (e.state === 'requires_action') {
        return { ...s, status: 'needs_you', turnStartedAt: s.turnStartedAt ?? e.now, unread: true }
      }
      // idle: authoritative turn-over. A stop, an error or a limit keeps saying why it ended.
      return {
        ...ended(s, STICKY_END.includes(s.status) ? s.status : 'idle'),
        queuedCount: 0,
        unread: s.unread || isBusy(s.status),
      }

    case 'interrupted':
      if (s.status === 'closed') return s
      return ended(s, 'stopped')

    case 'turnError':
      // An interrupted turn ends in an error result; a usage limit already said why.
      if (s.status === 'stopped' || s.status === 'limited' || s.status === 'closed') return s
      return { ...ended(s, 'error'), lastError: e.message, unread: true }

    case 'usageLimit':
      return { ...ended(s, 'limited'), limitResetsAt: e.resetsAt ?? s.limitResetsAt, unread: true }

    case 'closed':
      return { ...ended(s, 'closed'), queuedCount: 0 }

    case 'requestOpened':
      return {
        ...s,
        pendingCount: s.pendingCount + 1,
        status: s.status === 'working' || s.status === 'starting' ? 'needs_you' : s.status,
        unread: true,
      }

    case 'requestClosed': {
      const pendingCount = Math.max(0, s.pendingCount - 1)
      return { ...s, pendingCount, status: pendingCount === 0 && s.status === 'needs_you' ? 'working' : s.status }
    }

    case 'turnEnded':
      if (e.queued === undefined) return s
      // The CLI takes the next queued send straight away: a new turn starts now.
      return e.queued > 0
        ? { ...s, queuedCount: e.queued, turnStartedAt: e.now, activity: null }
        : { ...s, queuedCount: 0 }

    case 'activity':
      return isBusy(s.status) || s.status === 'starting' ? { ...s, activity: e.activity } : s

    case 'viewed':
      return s.unread ? { ...s, unread: false } : s
  }
}

export type NotifyReason = 'finished' | 'needs_you' | 'error' | 'limited'

/** The notification a transition earns, if any (SPEC: finished / needs_you / error / limited). */
export function notifyReason(prev: StatusState, next: StatusState): NotifyReason | null {
  if (prev.status === next.status) return null
  if (next.status === 'needs_you') return 'needs_you'
  if (next.status === 'error') return 'error'
  if (next.status === 'limited') return 'limited'
  if (next.status === 'idle' && isBusy(prev.status)) return 'finished'
  return null
}

/** Epoch ms from the SDK's resetsAt (epoch seconds on the wire; ms accepted too). */
export function resetsAtMs(resetsAt: number | undefined | null): number | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt
}

/** The status events an SDK message carries (the runtime adds userSent, interrupted, closed, requests). */
export function statusEventsFor(msg: SDKMessage, now: number): StatusEvent[] {
  const m = msg as { type: string; subtype?: string }
  if (m.type === 'system' && m.subtype === 'init') return [{ type: 'init', now }]
  if (m.type === 'system' && m.subtype === 'session_state_changed') {
    const state = (msg as { state?: string }).state
    if (state === 'running' || state === 'idle' || state === 'requires_action') return [{ type: 'stateChanged', state, now }]
    return []
  }
  if (m.type === 'rate_limit_event') {
    const info = (msg as { rate_limit_info?: { status?: string; resetsAt?: number } }).rate_limit_info
    return info?.status === 'rejected' ? [{ type: 'usageLimit', resetsAt: resetsAtMs(info.resetsAt) }] : []
  }
  if (m.type === 'assistant' && (msg as { error?: string }).error === 'rate_limit') {
    return [{ type: 'usageLimit', resetsAt: null }]
  }
  if (m.type === 'result') {
    const r = msg as { subtype: string; is_error?: boolean; errors?: string[]; result?: string; queued_turn_count?: number }
    const out: StatusEvent[] = []
    if (r.subtype !== 'success' || r.is_error) {
      const message = (r.errors?.length ? r.errors.join('\n') : r.result) || r.subtype
      out.push({ type: 'turnError', message })
    }
    out.push({ type: 'turnEnded', queued: r.queued_turn_count, now })
    return out
  }
  return []
}
