// server/tests/climayte-lean.test.ts — `lean=1` on the CliMayte lists (Desk 2's server and pane).
//
// The lists answer the same rows, in the same order, with and without it; lean drops the long text no
// list row shows (result, results, reports, whole attempts, verdict notes past their first line), keeps
// a count of the result, and leaves the answer without it exactly as it was.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  climayteCancel,
  climayteLeanWave,
  climayteRun,
  setCliMayteAccountsProvider,
} from '../src/climayte'
import { workers } from '../src/climayte-core'
import type { CliMayteWave } from '../src/climayte-lib'
import { app } from '../src/http-app'
import '../src/routes/climayte'

// A fresh Hono keeps the shared app's router open for later files (climayte-origin.test.ts has the story).
const http = new Hono().route('/', app)

const scratch = mkdtempSync(join(tmpdir(), 'climayte-lean-'))
const CWD = join(scratch, 'repo')
mkdirSync(CWD, { recursive: true })
const GROUP = 'lean-g'

beforeAll(() => setCliMayteAccountsProvider(() => []))
afterAll(() => {
  climayteCancel({ group: GROUP })
  setCliMayteAccountsProvider(null)
  rmSync(scratch, { recursive: true, force: true })
})

const list = async (qs: string) =>
  (await (
    await http.fetch(new Request(`http://127.0.0.1/api/corch/workers?group=${GROUP}${qs}`))
  ).json()) as Array<Record<string, any>>

describe('workers list with lean=1', () => {
  test('same rows in the same order, the long text gone, a count of the result kept', async () => {
    const made = climayteRun({
      tasks: ['one', 'two'].map((t) => ({ prompt: `do ${t}`, cwd: CWD, title: t, size: 'whole' })),
      group: GROUP,
    }).workers
    const w = workers.get(made[0]!.id)!
    w.result = 'x'.repeat(500)
    w.results = ['x'.repeat(200), 'y'.repeat(300)]
    w.reports = [{ at: 1, message: 'earlier', results: ['z'.repeat(400)] }]
    w.verdicts = [
      {
        at: 1,
        verdict: 'fail',
        note: `first line\n${'n'.repeat(500)}`,
        by: 'owner',
        units: 0,
      } as never,
    ]

    const full = await list('')
    const lean = await list('&lean=1')
    expect(lean.map((r) => r.id)).toEqual(full.map((r) => r.id))
    expect(full.find((r) => r.id === w.id)!.result).toHaveLength(500)

    const row = lean.find((r) => r.id === w.id)!
    expect(row.result).toBeNull()
    expect(row.results).toBeUndefined()
    expect(row.reports).toBeUndefined()
    expect(row.resultChars).toBe(500)
    expect(row.verdicts[0]).toMatchObject({ verdict: 'fail', by: 'owner', note: 'first line' })
    // What a list row shows stays.
    expect(row.title).toBe(full.find((r) => r.id === w.id)!.title)
    expect(row.prompt).toBe(full.find((r) => r.id === w.id)!.prompt)
    expect(row.status).toBe(full.find((r) => r.id === w.id)!.status)
  })
})

describe('waves list with lean=1', () => {
  test('a wave keeps its tasks, proof and report but loses each task prompt, check and the notes', () => {
    const wave: CliMayteWave = {
      id: 'wv-aaaaaa',
      group: 'g-1',
      managerId: 'w-1',
      plan: '/p/plan.md',
      cwd: '/p',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: 'p'.repeat(900),
          title: 'Title',
          kind: 'code',
          check: 'bun test',
          paths: ['a/**'],
          after: [],
          workerId: 'w-2',
          state: 'passed',
          proof: { check: true, commits: ['abc1234'], paths: true, note: 'ok' },
        },
      ],
      escalations: [],
      notes: 'n'.repeat(900),
      rounds: 1,
      maxRounds: 3,
      batch: { size: 1, settleS: 0, held: [], since: null },
      status: 'running',
      report: 'short report',
      createdAt: 1,
      updatedAt: 2,
    }
    const lean = climayteLeanWave(wave)
    expect(lean.tasks[0]).toMatchObject({
      key: 't1',
      title: 'Title',
      state: 'passed',
      prompt: '',
      check: null,
    })
    expect(lean.tasks[0]!.proof).toEqual(wave.tasks[0]!.proof)
    expect(lean.report).toBe('short report')
    expect(lean.notes).toBe('')
    expect(wave.tasks[0]!.prompt).toHaveLength(900)
  })
})
