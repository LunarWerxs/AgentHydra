// server/src/routes/corch.ts — HTTP face of Corch (delegating work onto the owner's CLI accounts)
// and of quick add (signing a CLI account in from an email). See docs/CORCH.md "Routes".
// The Corch view, the Quick add row in the web app and the corch_* MCP tools are the callers. The
// MCP tools go through here too, never corch.ts directly: a stdio MCP server is its own process,
// and a second Corch there would relaunch the daemon's workers as if they had died.

import {
  corchCancel,
  corchGet,
  corchHandoff,
  corchJournal,
  corchJournalLines,
  corchList,
  corchRemove,
  corchRun,
  corchScorecard,
  corchSend,
  corchTotals,
  corchVerdict,
  corchWait,
} from '../corch'
import {
  cancelQuickAdd,
  listQuickAdds,
  reopenQuickAddWindow,
  startQuickAdd,
  submitQuickAddCode,
} from '../core/cli-quick-add'
import { app } from '../http-app'
import { CORCH_MAX_WAIT_S } from '../mcp-client'
import { jsonBody } from '../route-helpers'

const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const flag = (v: string | undefined): boolean => v === '1' || v === 'true'
const waitMs = (v: string | undefined): number =>
  Math.min(CORCH_MAX_WAIT_S, Math.max(0, Number(v) || 0)) * 1000
/** A whole number, 0 or more, or undefined. */
const optInt = (v: string | undefined): number | undefined => {
  const n = Math.floor(Number(v))
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : undefined
}

// --- Corch workers -----------------------------------------------------------
// `wait` (seconds, capped at CORCH_MAX_WAIT_S) holds the answer until the next status change in
// scope, for corch_status {wait_seconds}; without it the list answers at once. `limit` keeps every
// active worker and only that many recently finished ones; `brief=1` leaves out the prompt and all
// but the last 3 attempts (corch_status uses both; the Corch view reads the full list).
app.get('/api/corch/workers', async (c) => {
  const filter = {
    group: optStr(c.req.query('group')),
    id: optStr(c.req.query('id')),
    active: flag(c.req.query('active')) ? true : undefined,
    limit: optInt(c.req.query('limit')),
    brief: flag(c.req.query('brief')),
  }
  const wait = waitMs(c.req.query('wait'))
  if (wait > 0) return c.json(await corchWait(filter, wait))
  return c.json(corchList(filter))
})
// One worker's detail with its last 60 event lines; `wait` first waits for its next status change.
app.get('/api/corch/workers/:id', async (c) => {
  const id = c.req.param('id')
  const wait = waitMs(c.req.query('wait'))
  if (wait > 0 && corchGet(id)) await corchWait({ id }, wait)
  const worker = corchGet(id)
  return worker ? c.json(worker) : c.json({ error: 'worker not found' }, 404)
})
// The orchestration journal (corch-journal.ts), oldest first, the newest `limit` (default 100).
// `format=lines` answers readable one-line strings instead of the JSON entries (corch_log).
app.get('/api/corch/journal', (c) => {
  const filter = {
    group: optStr(c.req.query('group')),
    id: optStr(c.req.query('id')),
    since: optStr(c.req.query('since')),
    limit: optInt(c.req.query('limit')) || undefined,
  }
  return c.json(
    c.req.query('format') === 'lines' ? corchJournalLines(filter) : corchJournal(filter),
  )
})
// corchRun validates the tasks (cwd exists, prompt non-empty, perAccount 1..4) and throws on a bad
// one; that is the caller's mistake, so it answers 400 with the reason rather than a 500.
app.post('/api/corch/workers', async (c) => {
  const body = await jsonBody(c)
  if (!Array.isArray(body.tasks) || !body.tasks.length)
    return c.json({ error: 'tasks must be a non-empty array' }, 400)
  const accounts = Array.isArray(body.accounts)
    ? body.accounts.filter((a): a is string => typeof a === 'string')
    : undefined
  try {
    return c.json(
      corchRun({
        tasks: body.tasks as Parameters<typeof corchRun>[0]['tasks'],
        group: optStr(body.group),
        accounts,
        perAccount: typeof body.perAccount === 'number' ? body.perAccount : undefined,
        // Validated by corchRun (unknown values are refused with the valid ones listed).
        model: body.model as string | undefined,
        effort: body.effort as string | undefined,
        kind: body.kind as string | undefined,
      }),
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
app.post('/api/corch/workers/:id/send', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.text !== 'string' || !body.text.trim())
    return c.json({ error: 'text is required' }, 400)
  return c.json(
    corchSend(c.req.param('id'), body.text, {
      urgent: body.urgent === true,
      model: body.model as string | undefined,
      effort: body.effort as string | undefined,
    }),
  )
})
// A thumbs up or down on a finished task's result; a fail goes back to it one rung up the ladder.
app.post('/api/corch/workers/:id/verdict', async (c) => {
  const body = await jsonBody(c)
  const r = corchVerdict(c.req.param('id'), {
    verdict: body.verdict,
    note: body.note,
    retry: body.retry,
    kind: body.kind,
  })
  return c.json(r, r.ok ? 200 : 400)
})
// What works per kind of task, from every verdict (corch-scorecard.ts).
app.get('/api/corch/scorecard', (c) => c.json(corchScorecard()))
app.post('/api/corch/workers/:id/handoff', (c) => c.json(corchHandoff(c.req.param('id'))))
app.post('/api/corch/cancel', async (c) => {
  const body = await jsonBody(c)
  const id = optStr(body.id)
  const group = optStr(body.group)
  if (!id && !group) return c.json({ error: 'id or group is required' }, 400)
  return c.json(corchCancel({ id, group }))
})

// What Corch has offloaded, over every task on record: the Corch view's counter.
app.get('/api/corch/totals', (c) => c.json(corchTotals()))

// Remove finished tasks by id; their logs and transcripts move to corch/archive, never deleted.
app.post('/api/corch/remove', async (c) => {
  const body = await jsonBody(c)
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string')
    : []
  if (!ids.length) return c.json({ error: 'ids is required' }, 400)
  return c.json(corchRemove(ids))
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
