// plugins/70-orchestrator.ts through its route: the chats and transcripts come from stand-in engine routes (the send
// queue's too, which records what the armed orchestrator queues), the judge from a stand-in model (ctx.deps.orchestratorAsk),
// the CreAitor from a stand-in script run by this test's own runtime. Nothing outside a temp folder is read or written.

import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import type { AccountInfo, ChatSummary, ExternalSession, TranscriptItem } from '@shared/protocol'
import { ORCHESTRATOR_FROM, type OrchestratorPlan } from '@shared/orchestrator'
import type { ServerContext } from '../../src/context'
import { createServer, type DeskServer } from '../../src/index'
import plugin from '../../src/plugins/70-orchestrator'
import { NOTES_PER_HOUR } from '../../src/orchestrator/foreman'

const NOW = Date.now()
// The real fetch: a web store test in the same `bun test` run replaces the global one and never restores it.
const realFetch = globalThis.fetch
const temps: string[] = []
const servers: DeskServer[] = []
const stops: (() => void | Promise<void>)[] = []
const saved = { tool: process.env.HYDRA_DESK_CREAITOR, python: process.env.HYDRA_DESK_PYTHON }
afterEach(async () => {
  setSystemTime()
  for (const s of stops.splice(0)) await s()
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const [k, v] of [['HYDRA_DESK_CREAITOR', saved.tool], ['HYDRA_DESK_PYTHON', saved.python]] as const)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
})

function chat(id: string, fields: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id, sessionId: null, title: id, cwd: '/work/repo', account: { id: 'default', label: '#1', configDir: null }, accountAuto: false,
    model: null, effort: null, permissionMode: 'default', delegateToCliMayte: false, status: 'idle', activity: null, turnStartedAt: null,
    lastError: null, limitResetsAt: null, unread: false, pinned: false, archived: false, group: null, forkedFrom: null, createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000, costUsd: 0, contextPct: null, pendingCount: 0, queuedCount: 0, climayteActive: 0, ...fields
  }
}
const said = (text: string, ago = 3_600_000): TranscriptItem => ({ id: `a${ago}`, ts: NOW - ago, kind: 'assistant_text', text })
const wrote = (ago: number): TranscriptItem => ({ id: `u${ago}`, ts: NOW - ago, kind: 'user', text: 'go' })

const CHATS: [ChatSummary, TranscriptItem[]][] = [
  [chat('card', { status: 'needs_you', sessionId: 'sess-card' }), [{ id: 'q', ts: NOW - 3_600_000, kind: 'question', state: 'pending', questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'S3' }, { label: 'Disk' }] }] }]],
  [chat('need'), [said('Done the rest.\n\n🔴 NEED: Ship the release now? A) Wait a day ★ B) --force')]],
  [chat('asks'), [said('All green. Want me to deploy it to the box too?')]],
  [chat('person'), [said('🔴 NEED: Pick one? A) x B) y', 3_000_000), wrote(120_000)]],
  [chat('permission', { status: 'needs_you' }), [{ id: 'p', ts: NOW - 3_600_000, kind: 'permission', toolName: 'Bash', input: {}, canAlwaysAllow: false, state: 'pending' }]],
  [chat('limited', { status: 'limited', limitResetsAt: NOW + 3_600_000 }), [said('Working on it.')]],
  [chat('moved', { status: 'limited', accountAuto: true }), []],
  [chat('error', { status: 'error', lastError: 'network down' }), []],
  // the armed orchestrator continued it 2 min ago (its note, never the person's): it waits before another
  [chat('continued', { status: 'error', lastError: 'overloaded' }), [{ id: 'n', ts: NOW - 120_000, kind: 'note', from: ORCHESTRATOR_FROM, text: 'Continue the task.' }]],
  // its transcript does not load (the stand-in answers 500): shown, never acted on
  [chat('unreadable', { status: 'error', lastError: 'disk full' }), []],
  [chat('busy', { status: 'working', activity: 'Bash: bun test' }), []],
  [chat('finished'), [said('Landed 3 of 3; everything is verified.')]],
  [chat('old', { updatedAt: NOW - 10 * 86_400_000 }), [said('🔴 NEED: Old? A) a B) b')]],
  [chat('archived', { archived: true }), [said('🔴 NEED: Gone? A) a B) b')]]
]

