import { expect, test } from 'bun:test'
import type { CliMayteWorker, SwarmJob } from '@shared/protocol'
import { badgeTip, parseSubMode, rowSubItems, SUB_MODE_DEFAULTS, taskMode, jobMode } from '../../src/components/sidebar/subitems'
import { ACCOUNT_TONES, accountTone } from '../../src/components/sidebar/account-tone'
import { nestTasks } from '../../src/components/sidebar/tasks'

const worker = (id: string, o: Partial<CliMayteWorker> = {}): CliMayteWorker =>
  ({ id, title: `Task ${id}`, group: null, status: 'running', active: true, sessionId: `s-${id}`, originSessionId: 's-chat', originWorkerId: null, startedAt: 1, ...o }) as CliMayteWorker
const job = (id: string, o: Partial<SwarmJob> = {}): SwarmJob =>
  ({ id, title: `Job ${id}`, status: 'running', active: true, callerSessionId: 's-chat', startedAt: 1, tasks: { done: 0, total: 1, failed: 0, cancelled: 0 }, callerTitle: null, pc: null, ...o }) as SwarmJob

test('the mode store defaults to Count for both kinds, and reads a stored value', () => {
  expect(SUB_MODE_DEFAULTS).toEqual({ tasks: 'count', jobs: 'count' })
  expect(taskMode.value).toBe('count')
  expect(jobMode.value).toBe('count')
  expect(parseSubMode('list', 'tasks')).toBe('list')
  expect(parseSubMode('list', 'jobs')).toBe('list')
  // Nothing stored, or a stale value: the kind's default.
  expect(parseSubMode(null, 'jobs')).toBe('count')
  expect(parseSubMode('1', 'tasks')).toBe('count')
})

test('a row in Count mode has a badge per kind with its running count and titles, and no lines until opened', () => {
  const nested = nestTasks(
    [{ key: 'chat:a', sessionIds: ['s-chat'] }],
    [worker('1'), worker('2'), worker('3', { status: 'done', active: false, startedAt: 3 })],
    [job('x'), job('y', { active: false, status: 'done' })]
  )
  const tasks = nested.byRow.get('chat:a') ?? null
  const jobs = nested.jobsByRow.get('chat:a') ?? null
  const modes = { tasks: 'count', jobs: 'count' } as const
  const closed = rowSubItems('chat:a', tasks, jobs, modes, new Set())
  expect(closed.nodes).toEqual([])
  expect(closed.jobs).toEqual([])
  expect(closed.badges.map((b) => [b.kind, b.running, b.total, b.open])).toEqual([
    ['tasks', 2, 2, false],
    ['jobs', 1, 2, false]
  ])
  expect(closed.badges[1]!.titles).toEqual(['Job x', 'Job y'])

  // Opening one kind's badge draws that kind's lines only; the other stays a badge.
  const open = rowSubItems('chat:a', tasks, jobs, modes, new Set(['jobs|chat:a']))
  expect(open.nodes).toEqual([])
  expect(open.jobs.length).toBe(2)
  expect(open.badges.find((b) => b.kind === 'jobs')!.open).toBe(true)
})

test('List mode draws the lines and no badge; a kind with nothing under the row has none either', () => {
  const list = rowSubItems('chat:a', [{ worker: worker('1'), depth: 1 }], [job('x')], { tasks: 'list', jobs: 'list' }, new Set())
  expect(list.nodes.length).toBe(1)
  expect(list.jobs.length).toBe(1)
  expect(list.badges).toEqual([])
  expect(rowSubItems('chat:b', null, null, { tasks: 'count', jobs: 'count' }, new Set()).badges).toEqual([])
})

test("a badge's tooltip lists 8 titles then how many more, and says what a click does", () => {
  const titles = Array.from({ length: 11 }, (_, i) => `Title ${i + 1}`)
  const tip = badgeTip({ kind: 'tasks', running: 0, total: 11, titles, accounts: [], open: false }).split('\n')
  expect(tip[0]).toBe('CliMayte tasks: none running, 11 in all')
  expect(tip.slice(1, 9)).toEqual(titles.slice(0, 8))
  expect(tip.slice(9)).toEqual(['+3 more', 'Click to list them'])
})

test("a CliMayte badge has each account once, running ones first, and its tooltip names each task's account", () => {
  const nodes = [
    { worker: worker('1', { account: '#5', status: 'done', active: false }), depth: 1 },
    { worker: worker('2', { account: '#3' }), depth: 2 },
    { worker: worker('3', { account: '#3' }), depth: 2 },
    { worker: worker('4', { account: null }), depth: 1 }
  ]
  const [badge] = rowSubItems('chat:a', nodes, null, { tasks: 'count', jobs: 'count' }, new Set()).badges
  expect(badge!.accounts).toEqual([
    { label: '#3', running: true },
    { label: '#5', running: false }
  ])
  expect(badge!.titles).toEqual(['#5 · Task 1', '#3 · Task 2', '#3 · Task 3', 'Task 4'])
  // HSwarm's jobs run on no account.
  expect(rowSubItems('chat:a', null, [job('x')], { tasks: 'count', jobs: 'count' }, new Set()).badges[0]!.accounts).toEqual([])
})

test('an account keeps one colour however its label is written, and neighbouring accounts differ', () => {
  expect(accountTone('#3')).toBe(accountTone('3'))
  expect(new Set(['#1', '#2', '#3', '#4', '#5'].map(accountTone)).size).toBe(ACCOUNT_TONES.length)
  expect(accountTone(null)).toBeNull()
  expect(accountTone('  ')).toBeNull()
  expect<readonly string[]>(ACCOUNT_TONES).toContain(accountTone('sue')!)
})

test('a cloud row in Count mode shows an HSwarm badge for the jobs placed under it', () => {
  const nested = nestTasks([{ key: 'cloud:s-chat', sessionIds: ['s-chat'] }], [], [job('x'), job('y', { active: false })])
  const sub = rowSubItems('cloud:s-chat', nested.byRow.get('cloud:s-chat'), nested.jobsByRow.get('cloud:s-chat'), { tasks: 'count', jobs: 'count' }, new Set())
  expect(sub.badges.map((b) => [b.kind, b.running, b.total])).toEqual([['jobs', 1, 2]])
})
