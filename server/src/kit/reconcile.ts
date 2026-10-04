// TEMPORARY (docs/ANALYTICS-PLAN.md §5 piece 8, removed in piece 18): for one window, the kit's number
// next to each old producer's number, so every migration piece can show it moved nothing.
// One row per pair: { name, kit, old, gapPct, note } plus the kit's coverage of that source. A gap on a
// source the kit has not fully ingested is marked `partial`, not read as a disagreement.
import { type LastWindow, type UsageQueryOpts, type UsageResult, usageQuery } from './query'

export interface ReconcileRow {
  name: string
  kit: number | null
  old: number | null
  /** (kit - old) / old * 100, 2 decimals. 0 when both are 0; null when old is missing or 0 with kit > 0. */
  gapPct: number | null
  /** full: the kit holds the whole window for these sources. partial: it starts late, is stale or is mid-rollup. none: no events. */
  coverage: 'full' | 'partial' | 'none'
  note: string
}

type Awaitable<T> = T | Promise<T>

export interface OldTotals {
  tokens: number
  usd: number | null
}

/** What each old producer says for the window. A reader that has no answer returns null (its row says so). */
export interface OldReaders {
  /** P1 spendReport, from `sinceMs`: overall and per provider key. */
  spend(
    sinceMs: number,
  ): Awaitable<{ claude: OldTotals; byProvider: Record<string, OldTotals> } | null>
  /** P4 / account-tokens: tokens per CLI instance name and per account uuid, for 5h, 7d or all time only. */
  cliTokens(last: LastWindow | null): Awaitable<{
    byInstance: Record<string, number>
    byAccount: Record<string, number>
  } | null>
  /** P5 climayteTotals(since). */
  climayte(sinceMs: number): Awaitable<OldTotals | null>
  /** P15 model-stats over `days` whole days: tasks, billed $ and list $. */
  hswarm(days: number): Awaitable<{ calls: number; billedUsd: number; listUsd: number } | null>
}

export interface ReconcileParams {
  last?: LastWindow
  from?: number
  to?: number
}

const CLAUDE_SOURCES = ['cli', 'desktop', 'climayte']
const DAY_MS = 86_400_000

const round2 = (n: number): number => Math.round(n * 100) / 100

export function gapOf(kit: number | null, old: number | null): number | null {
  if (kit === null || old === null) return null
  if (old === 0) return kit === 0 ? 0 : null
  return round2(((kit - old) / old) * 100)
}

/** Coverage of the named sources over the window, from the query's coverage block. */
function coverageOf(
  res: UsageResult,
  sources: string[],
): { coverage: ReconcileRow['coverage']; why: string } {
  const have = sources.map((s) => ({ s, c: res.coverage.sources[s] }))
  const present = have.filter((h) => h.c)
  if (present.length === 0)
    return { coverage: 'none', why: `kit has no ${sources.join('/')} events` }
  const why: string[] = []
  const missing = have.filter((h) => !h.c).map((h) => h.s)
  if (missing.length) why.push(`no events from ${missing.join(', ')}`)
  const late = present.filter((h) => h.c.firstTs > res.window.from)
  if (late.length && res.window.from > 0)
    why.push(
      `${late.map((h) => h.s).join(', ')} starts ${new Date(Math.min(...late.map((h) => h.c.firstTs))).toISOString()}, after the window`,
    )
  if (res.coverage.dirtyFrom !== null && res.coverage.dirtyFrom <= res.window.to)
    why.push('rollup stale from ' + new Date(res.coverage.dirtyFrom).toISOString())
  return why.length ? { coverage: 'partial', why: why.join('; ') } : { coverage: 'full', why: '' }
}

function pair(
  name: string,
  kit: number | null,
  old: number | null,
  cov: { coverage: ReconcileRow['coverage']; why: string },
  note = '',
): ReconcileRow {
  const gapPct = gapOf(kit, old)
  const parts = [note]
  if (old === null) parts.push('old producer gave no number')
  else if (gapPct === null && kit !== null) parts.push('old is 0, gap undefined')
  if (cov.coverage !== 'full' && gapPct !== 0) parts.push(`partial: ${cov.why}`)
  return { name, kit, old, gapPct, coverage: cov.coverage, note: parts.filter(Boolean).join('; ') }
}

const num = (v: number | null | undefined): number | null => (v === undefined ? null : v)