function outside(id: string, fields: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id, title: id, cwd: '/work/other', source: 'desktop', instance: '#2', status: 'idle', activity: null, lastActivityAt: NOW - 120_000, model: null,
    accountId: null, canResume: true, fromPc: null, pinned: false, archived: false, unread: false, group: null, ...fields
  }
}
const asked: TranscriptItem = {
  id: 't', ts: NOW - 3_600_000, kind: 'tool_use', name: 'AskUserQuestion', status: 'running', startedAt: NOW - 3_600_000,
  input: { questions: [{ question: 'Which region?', header: 'Region', options: [{ label: 'East' }, { label: 'West' }] }] }
}
// AgentHydra cuts a call's input at 1200 characters, and a cut one arrives as { raw }: the question is still read.
const cut = JSON.stringify({ questions: [{ question: 'Keep the "old" cache?', options: [{ label: 'Keep', description: 'x'.repeat(900) }, { label: 'Drop', description: 'y'.repeat(400) }] }] }).slice(0, 1200)
// Outside sessions (Claude Desktop, CLI, Codex): a question there is an AskUserQuestion call still running.
const OUTSIDE: [ExternalSession, TranscriptItem[]][] = [
  [outside('o-ask', { status: 'needs_you' }), [asked]],
  [outside('o-cut', { status: 'needs_you', lastActivityAt: NOW - 180_000 }), [{ ...asked, input: { raw: cut } }]],
  [outside('o-need', { source: 'cli' }), [said('🔴 NEED: Merge it? A) Merge ★ B) Hold')]],
  [outside('o-window', { status: 'needs_you' }), [said('Running the deploy.')]],
  [outside('o-busy', { status: 'working', activity: 'Edit: a.ts' }), []],
  [outside('o-person'), [said('🔴 NEED: Pick? A) x B) y', 3_000_000), wrote(60_000)]],
  [outside('o-done', { source: 'codex' }), [said('All 4 landed.')]],
  [outside('o-stale', { status: 'stale' }), [said('🔴 NEED: Stale? A) a B) b')]],
  [outside('o-old', { lastActivityAt: NOW - 10 * 86_400_000 }), [said('🔴 NEED: Old? A) a B) b')]],
  [outside('o-archived', { archived: true }), [said('🔴 NEED: Gone? A) a B) b')]]
]

/** What the judge's stand-in answers for one chat: a verdict with its message and reason, or 'error' (the model call fails). */
type Answer = { verdict: 'fine' | 'nudge' | 'continue' | 'leave'; message?: string; why?: string } | 'error'

/** The judge's stand-in, handed to the plugin as ctx.deps.orchestratorAsk in place of the SDK: `answers` by chat id, `fallback`
 *  for the rest. It records each chat it was asked about, and the model each call asked for. */
function judge(answers: Record<string, Answer> = {}, fallback: Answer = { verdict: 'fine', why: 'it is moving' }) {
  const asked: string[] = []
  const models: string[] = []
  /** Each call's chat and the account folder it signed in with; a folder in `refused` has its login refused. */
  const signedIn: [string, string | null][] = []
  const refused = new Set<string>()
  const ask = async (req: { brief: { id: string }; model: string; configDir: string | null }): Promise<{ text: string; resolved: string | null }> => {
    asked.push(req.brief.id)
    models.push(req.model)
    signedIn.push([req.brief.id, req.configDir])
    if (req.configDir && refused.has(req.configDir)) throw new Error('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed')
    const a = answers[req.brief.id] ?? fallback
    if (a === 'error') throw new Error('model down')
    return { text: JSON.stringify({ verdict: a.verdict, message: a.message ?? '', why: a.why ?? 'the reason' }), resolved: 'claude-opus-5-5' }
  }
  return { asked, models, signedIn, refused, ask }
}

/** The plugin over a stand-in engine; `sent` counts every request that would change something, and `queued` holds
 *  each message handed to the send queue and not yet delivered (a test delivers them by emptying it). `onQueue` runs
 *  while the queue takes a message. */
