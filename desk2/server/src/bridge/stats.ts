// The home screen's stats card (GET /api/stats/home), consolidated over every source AgentHydra counts
// (owner, 2026-10-04: "the overview screen needs to display full consolidated stats from all sources.
// Analytics. Hswarm. Climate etc."). Four reads in parallel: AgentHydra's spend report (sessions, turns,
// tokens and dollars per source, model and day), its activity report (the hours of the week, agent time),
// CliMayte's totals and HSwarm's own stats. The spend report is the card: without it there is no answer.
// The other three may fail on their own (HSwarm is often down); the answer then names them in `missing`,
// and the card shows a dash for them, never a made-up 0.

import type { HeatCell, HomeStats, HomeStatsMissing, HomeStatsRange } from '@shared/protocol'
import { BridgeError, type AhActivityReport, type AhCorchTotals, type AhHswarmStats, type AhSpendReport, type HydraClient } from './client'

export const HOME_STATS_RANGES: readonly HomeStatsRange[] = ['all', '30d', '7d']
export const isHomeStatsRange = (r: string): r is HomeStatsRange => (HOME_STATS_RANGES as readonly string[]).includes(r)

/** How long one range's answer is reused: the spend report reads every store (about 1 s for all). */
const HOME_STATS_FRESH_MS = 60_000
/** The activity grid: 27 weeks of 7 days, oldest first, ending today. */
const HEAT_DAYS = 189

const DAY = 86_400_000
const RANGE_DAYS: Record<Exclude<HomeStatsRange, 'all'>, number> = { '30d': 30, '7d': 7 }
// HSwarm lists its days back from today, 90 at most; its `total` is lifetime whatever is asked (hswarmFigures).
const HSWARM_DAYS: Record<HomeStatsRange, number> = { all: 90, '30d': 30, '7d': 7 }

const SOURCE_LABELS: Record<string, string> = {
  desktop: 'Claude desktop',
  cli: 'Claude Code CLI',
  climayte: 'CliMayte',
  hswarm: 'HSwarm',
  codex: 'Codex',
  opencode: 'OpenCode',
  dsh: 'DeepSeek',
  hermes: 'Hermes',
}
/** The name the card gives one of AgentHydra's sources; one it does not know keeps its key. */
const sourceLabel = (key: string): string => SOURCE_LABELS[key] ?? key

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const unreachable = (err: unknown): boolean => err instanceof BridgeError && err.unreachable

