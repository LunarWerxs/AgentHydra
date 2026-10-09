// The orchestrator: GET /api/diagnostics/orchestrator lists every open chat and outside session (a Claude Desktop,
// CLI, CliMayte or Codex session AgentHydra knows) active in the last `?days=` days (3 by default) with the one move
// the orchestrator would make next and why; `?ask=1` also asks the CreAitor, when this machine has it, what the owner
// would answer each one that waits on a question. Phase A, shadow: that is all it does. Phase B, armed: the
// `orchestrator` setting (Settings > General, beside the babysitter's switch; or POST the same path { armed }), off by
// default and kept until it is turned off (owner, 2026-10-09: "I may not always want the foreman on ... but sometimes I
// might want it on"). Armed, it looks every TICK_MS: it continues Desk chats an error stopped (orchestrator/act.ts)
// through Desk's send queue, and its foreman peeks at each running chat every PEEK_MS and sends a check-in note to one
// that keeps failing the same step or hangs on a call (orchestrator/foreman.ts). A usage limit's stop is the
// babysitter's (plugins/72-babysitter.ts). It never acts blind: no read of Desk's chats, no act. Own page only.
// README "What Desk 2 adds", the orchestrator.

import type { Hono } from 'hono'
import type { ChatSummary, ExternalSession, QueueState, TranscriptItem } from '@shared/protocol'
import type { OrchestratorAct, OrchestratorArm, OrchestratorPlan, OrchestratorRow } from '@shared/orchestrator'
import type { ServerContext } from '../context'
import { DIAGNOSTICS_API } from '../engine/diagnostics'
import { afterGivingUp, decide, type Act } from '../orchestrator/act'
import { askCreaitor, creaitorTool } from '../orchestrator/creaitor'
import { NOTES_PER_HOUR, noteText, PEEK_MS, peek, personRecent, type Peek } from '../orchestrator/foreman'
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

/** What the foreman last saw in one running chat, and the notes it sent there. */
interface Peeked {
  at: number
  seen: Peek
  /** Episodes (Peek key) already noted or flagged: one each. */
  done: string[]
  /** When each note went, for NOTES_PER_HOUR. */
  notes: number[]
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  let stopped = false
  const armed = (): boolean => !stopped && ctx.settings().orchestrator === true
  let ticking: Promise<void> | null = null
  /** Chat id -> continues sent since its last good turn (act.ts decide). */
  const tries = new Map<string, number>()
  const acts: OrchestratorAct[] = []
  /** Running chat id -> the foreman's last peek. */
  const peeked = new Map<string, Peeked>()

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
   *  one's Claude session. `blind` when Desk's own chats could not be read; `unread`, the chats whose transcript
   *  could not be (each is classified as if it were empty, which is fine to show and never enough to act on). */
  async function read(
    days: number,
    outside: boolean
  ): Promise<{ rows: OrchestratorRow[]; session: Map<string, string | null>; blind: boolean; unread: Set<string> }> {
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
    const unread = new Set<string>()
    for (const { s, items } of subjects) {
      const busy = s.status === 'working' || s.status === 'starting'
      const got = busy ? null : await get<TranscriptItem[]>(items)
      if (!busy && got === null) unread.add(s.id)
      rows.push(classify(s, got, now))
    }
    return { rows, session: new Map(subjects.map(({ s }) => [s.id, s.session])), blind: own === null, unread }
  }

  /** The plan as the page shows it: a chat the orchestrator gave up on reads as left to a person. Only the shown
   *  rows say so; the tick decides on the chat's own move, or the given-up chat would count as a good turn. */
  function plan(read: OrchestratorRow[], days: number): OrchestratorPlan {
    const now = Date.now()
    const rows = read.map((r) => {
      const row = afterGivingUp(r, tries)
      // A running chat the foreman found wrong in its last peek says so beside its activity.
      const p = peeked.get(row.id)
      return row.move === 'watch' && p && p.seen.kind !== 'ok' && now - p.at < 2 * PEEK_MS ? { ...row, reason: `${row.reason}; the foreman saw: ${p.seen.detail}` } : row
    })
    const counts: OrchestratorPlan['counts'] = {}
    for (const r of rows) counts[r.move] = (counts[r.move] ?? 0) + 1
    return { at: now, mode: armed() ? 'armed' : 'shadow', days, creaitor: creaitorTool() !== null, rows: rank(rows), counts, acts: [...acts] }
  }

