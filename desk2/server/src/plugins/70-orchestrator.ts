// The orchestrator, phase A (shadow): GET /api/diagnostics/orchestrator lists every open chat active in the last
// `?days=` days (3 by default) with the one move the orchestrator would make next and why; `?ask=1` also asks the
// CreAitor, when this machine has it, what the owner would answer each chat that waits on a question. It reads the
// engine's own routes and dispatches nothing: no message is sent, no card answered, no chat moved or resumed.
// Own page only (an ask runs a model). README "What Desk 2 adds", the orchestrator.

import type { Hono } from 'hono'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import type { OrchestratorPlan, OrchestratorRow } from '@shared/orchestrator'
import type { ServerContext } from '../context'
import { DIAGNOSTICS_API } from '../engine/diagnostics'
import { askCreaitor, creaitorTool } from '../orchestrator/creaitor'
import { classify, rank } from '../orchestrator/plan'
import { notOwnPage } from '../own-page'

const WHAT = "the orchestrator's plan"
/** At most this many chats are read per plan, the most recently active first. */
const MAX_CHATS = 100
/** CreAitor asks run this many at once. */
const ASK_WIDTH = 4

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
    const chats = ((await get<ChatSummary[]>('/api/chats')) ?? [])
      .filter((ch) => !ch.archived && now - ch.updatedAt < days * 86_400_000)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHATS)
    const rows: OrchestratorRow[] = []
    for (const ch of chats) {
      const busy = ch.status === 'working' || ch.status === 'starting'
      const items = busy ? null : await get<TranscriptItem[]>(`/api/chats/${encodeURIComponent(ch.id)}/items`)
      rows.push(classify(ch, items, now))
    }
    const tool = creaitorTool()
    if (tool && c.req.query('ask') === '1') {
      const asking = rows.filter((r) => r.question)
      for (let i = 0; i < asking.length; i += ASK_WIDTH)
        await Promise.all(asking.slice(i, i + ASK_WIDTH).map(async (r) => (r.creaitor = await askCreaitor(tool, r.question ?? '', r.options ?? [], r.cwd))))
    }
    const counts: OrchestratorPlan['counts'] = {}
    for (const r of rows) counts[r.move] = (counts[r.move] ?? 0) + 1
    const plan: OrchestratorPlan = { at: now, mode: 'shadow', days, creaitor: tool !== null, rows: rank(rows), counts }
    return c.json(plan)
  })
}
