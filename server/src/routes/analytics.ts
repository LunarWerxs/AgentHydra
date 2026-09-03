import { type AgentPresence, detectAgentTools } from '../agent-catalog'
import {
  activityReport,
  analyticsCoverage,
  concurrencyReport,
  dropAnalytics,
  recentEdits,
  refreshAnalytics,
  spendReport,
} from '../analytics'
import { app } from '../http-app'
import { boundedQueryInt } from '../route-helpers'
import { listTranscriptFiles } from '../transcript'
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
const AGENT_TOOLS_TTL_MS = 60_000
function cachedAgentTools(): AgentPresence[] {
  const now = Date.now()
  if (agentToolsCache && now - agentToolsCache.at < AGENT_TOOLS_TTL_MS) return agentToolsCache.tools
  const tools = detectAgentTools()
  agentToolsCache = { at: now, tools }
  return tools
}

app.get('/api/analytics/spend', (c) => c.json(spendReport({ sinceMs: analyticsPeriod(c) })))
app.get('/api/analytics/activity', (c) => c.json(activityReport({ sinceMs: analyticsPeriod(c) })))
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
/**
 * Which coding agents are installed on this machine (server/src/agent-catalog.ts).
 *
 * Cached for a minute: it is a bounded directory walk, the answer changes when someone installs a
 * tool, and the UI asks for it on every visit to the analytics tab.
 */
app.get('/api/agent-tools', (c) => c.json({ tools: cachedAgentTools() }))
// Recompute on demand. Bounded by the same wall-clock budget the warm uses, so a click cannot
// wedge the daemon on a store with thousands of transcripts in it.
app.post('/api/analytics/refresh', async (c) =>
  c.json(
    await refreshAnalytics(listTranscriptFiles(), {
      budgetMs: boundedQueryInt(c.req.query('budgetMs'), 30_000, 120_000),
    }),
  ),
)
app.delete('/api/analytics', (c) => c.json({ ok: dropAnalytics(), ...analyticsCoverage() }))
