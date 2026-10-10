// server/tests/climayte-thrash.test.ts — a run that ends in Claude Code's "Autocompact is thrashing"
// error continues its session one rung up the ladder, once per rung (climayte-steer.ts).

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteList,
  climayteRun,
  climayteWait,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { setSpendKit } from '../src/climayte-core'
import { type CliMayteWorker, classifyAttempt } from '../src/climayte-lib'
import type { CliMayteVerdict } from '../src/climayte-scorecard'
import { HAIKU, OPUS, SONNET } from '../src/climayte-scorecard'
import { isContextThrash, THRASH_PROMPT, thrashContinueRung } from '../src/climayte-steer'
import { harnessKit } from './mocks/climayte-kit'

setSpendKit(harnessKit)

const THRASH =
  'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.'

const thrashEvents = [{ type: 'result', is_error: true, num_turns: 3, result: THRASH }]

const worker = (verdicts: CliMayteVerdict[] = []) =>
  ({ verdicts, auto: false, kind: null }) as unknown as CliMayteWorker

const verdict = (model: string, effort: string | null, context = false): CliMayteVerdict => ({
  at: 0,
  verdict: 'fail',
  note: null,
  model,
  effort,
  units: 0,
  ...(context ? { context: true } : {}),
})

describe('a run that ends in the context thrash error', () => {
  test('the run is classed as an error whose text names the thrash', () => {
    const v = classifyAttempt(thrashEvents, '', true)
    expect(v.outcome).toBe('error')
    expect(isContextThrash(v.result)).toBe(true)
  })

  test('an ordinary error is not a thrash', () => {
    expect(isContextThrash('Something else broke the turn.')).toBe(false)
    expect(isContextThrash(null)).toBe(false)
  })

  test('the first thrash on a rung continues on the next rung', () => {
    expect(thrashContinueRung(worker(), verdict(HAIKU, 'high'))).toEqual({
      model: SONNET,
      effort: 'low',
    })
  })

  test('a second thrash on the same rung fails', () => {
    const w = worker([verdict(HAIKU, 'high', true)])
    expect(thrashContinueRung(w, verdict(HAIKU, 'high'))).toBeNull()
  })

  test('a thrash on the top rung fails', () => {
    expect(thrashContinueRung(worker(), verdict(OPUS, 'max'))).toBeNull()
  })

  test('the continuation note tells the session how to read large files', () => {
    expect(THRASH_PROMPT).toContain('120 lines')
    expect(THRASH_PROMPT).toContain('grep -n')
    expect(THRASH_PROMPT).toContain('tail -40')
  })
})

describe('a worker that thrashes is continued in its own session, one rung up', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-thrash-'))
  const cwd = join(root, 'work')
  const configDir = join(root, 'acct')
  for (const d of [cwd, configDir]) mkdirSync(d, { recursive: true })
  const groups: string[] = []

  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('the Haiku run that thrashed finishes on Sonnet, carrying the note', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      {
        id: 'thrash-acct',
        num: 51,
        name: 'thrash',
        configDir,
        sessionPct: 0,
        weekPct: 0,
        planFactor: 1,
        sessionResetsAt: Date.now() + 2 * 3_600_000,
      },
    ])
    startCliMayte()
    const run = climayteRun({
      tasks: [
        {
          prompt: 'FAKE-THRASH the debug task',
          cwd,
          kind: 'debug',
          model: HAIKU,
          effort: 'high',
          ownerWords: 'the thrash continuation under test',
        },
      ],
      group: 'thrash-continue',
      size: 'whole',
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 60_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }
    expect(w?.status).toBe('done')
    expect(w?.verdicts?.some((v) => v.context && v.model === HAIKU)).toBe(true)
    expect(w?.model).toBe(SONNET)
  })
})