/** '1 PM', the way the card has always named an hour. */
function hourLabel(h: number): string {
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`
}

/** The busiest hour of the day over the week's 168 slots (Sunday 00:00 first, the PC's local time); null when all are quiet. */
function peakHour(hours: number[]): string | null {
  const byHour = new Array<number>(24).fill(0)
  for (let i = 0; i < hours.length; i++) byHour[i % 24] = byHour[i % 24]! + num(hours[i])
  const max = Math.max(...byHour)
  return max > 0 ? hourLabel(byHour.indexOf(max)) : null
}

/** A local calendar day as AgentHydra keys its days: YYYY-MM-DD. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * HEAT_DAYS cells, oldest first, ending on `today`: each day's turns, and its level 0-4 against the busiest
 * day in the window (the scale the card has always drawn: any activity is at least 1).
 */
function heatCells(turnsByDay: Map<string, number>, today: Date): HeatCell[] {
  const days = Array.from({ length: HEAT_DAYS }, (_, i) => {
    const d = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (HEAT_DAYS - 1 - i)))
    return { day: d, count: turnsByDay.get(d) ?? 0 }
  })
  const max = Math.max(1, ...days.map((c) => c.count))
  return days.map((c) => ({ ...c, level: c.count <= 0 ? 0 : Math.min(4, Math.ceil((c.count / max) * 4)) }))
}

/**
 * HSwarm's tasks and saving for the range. Its `total` is lifetime whatever `days` asked (the console only
 * cuts its `days` list), so a 7 or 30 day card added the lifetime count to a week's figures; a range sums
 * the days listed instead. A saving no task was priced for stays unknown, never $0.
 */
function hswarmFigures(range: HomeStatsRange, h: AhHswarmStats): { tasks: number; savedUsd: number | null } {
  const usd = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (range === 'all') return { tasks: num(h.total.tasks), savedUsd: usd(h.total.saved_usd) }
  const days = h.days ?? []
  const saved = days.map((d) => usd(d.saved_usd)).filter((v): v is number => v !== null)
  return { tasks: days.reduce((sum, d) => sum + num(d.tasks), 0), savedUsd: saved.length ? saved.reduce((a, b) => a + b, 0) : null }
}

interface Reads {
  spend: AhSpendReport
  activity: AhActivityReport | null
  climayte: AhCorchTotals | null
  hswarm: AhHswarmStats | null
  missing: HomeStatsMissing[]
}

/** One answer from the four reads. */
function consolidate(range: HomeStatsRange, r: Reads, today: Date): HomeStats {
  const { spend } = r
  const sources = (spend.bySource ?? [])
    .map((b) => ({
      key: b.key,
      label: sourceLabel(b.key),
      sessions: num(b.sessions),
      messages: num(b.turns),
      tokens: num(b.tokens?.total),
      costUsd: b.costUsd ?? null,
    }))
    .filter((s) => s.sessions || s.messages || s.tokens)
    .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions)
  // `rank:` rows are AgentHydra's dispatch ranks, not models: their sessions are already under the model.
  const models = (spend.byModel ?? [])
    .filter((b) => !b.key.startsWith('rank:') && num(b.sessions) > 0)
    .map((b) => ({ key: b.key, sessions: num(b.sessions), turns: num(b.turns) }))
    .sort((a, b) => b.sessions - a.sessions || b.turns - a.turns)
  const turnsByDay = new Map<string, number>()
  for (const d of spend.byDay ?? []) {
    const n = num(d.turns)
    if (n > 0) turnsByDay.set(d.key, (turnsByDay.get(d.key) ?? 0) + n)
  }
  const t = spend.tokens
  return {
    range,
    sessions: num(spend.sessions),
    messages: sources.reduce((sum, s) => sum + s.messages, 0),
    tokens: { input: num(t?.input), cacheRead: num(t?.cacheRead), cacheWrite: num(t?.cacheWrite), output: num(t?.output), total: num(t?.total) },
    costUsd: spend.totalCostUsd ?? null,
    pricesAsOf: spend.pricesAsOf || null,
    activeDays: turnsByDay.size,
    peakHour: r.activity ? peakHour(r.activity.hours ?? []) : null,
    favoriteModel: models[0]?.key ?? null,
    agentMinutes: r.activity ? num(r.activity.agentMinutes) : null,
    heat: heatCells(turnsByDay, today),
    sources,
    models: models.map(({ key, sessions }) => ({ key, sessions })),
    climayte: r.climayte
      ? { tasks: num(r.climayte.tasks), sessions: num(r.climayte.sessions), costUsd: num(r.climayte.costUsd), limitHits: num(r.climayte.limitHits) }
      : null,
    hswarm: r.hswarm ? hswarmFigures(range, r.hswarm) : null,
    coverage: { sessions: num(spend.coverage?.sessions), total: num(spend.coverage?.total), refreshing: !!spend.coverage?.refreshing },
    missing: r.missing,
  }
}

const WHO: Record<HomeStatsMissing['part'], string> = {
  activity: "AgentHydra's activity report",
  climayte: "CliMayte's totals",
  hswarm: 'HSwarm',
}

/**
 * `homeStats(range)`: the card's answer, reused for HOME_STATS_FRESH_MS (a failure is not kept). AgentHydra
 * down throws its unreachable BridgeError; a spend report that fails or runs out of time while the rest
 * answered throws an http one (slow or broken, not down).
 */
export function createHomeStats(client: HydraClient, now: () => number = Date.now) {
  const kept = new Map<HomeStatsRange, { at: number; answer: Promise<HomeStats> }>()

  async function read(range: HomeStatsRange): Promise<HomeStats> {
    const since = range === 'all' ? undefined : now() - RANGE_DAYS[range] * DAY
    const [spend, activity, climayte, hswarm] = await Promise.allSettled([
      client.spend(range),
      client.activity(range),
      client.corchTotals(since),
      client.hswarmStats(HSWARM_DAYS[range]),
    ])
    if (spend.status === 'rejected') {
      const err = spend.reason
      if (!(err instanceof BridgeError)) throw err
      const others = [activity, climayte, hswarm]
      if (err.unreachable && others.every((p) => p.status === 'rejected' && unreachable(p.reason))) throw err
      throw err.kind === 'timeout' ? new BridgeError('http', `AgentHydra's spend report is still working: ${err.message}`, 504) : err
    }
    const missing: HomeStatsMissing[] = []
    function take<T>(part: HomeStatsMissing['part'], p: PromiseSettledResult<T>, valid: (v: T) => boolean = () => true): T | null {
      if (p.status === 'fulfilled' && valid(p.value)) return p.value
      const why = p.status === 'rejected' ? (p.reason instanceof Error ? p.reason.message : String(p.reason)) : null
      missing.push({ part, reason: why === null ? `${WHO[part]} answered without figures` : `${WHO[part]} did not answer (${why})` })
      return null
    }
    return consolidate(
      range,
      {
        spend: spend.value,
        activity: take('activity', activity, (a) => Array.isArray(a?.hours)),
        // Every figure the tile shows, or none: a part left out is a dash with its reason, never a made-up 0.
        climayte: take('climayte', climayte, (c) => [c?.tasks, c?.sessions, c?.costUsd, c?.limitHits].every((v) => typeof v === 'number')),
        hswarm: take('hswarm', hswarm, (h) => typeof h?.total?.tasks === 'number'),
        missing,
      },
      new Date(now()),
    )
  }

  return function homeStats(range: HomeStatsRange): Promise<HomeStats> {
    const hit = kept.get(range)
    if (hit && now() - hit.at < HOME_STATS_FRESH_MS) return hit.answer
    const entry = { at: now(), answer: read(range) }
    kept.set(range, entry)
    entry.answer.catch(() => {
      if (kept.get(range) === entry) kept.delete(range)
    })
    return entry.answer
  }
}
