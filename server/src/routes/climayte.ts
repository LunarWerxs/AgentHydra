// server/src/routes/climayte.ts — HTTP face of CliMayte (delegating work onto the owner's CLI accounts)
// and of quick add (signing a CLI account in from an email). See docs/CLIMAYTE.md "Routes".
// The CliMayte view, the Quick add row in the web app and the climayte_* MCP tools are the callers. The
// MCP tools go through here too, never climayte.ts directly: a stdio MCP server is its own process,
// and a second CliMayte there would relaunch the daemon's workers as if they had died.

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  CliMayteSplitNeeded,
  climayteAdopt,
  climayteCancel,
  climayteCapacity,
  climayteDeliverNow,
  climayteGet,
  climayteHandoff,
  climayteJournal,
  climayteJournalLines,
  climayteList,
  climaytePingState,
  climayteRemove,
  climayteReports,
  climayteRun,
  climayteScorecard,
  climayteSend,
  climayteSetPriority,
  climayteTotals,
  climayteUnreadPings,
  climayteUnreadSessions,
  climayteVerdict,
  climayteVerdicts,
  climayteWait,
  climayteWave,
  climayteWaveResolve,
  climayteWaveStart,
  climayteWaves,
  climayteWaveVerify,
  verdictNoteTooLong,
} from '../climayte'
import type { CliMayteOrigin } from '../climayte-ping'
import { buildStatus, remoteSnapshots } from '../climayte-remote'
import { queueSharingOn } from '../core/cli-login-sync'
import {
  cancelQuickAdd,
  listQuickAdds,
  reopenQuickAddWindow,
  startQuickAdd,
  submitQuickAddCode,
} from '../core/cli-quick-add'
import { ownBuild } from '../core/own-build'
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The dispatching chat the MCP tool resolved from its caller binding (mcp-self.ts callerOrigin),
 *  checked before anything is pinged at it: a session id that is a UUID, a Claude home that is an
 *  absolute folder on this machine. The tool never forwards an origin from its client's arguments;
 *  a body without one is simply not pinged. */
function chatOrigin(v: unknown): { origin: CliMayteOrigin | undefined; why: string | null } {
  if (v === undefined || v === null) return { origin: undefined, why: null }
  const o = v as Record<string, unknown>
  if (o.kind !== 'chat') return { origin: undefined, why: 'origin refused: kind must be chat' }
  if (typeof o.sessionId !== 'string' || !UUID.test(o.sessionId))
    return { origin: undefined, why: 'origin refused: sessionId is not a session id' }
  if (typeof o.home !== 'string' || !isAbsolute(o.home) || !existsSync(o.home))
    return { origin: undefined, why: 'origin refused: home is not a folder on this machine' }
  const transcript = typeof o.transcript === 'string' && o.transcript ? o.transcript : null
  const how = typeof o.how === 'string' ? o.how.slice(0, 300) : ''
  return {
    origin: { kind: 'chat', sessionId: o.sessionId, home: o.home, transcript, how },
    why: null,
  }
}

/** What a dispatch answers about its pings: on (to a chat, or to the worker that dispatched it),
 *  or off and why. */
function pingReply(
  origin: CliMayteOrigin | undefined,
  refused: string | null,
): { on: true; to?: string } | { on: false; why: string } {
  if (!origin) return { on: false, why: refused ?? 'no origin was sent' }
  const state = climaytePingState()
  if (!state.on) return state
  return origin.kind === 'worker' ? { on: true, to: origin.workerId } : { on: true }
}