  async function carry(a: Act): Promise<OrchestratorAct> {
    const base = { at: Date.now(), id: a.row.id, title: a.row.title, move: a.row.move }
    if (a.kind === 'give-up') return { ...base, did: 'gave-up' }
    const id = encodeURIComponent(a.row.id)
    const error = (await post('/api/queue', { kind: 'message', chatId: a.row.id, text: a.text })) ?? (a.release ? await post(`/api/queue/chats/${id}/resume`) : null)
    return error ? { ...base, did: 'continued', error } : { ...base, did: 'continued' }
  }

  /** The foreman's round: each running Desk chat and Claude Desktop session not peeked at in PEEK_MS is read and judged
   *  (foreman.ts peek); a spinning or hung one gets one note per episode, at most NOTES_PER_HOUR an hour, never while a
   *  person wrote in it in the last 10 minutes; a stalled Desk chat is flagged on the page only. A disarm part-way
   *  through stops it before its next send. */
  async function rounds(): Promise<void> {
    const now = Date.now()
    const [own, others] = await Promise.all([get<ChatSummary[]>('/api/chats'), get<ExternalSession[]>('/api/external/sessions')])
    const running = [
      ...(own ?? []).filter((ch) => !ch.archived && ch.status === 'working').map((ch) => ({ id: ch.id, title: ch.title, source: 'desk' as const })),
      ...(others ?? []).filter((x) => !x.archived && !x.fromPc && x.source === 'desktop' && x.status === 'working').map((x) => ({ id: x.id, title: x.title, source: 'desktop' as const }))
    ]
    const live = new Set(running.map((r) => r.id))
    for (const id of peeked.keys()) if (!live.has(id) && now - (peeked.get(id)?.at ?? 0) > 86_400_000) peeked.delete(id)
    for (const r of running) {
      const before = peeked.get(r.id)
      if (before && now - before.at < PEEK_MS) continue
      const id = encodeURIComponent(r.id)
      const items = await get<TranscriptItem[]>(r.source === 'desk' ? `/api/chats/${id}/items` : `/api/external/sessions/${id}/items`)
      if (!items) continue
      const seen = peek(items, now, r.source === 'desk')
      const p: Peeked = { at: now, seen, done: before?.done ?? [], notes: (before?.notes ?? []).filter((t) => now - t < 3_600_000) }
      peeked.set(r.id, p)
      if (seen.kind === 'ok' || p.done.includes(seen.key)) continue
      const base = { at: now, id: r.id, title: r.title, move: 'watch' as const, source: r.source, detail: seen.detail }
      if (seen.kind === 'stalled') {
        p.done.push(seen.key)
        acts.unshift({ ...base, did: 'flagged' })
        continue
      }
      if (personRecent(items, now) || p.notes.length >= NOTES_PER_HOUR) continue
      if (!armed()) break
      const text = noteText(seen)
      const error = r.source === 'desk' ? await post('/api/queue', { kind: 'message', chatId: r.id, text }) : await post(`/api/external/sessions/${id}/message`, { text })
      p.done.push(seen.key)
      p.notes.push(now)
      acts.unshift(error ? { ...base, did: 'nudged', error } : { ...base, did: 'nudged' })
    }
  }

  /** One look while armed; never two at once. Without a read of the chats or of the send queue it continues nothing,
   *  and a disarm part-way through stops it before the next send. */
  function tick(): Promise<void> {
    ticking ??= (async () => {
      if (!armed()) return
      const { rows, blind, unread } = await read(DEFAULT_DAYS, false)
      const queue = await get<QueueState>('/api/queue')
      if (armed() && !blind && queue) {
        const waiting = queue.items.flatMap((i) => (i.kind === 'message' && i.state !== 'failed' ? [i.chatId] : []))
        for (const a of decide(rows, tries, new Set([...unread, ...waiting]))) {
          if (!armed()) break
          tries.set(a.row.id, a.count)
          acts.unshift(await carry(a))
        }
      }
      if (armed()) await rounds()
      acts.splice(ACTS_KEPT)
    })()
      .catch((err: unknown) => console.error('[orchestrator] tick failed:', err))
      .finally(() => (ticking = null))
    return ticking
  }

  // It looks every TICK_MS and does nothing while off, so the switch (saved from Settings or here) takes effect on the
  // next look. The timer never keeps the process alive.
  const timer = setInterval(() => void tick(), TICK_MS)
  ;(timer as { unref?: () => void }).unref?.()
  function arm(on: boolean): void {
    if (on !== ctx.settings().orchestrator) ctx.updateSettings({ orchestrator: on })
  }
  ctx.onStop(() => {
    stopped = true
    clearInterval(timer)
  })

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
    if (armed()) await tick()
    const { rows } = await read(DEFAULT_DAYS, true)
    return c.json(plan(rows, DEFAULT_DAYS))
  })
}
