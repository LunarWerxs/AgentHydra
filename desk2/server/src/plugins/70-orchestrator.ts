// The orchestrator, phase A (shadow): GET /api/diagnostics/orchestrator lists every open chat and outside session (a
// Claude Desktop, CLI, CliMayte or Codex session AgentHydra knows) active in the last `?days=` days (3 by default) with
// the one move the orchestrator would make next and why; `?ask=1` also asks the CreAitor, when this machine has it,
// what the owner would answer each one that waits on a question. It reads the engine's own routes and dispatches
// nothing: no message is sent, no card answered, no chat moved or resumed. Own page only (an ask runs a model).
// README "What Desk 2 adds", the orchestrator.

import type { Hono } from 'hono'
import type { ChatSummary, ExternalSession, TranscriptItem } from '@shared/protocol'
import type { OrchestratorPlan, OrchestratorRow } from '@shared/orchestrator'
import type { ServerContext } from '../context'
import { DIAGNOSTICS_API } from '../engine/diagnostics'
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

export default function plugin(app: Hono, _ctx: ServerContext): void {
  async function get<T>(path: string): Promise<T | null> {
    const res = await app.request(path)
    return res.ok ? ((await res.json()) as T) : null
  }

  app.get(`${DIAGNOSTICS_API}/orchestrator`, async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const days = Math.min(30, Math.max(1, Number(c.req.query('days')) || 3))
    const now = Date.now()
    const [own, outside] = await Promise.all([get<ChatSummary[]>('/api/chats'), get<ExternalSession[]>('/api/external/sessions')])
    const subjects = [
      ...(own ?? []).filter((ch) => !ch.archived).map((ch) => ({ s: fromChat(ch), items: `/api/chats/${encodeURIComponent(ch.id)}/items` })),
      ...(outside ?? []).filter((x) => !x.archived && x.status !== 'stale').map((x) => ({ s: fromExternal(x), items: `/api/external/sessions/${encodeURIComponent(x.id)}/items` }))
    ]
      .filter(({ s }) => now - s.updatedAt < days * 86_400_000)
      .sort((a, b) => b.s.updatedAt - a.s.updatedAt)
      .slice(0, MAX_CHATS)
    const rows: OrchestratorRow[] = []
    for (const { s, items } of subjects) {
      const busy = s.status === 'working' || s.status === 'starting'
      rows.push(classify(s, busy ? null : await get<TranscriptItem[]>(items), now))
    }
    const tool = creaitorTool()
    const counts: OrchestratorPlan['counts'] = {}
    for (const r of rows) counts[r.move] = (counts[r.move] ?? 0) + 1
    const plan: OrchestratorPlan = { at: now, mode: 'shadow', days, creaitor: tool !== null, rows: rank(rows), counts }
    const asking = tool && c.req.query('ask') === '1' ? rows.filter((r) => r.question) : []
    if (!tool || !asking.length) return c.json(plan)
    return slowJson(
      (async () => {
        for (let i = 0; i < asking.length; i += ASK_WIDTH)
          await Promise.all(asking.slice(i, i + ASK_WIDTH).map(async (r) => (r.creaitor = await askCreaitor(tool, r.question ?? '', r.options ?? [], r.cwd))))
        return plan
      })()
    )
  })
}
