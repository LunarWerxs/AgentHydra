// The orchestrator: GET /api/diagnostics/orchestrator lists every open chat and outside session (a Claude Desktop,
// CLI, CliMayte or Codex session AgentHydra knows) active in the last `?days=` days (3 by default) with the one move
// the orchestrator would make next and why; `?ask=1` also asks the CreAitor, when this machine has it, what the owner
// would answer each one that waits on a question. Phase A, shadow: that is all it does. Phase B: POST the same path
// { armed: true } and, until it is disarmed or Desk stops, it looks at Desk's own chats every TICK_MS and continues
// the ones a limit or an error stopped (orchestrator/act.ts) through Desk's send queue. It never starts armed (owner,
// 2026-09-07: nothing starts on boot) and never acts blind: no read of Desk's chats, no act. Own page only.
// README "What Desk 2 adds", the orchestrator.

import type { Hono } from 'hono'
import type { ChatSummary, ExternalSession, TranscriptItem } from '@shared/protocol'
import type { OrchestratorAct, OrchestratorArm, OrchestratorPlan, OrchestratorRow } from '@shared/orchestrator'
import type { ServerContext } from '../context'
import { DIAGNOSTICS_API } from '../engine/diagnostics'
import { afterGivingUp, decide, type Act } from '../orchestrator/act'
import { askCreaitor, creaitorTool } from '../orchestrator/creaitor'
import { classify, fromChat, fromExternal, rank } from '../orchestrator/plan'
import { notOwnPage } from '../own-page'

const WHAT = "the orchestrator's plan"
/** At most this many chats and outside sessions are read per plan, the most recently active first. */
const MAX_CHATS = 100
/** CreAitor asks run this many at once. */
const ASK_WIDTH = 4
/** Bun closes a request that sends nothing for 10 s, and one ask may take a minute: while the CreAitor answers, the
 *  reply sends a space this often ahead of its JSON, which JSON allows. */
const KEEPALIVE_MS = 4_000
const DEFAULT_DAYS = 3
/** How often the armed orchestrator looks at Desk's chats. */
const TICK_MS = 60_000
/** Acts kept for the page. */
const ACTS_KEPT = 50

