// TEMPORARY (docs/ANALYTICS-PLAN.md §5 piece 8, removed in piece 18): for one window, the kit's number
// next to each old producer's number, so every migration piece can show it moved nothing.
// One row per pair: { name, kit, old, gapPct, note } plus the kit's coverage of that source. A gap on a
// source the kit has not fully ingested is marked `partial`, not read as a disagreement.

import { type LastWindow, type UsageQueryOpts, type UsageResult, usageQuery } from './query'
import { type OldTotals, oldClimayte, oldCliTokens, oldHswarm, oldSpend } from './reconcile-old'

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

export type { OldTotals }

/** What each old producer says for the window. A reader that has no answer returns null (its row says so). */
export interface OldReaders {
  /** P1 session_stats (what the pre-kit spendReport summed), from `sinceMs`: Claude overall and per provider key. */
  spend(
    sinceMs: number,
  ): Awaitable<{ claude: OldTotals; byProvider: Record<string, OldTotals> } | null>
  /** P4 / account-tokens: tokens per CLI instance (id, as the kit's `cli:<id>`, and display name) and per
   *  account uuid, for 5h, 7d or all time only. reconcile keys both the kit's way. */
  cliTokens(last: LastWindow | null): Awaitable<{
    byInstance: Array<{ id: string; name: string; tokens: number }>
    byAccount: Record<string, number>
  } | null>
  /** P5 the per-attempt transcript re-read (pre-kit attemptSpend) over attempts ending after `sinceMs`. */
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
  const p1 = 'P1 session_stats claude'
  rows.push(
    pair('claude tokens', base.totals.tokens ?? 0, num(spend?.claude.tokens), claudeCov, p1),
  )
  rows.push(pair('claude list $', base.totals.list_usd ?? 0, num(spend?.claude.usd), claudeCov, p1))
  notes.push(
    'P1 has no desktop-only figure (session_stats holds all Claude sessions), so the claude rows compare the kit cli+desktop+climayte total',
  )
  notes.push('P1 is day-granular: a window starting mid-day differs from the kit by that part-day')
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
    const oldInst = new Map(cli.byInstance.map((i) => [`cli:${i.id}`, i]))
    for (const k of new Set([...byInst.keys(), ...oldInst.keys()]))
      rows.push(
        pair(
          `cli instance ${oldInst.get(k)?.name ?? k} tokens`,
          byInst.get(k) ?? 0,
          oldInst.get(k)?.tokens ?? null,
          cliCov,
          'P4 account-tokens by instance',
        ),
      )
    const acctKit = q({ source: CLAUDE_SOURCES }, ['account'])
    const byAcct = new Map(acctKit.rows.map((r) => [String(r.account ?? ''), r.tokens as number]))
    const { hswarmAccountId } = await import('../routes/hswarm')
    const oldAcct = new Map(
      Object.entries(cli.byAccount).map(([uuid, t]) => [hswarmAccountId(uuid), t]),
    )
    for (const k of new Set([...byAcct.keys(), ...oldAcct.keys()]))
      if (k)
        rows.push(
          pair(
            `account ${k} tokens`,
            byAcct.get(k) ?? 0,
            oldAcct.get(k) ?? null,
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
    pair(
      'climayte tokens',
      cmKit.totals.tokens ?? 0,
      num(cm?.tokens),
      cmCov,
      'P5 transcript re-read',
    ),
  )
  rows.push(
    pair(
      'climayte list $',
      cmKit.totals.list_usd ?? 0,
      num(cm?.usd),
      cmCov,
      'P5 transcript re-read',
    ),
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

// ---- the real producers: independent of the kit, see reconcile-old.ts ----

export const liveReaders: OldReaders = {
  spend: oldSpend,
  cliTokens: oldCliTokens,
  climayte: oldClimayte,
  hswarm: oldHswarm,
}