function desk(onQueue?: (app: Hono) => Promise<unknown>, chats = CHATS, model = judge(), accounts?: AccountInfo[]): { app: Hono; sent: string[]; queued: { chatId: string; text: string }[] } {
  const app = new Hono()
  if (accounts) app.get('/api/accounts', (c) => c.json(accounts))
  const sent: string[] = []
  const queued: { chatId: string; text: string }[] = []
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET') sent.push(`${c.req.method} ${c.req.path}`)
    await next()
  })
  app.post('/api/queue', async (c) => {
    const { chatId, text } = (await c.req.json()) as { chatId: string; text: string }
    queued.push({ chatId, text })
    await onQueue?.(app)
    return c.json({ id: 'q' })
  })
  app.get('/api/queue', (c) =>
    c.json({
      items: queued.map(({ chatId, text }, i) => ({ id: `q${i}`, rev: 1, createdAt: NOW, updatedAt: NOW, state: 'waiting', reason: null, text, kind: 'message', chatId })),
      paused: false, sendMode: 'immediate', maxNewChats: 1, held: {}, rev: 0
    })
  )
  app.post('/api/queue/chats/:id/resume', (c) => c.json({ items: [] }))
  app.get('/api/chats', (c) => c.json(chats.map(([ch]) => ch)))
  app.get('/api/chats/:id/items', (c) =>
    c.req.param('id') === 'unreadable' ? c.json({ error: 'no transcript' }, 500) : c.json(chats.find(([ch]) => ch.id === c.req.param('id'))?.[1] ?? [])
  )
  app.get('/api/external/sessions', (c) => c.json(OUTSIDE.map(([s]) => s)))
  app.get('/api/external/sessions/:id/items', (c) => c.json(OUTSIDE.find(([s]) => s.id === c.req.param('id'))?.[1] ?? []))
  // The `orchestrator` setting is what arming saves; `orchestratorModel` is what the judge asks.
  const settings = { orchestrator: false, orchestratorModel: 'opus' }
  plugin(app, {
    onStop: (fn: () => void) => stops.push(fn),
    settings: () => settings,
    updateSettings: (p: object) => Object.assign(settings, p),
    deps: { orchestratorAsk: model.ask }
  } as unknown as ServerContext)
  return { app, sent, queued }
}

