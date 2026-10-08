// The window's own clock (SPEC "Speed (timings)"): what it measured goes to POST /api/diagnostics/timings/client,
// and a closed chat is started ahead when the owner begins typing in it. Both are fire and forget: neither may
// fail a send or slow the window.
import type { ClientTimingReport, TimingStage } from '@shared/timings'

/** Only a real window reports: a test or a server render has no frames to measure. */
const inWindow = (): boolean => typeof window !== 'undefined' && typeof requestAnimationFrame === 'function' && typeof fetch === 'function'

export function reportTiming(stage: TimingStage, ms: number, chatId?: string): void {
  if (!inWindow() || !Number.isFinite(ms) || ms < 0) return
  const body: ClientTimingReport = { stage, ms: Math.round(ms), ...(chatId ? { chatId } : {}) }
  void fetch('/api/diagnostics/timings/client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {})
}

/** Reports `stage` as the time from `from` (performance.now()) to the frame after the next one: what was drawn is then on screen. */
export function reportAtPaint(stage: TimingStage, from: number, chatId?: string): void {
  if (!inWindow()) return
  requestAnimationFrame(() => requestAnimationFrame(() => reportTiming(stage, performance.now() - from, chatId)))
}

const WARM_AGAIN_MS = 60_000
const WARMED_MAX = 200
const warmed = new Map<string, number>()

/** Asks the server to start a closed chat's process now (the warm start); at most once a minute per chat. */
export function warmChat(chatId: string): void {
  if (!inWindow()) return
  const now = Date.now()
  if (now - (warmed.get(chatId) ?? 0) < WARM_AGAIN_MS) return
  warmed.delete(chatId)
  warmed.set(chatId, now)
  // Only the last minute matters: past WARMED_MAX chats the oldest is let go.
  for (const id of warmed.keys()) {
    if (warmed.size <= WARMED_MAX) break
    warmed.delete(id)
  }
  void fetch(`/api/chats/${encodeURIComponent(chatId)}/warm`, { method: 'POST' }).catch(() => {})
}