/** A JSON reply whose body is still being worked out, kept open with a space every KEEPALIVE_MS. */
function slowJson(work: Promise<unknown>): Response {
  const enc = new TextEncoder()
  let tick: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(out) {
      tick = setInterval(() => out.enqueue(enc.encode(' ')), KEEPALIVE_MS)
      return work.then(
        (value) => {
          clearInterval(tick)
          out.enqueue(enc.encode(JSON.stringify(value)))
          out.close()
        },
        (err: unknown) => {
          clearInterval(tick)
          out.error(err)
        }
      )
    },
    cancel() {
      clearInterval(tick)
    }
  })
  return new Response(body, { headers: { 'content-type': 'application/json; charset=UTF-8' } })
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  let armed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<void> | null = null
  /** Chat id -> continues sent since its last good turn (act.ts decide). */
  const tries = new Map<string, number>()
  const acts: OrchestratorAct[] = []

  async function get<T>(path: string): Promise<T | null> {
    const res = await app.request(path)
    return res.ok ? ((await res.json()) as T) : null
  }

  /** null when the route took it, else why not. */
  async function post(path: string, body?: unknown): Promise<string | null> {
    const res = await app.request(path, body === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) return null
    const answer = (await res.json().catch(() => null)) as { error?: unknown } | null
    return typeof answer?.error === 'string' ? answer.error : `${path} answered ${res.status}`
  }

  /** Each open chat's row (with `outside`, each outside session's too), the most recently active first, and each
   *  one's Claude session. `blind` when Desk's own chats could not be read. */
  async function read(days: number, outside: boolean): Promise<{ rows: OrchestratorRow[]; session: Map<string, string | null>; blind: boolean }> {
    const now = Date.now()
    const [own, others] = await Promise.all([get<ChatSummary[]>('/api/chats'), outside ? get<ExternalSession[]>('/api/external/sessions') : null])
    const subjects = [
      ...(own ?? []).filter((ch) => !ch.archived).map((ch) => ({ s: fromChat(ch), items: `/api/chats/${encodeURIComponent(ch.id)}/items` })),
      ...(others ?? []).filter((x) => !x.archived && x.status !== 'stale').map((x) => ({ s: fromExternal(x), items: `/api/external/sessions/${encodeURIComponent(x.id)}/items` }))
    ]
      .filter(({ s }) => now - s.updatedAt < days * 86_400_000)
      .sort((a, b) => b.s.updatedAt - a.s.updatedAt)
      .slice(0, MAX_CHATS)
    const rows: OrchestratorRow[] = []
    for (const { s, items } of subjects) {
      const busy = s.status === 'working' || s.status === 'starting'
      rows.push(classify(s, busy ? null : await get<TranscriptItem[]>(items), now))
    }
    return { rows, session: new Map(subjects.map(({ s }) => [s.id, s.session])), blind: own === null }
  }

  /** The plan as the page shows it: a chat the orchestrator gave up on reads as left to a person. Only the shown
   *  rows say so; the tick decides on the chat's own move, or the given-up chat would count as a good turn. */
  function plan(read: OrchestratorRow[], days: number): OrchestratorPlan {
    const rows = read.map((r) => afterGivingUp(r, tries))
    const counts: OrchestratorPlan['counts'] = {}
    for (const r of rows) counts[r.move] = (counts[r.move] ?? 0) + 1
    return { at: Date.now(), mode: armed ? 'armed' : 'shadow', days, creaitor: creaitorTool() !== null, rows: rank(rows), counts, acts: [...acts] }
  }

  async function carry(a: Act): Promise<OrchestratorAct> {
    const base = { at: Date.now(), id: a.row.id, title: a.row.title, move: a.row.move }
    if (a.kind === 'give-up') return { ...base, did: 'gave-up' }
    const id = encodeURIComponent(a.row.id)
    const error = (await post('/api/queue', { kind: 'message', chatId: a.row.id, text: a.text })) ?? (a.release ? await post(`/api/queue/chats/${id}/resume`) : null)
    return error ? { ...base, did: 'continued', error } : { ...base, did: 'continued' }
  }

  /** One look at Desk's chats while armed; never two at once. */
  function tick(): Promise<void> {
    ticking ??= (async () => {
      const { rows, blind } = await read(DEFAULT_DAYS, false)
      if (!armed || blind) return
      for (const a of decide(rows, tries)) acts.unshift(await carry(a))
      acts.splice(ACTS_KEPT)
    })()
      .catch((err: unknown) => console.error('[orchestrator] tick failed:', err))
      .finally(() => (ticking = null))
    return ticking
  }

  function arm(on: boolean): void {
    armed = on
    clearInterval(timer)
    timer = on ? setInterval(() => void tick(), TICK_MS) : undefined
  }
  ctx.onStop(() => arm(false))

  app.get(`${DIAGNOSTICS_API}/orchestrator`, async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const days = Math.min(30, Math.max(1, Number(c.req.query('days')) || DEFAULT_DAYS))
    const { rows, session } = await read(days, true)
    const result = plan(rows, days)
    const tool = creaitorTool()
    const asking = tool && c.req.query('ask') === '1' ? rows.filter((r) => r.question) : []
    if (!tool || !asking.length) return c.json(result)
    return slowJson(
      (async () => {
        for (let i = 0; i < asking.length; i += ASK_WIDTH)
          await Promise.all(asking.slice(i, i + ASK_WIDTH).map(async (r) => (r.creaitor = await askCreaitor(tool, r.question ?? '', r.options ?? [], r.cwd, session.get(r.id) ?? null))))
        return result
      })()
    )
  })

  // Arm or disarm. Arming looks once at once, so the reply already holds what it did.
  app.post(`${DIAGNOSTICS_API}/orchestrator`, async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const body = (await c.req.json().catch(() => null)) as Partial<OrchestratorArm> | null
    if (typeof body?.armed !== 'boolean') return c.json({ error: 'the body must be JSON: { "armed": true | false }' }, 400)
    arm(body.armed)
    if (armed) await tick()
    const { rows } = await read(DEFAULT_DAYS, true)
    return c.json(plan(rows, DEFAULT_DAYS))
  })
}
