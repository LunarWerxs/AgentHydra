// The Speed section's labels and number shaping (SPEC "Speed (timings)").
import type { StageStats, TimingStage } from '@shared/timings'

export const STAGE_LABEL: Record<TimingStage, string> = {
  click_to_server: 'Send click to server answer',
  click_to_bubble: 'Send click to bubble shown',
  open_to_paint: 'Chat open to first paint',
  process_start: 'Process start',
  session_start_hooks: 'SessionStart hooks',
  hook: 'Hook',
  mcp_connect: 'MCP server connect',
  ready: 'Send to ready',
  queue_wait: 'Queued behind a turn',
  first_token: 'Ready to first token',
  tool: 'Tool call',
  api: 'API time',
  turn: 'Whole turn',
  worker_accept: 'Worker: send to accepted',
  worker_queue: 'Worker: queue wait',
  worker_first_item: 'Worker: first item synced',
  worker_turn: 'Worker: whole turn',
  account_move: 'Account move',
  sync_poll: 'Transcript sync poll',
  chat_open: 'Chat open (server)',
  title: 'Title generation',
  warm: 'Warm start',
  loop_stall: 'Server event loop blocked'
}

export const stageLabel = (s: string): string => STAGE_LABEL[s as TimingStage] ?? s

/** A row's label: the stage, and its name when the row is one hook, tool or MCP server. */
export const rowLabel = (r: Pick<StageStats, 'stage' | 'name'>): string => (r.name ? `${stageLabel(r.stage)}: ${r.name}` : stageLabel(r.stage))

/** "850 ms", "4.2 s", "3m 12s". */
export function ms(n: number): string {
  if (n < 1000) return `${Math.round(n)} ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`
  const s = Math.round(n / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

/** A bar's width in percent of the longest value, at least 1 so a short one still shows. */
export const barPct = (n: number, max: number): number => (max > 0 ? Math.max(1, Math.round((n / max) * 100)) : 0)

/** A turn's breakdown key: a stage, or 'hooks' / 'tools' (every hook or tool of the turn summed). */
export const partLabel = (k: string): string => (k === 'hooks' ? 'Hooks' : k === 'tools' ? 'Tools' : stageLabel(k))

/** A turn's stages, longest first, without the zero ones. */
export const stageParts = (stages: Record<string, number>): [string, number][] =>
  Object.entries(stages)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
