// server/tests/climayte-report-kept.test.ts — a follow-up reply does not replace the task's report in
// what climayte_status and the report view show (4Man d403d15f). The follow-up's own turns are kept
// as before; the earlier message's recap comes first when the follow-up's turns carry none.

import { describe, expect, test } from 'bun:test'
import {
  type CliMayteWorker,
  type CliMayteWorkerView,
  joinResults,
  statusTurns,
  toReport,
} from '../src/climayte-lib'

const recap = [
  'Edited the router.',
  '## What I did',
  'Landed abc1234 with the fix.',
  '## Am I 100% done?',
  'Two of three hosts; host c is left.',
].join('\n')

type W = Pick<CliMayteWorker, 'result' | 'results' | 'reports'>
const followUp = (said: string[]): W => ({
  result: joinResults(said),
  results: said,
  reports: [{ at: 1, message: 'the task', results: ['working…', recap] }],
})

describe('statusTurns', () => {
  test('a one-line follow-up reply does not replace the report with the recap', () => {
    const turns = statusTurns(followUp(['not mine']))
    expect(turns).toHaveLength(2)
    expect(turns[0]).toContain('Landed abc1234 with the fix.')
    expect(turns[0]).toContain('Earlier report, for: the task')
    expect(turns[1]).toBe('not mine')
    // The report view cuts to the recap of the first turn, so it shows the proof, not the reply.
    const view = {
      ...followUp(['not mine']),
      results: turns,
      status: 'done',
      used: { pct: null, rereadPct: null },
      attempts: [],
    } as unknown as CliMayteWorkerView
    expect(toReport(view).report.startsWith('## What I did')).toBe(true)
    expect(toReport(view).report).toContain('host c is left')
  })

  test('turns that carry their own recap, or no earlier recap, stay as stored', () => {
    const own = followUp(['## What I did\nthe follow-up work'])
    expect(statusTurns(own)).toEqual(own.results!)
    const none: W = { ...followUp(['ok']), reports: [{ at: 1, message: 'm', results: ['plain'] }] }
    expect(statusTurns(none)).toEqual(['ok'])
    expect(statusTurns({ result: null, results: [], reports: undefined })).toEqual([])
  })
})
