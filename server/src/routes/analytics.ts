import { type AgentPresence, detectAgentTools } from '../agent-catalog'
import {
  activityReport,
  analyticsCoverage,
  concurrencyReport,
  dropAnalytics,
  recentEdits,
  refreshAnalytics,
  sinkReport,
  spendReport,
  tokensByDay,
  warmAnalyticsInBackground,
} from '../analytics'
import { mineCommandCorrections } from '../command-corrections'
import { app } from '../http-app'
import { boundedQueryInt } from '../route-helpers'
import { ensureTranscriptIndex } from '../transcript'
import { isSessionPeriod, periodCutoffMs, type SessionPeriod } from '../types'

/** Read-only analytics/agent-tools routes. See index.ts for the app-wide middleware these routes
 *  run behind. */
// --- analytics ---------------------------------------------------------------
// Read-only aggregates over per-session TOTALS the background warm computed (server/src/
// analytics.ts). Every one of them reports its own coverage, because a chart drawn from a
// half-warmed store and a chart drawn from a complete one look identical and mean different things.
const analyticsPeriod = (c: { req: { query: (k: string) => string | undefined } }) => {
  const raw = c.req.query('period')
  const period: SessionPeriod = isSessionPeriod(raw) ? raw : '30d'
  return periodCutoffMs(period)
}
let agentToolsCache: { at: number; tools: AgentPresence[] } | null = null
let agentToolsRead: Promise<AgentPresence[]> | null = null
const AGENT_TOOLS_TTL_MS = 60_000
/** The last detection, refreshed behind it once a minute old; only the first ever call waits for the walk. */
function cachedAgentTools(): Promise<AgentPresence[]> {
  if (agentToolsCache && Date.now() - agentToolsCache.at < AGENT_TOOLS_TTL_MS)
    return Promise.resolve(agentToolsCache.tools)
  agentToolsRead ??= detectAgentTools()
    .then((tools) => {
      agentToolsCache = { at: Date.now(), tools }
      return tools
    })
    .finally(() => {
      agentToolsRead = null
    })
  if (!agentToolsCache) return agentToolsRead
  agentToolsRead.catch(() => undefined)
  return Promise.resolve(agentToolsCache.tools)
}

// `source` is a comma list of toolkit sources; absent = all, and `none` = nothing ticked.
const spendSources = (raw: string | undefined): string[] | null => {
  if (raw === undefined || raw === '') return null
  return raw === 'none' ? [] : raw.split(',').map((s) => s.trim())
}
app.get('/api/analytics/spend', async (c) =>
  c.json(
    await spendReport({
      sinceMs: analyticsPeriod(c),
      sources: spendSources(c.req.query('source')),
      pc: c.req.query('pc') === 'self' ? 'self' : null,
    }),
  ),
)
app.get('/api/analytics/activity', (c) => {
  const report = activityReport({ sinceMs: analyticsPeriod(c) })
  // Edit survival comes due hours after a session stops, and the boot warm has long finished by
  // then. Opening the tab is what measures the sessions that are now old enough; the warm skips
  // every row that is already current, so this costs a directory listing when nothing is due.
  if (report.editSurvival.overdue > 0) warmAnalyticsInBackground()
  return c.json(report)
})
// Weighted tokens per local day per source, for the Instances usage card: one request where the card
// used to make four 30-day spend reports (analytics.ts tokensByDay).
app.get('/api/analytics/tokens-by-day', async (c) =>
  c.json(await tokensByDay({ days: boundedQueryInt(c.req.query('days'), 14, 60) })),
)
// WHY a session was expensive: dead skill/MCP load, deep-context calls, subagent and cache-write
// spend, ranked against one total (analytics.ts sinkReport).
app.get('/api/analytics/sinks', (c) => c.json(sinkReport({ sinceMs: analyticsPeriod(c) })))
app.get('/api/analytics/concurrency', (c) =>
  c.json({
    buckets: concurrencyReport({
      sinceMs: analyticsPeriod(c),
      bucketMs: boundedQueryInt(c.req.query('bucketMinutes'), 60, 1440) * 60_000,
    }),
  }),
)
app.get('/api/analytics/edits', (c) =>
  c.json({ edits: recentEdits(boundedQueryInt(c.req.query('limit'), 200, 1000)) }),
)
app.get('/api/analytics', (c) => c.json(analyticsCoverage()))
// Recurring command mistakes (server/src/command-corrections.ts). Read on demand, never stored, and
// bounded like the refresh below: it opens transcripts, which the totals above never do.
app.get('/api/analytics/corrections', async (c) =>
  c.json(
    await mineCommandCorrections({
      limit: boundedQueryInt(c.req.query('limit'), 200, 2000),
      budgetMs: boundedQueryInt(c.req.query('budgetMs'), 15_000, 120_000),
    }),
  ),
)
/**
 * Which coding agents are installed on this machine (server/src/agent-catalog.ts).
 *
 * Cached for a minute: it is a bounded directory walk, the answer changes when someone installs a
 * tool, and the UI asks for it on every visit to the analytics tab.
 */
app.get('/api/agent-tools', async (c) => c.json({ tools: await cachedAgentTools() }))
// Recompute on demand. Bounded by the same wall-clock budget the warm uses, so a click cannot
// wedge the daemon on a store with thousands of transcripts in it.
app.post('/api/analytics/refresh', async (c) =>
  c.json(
    await refreshAnalytics(await ensureTranscriptIndex(), {
      budgetMs: boundedQueryInt(c.req.query('budgetMs'), 30_000, 120_000),
    }),
  ),
)
app.delete('/api/analytics', (c) => c.json({ ok: dropAnalytics(), ...analyticsCoverage() }))
