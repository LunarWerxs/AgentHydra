// Continuing a session that ran under another account or outside Hydra Desk (SPEC "Elsewhere"): only a
// Claude Code session is adopted, never onto the default login unasked, in place when its account folder
// holds it, else as a copy (sidecar folder included) taken from the folder the chat last ran in, also
// after a restart; a session no folder here has is refused at its send, in words.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo, DeskSettings, ExternalSession, TranscriptItem } from '@shared/protocol'
import { DEFAULT_ACCOUNT } from '../../../src/bridge/accounts'
import { encodeProjectDir } from '../../../src/bridge/session-jsonl'
import { ChatError, ChatManager, type ManagerBridge } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

const account = (num: number, configDir: string): AccountInfo => ({
  id: `acct-${num}`,
  label: `#${num} user${num} (Pro)`,
  configDir,
  number: num,
  email: null,
  plan: 'Pro',
  signedIn: true,
  fiveHourPct: 10,
  weeklyPct: 10,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  inUse: false,
})

/** Desk's home, a project folder, two accounts and a projects folder AgentHydra lists that is no account's. */
function world() {
  const elsewhere = join(temp('desk-claude-'), 'projects')
  return { home: temp('desk-continue-'), cwd: temp('desk-cwd-'), a: account(35, temp('desk-acct-35-')), b: account(132, temp('desk-acct-132-')), elsewhere }
}
type World = ReturnType<typeof world>

/** Settings' default account is `a` unless a test names another: Hydra Desk places nothing itself. */
function boot(w: World, o: { external?: ExternalSession[]; older?: ExternalSession[]; settings?: Partial<DeskSettings> } = {}) {
  process.env.HYDRA_DESK_HOME = w.home
  const q = fakeQueries()
  const bridge: ManagerBridge = {
    ...fakeBridge({ external: o.external, older: o.older, roots: [w.elsewhere, join(w.a.configDir!, 'projects'), join(w.b.configDir!, 'projects')] }).bridge,
    listAccounts: async () => [w.a, w.b],
  }
  const m = new ChatManager({
    home: w.home,
    claudeHome: w.home,
    emit: () => {},
    settings: () => ({ ...DEFAULT_SETTINGS, defaultAccountId: w.a.id, ...o.settings }),
    bridge,
    queryImpl: q.queryImpl,
    agentHydraMcp: null,
    env: { PATH: '/bin' },
    storeDebounceMs: 1,
    newChats: 'sdk',
  })
  managers.push(m)
  return { m, ...q }
}

