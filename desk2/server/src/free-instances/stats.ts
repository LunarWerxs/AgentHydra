// The Free tab's numbers (owner, 2026-10-08: "total tokens for ... Claude and ChatGPT ... and also per each ... also
// the success rate across which models ... were used on each"). Each day keeps, for each account and model, how many
// messages (new chats and continuations) were sent, how many failed, and their token estimate (tokens.ts). Counts
// only, never text; the last STATS_DAYS days are kept.
import type { FreeStatRow } from '@shared/free-instances'
import type { TokenLedger } from './tokens'

export const STATS_DAYS = 30
/** The model a message's tokens were counted under before Desk recorded models: its tokens show by day, and it
 *  counts in no success rate. */
export const UNRECORDED_MODEL = ''

export interface StatCell { sent: number; failed: number; input: number; output: number }
/** By day (YYYY-MM-DD, this PC's time), then account id, then model. */
export type StatsData = Record<string, Record<string, Record<string, StatCell>>>

const pad = (n: number) => String(n).padStart(2, '0')
export const dayOf = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const oldestKept = (now: number): string => dayOf(now - (STATS_DAYS - 1) * 86_400_000)

function add(stats: StatsData, at: number, instanceId: string, model: string, cell: StatCell): void {
  const byModel = ((stats[dayOf(at)] ??= {})[instanceId] ??= {})
  const c = (byModel[model] ??= { sent: 0, failed: 0, input: 0, output: 0 })
  c.sent += cell.sent; c.failed += cell.failed; c.input += cell.input; c.output += cell.output
}

/** One message counted: sent, failed or not, with its tokens (none for a failure); days past the kept span dropped. */
export function addStat(stats: StatsData, message: { at: number; instanceId: string; model: string | undefined; ok: boolean; input: number; output: number }): StatsData {
  add(stats, message.at, message.instanceId, message.model || 'unknown', { sent: 1, failed: message.ok ? 0 : 1, input: message.input, output: message.output })
  const oldest = oldestKept(message.at)
  for (const day of Object.keys(stats)) if (day < oldest) delete stats[day]
  return stats
}

/** The first record of a store that had none: the week of token estimates the accounts already hold, by day, as
 *  tokens alone, so the chart has a history from its first day. */
export function seedStats(tokens: Record<string, TokenLedger>): StatsData {
  const stats: StatsData = {}
  for (const [id, ledger] of Object.entries(tokens))
    for (const e of ledger.entries) add(stats, e.at, id, UNRECORDED_MODEL, { sent: 0, failed: 0, input: e.input, output: e.output })
  return stats
}

/** The rows of the last `days` days, oldest first. */
export function statRows(stats: StatsData, days: number, now: number): FreeStatRow[] {
  const oldest = dayOf(now - (Math.min(Math.max(1, days), STATS_DAYS) - 1) * 86_400_000)
  return Object.keys(stats).filter(d => d >= oldest).sort().flatMap(day =>
    Object.entries(stats[day]!).flatMap(([instanceId, byModel]) => Object.entries(byModel).map(([model, c]) => ({ day, instanceId, model, ...c }))))
}

/** A stored record as it must be: damaged cells are dropped, never trusted. */
export function validStats(value: unknown): StatsData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0
  const stats: StatsData = {}
  for (const [day, byId] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !byId || typeof byId !== 'object') continue
    for (const [id, byModel] of Object.entries(byId as Record<string, unknown>)) {
      if (!byModel || typeof byModel !== 'object') continue
      for (const [model, cell] of Object.entries(byModel as Record<string, StatCell>))
        if (cell && n(cell.sent) && n(cell.failed) && n(cell.input) && n(cell.output) && model.length <= 100) add(stats, Date.parse(`${day}T12:00:00`), id, model, cell)
    }
  }
  return stats
}
