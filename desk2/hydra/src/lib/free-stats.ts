// The Free accounts' numbers on the Usage history card (owner, 2026-10-08: "total tokens ... for Claude and ChatGPT ...
// and also per each ... also the success rate across which models ... were used on each"). Tokens follow the table's
// window (the status estimate, server/src/free-instances/tokens.ts); messages, success and tokens by model and by day
// come from Desk's daily record (stats.ts), which keeps the last weeks. Each account's own tokens are the table's
// Tokens column, so the card has no list of accounts (owner, the same day: "don't need this").
import type { FreeInstance, FreeProvider, FreeStatRow, FreeTokens } from '@desk/shared/free-instances'
import type { TokenWindow } from '@/lib/token-window'

/** Messages sent and failed; `tokens` as the row says where it came from. */
export interface FreeTally { sent: number; failed: number; tokens: number }
export interface FreeModelTally extends FreeTally { model: string; provider: FreeProvider }
export interface FreeSummary {
  /** Tokens in the table's window; messages over the record's days. */
  totals: Record<'all' | FreeProvider, FreeTally>
  /** Every model any account was sent to over the record's days, most messages first; tokens over those days. */
  models: FreeModelTally[]
  /** Each of the record's days, oldest first, with each provider's tokens (no-message days at 0). */
  days: Array<{ key: string; claude: number; chatgpt: number }>
}

/** The share of messages answered, or null when none were sent. */
export const answeredShare = (t: Pick<FreeTally, 'sent' | 'failed'>): number | null => (t.sent ? (t.sent - t.failed) / t.sent : null)

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const windowTokens = (t: FreeTokens | undefined, w: TokenWindow) => (!t ? 0 : (w === '5h' ? t.fiveHour : w === 'week' ? t.week : t.total).total)
const byMessages = (a: FreeModelTally, b: FreeModelTally) => b.sent - a.sent || b.tokens - a.tokens || a.model.localeCompare(b.model)

export function summarizeFree(rows: readonly FreeStatRow[], instances: readonly FreeInstance[], tokens: Record<string, FreeTokens>, window: TokenWindow, days: number, now: number): FreeSummary {
  const blank = (): FreeTally => ({ sent: 0, failed: 0, tokens: 0 })
  const totals = { all: blank(), claude: blank(), chatgpt: blank() }
  const byId = new Map(instances.map(i => [i.id, i]))
  const models = new Map<string, FreeModelTally>()
  const keys = Array.from({ length: days }, (_, k) => dayKey(now - (days - 1 - k) * 86_400_000))
  const perDay = new Map(keys.map(key => [key, { key, claude: 0, chatgpt: 0 }]))
  for (const i of instances) {
    const n = windowTokens(tokens[i.id], window)
    totals.all.tokens += n; totals[i.provider].tokens += n
  }
  for (const r of rows) {
    const instance = byId.get(r.instanceId)
    if (!instance) continue
    const day = perDay.get(r.day)
    if (day) day[instance.provider] += r.input + r.output
    for (const t of [totals.all, totals[instance.provider]]) { t.sent += r.sent; t.failed += r.failed }
    // Tokens from before Desk recorded models count by day only.
    if (!r.model) continue
    const key = `${instance.provider}/${r.model}`
    const m = models.get(key) ?? { model: r.model, provider: instance.provider, ...blank() }
    m.sent += r.sent; m.failed += r.failed; m.tokens += r.input + r.output
    models.set(key, m)
  }
  return {
    totals,
    models: [...models.values()].sort(byMessages),
    days: [...perDay.values()],
  }
}
