// Hydra Desk 2's cloud list (the chrome bar's cloud button): AgentHydra's whole session list, both PCs'
// chats included, with the filters of AgentHydra's Sessions ⋯ menu. Pure: no Vue, no store.
//
// The scopes follow AgentHydra's own model (web/src/lib/session-scopes.ts there): each filter is the list
// of TICKED values, every value ticked is "no narrowing", none ticked is the server's `none`. Source,
// instance, queued work, usage limits, archived and the time period are applied by AgentHydra; shape
// and computer narrow the rows already fetched.
import type { CloudSession } from '@shared/protocol'
import { folderKey, folderLabel, NO_FOLDER } from '../sidebar/logic'

/** claude-opus-5-5 -> Opus 5.5, the way AgentHydra's rows name it; any other model as it is. */
export function modelName(m: string | null | undefined): string | null {
  const hit = m?.match(/^claude-([a-z]+)-(\d+)-(\d+)/)
  return hit ? `${hit[1]!.charAt(0).toUpperCase()}${hit[1]!.slice(1)} ${hit[2]}.${hit[3]}` : (m ?? null)
}

export const SOURCE_VALUES = ['claude', 'codex', 'opencode', 'hermes', 'dsh', 'zswarm'] as const
export type CloudSource = (typeof SOURCE_VALUES)[number]
export const SOURCE_LABELS: Record<CloudSource, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  dsh: 'DSH',
  zswarm: 'HSwarm'
}
export const DISPATCHED_VALUES = ['queued', 'manual'] as const
export type DispatchedValue = (typeof DISPATCHED_VALUES)[number]
export const DISPATCHED_LABELS: Record<DispatchedValue, string> = { queued: 'Queued by me', manual: 'Driven by hand' }
export const RATE_LIMIT_VALUES = ['clear', 'resolved', 'pending'] as const
export type RateLimitValue = (typeof RATE_LIMIT_VALUES)[number]
export const RATE_LIMIT_LABELS: Record<RateLimitValue, string> = {
  clear: 'Never stopped by a limit',
  resolved: 'Stopped, then resumed',
  pending: 'Still stopped right now'
}
export const SHAPE_VALUES = ['quick', 'standard', 'deep', 'marathon', 'automation'] as const
export type CloudShape = (typeof SHAPE_VALUES)[number]
export const SHAPE_LABELS: Record<CloudShape, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
  marathon: 'Marathon',
  automation: 'Automation'
}
export const ARCHIVED_VALUES = ['active', 'archived'] as const
export type ArchivedValue = (typeof ARCHIVED_VALUES)[number]
export const ARCHIVED_LABELS: Record<ArchivedValue, string> = { active: 'Not archived', archived: 'Archived' }
export const PERIOD_VALUES = ['24h', '7d', '30d', 'all'] as const
export type CloudPeriod = (typeof PERIOD_VALUES)[number]
export const PERIOD_LABELS: Record<CloudPeriod, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time'
}

/** The instance filter: the default login, each named desktop instance, and every other one. */
export const INSTANCE_DEFAULT = 'default'
export const INSTANCE_OTHER = 'other'

export interface CloudScopes {
  source: CloudSource[]
  /** null: every instance (no narrowing); else the ticked names, 'default' and 'other' included. */
  instance: string[] | null
  dispatched: DispatchedValue[]
  rateLimit: RateLimitValue[]
  shape: CloudShape[]
  archived: ArchivedValue[]
  period: CloudPeriod
  /** null: both PCs; else the ticked PC names. */
  pcs: string[] | null
  /** The search box keeps these filters instead of looking at everything. */
  onlyThisView: boolean
}

/** What the list shows until its owner picks otherwise: AgentHydra's Sessions defaults (every source but
 *  HSwarm, live sessions only, the last 24 hours), both PCs. */
export const DEFAULT_SCOPES: CloudScopes = {
  source: SOURCE_VALUES.filter((s) => s !== 'zswarm'),
  instance: null,
  dispatched: [...DISPATCHED_VALUES],
  rateLimit: [...RATE_LIMIT_VALUES],
  shape: [...SHAPE_VALUES],
  archived: ['active'],
  period: '24h',
  pcs: null,
  onlyThisView: false
}

