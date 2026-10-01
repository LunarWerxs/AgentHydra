// server/src/routes/climayte.ts — HTTP face of CliMayte (delegating work onto the owner's CLI accounts)
// and of quick add (signing a CLI account in from an email). See docs/CLIMAYTE.md "Routes".
// The CliMayte view, the Quick add row in the web app and the climayte_* MCP tools are the callers. The
// MCP tools go through here too, never climayte.ts directly: a stdio MCP server is its own process,
// and a second CliMayte there would relaunch the daemon's workers as if they had died.

import {
  climayteCancel,
  climayteGet,
  climayteHandoff,
  climayteJournal,
  climayteJournalLines,
  climayteList,
  climayteRemove,
  climayteRun,
  climayteScorecard,
  climayteSend,
  climayteSetPriority,
  climayteTotals,
  climayteVerdict,
  climayteWait,
} from '../climayte'
import {
  cancelQuickAdd,
  listQuickAdds,
  reopenQuickAddWindow,
  startQuickAdd,
  submitQuickAddCode,
} from '../core/cli-quick-add'
import { app } from '../http-app'
import { CLIMAYTE_MAX_WAIT_S } from '../mcp-client'
import { jsonBody } from '../route-helpers'

const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const flag = (v: string | undefined): boolean => v === '1' || v === 'true'
const waitMs = (v: string | undefined): number =>
  Math.min(CLIMAYTE_MAX_WAIT_S, Math.max(0, Number(v) || 0)) * 1000
/** A whole number, 0 or more, or undefined. */
const optInt = (v: string | undefined): number | undefined => {
  const n = Math.floor(Number(v))
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : undefined
}

