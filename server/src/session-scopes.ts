// server/src/session-scopes.ts — the session list's filter scopes as SETS of real values.
//
// Every scope used to be one value with an 'all' escape hatch ('hide' | 'include' | 'only', and so
// on). The sidebar menu now ticks any combination, so each scope is the set of values a row may have,
// and "all" is not a value any more: it is every value ticked (or, for the open-ended ones, no
// narrowing at all). The old spellings still parse, because MCP clients and saved links use them.
//
// Conventions shared by every parser below:
//   undefined → the caller did not ask, so the scope's DEFAULT applies;
//   a Set     → exactly those values (an empty Set means "nothing", on purpose: None ticked);
//   an unrecognised value is dropped, and if that leaves nothing the default applies. A typo must
//   never hide sessions, the same rule the single-value parsers kept.

import type { SessionSource } from './types'
import { isSessionSource } from './types'

/** What a query string may carry for a scope: absent, one token, or a comma list. */
export type ScopeInput = string | readonly string[] | undefined

/** The token the client sends for "nothing ticked": an empty query value would read as unset. */
export const NONE_TOKEN = 'none'

export type ArchivedState = 'active' | 'archived'
export type DispatchedState = 'queued' | 'manual'
/** Where a Claude session stands against a usage wall. A partition: every row is exactly one.
 *  'clear' never hit one, 'resolved' hit one and was resumed, 'pending' still sits at it. */
export type RateLimitState = 'clear' | 'resolved' | 'pending'

const ARCHIVED_STATES: readonly ArchivedState[] = ['active', 'archived']
const DISPATCHED_STATES: readonly DispatchedState[] = ['queued', 'manual']
const RATE_LIMIT_STATES: readonly RateLimitState[] = ['clear', 'resolved', 'pending']

function tokens(input: ScopeInput): string[] | undefined {
  if (input === undefined) return undefined
  const list = typeof input === 'string' ? input.split(',') : input
  const out = list.map((s) => s.trim().toLowerCase()).filter(Boolean)
  return out.length ? out : undefined
}

/** Shared skeleton: expand legacy spellings, keep known values, honour 'none'. */
function parseScope<T extends string>(
  input: ScopeInput,
  universe: readonly T[],
  legacy: Record<string, readonly T[]>,
): Set<T> | undefined {
  const toks = tokens(input)
  if (!toks) return undefined
  if (toks.length === 1 && toks[0] === NONE_TOKEN) return new Set()
  const out = new Set<T>()
  let recognised = false
  for (const tok of toks) {
    const expanded = legacy[tok] ?? (universe.includes(tok as T) ? [tok as T] : undefined)
    if (!expanded) continue
    recognised = true
    for (const v of expanded) out.add(v)
  }
  return recognised ? out : undefined
}

const EVERY_SOURCE: readonly SessionSource[] = [
  'claude',
  'codex',
  'opencode',
  'hermes',
  'dsh',
  'zswarm',
  'foreign',
]

/** `undefined` means every source, so the 'foreign' reader is not dropped by an "all ticked" client.
 *  A `-name` token is an exclusion ("everything but HSwarm" is `-zswarm`), which keeps 'foreign'
 *  rows that a ticked list of named sources cannot express. */
export function parseSourceScope(input: ScopeInput): Set<SessionSource> | undefined {
  const toks = tokens(input)
  if (!toks) return undefined
  if (toks.length === 1 && toks[0] === NONE_TOKEN) return new Set()
  if (toks.includes('all')) return undefined
  const excluded = toks.filter((t) => t.startsWith('-')).map((t) => t.slice(1))
  const named = toks.filter(isSessionSource)
  if (excluded.some(isSessionSource) && named.length === 0) {
    const out = new Set(EVERY_SOURCE.filter((s) => !excluded.includes(s)))
    return out.size ? out : undefined
  }
  const out = new Set(named)
  return out.size ? out : undefined
}

/** Default 'active' only, the route's long-standing default (archived is the bulk of a store). */
export function parseArchivedScope(input: ScopeInput): Set<ArchivedState> {
  return (
    parseScope<ArchivedState>(input, ARCHIVED_STATES, {
      hide: ['active'],
      include: ['active', 'archived'],
      all: ['active', 'archived'],
      only: ['archived'],
    }) ?? new Set<ArchivedState>(['active'])
  )
}

/** `undefined` = no narrowing. */
export function parseDispatchedScope(input: ScopeInput): Set<DispatchedState> | undefined {
  return parseScope<DispatchedState>(input, DISPATCHED_STATES, { all: DISPATCHED_STATES })
}

/** `undefined` = no narrowing. 'only' and 'pending' keep their old meaning. */
export function parseRateLimitScope(input: ScopeInput): Set<RateLimitState> | undefined {
  return parseScope<RateLimitState>(input, RATE_LIMIT_STATES, {
    all: RATE_LIMIT_STATES,
    only: ['resolved', 'pending'],
  })
}

/** Instances are open-ended names, so there is no universe to check against. */
export function parseInstanceScope(input: ScopeInput): string[] | undefined {
  const raw = typeof input === 'string' ? input.split(',') : input
  const out = (raw ?? []).map((s) => s.trim()).filter(Boolean)
  if (out.length === 1 && out[0] === NONE_TOKEN) return []
  return out.length ? out : undefined
}

/** A set covering the whole universe is the same as no narrowing; this makes that explicit. */
export function coversAll<T>(set: ReadonlySet<T> | undefined, universe: readonly T[]): boolean {
  return !set || universe.every((v) => set.has(v))
}

export const ALL_ARCHIVED_STATES = ARCHIVED_STATES
export const ALL_DISPATCHED_STATES = DISPATCHED_STATES
export const ALL_RATE_LIMIT_STATES = RATE_LIMIT_STATES
