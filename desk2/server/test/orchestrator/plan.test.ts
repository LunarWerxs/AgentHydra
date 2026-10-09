// plugins/70-orchestrator.ts through its route: the chats and transcripts come from stand-in engine routes (the send
// queue's too, which records what the armed orchestrator queues), the CreAitor from a stand-in script run by this
// test's own runtime. Nothing outside a temp folder is read or written.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import type { ChatSummary, ExternalSession, TranscriptItem } from '@shared/protocol'
import { ORCHESTRATOR_FROM, type OrchestratorPlan } from '@shared/orchestrator'
import type { ServerContext } from '../../src/context'
import { createServer, type DeskServer } from '../../src/index'
import plugin from '../../src/plugins/70-orchestrator'

const NOW = Date.now()
const temps: string[] = []
const servers: DeskServer[] = []
const stops: (() => void | Promise<void>)[] = []
const saved = { tool: process.env.HYDRA_DESK_CREAITOR, python: process.env.HYDRA_DESK_PYTHON }
afterEach(async () => {
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

/** The plugin over a stand-in engine; `sent` counts every request that would change something, and `queued` holds
 *  each message handed to the send queue and not yet delivered (a test delivers them by emptying it). `onQueue` runs
 *  while the queue takes a message. */
function desk(onQueue?: (app: Hono) => Promise<unknown>, chats = CHATS): { app: Hono; sent: string[]; queued: { chatId: string; text: string }[] } {
  const app = new Hono()
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
  // The `orchestrator` setting is what arming saves.
  const settings = { orchestrator: false }
  plugin(app, { onStop: (fn: () => void) => stops.push(fn), settings: () => settings, updateSettings: (p: object) => Object.assign(settings, p) } as unknown as ServerContext)
  return { app, sent, queued }
}

/** The page's Arm / Disarm. */
const arm = async (app: Hono, armed: boolean): Promise<OrchestratorPlan> =>
  (await (await app.request('/api/diagnostics/orchestrator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ armed }) })).json()) as OrchestratorPlan

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

test('armed, it continues each Desk chat an error stopped, once per stop and twice at most, and leaves a limit stop to the babysitter', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  const { app, sent, queued } = desk()
  const lead = `[${ORCHESTRATOR_FROM}] Not from the user.\n`
  const continued = ['POST /api/diagnostics/orchestrator', 'POST /api/queue', 'POST /api/queue/chats/error/resume']
  // Arming looks at once: the chat an error stopped gets one continue; never 'unreadable', whose transcript did not
  // load (a person may have just written in it), nor 'limited', which the babysitter continues after its reset.
  const first = await arm(app, true)
  expect(first.mode).toBe('armed')
  expect(sent.splice(0)).toEqual(continued)
  expect(queued.map((q) => q.chatId)).toEqual(['error'])
  expect(queued[0].text).toStartWith(`${lead}Your last turn stopped on an error: network down`)
  expect(first.acts.map((a) => [a.id, a.move, a.did, a.error])).toEqual([['error', 'retry-error', 'continued', undefined]])
  // While it waits in the send queue, another look sends nothing.
  expect((await arm(app, true)).acts).toHaveLength(1)
  expect(sent.splice(0)).toEqual(['POST /api/diagnostics/orchestrator'])
  // Delivered, and stopped again (the stand-ins never change): one more.
  queued.splice(0)
  expect((await arm(app, true)).acts).toHaveLength(2)
  expect(sent.splice(0)).toEqual(continued)
  // The third stop: it gives up, sends nothing, and the plan leaves it to a person, for good.
  queued.splice(0)
  const third = await arm(app, true)
  expect([sent.splice(0), queued]).toEqual([['POST /api/diagnostics/orchestrator'], []])
  expect(third.acts[0]).toMatchObject({ id: 'error', did: 'gave-up' })
  const by = Object.fromEntries(third.rows.map((r) => [r.id, r]))
  expect([by.error.move, by.limited.move, by.unreadable.move]).toEqual(['leave', 'resume-after-limit', 'retry-error'])
  expect(by.error.reason).toBe('the orchestrator continued it 2 times and it stopped again: network down')
  expect(by.limited.reason).toBe('its account hit the usage limit; the babysitter continues it in 60 min, when it resets')
  for (const _ of [5, 6]) expect((await arm(app, true)).acts).toHaveLength(3)
  const off = await arm(app, false)
  expect([off.mode, sent.splice(0), queued]).toEqual(['shadow', Array(3).fill('POST /api/diagnostics/orchestrator'), []])
})

test('a disarm part-way through a look stops it before the next send', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  // The owner's Disarm lands while the queue takes the look's first continue, with a second chat still to continue.
  const { app, queued } = desk((self) => arm(self, false), [...CHATS, [chat('error-2', { status: 'error', lastError: 'timed out' }), []]])
  await arm(app, true)
  expect(queued.map((q) => q.chatId)).toEqual(['error'])
  const plan = (await (await app.request('/api/diagnostics/orchestrator')).json()) as OrchestratorPlan
  expect([plan.mode, plan.acts.map((a) => a.id)]).toEqual(['shadow', ['error']])
})

// The foreman (orchestrator/foreman.ts): one check-in per episode, never into a chat a person is writing in, and a chat
// that stopped writing is only flagged.
test('armed, the foreman checks in once on a running chat that keeps failing the same step, and only flags one that stopped writing', async () => {
  process.env.HYDRA_DESK_CREAITOR = join(tmpdir(), 'no-such-creaitor.py')
  const failed = (n: number, status: 'error' | 'done' = 'error'): TranscriptItem => ({
    id: `t${n}`, ts: NOW - (10 - n) * 60_000, kind: 'tool_use', name: 'Bash', input: { command: 'bun test' }, status, startedAt: NOW - (10 - n) * 60_000
  })
  const { app, queued } = desk(undefined, [
    [chat('spinning', { status: 'working', activity: 'Bash: bun test' }), [failed(1), failed(2), failed(3)]],
    [chat('quiet', { status: 'working' }), [said('Starting on it.', 30 * 60_000)]],
    [chat('moving', { status: 'working' }), [failed(4), failed(5, 'done')]],
    [chat('person', { status: 'working' }), [failed(6), failed(7), failed(8), wrote(60_000)]]
  ])
  const first = await arm(app, true)
  expect(queued.map((q) => q.chatId)).toEqual(['spinning'])
  expect(queued[0].text).toStartWith(`[${ORCHESTRATOR_FROM}] Not from the user.\nA check-in: the same Bash call failed 3 times.`)
  expect(first.acts.map((a) => [a.id, a.did, a.detail])).toEqual([
    ['quiet', 'flagged', 'nothing new for 30 min while it says it is working'],
    ['spinning', 'nudged', 'the same Bash call failed 3 times']
  ])
  expect(first.rows.find((r) => r.id === 'spinning')?.reason).toBe('working: Bash: bun test; the foreman saw: the same Bash call failed 3 times')
  // The next look, inside the peek interval, sends nothing more.
  queued.splice(0)
  expect((await arm(app, true)).acts).toHaveLength(2)
  expect(queued).toEqual([])
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
  const plan = (await (await fetch(`${desk.url}/api/diagnostics/orchestrator?ask=1`)).json()) as OrchestratorPlan
  expect(plan.rows.map((r) => [r.id, r.creaitor])).toEqual([['need', { verdict: 'decide', answer: '', option: 'No', confidence: 0.9, basis: [], needLine: null, mode: 'shadow' }]])
}, 60_000)

test("a page that is not Desk's own is refused", async () => {
  const { app } = desk()
  const res = await app.request('/api/diagnostics/orchestrator', { headers: { origin: 'https://evil.example', host: 'localhost:7798' } })
  expect(res.status).toBe(403)
})
