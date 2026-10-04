// TEMPORARY (removed with reconcile.ts in piece 18): the OLD producers' figures for reconcile, each
// read straight from the source the pre-kit code read, never through a function the kit now backs
// (spendReport, climayteTotals and the quota budget move onto the kit, and a reader that called them
// would compare the kit with itself).
import type { LastWindow } from './query'

export interface OldTotals {
  tokens: number
  usd: number | null
}

/** Local date key, the resolution a session_stats row records its days at (the pre-kit dayKey). */
function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

/** Share of a session's weighted tokens on days inside the window; null: no day data (pre-kit windowShare). */
function windowShare(days: Record<string, number>, sinceDay: string): number | null {
  let total = 0
  let inWindow = 0
  for (const [day, w] of Object.entries(days)) {
    total += w
    if (day >= sinceDay) inWindow += w
  }
  return total > 0 ? inWindow / total : null
}

/**
 * P1, as the pre-kit spendReport summed it: every session_stats row (live and gone), each scaled by the
 * share of its days inside the window, per provider. Day-granular like the old report, so a window
 * that starts mid-day differs from the kit's exact hours; that gap is the old side's, not the kit's.
 */
export async function oldSpend(
  sinceMs: number,
): Promise<{ claude: OldTotals; byProvider: Record<string, OldTotals> }> {
  const { db } = await import('../db')
  const rows = db
    .query<
      {
        source: string
        input_tokens: number | null
        cache_read: number | null
        cache_write: number | null
        output_tokens: number | null
        cost_usd: number | null
        days_json: string | null
        last_ts: number | null
      },
      []
    >(
      'select source, input_tokens, cache_read, cache_write, output_tokens, cost_usd, days_json, last_ts from session_stats',
    )
    .all()
  const sinceDay = sinceMs > 0 ? dayKey(sinceMs) : null
  const byProvider: Record<string, OldTotals> = {}
  for (const r of rows) {
    let scale = 1
    if (sinceDay !== null) {
      let days: Record<string, number> = {}
      try {
        days = r.days_json ? JSON.parse(r.days_json) : {}
      } catch {}
      const share = windowShare(days, sinceDay)
      if (share === null) {
        if ((r.last_ts ?? 0) < sinceMs) continue
      } else if (share <= 0) continue
      else scale = share
    }
    const tokens =
      ((r.input_tokens ?? 0) +
        (r.cache_read ?? 0) +
        (r.cache_write ?? 0) +
        (r.output_tokens ?? 0)) *
      scale
    if (tokens <= 0) continue
    const p = byProvider[r.source] ?? { tokens: 0, usd: null }
    p.tokens += tokens
    if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd))
      p.usd = (p.usd ?? 0) + r.cost_usd * scale
    byProvider[r.source] = p
  }
  return { claude: byProvider.claude ?? { tokens: 0, usd: null }, byProvider }
}

/**
 * P5, as the pre-kit attemptSpend did: every CliMayte attempt that ended after `sinceMs` (or is still
 * running), its tokens and cost re-read from the transcript the attempt wrote. Whole attempts, not
 * clipped to the window, like the old counter.
 */
export async function oldClimayte(sinceMs: number): Promise<OldTotals> {
  const { workers, load } = await import('../climayte-core')
  const { attemptSpend } = await import('../climayte-lib')
  const { getCliInstance } = await import('../core/cli-instances')
  load()
  let tokens = 0
  let usd = 0
  for (const w of workers.values())
    for (const at of w.attempts) {
      if ((at.endedAt ?? Date.now()) < sinceMs) continue
      const dir = at.account.configDir ?? getCliInstance(at.account.id)?.configDir
      const session = at.sessionId === undefined ? w.sessionId : at.sessionId
      if (!dir || !session) continue
      const s = attemptSpend(dir, session, at.startedAt, at.endedAt ?? Date.now())
      tokens += s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite
      usd += s.costUsd
    }
  return { tokens, usd }
}

/** P4: tokens per CLI instance (id and display name) and per account uuid, 5h, 7d or all time only. */
export async function oldCliTokens(last: LastWindow | null): Promise<{
  byInstance: Array<{ id: string; name: string; tokens: number }>
  byAccount: Record<string, number>
} | null> {
  if (last !== '5h' && last !== '7d' && last !== 'all') return null
  const { accountTokens, cliAccountUuid } = await import('../core/account-tokens')
  const { listCliInstances } = await import('../core/cli-instances')
  const pick = (uuid: string) => {
    const t = accountTokens(uuid)
    return t ? (last === '5h' ? t.fiveHour : last === '7d' ? t.week : t.total).total : null
  }
  const byInstance: Array<{ id: string; name: string; tokens: number }> = []
  const byAccount: Record<string, number> = {}
  for (const i of listCliInstances()) {
    const uuid = cliAccountUuid(i.configDir, i.loggedIn)
    const t = uuid ? pick(uuid) : null
    if (uuid && t !== null) {
      byInstance.push({ id: i.id, name: i.name, tokens: t })
      byAccount[uuid.toLowerCase()] = t
    }
  }
  return { byInstance, byAccount }
}

/** P15: HSwarm's own model-stats over `days` whole days; null when it is not running. */
export async function oldHswarm(
  days: number,
): Promise<{ calls: number; billedUsd: number; listUsd: number } | null> {
  const { getHSwarmStatus } = await import('../hswarm')
  const st = getHSwarmStatus()
  if (!st.running || !st.port) return null
  try {
    const res = await fetch(`http://127.0.0.1:${st.port}/model-stats?days=${Math.min(90, days)}`)
    if (!res.ok) return null
    const j = (await res.json()) as {
      models?: Array<{ tasks: number; spent_usd: number; cost_usd: number }>
    }
    const m = j.models ?? []
    return {
      calls: m.reduce((s, x) => s + x.tasks, 0),
      billedUsd: m.reduce((s, x) => s + x.spent_usd, 0),
      listUsd: m.reduce((s, x) => s + x.cost_usd, 0),
    }
  } catch {
    return null
  }
}