// --- CliMayte workers -----------------------------------------------------------
// `wait` (seconds, capped at CLIMAYTE_MAX_WAIT_S) holds the answer until the next status change in
// scope, for climayte_status {wait_seconds}; without it the list answers at once. `limit` keeps every
// active worker and only that many recently finished ones; `brief=1` leaves out the prompt and all
// but the last 3 attempts (climayte_status uses both; the CliMayte view reads the full list).
// `report=1` answers the report view instead (toReport: status, verdict, what it used, `chars` of its
// report, default 1500); `ids` (comma-separated) keeps only those workers.
app.get('/api/corch/workers', async (c) => {
  const ids = optStr(c.req.query('ids'))
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const filter = {
    group: optStr(c.req.query('group')),
    id: optStr(c.req.query('id')),
    ids: ids?.length ? ids : undefined,
    active: flag(c.req.query('active')) ? true : undefined,
    limit: optInt(c.req.query('limit')),
    brief: flag(c.req.query('brief')),
    all: flag(c.req.query('all')),
  }
  const wait = waitMs(c.req.query('wait'))
  if (flag(c.req.query('report'))) {
    if (wait > 0) await climayteWait(filter, wait)
    return c.json(climayteReports(filter, optInt(c.req.query('chars'))))
  }
  if (wait > 0) return c.json(await climayteWait(filter, wait))
  return c.json(climayteList(filter))
})
// The other PC's CliMayte queue, as it last shared it through the login sync (core/climayte-queue-sync.ts):
// shown apart, never part of /api/corch/workers. `stale`: that PC was not seen (its snapshot or
// its polls of the store) for over 20 minutes.
app.get('/api/corch/remote', (c) => {
  const enabled = queueSharingOn()
  const pcs = enabled
    ? remoteSnapshots().map(({ pc, name, at, stale, workers, jobs, build }) => ({
        pc,
        name,
        at,
        stale,
        workers,
        jobs: jobs ?? [],
        ...buildStatus(name, build, ownBuild()),
      }))
    : []
  return c.json({ enabled, pcs })
})
// One worker's detail with its last 60 event lines; `wait` first waits for its next status change.
// `prompt=full` answers the whole brief, not its first 300 characters.
app.get('/api/corch/workers/:id', async (c) => {
  const id = c.req.param('id')
  const wait = waitMs(c.req.query('wait'))
  if (wait > 0 && climayteGet(id)) await climayteWait({ id }, wait)
  const worker = climayteGet(id, { fullPrompt: c.req.query('prompt') === 'full' })
  return worker ? c.json(worker) : c.json({ error: 'worker not found' }, 404)
})
// The orchestration journal (climayte-journal.ts), oldest first, the newest `limit` (default 100).
// `format=lines` answers readable one-line strings instead of the JSON entries (climayte_log).
app.get('/api/corch/journal', (c) => {
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
app.post('/api/corch/workers', async (c) => {
  const body = await jsonBody(c)
  if (!Array.isArray(body.tasks) || !body.tasks.length)
    return c.json({ error: 'tasks must be a non-empty array' }, 400)
  // A malformed list is refused, never trimmed: dropping the refs it cannot read used to leave an
  // empty list, which means "any account" (fuzz, 2026-10-02).
  if (
    body.accounts !== undefined &&
    (!Array.isArray(body.accounts) || body.accounts.some((a) => typeof a !== 'string'))
  )
    return c.json({ error: 'accounts must be a list of CLI instance ids' }, 400)
  const accounts = body.accounts as string[] | undefined
  // The MCP tool's spelling is per_account; either reaches the 1..4 check.
  const cap = body.perAccount ?? body.per_account
  // per_account as a hard cap (never spills); either spelling, a boolean or nothing.
  const strict = body.perAccountStrict ?? body.per_account_strict
  if (strict !== undefined && typeof strict !== 'boolean')
    return c.json({ error: 'perAccountStrict must be true or false' }, 400)
  const { origin, why } = chatOrigin(body.origin)
  try {
    const reply = climayteRun({
      tasks: body.tasks as Parameters<typeof climayteRun>[0]['tasks'],
      group: optStr(body.group),
      accounts,
      perAccount: cap === undefined ? undefined : Number(cap),
      perAccountStrict: strict,
      // Validated by climayteRun (unknown values are refused with the valid ones listed).
      model: body.model as string | undefined,
      effort: body.effort as string | undefined,
      // Holds a named model or effort; without it the pick is auto (runSetting).
      modelWhy: optStr(body.modelWhy),
      kind: body.kind as string | undefined,
      priority: body.priority as number | undefined,
      size: body.size as string | undefined,
      // A repeat of this group's dispatch from the last minutes answers with the workers it made
      // (field note 62); `copies: true` makes new ones anyway.
      copies: body.copies === true,
      origin,
    })
    // The origin as stored: a chat that is itself a CliMayte worker became that worker.
    const made = reply.workers.find((w) => !w.repeat)
    const stored = made ? (climayteGet(made.id) as { origin?: CliMayteOrigin } | null) : null
    return c.json({ ...reply, ping: pingReply(stored?.origin ?? origin, why) })
  } catch (err) {
    // Too big for one window (climayte sizeTasks): nothing started, and the pieces it needs.
    if (err instanceof CliMayteSplitNeeded)
      return c.json({ error: err.message, splitNeeded: err.tasks }, 409)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
app.post('/api/corch/workers/:id/send', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.text !== 'string' || !body.text.trim())
    return c.json({ error: 'text is required' }, 400)
  if (body.cwd !== undefined && typeof body.cwd !== 'string')
    return c.json({ error: 'cwd must be a folder path' }, 400)
  const r = climayteSend(c.req.param('id'), body.text, {
    urgent: body.urgent === true,
    model: body.model as string | undefined,
    effort: body.effort as string | undefined,
    cwd: body.cwd as string | undefined,
  })
  return c.json(r, r.ok || !body.cwd ? 200 : 400)
})
// Send now on a held message (Hydra Desk 2): the running turn stops and the same session continues
// with that message first. `text` names which held message; without it, the oldest.
app.post('/api/corch/workers/:id/deliver-now', async (c) => {
  const body = await jsonBody(c)
  if (body.text !== undefined && typeof body.text !== 'string')
    return c.json({ error: 'text must be a string' }, 400)
  return c.json(climayteDeliverNow(c.req.param('id'), body.text as string | undefined))
})
// A task's priority: queued and waiting work starts highest first (climayte_priority).
app.post('/api/corch/workers/:id/priority', async (c) => {
  const body = await jsonBody(c)
  const r = climayteSetPriority(c.req.param('id'), body.priority)
  return c.json(r, r.ok ? 200 : 400)
})
// A thumbs up or down on a finished task's result; a fail goes back to it one rung up the ladder.
app.post('/api/corch/workers/:id/verdict', async (c) => {
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
// The same verdict for several finished workers in one call; each id answers on its own.
app.post('/api/corch/verdicts', async (c) => {
  const body = await jsonBody(c)
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string')
    : []
  if (!ids.length) return c.json({ error: 'ids is required' }, 400)
  const tooLong = verdictNoteTooLong(body.note)
  if (tooLong) return c.json({ error: tooLong }, 400)
  return c.json(
    climayteVerdicts(ids, {
      verdict: body.verdict,
      note: body.note,
      retry: body.retry,
      kind: body.kind,
      by: body.by === 'owner' ? 'owner' : 'orchestrator',
    }),
  )
})
// --- waves (the CLIManager, docs/CLIMAYTE.md "Manager") --------------------------------
// A refused wave (under 3 tasks, a manage task, a repeated key, an unknown `after`) is the caller's
// mistake: 400 with the reason, nothing started.
app.post('/api/corch/waves', async (c) => {
  const body = await jsonBody(c)
  const { origin, why } = chatOrigin(body.origin)
  try {
    const reply = climayteWaveStart({
      plan: body.plan,
      cwd: body.cwd,
      tasks: body.tasks,
      verify: body.verify,
      branch: body.branch,
      maxRounds: body.max_rounds ?? body.maxRounds,
      origin,
    })
    const stored = climayteGet(reply.managerId) as { origin?: CliMayteOrigin } | null
    return c.json({ ...reply, ping: pingReply(stored?.origin ?? origin, why) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
app.get('/api/corch/waves', (c) => c.json({ waves: climayteWaves() }))
app.get('/api/corch/waves/:id', (c) => {
  const wave = climayteWave(c.req.param('id'))
  return wave ? c.json(wave) : c.json({ error: 'wave not found' }, 404)
})
app.post('/api/corch/waves/:id/verify', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.ok !== 'boolean') return c.json({ error: 'ok (true or false) is required' }, 400)
  const r = climayteWaveVerify(c.req.param('id'), { ok: body.ok, note: body.note })
  return c.json({ ok: r.ok, message: r.message }, r.status as 200 | 404 | 409)
})
app.post('/api/corch/waves/:id/tasks/:key/resolve', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.ok !== 'boolean') return c.json({ error: 'ok (true or false) is required' }, 400)
  const r = climayteWaveResolve(c.req.param('id'), c.req.param('key'), {
    ok: body.ok,
    note: body.note,
  })
  return c.json({ ok: r.ok, message: r.message }, r.status as 200 | 400 | 404 | 409)
})
// What works per kind of task, from every verdict (climayte-scorecard.ts).
// --- pings to the dispatching chat (climayte-ping.ts) -----------------------------------
// climayte_status {group, ping: true}: the caller becomes the origin of the group's live workers
// that have none (work dispatched before origins, or by an untraced caller).
app.post('/api/corch/adopt', async (c) => {
  const body = await jsonBody(c)
  const group = optStr(body.group)
  if (!group) return c.json({ error: 'group is required' }, 400)
  const { origin, why } = chatOrigin(body.origin)
  if (!origin) return c.json({ error: why ?? 'origin is required' }, 400)
  const r = climayteAdopt(group, origin)
  return c.json({ ...r, ping: pingReply(r.origin, null) })
})
// Which chats hold pings no channel delivered; POST .../read answers one chat's and marks them read.
app.get('/api/corch/pings', (c) => c.json({ unread: climayteUnreadSessions() }))
app.post('/api/corch/pings/read', async (c) => {
  const body = await jsonBody(c)
  const sid = optStr(body.sessionId)
  if (!sid) return c.json({ error: 'sessionId is required' }, 400)
  return c.json(climayteUnreadPings(sid))
})
app.get('/api/corch/scorecard', (c) => c.json(climayteScorecard()))
app.post('/api/corch/workers/:id/handoff', (c) => c.json(climayteHandoff(c.req.param('id'))))
app.post('/api/corch/cancel', async (c) => {
  const body = await jsonBody(c)
  const id = optStr(body.id)
  const group = optStr(body.group)
  if (!id && !group) return c.json({ error: 'id or group is required' }, 400)
  return c.json(climayteCancel({ id, group }))
})

// What CliMayte has offloaded, over every task on record: the CliMayte view's counter.
// `since` (ISO or epoch ms) scopes the test metrics (limit hits, peaks, sizing) to a run.
// How many CLI accounts sit idle with room (climayteCapacity); the MCP quota checks quote it.
app.get('/api/corch/capacity', (c) => c.json(climayteCapacity()))

app.get('/api/corch/totals', (c) => {
  const raw = c.req.query('since')
  const since = raw ? (/^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)) : 0
  if (raw && !Number.isFinite(since))
    return c.json({ error: 'since must be an ISO time or epoch ms' }, 400)
  return c.json(climayteTotals(since))
})

// Remove finished tasks by id; their logs and transcripts move to corch/archive, never deleted.
app.post('/api/corch/remove', async (c) => {
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