export async function reconcile(
  params: ReconcileParams,
  old: OldReaders,
  opts: UsageQueryOpts = {},
): Promise<{ window: UsageResult['window']; rows: ReconcileRow[]; notes: string[] }> {
  const window = params.last ? { last: params.last } : { from: params.from, to: params.to }
  const q = (
    filter: Record<string, string[]>,
    groupBy: ('source' | 'instance' | 'account')[] = [],
  ) =>
    usageQuery(
      { window, filter, groupBy, measures: ['tokens', 'list_usd', 'billed_usd', 'calls'] },
      opts,
    )
  const base = q({ source: CLAUDE_SOURCES })
  const win = base.window
  const notes: string[] = []
  if (params.to !== undefined) notes.push('old producers have no upper bound: they read up to now')
  const rows: ReconcileRow[] = []
  const cov = (res: UsageResult, sources: string[]) => coverageOf(res, sources)

  // P1 spendReport
  const spend = await old.spend(win.from)
  const claudeCov = cov(base, CLAUDE_SOURCES)
  const p1 =
    'P1 spendReport claude (counts desktop chats only: CLI and CliMayte sessions are not in it)'
  rows.push(
    pair('claude tokens', base.totals.tokens ?? 0, num(spend?.claude.tokens), claudeCov, p1),
  )
  rows.push(pair('claude list $', base.totals.list_usd ?? 0, num(spend?.claude.usd), claudeCov, p1))
  const desk = q({ source: ['desktop'] })
  const deskCov = cov(desk, ['desktop'])
  rows.push(
    pair(
      'claude desktop tokens',
      desk.totals.tokens ?? 0,
      num(spend?.claude.tokens),
      deskCov,
      'P1 spendReport claude',
    ),
  )
  rows.push(
    pair(
      'claude desktop list $',
      desk.totals.list_usd ?? 0,
      num(spend?.claude.usd),
      deskCov,
      'P1 spendReport claude',
    ),
  )
  for (const src of ['codex', 'opencode', 'dsh']) {
    const r = q({ source: [src] })
    const c = cov(r, [src])
    const o = spend?.byProvider[src]
    rows.push(
      pair(
        `${src} tokens`,
        r.totals.tokens ?? 0,
        num(o?.tokens ?? (spend ? 0 : undefined)),
        c,
        'P1 byProvider',
      ),
    )
    rows.push(
      pair(
        `${src} list $`,
        r.totals.list_usd ?? 0,
        num(o ? o.usd : spend ? null : undefined),
        c,
        'P1 byProvider',
      ),
    )
  }

  // P4 / account-tokens
  const cli = await old.cliTokens(params.last ?? null)
  const cliKit = q({ source: ['cli'] }, ['instance'])
  const cliCov = cov(cliKit, ['cli'])
  if (!cli) {
    notes.push(
      'cli tokens: the old per-account ledger has no figure for this window (5h, 7d and all only)',
    )
  } else {
    const byInst = new Map(cliKit.rows.map((r) => [String(r.instance), r.tokens as number]))
    for (const k of new Set([...byInst.keys(), ...Object.keys(cli.byInstance)]))
      rows.push(
        pair(
          `cli instance ${k} tokens`,
          byInst.get(k) ?? 0,
          cli.byInstance[k] ?? null,
          cliCov,
          'P4 account-tokens by instance',
        ),
      )
    const acctKit = q({ source: CLAUDE_SOURCES }, ['account'])
    const byAcct = new Map(
      acctKit.rows.map((r) => [String(r.account ?? '').toLowerCase(), r.tokens as number]),
    )
    for (const k of new Set([...byAcct.keys(), ...Object.keys(cli.byAccount)]))
      if (k)
        rows.push(
          pair(
            `account ${k} tokens`,
            byAcct.get(k) ?? 0,
            cli.byAccount[k] ?? null,
            claudeCov,
            'account-tokens by account',
          ),
        )
  }

  // P5 CliMayte
  const cm = await old.climayte(win.from)
  const cmKit = q({ source: ['climayte'] })
  const cmCov = cov(cmKit, ['climayte'])
  rows.push(
    pair('climayte tokens', cmKit.totals.tokens ?? 0, num(cm?.tokens), cmCov, 'P5 attemptSpend'),
  )
  rows.push(
    pair('climayte list $', cmKit.totals.list_usd ?? 0, num(cm?.usd), cmCov, 'P5 attemptSpend'),
  )

  // P15 model-stats (whole days)
  const days = Math.max(1, Math.ceil((win.to - win.from) / DAY_MS))
  const hs = await old.hswarm(days)
  const hsKit = q({ source: ['hswarm'] })
  const hsCov = cov(hsKit, ['hswarm'])
  const hn = `P15 model-stats over ${days} whole day(s), not the exact window`
  rows.push(pair('hswarm calls', hsKit.totals.calls ?? 0, num(hs?.calls), hsCov, hn))
  rows.push(pair('hswarm billed $', hsKit.totals.billed_usd ?? 0, num(hs?.billedUsd), hsCov, hn))
  rows.push(pair('hswarm list $', hsKit.totals.list_usd ?? 0, num(hs?.listUsd), hsCov, hn))

  return { window: win, rows, notes: [...notes, ...base.notes] }
}

// ---- the real producers ----

const sumTokens = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
  t.input + t.output + t.cacheRead + t.cacheWrite

export const liveReaders: OldReaders = {
  async spend(sinceMs) {
    const { spendReport } = await import('../analytics')
    const r = spendReport({ sinceMs: sinceMs > 0 ? sinceMs : null })
    const byProvider: Record<string, OldTotals> = {}
    for (const p of r.byProvider) byProvider[p.key] = { tokens: p.tokens.total, usd: p.costUsd }
    return { claude: byProvider.claude ?? { tokens: 0, usd: null }, byProvider }
  },
  async cliTokens(last) {
    if (last !== '5h' && last !== '7d' && last !== 'all') return null
    const { accountTokens, cliAccountUuid } = await import('../core/account-tokens')
    const { listCliInstances } = await import('../core/cli-instances')
    const pick = (uuid: string) => {
      const t = accountTokens(uuid)
      return t ? (last === '5h' ? t.fiveHour : last === '7d' ? t.week : t.total).total : null
    }
    const byInstance: Record<string, number> = {}
    const byAccount: Record<string, number> = {}
    for (const i of listCliInstances()) {
      const uuid = cliAccountUuid(i.configDir, i.loggedIn)
      const t = uuid ? pick(uuid) : null
      if (uuid && t !== null) {
        byInstance[i.name] = t
        byAccount[uuid.toLowerCase()] = t
      }
    }
    return { byInstance, byAccount }
  },
  async climayte(sinceMs) {
    const { climayteTotals } = await import('../climayte-totals')
    const t = climayteTotals(sinceMs)
    return { tokens: sumTokens(t.tokens), usd: t.costUsd }
  },
  async hswarm(days) {
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
  },
}