/** No narrowing at all: what a search looks through unless "Only this view" is ticked. */
const WIDE: Omit<CloudScopes, 'onlyThisView' | 'pcs'> = {
  source: [...SOURCE_VALUES],
  instance: null,
  dispatched: [...DISPATCHED_VALUES],
  rateLimit: [...RATE_LIMIT_VALUES],
  shape: [...SHAPE_VALUES],
  archived: [...ARCHIVED_VALUES],
  period: 'all'
}

const pick = <T extends string>(raw: unknown, universe: readonly T[], fallback: readonly T[]): T[] =>
  Array.isArray(raw) && raw.every((v) => typeof v === 'string' && universe.includes(v as T))
    ? universe.filter((v) => raw.includes(v))
    : [...fallback]
const names = (raw: unknown): string[] | null =>
  Array.isArray(raw) && raw.every((v) => typeof v === 'string') ? [...raw] : null

/** Stored scopes, each one that is not a known value falling back to its default. */
export function parseScopes(stored: string | null | undefined): CloudScopes {
  let o: Record<string, unknown> = {}
  try {
    const v = JSON.parse(stored ?? 'null')
    if (v && typeof v === 'object') o = v as Record<string, unknown>
  } catch {
    // a broken value is the defaults
  }
  const d = DEFAULT_SCOPES
  return {
    source: pick(o.source, SOURCE_VALUES, d.source),
    instance: names(o.instance),
    dispatched: pick(o.dispatched, DISPATCHED_VALUES, d.dispatched),
    rateLimit: pick(o.rateLimit, RATE_LIMIT_VALUES, d.rateLimit),
    shape: pick(o.shape, SHAPE_VALUES, d.shape),
    archived: pick(o.archived, ARCHIVED_VALUES, d.archived),
    period: PERIOD_VALUES.includes(o.period as CloudPeriod) ? (o.period as CloudPeriod) : d.period,
    pcs: names(o.pcs),
    onlyThisView: o.onlyThisView === true
  }
}

/** Tick or untick one value, kept in the universe's order. */
export function toggle<T extends string>(selected: readonly T[], universe: readonly T[], value: T): T[] {
  const next = new Set(selected)
  if (!next.delete(value)) next.add(value)
  return universe.filter((v) => next.has(v))
}

const allOf = (selected: readonly string[], universe: readonly string[]) => universe.every((v) => selected.includes(v))
const scope = (selected: readonly string[], universe: readonly string[]): string | undefined =>
  allOf(selected, universe) ? undefined : selected.length ? selected.join(',') : 'none'

/** The scopes in force: a search looks at everything unless "Only this view" keeps the filters. */
export function effectiveScopes(s: CloudScopes, search: string): CloudScopes {
  return search.trim() && !s.onlyThisView ? { ...s, ...WIDE } : s
}

/**
 * The query for GET /api/cloud/sessions, in AgentHydra's spelling. Instance, queued work and usage limits
 * are facts about Claude sessions: sent only with Claude ticked, and with othersPass so they narrow the
 * Claude rows and leave the other sources' alone. "Every source but HSwarm" is `-zswarm`, which keeps
 * the tools the menu has no entry for.
 */
export function cloudQuery(s: CloudScopes, search: string): string {
  const q = new URLSearchParams()
  const claude = s.source.includes('claude')
  q.set('period', s.period)
  q.set('archived', s.archived.length ? s.archived.join(',') : 'none')
  const nonHswarm = SOURCE_VALUES.filter((v) => v !== 'zswarm')
  const source = allOf(s.source, nonHswarm) && s.source.length === nonHswarm.length ? '-zswarm' : scope(s.source, SOURCE_VALUES)
  if (source) q.set('source', source)
  if (claude && s.instance) q.set('instance', s.instance.length ? s.instance.join(',') : 'none')
  const dispatched = claude ? scope(s.dispatched, DISPATCHED_VALUES) : undefined
  if (dispatched) q.set('dispatched', dispatched)
  const ratelimited = claude ? scope(s.rateLimit, RATE_LIMIT_VALUES) : undefined
  if (ratelimited) q.set('ratelimited', ratelimited)
  q.set('othersPass', '1')
  if (search.trim()) q.set('title', search.trim())
  return q.toString()
}

