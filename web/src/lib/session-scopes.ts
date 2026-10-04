// web/src/lib/session-scopes.ts — the sidebar filters as SETS of ticked values.
//
// Every filter in the ⋯ menu used to be one choice with an 'all' value. They are now multi-select:
// the model is the list of values that are TICKED, and "all" is simply every value ticked, "none" is
// the empty list. Nothing here touches Vue or i18n, so the all / none / toggle / label rules are
// plain functions that can be tested directly.

import type { SessionPeriod, SessionSource } from '@/lib/api'
import type { SessionShape } from '@/lib/session-shape'

/** The providers the menu offers. 'foreign' (other tools) has no entry: ticking everything sends no
 *  source filter at all, which is how those rows stay visible. */
export const SOURCE_VALUES: readonly SessionSource[] = [
  'claude',
  'codex',
  'opencode',
  'hermes',
  'dsh',
  'zswarm',
]
export const DISPATCHED_VALUES = ['queued', 'manual'] as const
export type DispatchedValue = (typeof DISPATCHED_VALUES)[number]
/** A partition of Claude sessions by where they stand against a usage wall. */
export const RATE_LIMIT_VALUES = ['clear', 'resolved', 'pending'] as const
export type RateLimitValue = (typeof RATE_LIMIT_VALUES)[number]
export const ARCHIVED_VALUES = ['active', 'archived'] as const
export type ArchivedValue = (typeof ARCHIVED_VALUES)[number]
export const SHAPE_VALUES: readonly SessionShape[] = [
  'quick',
  'standard',
  'deep',
  'marathon',
  'automation',
]

/** The server's spelling of "nothing ticked" (an empty query value would read as "not asked"). */
const NONE_TOKEN = 'none'

export function isAllSelected(selected: readonly string[], universe: readonly string[]): boolean {
  return universe.every((v) => selected.includes(v))
}

/** Tick or untick one value. Always returns the universe's order, so equal sets are equal arrays. */
export function toggleValue<T extends string>(
  selected: readonly T[],
  universe: readonly T[],
  value: T,
): T[] {
  const next = new Set(selected)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return universe.filter((v) => next.has(v))
}

/** A stored value that is not an array of known values falls back to everything ticked. */
export function parseStoredSelection<T extends string>(
  raw: unknown,
  universe: readonly T[],
): T[] | undefined {
  if (!Array.isArray(raw)) return undefined
  if (!raw.every((v) => typeof v === 'string' && universe.includes(v as T))) return undefined
  return universe.filter((v) => raw.includes(v))
}

/** The query value for one scope: undefined when everything is ticked (no narrowing, so rows from
 *  sources the menu has no entry for stay visible), 'none' when nothing is, else a comma list. */
export function scopeParam(
  selected: readonly string[],
  universe: readonly string[],
): string | undefined {
  if (isAllSelected(selected, universe)) return undefined
  return selected.length === 0 ? NONE_TOKEN : selected.join(',')
}

/** What the sidebar shows until its owner picks otherwise: every source but HSwarm (its workers are
 *  noise in "what am I working on"), and live sessions only. */
export const DEFAULT_SOURCES: readonly SessionSource[] = SOURCE_VALUES.filter((v) => v !== 'zswarm')
export const DEFAULT_ARCHIVED: readonly ArchivedValue[] = ['active']

/** The source query value. Like scopeParam, but "every source except HSwarm" is spelled `-zswarm`
 *  rather than as a list, because a list leaves out the 'foreign' tools that have no menu entry. */
export function sourceParam(selected: readonly SessionSource[]): string | undefined {
  const all = scopeParam(selected, SOURCE_VALUES)
  if (all === undefined) return undefined
  if (isAllSelected(selected, DEFAULT_SOURCES) && selected.length === DEFAULT_SOURCES.length)
    return '-zswarm'
  return all
}

/** Every filter the list is fetched with. */
export interface ListScopes {
  instance: string[] | null
  archived: readonly ArchivedValue[]
  period: SessionPeriod
  source: readonly SessionSource[]
  dispatched: readonly DispatchedValue[]
  rateLimit: readonly RateLimitValue[]
  shape: readonly SessionShape[]
}

/** No narrowing at all: every source (HSwarm too), archived too, every instance, all time. */
export const WIDE_SCOPES: ListScopes = {
  instance: null,
  archived: ARCHIVED_VALUES,
  period: 'all',
  source: SOURCE_VALUES,
  dispatched: DISPATCHED_VALUES,
  rateLimit: RATE_LIMIT_VALUES,
  shape: SHAPE_VALUES,
}

/** Which filters the list uses right now. While the search box has text it looks at everything,
 *  unless the owner asked to search only what the sidebar shows; an empty box is the view's own. */
export function effectiveScopes(
  view: ListScopes,
  search: string,
  onlyThisView: boolean,
): ListScopes {
  return search.trim() && !onlyThisView ? WIDE_SCOPES : view
}

/** The scopes as the daemon's query params; undefined = not sent. The Claude-only ones (instance,
 *  queued work, usage wall) are left out unless Claude is ticked, since their menus are disabled. */
export function sessionScopeQuery(sc: ListScopes) {
  const claude = sc.source.includes('claude')
  return {
    instance:
      claude && sc.instance ? (sc.instance.length ? sc.instance.join(',') : 'none') : undefined,
    // Always sent: the server's own default for an absent archived scope is "active only".
    archived: sc.archived.length ? sc.archived.join(',') : 'none',
    period: sc.period,
    source: sourceParam(sc.source),
    dispatched: claude ? scopeParam(sc.dispatched, DISPATCHED_VALUES) : undefined,
    ratelimited: claude ? scopeParam(sc.rateLimit, RATE_LIMIT_VALUES) : undefined,
    othersPass: '1',
  }
}

/** The trigger's right-hand text: All, None, the one name, or the first name and a count. */
export function summarizeSelection<T extends string>(
  selected: readonly T[],
  universe: readonly T[],
  text: {
    all: string
    none: string
    label: (value: T) => string
    more: (first: string, extra: number) => string
  },
): string {
  if (isAllSelected(selected, universe)) return text.all
  const names = universe.filter((v) => selected.includes(v)).map(text.label)
  if (names.length === 0) return text.none
  const [first = ''] = names
  return names.length === 1 ? first : text.more(first, names.length - 1)
}
