// The stats card's tiles, rows and footer. Its figures are AgentHydra's, consolidated over every source it
// counts (HomeStats, GET /api/stats/home); a part that did not answer shows a dash with the reason as its
// tooltip, never a made-up 0. Until that answer comes, or when AgentHydra is not answering, the card falls
// back to what Hydra Desk knows about its own chats (DeskStats), which keeps no messages or tokens per chat,
// so those tiles show a dash too.
import type { HomeStats, HomeStatsMissing } from '@shared/protocol'
import { modelName, type DeskStats } from './logic'

export interface StatsTile {
  label: string
  value: string
  strong: boolean
  title?: string
}

const UNKNOWN = '–'
const count = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`

export function statsTiles(s: DeskStats): StatsTile[] {
  return [
    { label: 'Sessions', value: count(s.sessions), strong: true },
    { label: 'Messages', value: UNKNOWN, strong: true, title: 'Hydra Desk does not count messages yet' },
    { label: 'Total tokens', value: UNKNOWN, strong: true, title: `Hydra Desk does not count tokens yet; these sessions cost ${s.totalCost}` },
    { label: 'Active days', value: count(s.activeDays), strong: true },
    { label: 'Peak hour', value: s.peakHour, strong: true },
    { label: 'Favorite model', value: s.favoriteModel, strong: false }
  ]
}

/** One sentence like the real "You've used ~N× more tokens than …", built from real figures only. */
export function statsFooter(s: DeskStats): string {
  if (!s.sessions) return 'No sessions in this range yet.'
  const where = `${plural(s.sessions, 'session', 'sessions')} in ${plural(s.folders, 'folder', 'folders')}`
  const when = `over ${plural(s.activeDays, 'day', 'days')}`
  return s.totalCost === '$0.00' ? `You've run ${where} ${when}.` : `You've run ${where} ${when}, ${s.totalCost} in all.`
}

/** The line under Hydra Desk's own figures while AgentHydra's have not come, and when it did not answer. */
export const DESK_ONLY_WAITING = "Hydra Desk's own chats only, until AgentHydra's figures load."
export const DESK_ONLY_OFFLINE = "AgentHydra is not answering, so these are Hydra Desk's own chats only."

const UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K']
]

/** 487.6B, 12.3M, 4.1K, 950: a big count at a glance (999,950 is 1.0M, not 1000.0K). */
export function compact(n: number): string {
  for (const [size, unit] of UNITS) if (Math.abs(n) >= size * 0.99995) return `${(n / size).toFixed(1)}${unit}`
  return count(Math.round(n))
}

/** $257,672 for a big figure, $12.40 for a small one. */
export function usd(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`
}

function agentTime(minutes: number): string {
  return minutes < 60 ? plural(minutes, 'minute', 'minutes') : plural(Math.round(minutes / 60), 'hour', 'hours')
}

/** The nine tiles over AgentHydra's figures: what it counted, when, and what CliMayte and HSwarm did. */
export function homeTiles(s: HomeStats): StatsTile[] {
  const t = s.tokens
  const why = (part: HomeStatsMissing['part'], fallback: string) => s.missing.find((m) => m.part === part)?.reason ?? fallback
  const c = s.climayte
  const h = s.hswarm
  return [
    { label: 'Sessions', value: count(s.sessions), strong: true },
    { label: 'Messages', value: count(s.messages), strong: true, title: 'Model turns, across every source' },
    {
      label: 'Total tokens',
      value: compact(t.total),
      strong: true,
      title: [`Input ${count(t.input)}`, `Cache read ${count(t.cacheRead)}`, `Cache write ${count(t.cacheWrite)}`, `Output ${count(t.output)}`].join('\n')
    },
    { label: 'Active days', value: count(s.activeDays), strong: true, title: s.agentMinutes === null ? undefined : `${agentTime(s.agentMinutes)} of agent time` },
    { label: 'Peak hour', value: s.peakHour ?? UNKNOWN, strong: true, title: s.peakHour ? undefined : why('activity', 'No activity in this range') },
    { label: 'Favorite model', value: s.favoriteModel ? modelName(s.favoriteModel) : UNKNOWN, strong: false, title: s.favoriteModel ?? undefined },
    c
      ? { label: 'CliMayte tasks', value: count(c.tasks), strong: true, title: `${plural(c.limitHits, 'run', 'runs')} stopped at a usage limit\n${usd(c.costUsd)} at API rates` }
      : { label: 'CliMayte tasks', value: UNKNOWN, strong: true, title: why('climayte', 'CliMayte did not answer') },
    h
      ? { label: 'HSwarm tasks', value: count(h.tasks), strong: true, title: `Saved ${usd(h.savedUsd)} against Claude's API rates` }
      : { label: 'HSwarm tasks', value: UNKNOWN, strong: true, title: why('hswarm', 'HSwarm did not answer') },
    {
      label: 'Cost at API rates',
      value: s.costUsd === null ? UNKNOWN : usd(s.costUsd),
      strong: true,
      title: s.costUsd === null ? 'AgentHydra could not price these sessions' : s.pricesAsOf ? `Prices as of ${s.pricesAsOf}` : undefined
    }
  ]
}

export interface SourceRow {
  key: string
  label: string
  sessions: string
  tokens: string
  cost: string
  /** Its tokens against the biggest source's, 0..1: the row's bar. */
  share: number
  title: string
}

/** The Sources list, most tokens first (the server's order). */
export function homeSources(s: HomeStats): SourceRow[] {
  const max = Math.max(1, ...s.sources.map((x) => x.tokens))
  return s.sources.map((x) => ({
    key: x.key,
    label: x.label,
    sessions: count(x.sessions),
    tokens: compact(x.tokens),
    cost: x.costUsd === null ? UNKNOWN : usd(x.costUsd),
    share: x.tokens / max,
    title: `${x.label}: ${plural(x.sessions, 'session', 'sessions')}, ${plural(x.messages, 'message', 'messages')}, ${count(x.tokens)} tokens${x.costUsd === null ? ', not priced' : ''}`
  }))
}

/** The Models tab: AgentHydra's models under their short names, merged (a dated id joins its model's row). */
export function homeModels(s: HomeStats): { label: string; sessions: number }[] {
  const byName = new Map<string, number>()
  for (const m of s.models) {
    const label = modelName(m.key)
    byName.set(label, (byName.get(label) ?? 0) + m.sessions)
  }
  return [...byName].map(([label, sessions]) => ({ label, sessions })).sort((a, b) => b.sessions - a.sessions)
}

/** One real sentence, and a second while AgentHydra is still reading sessions. */
export function homeFooter(s: HomeStats): string[] {
  const sources = s.sources.filter((x) => x.sessions > 0).length
  const cost = s.costUsd === null ? '.' : `, ${usd(s.costUsd)} at API rates.`
  const lines = [
    s.sessions
      ? `${plural(s.sessions, 'session', 'sessions')} from ${plural(sources, 'source', 'sources')} over ${plural(s.activeDays, 'day', 'days')}${cost}`
      : 'No sessions in this range yet.'
  ]
  if (s.coverage.refreshing)
    lines.push(`AgentHydra is still reading sessions (${count(s.coverage.sessions)} of ${count(s.coverage.total)}), so these figures will grow.`)
  return lines
}
