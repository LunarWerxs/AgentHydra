// plugins/70-orchestrator.ts through its route: the chats and transcripts come from stand-in engine routes, the
// CreAitor from a stand-in script run by this test's own runtime. Nothing outside a temp folder is read or written.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import type { ChatSummary, ExternalSession, TranscriptItem } from '@shared/protocol'
import type { OrchestratorPlan } from '@shared/orchestrator'
import type { ServerContext } from '../../src/context'
import { createServer, type DeskServer } from '../../src/index'
import plugin from '../../src/plugins/70-orchestrator'

const NOW = Date.now()
const temps: string[] = []
const servers: DeskServer[] = []
const saved = { tool: process.env.HYDRA_DESK_CREAITOR, python: process.env.HYDRA_DESK_PYTHON }
afterEach(async () => {
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
  [chat('card', { status: 'needs_you' }), [{ id: 'q', ts: NOW - 3_600_000, kind: 'question', state: 'pending', questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'S3' }, { label: 'Disk' }] }] }]],
  [chat('need'), [said('Done the rest.\n\n🔴 NEED: Ship the release now? A) Ship it ★ B) Wait a day')]],
  [chat('asks'), [said('All green. Want me to deploy it to the box too?')]],
  [chat('person'), [said('🔴 NEED: Pick one? A) x B) y', 3_000_000), wrote(120_000)]],
  [chat('permission', { status: 'needs_you' }), [{ id: 'p', ts: NOW - 3_600_000, kind: 'permission', toolName: 'Bash', input: {}, canAlwaysAllow: false, state: 'pending' }]],
  [chat('limited', { status: 'limited', limitResetsAt: NOW + 3_600_000 }), [said('Working on it.')]],
  [chat('moved', { status: 'limited', accountAuto: true }), []],
  [chat('error', { status: 'error', lastError: 'network down' }), []],
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

/** The plugin over a stand-in engine; `sent` counts every request that would change something. */
function desk(): { app: Hono; sent: string[] } {
  const app = new Hono()
  const sent: string[] = []
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET') sent.push(`${c.req.method} ${c.req.path}`)
    await next()
  })
  app.get('/api/chats', (c) => c.json(CHATS.map(([ch]) => ch)))
  app.get('/api/chats/:id/items', (c) => c.json(CHATS.find(([ch]) => ch.id === c.req.param('id'))?.[1] ?? []))
  app.get('/api/external/sessions', (c) => c.json(OUTSIDE.map(([s]) => s)))
  app.get('/api/external/sessions/:id/items', (c) => c.json(OUTSIDE.find(([s]) => s.id === c.req.param('id'))?.[1] ?? []))
  plugin(app, {} as ServerContext)
  return { app, sent }
}

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
    ['limited', 'resume-after-limit', 'desk'],
    ['moved', 'watch', 'desk'],
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
  expect([by.need.question, by.need.options]).toEqual(['Ship the release now?', ['Ship it', 'Wait a day']])
  expect([by['o-need'].question, by['o-need'].options]).toEqual(['Merge it?', ['Merge', 'Hold']])
  expect(by.asks.question).toBe('Want me to deploy it to the box too?')
  expect(plan.counts).toEqual({ 'answer-question': 3, 'answer-need': 3, 'retry-error': 1, 'resume-after-limit': 1, watch: 3, leave: 4, done: 2 })
  expect(sent).toEqual([])
})

test('?ask=1 hands each waiting question and its choices to the CreAitor and shows its answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-creaitor-'))
  temps.push(dir)
  const tool = join(dir, 'creaitor.js')
  // Answers with the last --option it was given, so the row shows the choices arrived.
  writeFileSync(tool, `const a = process.argv.slice(2); const o = a.filter((x, i) => a[i - 1] === '--option'); console.log(JSON.stringify({ verdict: o.length ? 'decide' : 'escalate', option: o.at(-1) ?? '', answer: a[1], confidence: 0.9, basis: ['r1'], need_line: o.length ? null : '🔴 NEED: x', mode: 'shadow' }))\n`)
  process.env.HYDRA_DESK_CREAITOR = tool
  process.env.HYDRA_DESK_PYTHON = process.execPath
  const { app, sent } = desk()
  const plan = (await (await app.request('/api/diagnostics/orchestrator?ask=1')).json()) as OrchestratorPlan
  const by = Object.fromEntries(plan.rows.map((r) => [r.id, r.creaitor]))
  expect(by.card).toMatchObject({ verdict: 'decide', option: 'Disk', answer: 'Which store?', basis: ['r1'] })
  expect(by.need).toMatchObject({ verdict: 'decide', option: 'Wait a day' })
  expect(by.asks).toMatchObject({ verdict: 'escalate', needLine: '🔴 NEED: x' })
  expect(by['o-ask']).toMatchObject({ verdict: 'decide', option: 'West', answer: 'Which region?' })
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