/**
 * What kind of session it was (AgentHydra web/src/lib/session-shape.ts, same thresholds): the larger of
 * the verdicts by message count and by how long it ran; queued work is Automation outright.
 */
const BY_MESSAGES = [25, 450, 1000]
const BY_MINUTES = [15, 150, 480]
const SCALE: CloudShape[] = ['quick', 'standard', 'deep', 'marathon']
const rank = (v: number, bounds: number[]) => {
  const i = bounds.findIndex((b) => v < b)
  return i < 0 ? bounds.length : i
}
export function sessionShape(s: Pick<CloudSession, 'messageCount' | 'createdAt' | 'lastActivityAt' | 'dispatched'>): CloudShape {
  if (s.dispatched) return 'automation'
  const minutes = s.createdAt === null ? null : Math.max(0, (s.lastActivityAt - s.createdAt) / 60_000)
  return SCALE[Math.max(rank(s.messageCount, BY_MESSAGES), minutes === null ? 0 : rank(minutes, BY_MINUTES))] ?? 'quick'
}

/** The PC a row came from: the chat sync's name for another PC's chat, else this one. */
export const pcOf = (s: Pick<CloudSession, 'fromPc'>, thisPc: string): string => s.fromPc ?? thisPc

/** Every PC the rows name, this one first. */
export function pcsIn(rows: Pick<CloudSession, 'fromPc'>[], thisPc: string): string[] {
  const others = [...new Set(rows.map((r) => r.fromPc).filter((p): p is string => !!p && p !== thisPc))].sort()
  return [thisPc, ...others]
}

export interface CloudGroup {
  key: string
  label: string
  cwd: string | null
  rows: CloudSession[]
}

export const RESULTS_LABEL = 'Best matches first'

/**
 * The rows the list shows, grouped by folder like the rest of the sidebar: the shape and computer filters
 * applied, groups ordered by their newest row, rows newest first. A search's answer (`ranked`) keeps
 * AgentHydra's order instead, best match first (a title hit before a folder hit before letters in order),
 * as one group.
 */
export function groupCloud(
  rows: CloudSession[],
  s: { shape: readonly CloudShape[]; pcs: string[] | null },
  thisPc: string,
  ranked = false
): CloudGroup[] {
  const shown = rows.filter((r) => s.shape.includes(sessionShape(r)) && (s.pcs === null || s.pcs.includes(pcOf(r, thisPc))))
  if (ranked) return shown.length ? [{ key: 'cloud:results', label: RESULTS_LABEL, cwd: null, rows: shown }] : []
  const byFolder = new Map<string, CloudGroup>()
  for (const r of [...shown].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
    const key = r.cwd ? folderKey(r.cwd) : ''
    let g = byFolder.get(key)
    if (!g) {
      g = { key: `cloud:${key}`, label: r.cwd ? folderLabel(r.cwd) : NO_FOLDER, cwd: r.cwd, rows: [] }
      byFolder.set(key, g)
    }
    g.rows.push(r)
  }
  return [...byFolder.values()]
}

/** A filter's right-hand text in the menu: All, None, the one name, or the first and a count. */
export function summarize(selected: readonly string[], universe: readonly string[], label: (v: string) => string): string {
  if (allOf(selected, universe)) return 'All'
  const shown = universe.filter((v) => selected.includes(v)).map(label)
  if (!shown.length) return 'None'
  return shown.length === 1 ? (shown[0] ?? '') : `${shown[0]} +${shown.length - 1}`
}

/** Any filter narrowing the list, so the filter button shows it is on. */
export function scopesNarrowed(s: CloudScopes): boolean {
  const d = DEFAULT_SCOPES
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v))
  return (
    !same(s.source, d.source) ||
    s.instance !== null ||
    !same(s.dispatched, d.dispatched) ||
    !same(s.rateLimit, d.rateLimit) ||
    !same(s.shape, d.shape) ||
    !same(s.archived, d.archived) ||
    s.period !== d.period ||
    s.pcs !== null
  )
}