/** A transcript file at <projects root>/<cwd's folder>/<id>.jsonl. */
function transcript(root: string, w: World, id: string, text: string, mtimeSec?: number): string {
  const file = join(root, encodeProjectDir(w.cwd), `${id}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec)
  return file
}
const projects = (a: AccountInfo) => join(a.configDir!, 'projects')

const outside = (id: string, source: ExternalSession['source'], cwd: string): ExternalSession => ({
  id,
  title: 'Elsewhere',
  cwd,
  source,
  instance: null,
  status: 'idle',
  activity: null,
  lastActivityAt: 1,
  model: null,
  accountId: null,
  canResume: false,
  pinned: false,
  archived: false,
  unread: false,
  group: null,
})

async function refusal(p: Promise<unknown>): Promise<ChatError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(err instanceof ChatError)) throw new Error(`expected a ChatError, got ${String(err)}`)
  return err
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const systemTexts = (items: TranscriptItem[]) => items.flatMap((i) => (i.kind === 'system' ? [i.text] : []))

let n = 0
const uuid = () => `40000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const init = (sessionId: string): SDKMessage =>
  ({ type: 'system', subtype: 'init', session_id: sessionId, uuid: uuid(), cwd: '/', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', skills: [], plugins: [], claude_code_version: '2' }) as unknown as SDKMessage

test('Codex, CliMayte worker and other sessions are read-only: the import, or a fork of one, is refused in a sentence', async () => {
  const w = world()
  const t = boot(w, { external: [outside('codex-sess-1', 'codex', w.cwd), outside('worker-sess-1', 'climayte', w.cwd), outside('other-sess-1', 'other', w.cwd)] })
  for (const [id, name] of [
    ['codex-sess-1', 'Codex'],
    ['worker-sess-1', 'CliMayte worker'],
    ['other-sess-1', 'outside'],
  ] as const) {
    const err = await refusal(t.m.importSession({ sessionId: id, cwd: w.cwd, title: 'From elsewhere' }))
    expect(err.status).toBe(400)
    expect(err.message).toBe(`This ${name} session is read-only: only Claude Desktop and terminal sessions can be continued in Hydra Desk.`)
  }
  expect((await refusal(t.m.importSession({ sessionId: 'codex-sess-1', fork: true }))).status).toBe(400)
  expect(t.m.list()).toEqual([])
})

test('a read-only session older than the 24-hour list is refused too: it is looked up on its own', async () => {
  const w = world()
  const t = boot(w, { older: [outside('codex-old-1', 'codex', w.cwd)] })
  const err = await refusal(t.m.importSession({ sessionId: 'codex-old-1', cwd: w.cwd, title: 'Last week' }))
  expect(err.status).toBe(400)
  expect(err.message).toBe('This Codex session is read-only: only Claude Desktop and terminal sessions can be continued in Hydra Desk.')
  expect(t.m.list()).toEqual([])
})

test('two imports of one session at once (two windows) make one chat', async () => {
  const w = world()
  const t = boot(w)
  const req = { sessionId: '1b1b1b1b-1111-4222-8333-444455556666', cwd: w.cwd, title: 'From Desktop' }
  const [a, b] = await Promise.all([t.m.importSession(req), t.m.importSession(req)])
  expect(b.id).toBe(a.id)
  expect(t.m.list().map((c) => c.id)).toEqual([a.id])
})

test('unasked, an import never lands on the default login and says so; named, it does', async () => {
  const w = world()
  const t = boot(w, { settings: { defaultAccountId: 'auto' } })
  const req = { sessionId: '1a1a1a1a-1111-4222-8333-444455556666', cwd: w.cwd, title: 'From Desktop' }
  const err = await refusal(t.m.importSession(req))
  expect(err.status).toBe(409)
  expect(err.message).toBe('Choose the account to continue this session on: Hydra Desk does not choose one.')
  expect(t.m.list()).toEqual([])
  expect((await t.m.importSession({ ...req, configDir: null })).account.id).toBe(DEFAULT_ACCOUNT.id)
})

test("an import lands on Settings' default account; one under a named folder is that folder's", async () => {
  const w = world()
  const t = boot(w)
  const placed = await t.m.importSession({ sessionId: '2b2b2b2b-1111-4222-8333-444455556666', cwd: w.cwd, title: 'Placed' })
  expect(placed).toMatchObject({ account: { id: w.a.id }, accountAuto: false })
  const named = await t.m.importSession({ sessionId: '3c3c3c3c-1111-4222-8333-444455556666', cwd: w.cwd, title: 'Named', configDir: w.b.configDir })
  expect(named).toMatchObject({ account: { id: w.b.id }, accountAuto: false })
})

test('a session its account folder holds continues in place: nothing is copied', async () => {
  const w = world()
  const t = boot(w)
  const id = '4d4d4d4d-1111-4222-8333-444455556666'
  transcript(projects(w.a), w, id, '{"type":"user"}\n')
  const chat = await t.m.importSession({ sessionId: id, cwd: w.cwd, title: 'In place', configDir: w.a.configDir })
  await t.m.send(chat.id, 'carry on')
  expect(t.last().options).toMatchObject({ resume: id, env: { CLAUDE_CONFIG_DIR: w.a.configDir } })
  expect(systemTexts(t.m.listItems(chat.id)).some((s) => s.startsWith('Copied'))).toBe(false)
})

test('a session no folder on this machine has: the send is refused, the transcript says why, nothing starts', async () => {
  const w = world()
  const t = boot(w)
  const id = '5e5e5e5e-1111-4222-8333-444455556666'
  const chat = await t.m.importSession({ sessionId: id, cwd: w.cwd, title: 'Gone', configDir: w.a.configDir })
  const err = await refusal(t.m.send(chat.id, 'carry on'))
  const why = `No folder on this machine has session ${id}, so it cannot be resumed.`
  expect(err.status).toBe(409)
  expect(err.message).toBe(why)
  expect(t.all).toHaveLength(0)
  expect(systemTexts(t.m.listItems(chat.id))).toContain(why)
  expect(t.m.get(chat.id).status).toBe('closed')
})

test('a fork of an outside session is copied into its account folder with its sidecar, and forked there', async () => {
  const w = world()
  const t = boot(w)
  const id = '6f6f6f6f-1111-4222-8333-444455556666'
  transcript(w.elsewhere, w, id, JSON.stringify({ type: 'user', uuid: 'u-1', parentUuid: null }) + '\n')
  const agent = join(w.elsewhere, encodeProjectDir(w.cwd), id, 'subagents', 'agent-a1.jsonl')
  mkdirSync(dirname(agent), { recursive: true })
  writeFileSync(agent, '{"type":"assistant"}\n')
  const fork = await t.m.importSession({ sessionId: id, cwd: w.cwd, title: 'Desktop chat', configDir: w.b.configDir, fork: true })
  await t.m.send(fork.id, 'take it from here')
  expect(t.last().options).toMatchObject({ resume: id, forkSession: true, resumeSessionAt: 'u-1', env: { CLAUDE_CONFIG_DIR: w.b.configDir } })
  expect(existsSync(join(projects(w.b), encodeProjectDir(w.cwd), `${id}.jsonl`))).toBe(true)
  expect(readFileSync(join(projects(w.b), encodeProjectDir(w.cwd), id, 'subagents', 'agent-a1.jsonl'), 'utf8')).toBe('{"type":"assistant"}\n')
})

test("a session continued on the default login is seeded under the manager's Claude home, never the real ~/.claude", async () => {
  const w = world()
  const t = boot(w)
  const id = '8b8b8b8b-1111-4222-8333-444455556666'
  transcript(w.elsewhere, w, id, '{"type":"user"}\n')
  const chat = await t.m.importSession({ sessionId: id, cwd: w.cwd, title: 'Default login', configDir: null })
  await t.m.send(chat.id, 'carry on')
  expect(t.last().options).toMatchObject({ resume: id })
  expect(existsSync(join(w.home, '.claude', 'projects', encodeProjectDir(w.cwd), `${id}.jsonl`))).toBe(true)
  expect(existsSync(join(homedir(), '.claude', 'projects', encodeProjectDir(w.cwd)))).toBe(false)
})

test('after a restart a chat switched to another account resumes from the folder it last ran in, not the newest copy', async () => {
  const w = world()
  const id = '7a7a7a7a-1111-4222-8333-444455556666'
  const first = boot(w)
  const chat = await first.m.create({ cwd: w.cwd, prompt: 'remember this', accountId: w.a.id })
  await waitFor(() => first.all.length === 1)
  first.last().push(init(id))
  await waitFor(() => first.m.get(chat.id).sessionId === id)
  // the CLI wrote the turns under #35; a diverged copy elsewhere is newer
  transcript(projects(w.a), w, id, 'turn 1\nturn 2 on #35\n', 1_000)
  transcript(w.elsewhere, w, id, 'turn 1\nsomeone else\n', 2_000)
  managers.splice(managers.indexOf(first.m), 1)
  await first.m.closeAll()

  const second = boot(w)
  await second.m.patch(chat.id, { accountId: w.b.id })
  await second.m.send(chat.id, 'go on')
  expect(readFileSync(join(projects(w.b), encodeProjectDir(w.cwd), `${id}.jsonl`), 'utf8')).toBe('turn 1\nturn 2 on #35\n')
  expect(second.last().options).toMatchObject({ resume: id, env: { CLAUDE_CONFIG_DIR: w.b.configDir } })
  expect(systemTexts(second.m.listItems(chat.id)).some((s) => s.startsWith("Copied this session into #132 user132 (Pro)'s folder"))).toBe(true)
})
