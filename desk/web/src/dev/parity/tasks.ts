// The background-tasks scene's workers: the run in real-background-tasks-panel.png (hydra-desk-parity-
// round2, 11m 06s, three Opus 5.5 agents in its Fix phase, 539.6k tokens) as CliMayte workers the
// parity chat dispatched, and 25 finished ones behind 'Finished 25'.
import type { CliMayteWorker } from '@shared/protocol'
import { PARITY_NOW } from './clock'

const SESSION = 's-ccd'
const START = PARITY_NOW - 666_000

const worker = (over: Partial<CliMayteWorker> & Pick<CliMayteWorker, 'id' | 'title'>): CliMayteWorker => ({
  description: null,
  group: null,
  status: 'running',
  active: true,
  account: '#68',
  model: 'claude-opus-5-5',
  effort: 'high',
  kind: 'fix',
  cwd: 'C:/Users/jacob/Desktop/Project/Agent Hydra/desk',
  sessionId: `ws-${over.id}`,
  originSessionId: SESSION,
  startedAt: START,
  endedAt: null,
  lastActivityAt: PARITY_NOW - 2000,
  lastActivity: null,
  usedPct: null,
  tokens: null,
  verdict: null,
  error: null,
  ...over
})

const ROUND2 = 'hydra-desk-parity-round2'
const BRIEF =
  'Round 2: fix the critics findings (new-session screen, account labels, menus, tooltips, dock cards, sidebar polish), then re-audit against a fresh build'

export function backgroundTaskWorkers(): CliMayteWorker[] {
  const finished = Array.from({ length: 25 }, (_, i) =>
    worker({
      id: `done-${i}`,
      title: `Round 1 piece ${i + 1}`,
      status: 'done',
      active: false,
      verdict: 'ok',
      startedAt: START - (i + 2) * 3_600_000,
      endedAt: START - (i + 1) * 3_600_000,
      lastActivityAt: START - (i + 1) * 3_600_000,
      tokens: 120_000 + i * 1000
    })
  )
  return [
    worker({ id: 'r2-newsession', title: 'newsession', group: ROUND2, description: BRIEF, tokens: 170_500 }),
    worker({ id: 'r2-composer', title: 'composer-polish', group: ROUND2, description: BRIEF, tokens: 177_500 }),
    worker({
      id: 'r2-shell',
      title: 'shell-polish',
      group: ROUND2,
      description: BRIEF,
      status: 'done',
      active: false,
      verdict: 'ok',
      tokens: 191_600,
      endedAt: START + 640_000,
      lastActivityAt: START + 640_000
    }),
    ...finished
  ]
}