// --- CliMayte workers -----------------------------------------------------------
// `wait` (seconds, capped at CLIMAYTE_MAX_WAIT_S) holds the answer until the next status change in
// scope, for climayte_status {wait_seconds}; without it the list answers at once. `limit` keeps every
// active worker and only that many recently finished ones; `brief=1` leaves out the prompt and all
// but the last 3 attempts (climayte_status uses both; the CliMayte view reads the full list).
app.get('/api/climayte/workers', async (c) => {
  const filter = {
    group: optStr(c.req.query('group')),
    id: optStr(c.req.query('id')),
    active: flag(c.req.query('active')) ? true : undefined,
    limit: optInt(c.req.query('limit')),
    brief: flag(c.req.query('brief')),
  }
  const wait = waitMs(c.req.query('wait'))
  if (wait > 0) return c.json(await climayteWait(filter, wait))
  return c.json(climayteList(filter))
})
// One worker's detail with its last 60 event lines; `wait` first waits for its next status change.
app.get('/api/climayte/workers/:id', async (c) => {
  const id = c.req.param('id')
  const wait = waitMs(c.req.query('wait'))
  if (wait > 0 && climayteGet(id)) await climayteWait({ id }, wait)
  const worker = climayteGet(id)
  return worker ? c.json(worker) : c.json({ error: 'worker not found' }, 404)
})
// The orchestration journal (climayte-journal.ts), oldest first, the newest `limit` (default 100).
// `format=lines` answers readable one-line strings instead of the JSON entries (climayte_log).
app.get('/api/climayte/journal', (c) => {
  const filter = {
    group: optStr(c.req.query('group')),
    id: optStr(c.req.query('id')),
    since: optStr(c.req.query('since')),
    limit: optInt(c.req.query('limit')) || undefined,
  }
  return c.json(
    c.req.query('format') === 'lines' ? climayteJournalLines(filter) : climayteJournal(filter),
  )
})
// climayteRun validates the tasks (cwd exists, prompt non-empty, perAccount 1..4) and throws on a bad
// one; that is the caller's mistake, so it answers 400 with the reason rather than a 500.
app.post('/api/climayte/workers', async (c) => {
  const body = await jsonBody(c)
  if (!Array.isArray(body.tasks) || !body.tasks.length)
    return c.json({ error: 'tasks must be a non-empty array' }, 400)
  const accounts = Array.isArray(body.accounts)
    ? body.accounts.filter((a): a is string => typeof a === 'string')
    : undefined
  try {
    return c.json(
      climayteRun({
        tasks: body.tasks as Parameters<typeof climayteRun>[0]['tasks'],
        group: optStr(body.group),
        accounts,
        perAccount: typeof body.perAccount === 'number' ? body.perAccount : undefined,
        // Validated by climayteRun (unknown values are refused with the valid ones listed).
        model: body.model as string | undefined,
        effort: body.effort as string | undefined,
        kind: body.kind as string | undefined,
        priority: body.priority as number | undefined,
      }),
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
app.post('/api/climayte/workers/:id/send', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.text !== 'string' || !body.text.trim())
    return c.json({ error: 'text is required' }, 400)
  return c.json(
    climayteSend(c.req.param('id'), body.text, {
      urgent: body.urgent === true,
      model: body.model as string | undefined,
      effort: body.effort as string | undefined,
    }),
  )
})
// A task's priority: queued and waiting work starts highest first (climayte_priority).
app.post('/api/climayte/workers/:id/priority', async (c) => {
  const body = await jsonBody(c)
  const r = climayteSetPriority(c.req.param('id'), body.priority)
  return c.json(r, r.ok ? 200 : 400)
})
// A thumbs up or down on a finished task's result; a fail goes back to it one rung up the ladder.
app.post('/api/climayte/workers/:id/verdict', async (c) => {
  const body = await jsonBody(c)
  const r = climayteVerdict(c.req.param('id'), {
    verdict: body.verdict,
    note: body.note,
    retry: body.retry,
    kind: body.kind,
    // Only the view says 'owner'; a check's verdict never comes over HTTP.
    by: body.by === 'owner' ? 'owner' : 'orchestrator',
  })
  return c.json(r, r.ok ? 200 : 400)
})
// What works per kind of task, from every verdict (climayte-scorecard.ts).
app.get('/api/climayte/scorecard', (c) => c.json(climayteScorecard()))
app.post('/api/climayte/workers/:id/handoff', (c) => c.json(climayteHandoff(c.req.param('id'))))
app.post('/api/climayte/cancel', async (c) => {
  const body = await jsonBody(c)
  const id = optStr(body.id)
  const group = optStr(body.group)
  if (!id && !group) return c.json({ error: 'id or group is required' }, 400)
  return c.json(climayteCancel({ id, group }))
})

// What CliMayte has offloaded, over every task on record: the CliMayte view's counter.
app.get('/api/climayte/totals', (c) => c.json(climayteTotals()))

// Remove finished tasks by id; their logs and transcripts move to corch/archive, never deleted.
app.post('/api/climayte/remove', async (c) => {
  const body = await jsonBody(c)
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string')
    : []
  if (!ids.length) return c.json({ error: 'ids is required' }, 400)
  return c.json(climayteRemove(ids))
})

// --- quick add ---------------------------------------------------------------
app.post('/api/cli-instances/quick-add', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.email !== 'string') return c.json({ error: 'email is required' }, 400)
  const flow = startQuickAdd(
    body.email,
    typeof body.instanceId === 'string' ? body.instanceId : undefined,
  )
  return 'error' in flow ? c.json(flow, 400) : c.json(flow)
})
app.get('/api/cli-instances/quick-add', (c) => c.json(listQuickAdds()))
app.post('/api/cli-instances/quick-add/:id/code', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.code !== 'string') return c.json({ error: 'code is required' }, 400)
  return c.json(submitQuickAddCode(c.req.param('id'), body.code))
})
// Open the throwaway sign-in window again after the person closed it (core/signin-window.ts).
app.post('/api/cli-instances/quick-add/:id/window', (c) =>
  c.json(reopenQuickAddWindow(c.req.param('id'))),
)
app.post('/api/cli-instances/quick-add/:id/cancel', (c) =>
  c.json(cancelQuickAdd(c.req.param('id'))),
)