/** The page's Arm / Disarm. */
const arm = async (app: Hono, armed: boolean): Promise<OrchestratorPlan> =>
  (await (await app.request('/api/diagnostics/orchestrator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ armed }) })).json()) as OrchestratorPlan

/** Moves the clock to `min` minutes after the chats were written (the judge judges again after PEEK_MS). */
const at = (min: number): void => {
  setSystemTime(new Date(NOW + min * 60_000))
}

test('armed, the judge continues a Desk chat an error stopped, once per stop and twice at most, and a limit stop stays with the babysitter', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  const model = judge({ error: { verdict: 'continue', message: 'Pick up where you stopped.' } })
  const { app, sent, queued } = desk(undefined, CHATS, model)
  const lead = `[${ORCHESTRATOR_FROM}] Not from the user.\n`
  const continued = ['POST /api/diagnostics/orchestrator', 'POST /api/queue', 'POST /api/queue/chats/error/resume']
  // Arming looks at once: the judge reads the chat an error stopped, and its message goes out with a resume. Never
  // 'unreadable', whose transcript did not load (a person may have just written in it), nor 'limited' or 'moved', which
  // the babysitter continues after the reset.
  const first = await arm(app, true)
  expect(first.mode).toBe('armed')
  expect(sent.splice(0)).toEqual(continued)
  expect(queued).toEqual([{ chatId: 'error', text: `${lead}Pick up where you stopped.` }])
  expect(first.acts.map((a) => [a.id, a.move, a.did, a.error])).toEqual([['error', 'retry-error', 'continued', undefined]])
  expect(first.rows.find((r) => r.id === 'error')?.judgment).toMatchObject({ verdict: 'continue', message: 'Pick up where you stopped.', held: null, error: null, resolved: 'claude-opus-5-5' })
  expect([model.asked.includes('unreadable'), model.asked.includes('limited'), model.asked.includes('moved'), model.models[0]]).toEqual([false, false, false, 'opus'])
  // Judged within PEEK_MS, and its message still waits in the send queue: a look asks nothing new about it.
  expect((await arm(app, true)).acts).toHaveLength(1)
  expect([sent.splice(0), model.asked.filter((id) => id === 'error')]).toEqual([['POST /api/diagnostics/orchestrator'], ['error']])
  // Delivered; eleven minutes later it stopped again: the second continue.
  queued.splice(0)
  at(11)
  expect((await arm(app, true)).acts).toHaveLength(2)
  expect(sent.splice(0)).toEqual(continued)
  // The third stop: the hard limit gives up without asking the judge, and the plan leaves the chat to a person.
  queued.splice(0)
  at(22)
  const third = await arm(app, true)
  expect([sent.splice(0), queued, model.asked.filter((id) => id === 'error').length]).toEqual([['POST /api/diagnostics/orchestrator'], [], 2])
  expect(third.acts[0]).toMatchObject({ id: 'error', did: 'gave-up' })
  const by = Object.fromEntries(third.rows.map((r) => [r.id, r]))
  expect([by.error.move, by.limited.move, by.unreadable.move]).toEqual(['leave', 'resume-after-limit', 'retry-error'])
  expect(by.error.reason).toBe('the orchestrator continued it 2 times and it stopped again: network down')
  expect(by.limited.reason).toBe('its account hit the usage limit; the babysitter continues it in 38 min, when it resets')
  // The model's own setting is what the route reports, once the SDK has named the model it resolves to.
  expect(await (await app.request('/api/orchestrator/model')).json()).toEqual({ setting: 'opus', resolved: 'claude-opus-5-5' })
  const off = await arm(app, false)
  expect([off.mode, sent.splice(0), queued]).toEqual(['shadow', ['POST /api/diagnostics/orchestrator'], []])
})

test('a judge whose call fails sends nothing, and its error shows on the row', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  const { app, sent, queued } = desk(undefined, [[chat('error', { status: 'error', lastError: 'network down' }), []]], judge({ error: 'error' }))
  const plan = await arm(app, true)
  expect([queued, sent.splice(0), plan.acts]).toEqual([[], ['POST /api/diagnostics/orchestrator'], []])
  expect(plan.rows.find((r) => r.id === 'error')?.judgment).toMatchObject({ verdict: null, error: 'model down', message: '', held: null })
})

test('a disarm part-way through a look stops it before the next send', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  // The owner's Disarm lands while the queue takes the look's first continue, with a second chat still to continue.
  // The second chat's judgment answers only after that Disarm, as a slow model would; the look is judged three at a time,
  // so without the wait it could already have passed its check when the Disarm landed.
  const carry = { verdict: 'continue' as const, message: 'Carry on.' }
  const model = judge({ error: carry, 'error-2': carry })
  let releaseSecond: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const slow = async (req: Parameters<typeof model.ask>[0]) => {
    if (req.brief.id === 'error-2') await gate
    return model.ask(req)
  }
  const { app, queued } = desk(
    async (self) => {
      await arm(self, false)
      releaseSecond()
    },
    [...CHATS, [chat('error-2', { status: 'error', lastError: 'timed out' }), []]],
    { ...model, ask: slow }
  )
  await arm(app, true)
  expect(queued.map((q) => q.chatId)).toEqual(['error'])
  const plan = (await (await app.request('/api/diagnostics/orchestrator')).json()) as OrchestratorPlan
  expect([plan.mode, plan.acts.map((a) => a.id)]).toEqual(['shadow', ['error']])
})

