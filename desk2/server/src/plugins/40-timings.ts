// Speed tracking's routes (SPEC "Speed (timings)"): the report, and the window's own measurements.

import type { Hono } from 'hono'
import { CLIENT_STAGES, type TimingStage } from '@shared/timings'
import type { ServerContext } from '../context'
import { DIAGNOSTICS_API, diagnosticsRoute } from '../engine/diagnostics'
import { watchLoopStalls } from '../engine/loop-stall'
import { setSyncBlockSink } from '../engine/sync-block'
import { Timings } from '../engine/timings'

/** The longest wait the window may report: anything past it is a sleeping laptop, not a wait. */
const MAX_CLIENT_MS = 600_000

export default async function plugin(app: Hono, ctx: ServerContext): Promise<void> {
  const timings = Timings.for(ctx.home)
  ctx.onStop(watchLoopStalls(timings))
  setSyncBlockSink((b) => timings.span({ stage: 'sync_block', name: b.label, ms: b.ms }))

  diagnosticsRoute(app, 'timings', () => timings.report())

  // The window's clock: click to server answer, click to bubble shown, open to first paint. Only those stages,
  // only a plain duration and a chat id.
  app.post(`${DIAGNOSTICS_API}/timings/client`, async (c) => {
    const b = (await c.req.json().catch(() => null)) as { stage?: unknown; ms?: unknown; chatId?: unknown } | null
    const stage = b?.stage as TimingStage
    const ms = b?.ms
    if (!b || !CLIENT_STAGES.includes(stage) || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_CLIENT_MS) return c.json({ error: 'stage must be a window stage and ms a duration in milliseconds' }, 400)
    timings.span({ stage, ms, ...(typeof b.chatId === 'string' && /^[\w:.-]{1,80}$/.test(b.chatId) ? { chatId: b.chatId } : {}) })
    return c.json({ ok: true })
  })
}