// The judge on running chats: one due a peek is judged, and a nudge goes in. Never into a chat a person wrote in, never
// into a stalled one (a note queues behind a turn that stopped answering), and never more than two an hour.
test('armed, the judge checks in on a running chat that keeps failing a step, and leaves a stalled one and one a person just wrote in', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  const failed = (n: number, status: 'error' | 'done' = 'error'): TranscriptItem => ({
    id: `t${n}`, ts: NOW - (10 - n) * 60_000, kind: 'tool_use', name: 'Bash', input: { command: 'bun test' }, status, startedAt: NOW - (10 - n) * 60_000
  })
  const model = judge({
    spinning: { verdict: 'nudge', message: 'Stop repeating bun test; read the error first.', why: 'the same test fails again and again' },
    quiet: { verdict: 'nudge', message: 'Still there?', why: 'nothing new for half an hour' }
  })
  const { app, queued } = desk(
    undefined,
    [
      [chat('spinning', { status: 'working', activity: 'Bash: bun test' }), [failed(1), failed(2), failed(3)]],
      [chat('quiet', { status: 'working' }), [said('Starting on it.', 30 * 60_000)]],
      [chat('moving', { status: 'working' }), [failed(4), failed(5, 'done')]],
      [chat('person', { status: 'working' }), [failed(6), failed(7), failed(8), wrote(60_000)]]
    ],
    model
  )
  const first = await arm(app, true)
  expect(queued).toEqual([{ chatId: 'spinning', text: `[${ORCHESTRATOR_FROM}] Not from the user.\nStop repeating bun test; read the error first.` }])
  expect(first.acts.map((a) => [a.id, a.did, a.detail]).sort()).toEqual([
    ['quiet', 'flagged', 'nothing new for half an hour'],
    ['spinning', 'nudged', 'the same test fails again and again']
  ])
  const by = Object.fromEntries(first.rows.map((r) => [r.id, r]))
  expect([by.spinning.judgment?.verdict, by.spinning.judgment?.held]).toEqual(['nudge', null])
  expect(by.quiet.judgment?.held).toContain('stalled')
  expect(model.asked).not.toContain('person')
  // Judged within PEEK_MS: the next look asks nothing more about them.
  queued.splice(0)
  expect((await arm(app, true)).acts).toHaveLength(2)
  expect([queued, model.asked.filter((id) => id === 'spinning')]).toEqual([[], ['spinning']])
})

test('two check-ins an hour to one chat at most, even when the judge asks for more', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  // A call that has run an hour is hung, not stalled: the judge is asked each time, and the limit holds the third check-in.
  const hung: TranscriptItem = { id: 'h', ts: NOW - 3_600_000, kind: 'tool_use', name: 'Bash', input: { command: 'sleep 9999' }, status: 'running', startedAt: NOW - 3_600_000 }
  const model = judge({ hung: { verdict: 'nudge', message: 'Is it stuck? Stop it if so.', why: 'a command has run an hour' } })
  const { app, queued } = desk(undefined, [[chat('hung', { status: 'working' }), [hung]]], model)
  await arm(app, true)
  expect(queued).toHaveLength(1)
  queued.splice(0)
  at(11)
  await arm(app, true)
  expect(queued).toHaveLength(1)
  queued.splice(0)
  at(22)
  const third = await arm(app, true)
  expect([queued, model.asked.filter((id) => id === 'hung').length]).toEqual([[], 3])
  expect(third.rows.find((r) => r.id === 'hung')?.judgment).toMatchObject({ verdict: 'nudge', held: `${NOTES_PER_HOUR} check-in notes already went to it this hour` })
})

test('the judge is asked about at most three chats at once', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  let inFlight = 0
  let most = 0
  const asked: string[] = []
  const slow = async (req: { brief: { id: string } }): Promise<{ text: string; resolved: string | null }> => {
    asked.push(req.brief.id)
    inFlight++
    most = Math.max(most, inFlight)
    await Bun.sleep(20)
    inFlight--
    return { text: JSON.stringify({ verdict: 'fine', message: '', why: 'moving' }), resolved: null }
  }
  const errors = [0, 1, 2, 3, 4].map((i): [ChatSummary, TranscriptItem[]] => [chat(`e${i}`, { status: 'error', lastError: 'boom' }), []])
  const { app } = desk(undefined, errors, { asked: [], models: [], signedIn: [], refused: new Set(), ask: slow })
  await arm(app, true)
  expect(asked.filter((id) => id.startsWith('e'))).toHaveLength(5)
  expect(most).toBe(3)
})

test('a page look judges nothing; only the armed tick does', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  const model = judge({ error: { verdict: 'continue', message: 'Carry on.' } })
  const { app, sent } = desk(undefined, CHATS, model)
  await app.request('/api/diagnostics/orchestrator')
  expect([model.asked, sent]).toEqual([[], []])
})

test('each open chat and outside session gets its one next move, most urgent first, and nothing is sent', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  const { app, sent } = desk()
  const plan = (await (await app.request('/api/diagnostics/orchestrator')).json()) as OrchestratorPlan
  expect(plan.creaitor).toBe(false)
  expect(plan.rows.map((r) => [r.id, r.move, r.source])).toEqual([
    ['card', 'answer-question', 'desk'],
    ['o-ask', 'answer-question', 'desktop'],
    ['o-cut', 'answer-question', 'desktop'],
    ['need', 'answer-need', 'desk'],
    ['asks', 'answer-need', 'desk'],
    ['o-need', 'answer-need', 'cli'],
    ['error', 'retry-error', 'desk'],
    ['unreadable', 'retry-error', 'desk'],
    ['limited', 'resume-after-limit', 'desk'],
    ['moved', 'watch', 'desk'],
    ['continued', 'watch', 'desk'],
    ['busy', 'watch', 'desk'],
    ['o-busy', 'watch', 'desktop'],
    ['person', 'leave', 'desk'],
    ['permission', 'leave', 'desk'],
    ['o-window', 'leave', 'desktop'],
    ['o-person', 'leave', 'desktop'],
    ['finished', 'done', 'desk'],
    ['o-done', 'done', 'codex']
  ])
  const by = Object.fromEntries(plan.rows.map((r) => [r.id, r]))
  expect([by.card.question, by.card.options]).toEqual(['Which store?', ['S3', 'Disk']])
  expect([by['o-ask'].question, by['o-ask'].options, by['o-ask'].account]).toEqual(['Which region?', ['East', 'West'], '#2'])
  expect([by['o-cut'].question, by['o-cut'].options]).toEqual(['Keep the "old" cache?', ['Keep', 'Drop']])
  expect([by.need.question, by.need.options]).toEqual(['Ship the release now?', ['Wait a day', '--force']])
  expect([by['o-need'].question, by['o-need'].options]).toEqual(['Merge it?', ['Merge', 'Hold']])
  expect(by.asks.question).toBe('Want me to deploy it to the box too?')
  expect(by.continued.reason).toBe('the orchestrator continued it 2 min ago')
  expect(plan.counts).toEqual({ 'answer-question': 3, 'answer-need': 3, 'retry-error': 2, 'resume-after-limit': 1, watch: 4, leave: 4, done: 2 })
  expect([plan.mode, plan.acts]).toEqual(['shadow', []])
  expect(sent).toEqual([])
})

test("the judge signs in with the least used managed account nobody is using, and a second when that one's login is refused", async () => {
  // Desk's default ~/.claude login's token expires: every judgment failed on it (2026-10-09).
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  const account = (id: string, configDir: string | null, pct: number, inUse = false): AccountInfo => ({
    id, label: id, configDir, email: null, plan: 'Pro', signedIn: true, fiveHourPct: pct, weeklyPct: pct, fiveHourResetsAt: null, weeklyResetsAt: null, inUse
  })
  const dir = (id: string): string => `C:/Users/me/.claude-instances/${id}`
  const accounts = [account('default', null, 0), account('busy', dir('busy'), 1, true), account('a', dir('a'), 5), account('b', dir('b'), 40), account('full', dir('full'), 100)]
  const model = judge({ error: { verdict: 'continue', message: 'Pick up where you stopped.' } })
  model.refused.add(dir('a'))
  const { app, queued } = desk(undefined, CHATS, model, accounts)
  await arm(app, true)
  expect(model.signedIn.filter(([id]) => id === 'error').map(([, d]) => d)).toEqual([dir('a'), dir('b')])
  expect(queued.map((q) => q.chatId)).toEqual(['error'])
})

test('?ask=1 hands each waiting question and its choices to the CreAitor and shows its answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-creaitor-'))
  temps.push(dir)
  const tool = join(dir, 'creaitor.js')
  // Reads its command line as strictly as the CreAitor's argparse (a choice that starts with a dash and is not passed
  // as --option=value is refused) and answers with the last choice, so the row shows the choices arrived intact.
  const flags = { repo: 's', timeout: 's', json: 'b', session: 's', via: 's', option: 'm' }
  const options = Object.fromEntries(Object.entries(flags).map(([k, t]) => [k, { type: t === 'b' ? 'boolean' : 'string', multiple: t === 'm' }]))
  writeFileSync(tool, `const { values: v, positionals: p } = require('node:util').parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: ${JSON.stringify(options)} }); const o = v.option ?? []; console.log(JSON.stringify({ verdict: o.length ? 'decide' : 'escalate', option: o.at(-1) ?? '', answer: p[1], confidence: 0.9, basis: [v.session, v.via].filter(Boolean), need_line: o.length ? null : '🔴 NEED: x', mode: 'shadow' }))\n`)
  process.env.HYDRA_DESK_CREAITOR = tool
  process.env.HYDRA_DESK_PYTHON = process.execPath
  const { app, sent } = desk()
  const plan = (await (await app.request('/api/diagnostics/orchestrator?ask=1')).json()) as OrchestratorPlan
  const by = Object.fromEntries(plan.rows.map((r) => [r.id, r.creaitor]))
  // basis echoes --session and --via: an ask carries its chat's session, so the shadow log can be graded against
  // the owner's own reply there (claude-memory bench.py --shadow)
  expect(by.card).toMatchObject({ verdict: 'decide', option: 'Disk', answer: 'Which store?', basis: ['sess-card', 'orchestrator'] })
  expect(by.need).toMatchObject({ verdict: 'decide', option: '--force' })
  expect(by.asks).toMatchObject({ verdict: 'escalate', needLine: '🔴 NEED: x' })
  expect(by['o-ask']).toMatchObject({ verdict: 'decide', option: 'West', answer: 'Which region?', basis: ['o-ask', 'orchestrator'] })
  expect(by['o-need']).toMatchObject({ verdict: 'decide', option: 'Hold' })
  expect(by.finished).toBeUndefined()
  expect(sent).toEqual([])
}, 60_000) // five child processes; a cold runtime start alone took 4 s on a busy PC

test("an ask longer than the server's 10 s idle limit still reaches the page", async () => {
  // Bun closes a request that sends nothing for 10 s, and one CreAitor ask may take a minute (found live,
  // 2026-10-07: the page's ask dropped at 12 s). Through the real server, with only this plugin and a stand-in engine.
  const dir = mkdtempSync(join(tmpdir(), 'desk-orchestrator-'))
  temps.push(dir)
  const plugins = join(dir, 'plugins')
  mkdirSync(plugins)
  const need = said('🔴 NEED: Ship it? A) Yes B) No')
  writeFileSync(join(plugins, '20-chats.ts'), `export default function (app) {\n  app.get('/api/chats', (c) => c.json(${JSON.stringify([chat('need')])}))\n  app.get('/api/chats/:id/items', (c) => c.json(${JSON.stringify([need])}))\n}\n`)
  writeFileSync(join(plugins, '70-orchestrator.ts'), `export { default } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, '../../src/plugins/70-orchestrator.ts')).href)}\n`)
  const tool = join(dir, 'slow.js')
  writeFileSync(tool, `setTimeout(() => console.log(JSON.stringify({ verdict: 'decide', option: 'No', answer: '', confidence: 0.9, basis: [], mode: 'shadow' })), 15_000)\n`)
  process.env.HYDRA_DESK_CREAITOR = tool
  process.env.HYDRA_DESK_PYTHON = process.execPath
  const desk = await createServer({ port: 0, home: join(dir, 'home'), pluginsDir: plugins })
  servers.push(desk)
  const plan = (await (await realFetch(`${desk.url}/api/diagnostics/orchestrator?ask=1`)).json()) as OrchestratorPlan
  expect(plan.rows.map((r) => [r.id, r.creaitor])).toEqual([['need', { verdict: 'decide', answer: '', option: 'No', confidence: 0.9, basis: [], needLine: null, mode: 'shadow' }]])
}, 60_000)

test("a page that is not Desk's own is refused", async () => {
  const { app } = desk()
  const res = await app.request('/api/diagnostics/orchestrator', { headers: { origin: 'https://evil.example', host: 'localhost:7798' } })
  expect(res.status).toBe(403)
})
