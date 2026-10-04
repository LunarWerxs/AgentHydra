// A chat Hydra Desk runs itself (an import, a fork, or one stored before chats became CliMayte workers) runs in a
// chat host (SPEC "Chat hosts"): a server restart leaves it running, and the next server takes it over where it
// is. The host here is the real core behind its real websocket, in this process; Claude Code is a FakeQuery the
// test drives.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerEvent, TranscriptItem } from '@shared/protocol'
import { ChatManager } from '../../src/engine/chat-manager'
import { chatQueryImpl, HostedQuery, type HostedDeps } from '../../src/host/client'
import { HostCore } from '../../src/host/core'
import { hostFilePath, writeHostFile } from '../../src/host/launch'
import { HOST_PROTOCOL, type HostFile, type HostSpec } from '../../src/host/protocol'
import { serveHost } from '../../src/host/serve'
import { DEFAULT_SETTINGS } from '../../src/settings'
import { fakeBridge, FakeQuery } from '../engine/manager/fakes'

const temps: string[] = []
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Host {
  core: HostCore
  fake: FakeQuery
  exited: number | null
}

/** Chat hosts in this process: launch() starts the real core behind its real websocket, a FakeQuery for Claude Code. */
function hostsIn(home: string) {
  const hosts: Host[] = []
  const deps: HostedDeps = {
    home,
    launch: async (spec: HostSpec): Promise<HostFile> => {
      const host = { exited: null } as Host
      const core = new HostCore({
        spec,
        queryImpl: ({ prompt, options }) => {
          host.fake = new FakeQuery(prompt, options)
          return host.fake as unknown as Query
        },
        exit: (code) => {
          host.exited = code
          server.stop(true)
          rmSync(hostFilePath(spec.dir, spec.chatId), { force: true })
        },
      })
      host.core = core
      const server = serveHost(core, spec.token)
      cleanups.push(() => {
        if (host.exited === null) core.shutdown(0)
      })
      const file: HostFile = { protocol: HOST_PROTOCOL, chatId: spec.chatId, pid: process.pid, port: server.port as number, token: spec.token, startedAt: core.startedAt }
      writeHostFile(spec.dir, file)
      core.start()
      hosts.push(host)
      return file
    },
  }
  return { hosts, deps }
}

/** Chats this process runs (no CliMayte worker), stored as a server before this one left them. */
function storeChats(home: string, ids: string[]): void {
  const chats = ids.map((id, i) => ({
    id,
    sessionId: null,
    title: `Chat ${i + 1}`,
    cwd: home,
    account: { id: 'default', label: 'Default', configDir: null },
    accountAuto: false,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: false,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    costUsd: 0,
    contextPct: null,
  }))
  writeFileSync(join(home, 'chats.json'), JSON.stringify(chats))
}

const CHAT = 'c0ffee00-0000-4000-8000-0000000000a1'
const OTHER = 'c0ffee00-0000-4000-8000-0000000000b2'

/** One Hydra Desk server's engine over `home`. */
function desk(home: string, deps: HostedDeps) {
  const events: ServerEvent[] = []
  const m = new ChatManager({
    home,
    emit: (e) => events.push(e),
    settings: () => DEFAULT_SETTINGS,
    bridge: fakeBridge().bridge,
    queryImpl: (p) => new HostedQuery(p, deps).query,
    agentHydraMcp: null,
    env: { PATH: '/bin' },
    storeDebounceMs: 1,
  })
  cleanups.push(() => m.closeAll())
  return { m, events }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const SID = 'hosted-session-0001'
let n = 0
const uuid = () => `40000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const msg = (m: Record<string, unknown>) => ({ uuid: uuid(), session_id: SID, ...m }) as unknown as SDKMessage
const init = () => msg({ type: 'system', subtype: 'init', cwd: '/', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', skills: [], plugins: [], claude_code_version: '2' })
const state = (s: 'running' | 'idle' | 'requires_action') => msg({ type: 'system', subtype: 'session_state_changed', state: s })
const text = (id: string, t: string) => msg({ type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', content: [{ type: 'text', text: t }] } })
const toolUse = (id: string, toolId: string) => msg({ type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls' } }] } })
const toolResult = (toolId: string, out: string) => msg({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: out }] } })
const result = (cost: number) => msg({ type: 'result', subtype: 'success', is_error: false, result: 'Listed the files', total_cost_usd: cost, duration_ms: 5, num_turns: 2 })

/** Claude Code asks the host whether it may run the tool, with the SDK's own request id. */
function ask(fake: FakeQuery, toolUseID: string, requestId: string): Promise<PermissionResult | null> {
  const canUseTool = fake.options.canUseTool as CanUseTool
  return canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID, requestId, suggestions: [] })
}

const notifies = (events: ServerEvent[]) => events.flatMap((e) => (e.type === 'notify' ? [e.reason] : []))
const lines = (home: string, chatId: string) => readFileSync(join(home, 'chats', `${chatId}.jsonl`), 'utf8').trim().split('\n').length
const byId = (items: TranscriptItem[], id: string) => items.find((i) => i.id === id)

test('a restart leaves a working chat running, and the next server takes it over where it is', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-hosts-'))
  temps.push(home)
  const { hosts, deps } = hostsIn(home)

  // Server 1: the turn starts and Claude asks to run a command.
  storeChats(home, [CHAT])
  const s1 = desk(home, deps)
  await s1.m.send(CHAT, 'list the files')
  const chat = s1.m.get(CHAT)
  await waitFor(() => hosts.length === 1 && hosts[0]!.fake?.sent.length === 1)
  const host = hosts[0]!
  host.fake.push(init(), state('running'), text('msg_1', 'Looking at the folder.'), toolUse('msg_1', 'tu_1'))
  const allowed = ask(host.fake, 'tu_1', 'req-1')
  await waitFor(() => s1.m.get(chat.id).status === 'needs_you')
  expect(notifies(s1.events)).toEqual(['needs_you'])

  // The server stops (a restart); the chat goes on in its host, the question still open there.
  await s1.m.closeAll()
  expect(host.exited).toBeNull()
  const before = lines(home, chat.id)

  // Server 2 takes it over: the same card, still waiting, told no one twice, the transcript not written again.
  const s2 = desk(home, deps)
  expect(await s2.m.attachHosts()).toBe(1)
  expect(s2.m.get(chat.id)).toMatchObject({ status: 'needs_you', pendingCount: 1 })
  const items = s2.m.listItems(chat.id)
  expect(byId(items, 'req-1')).toMatchObject({ kind: 'permission', state: 'pending', toolUseId: 'tu_1' })
  expect(byId(items, 'msg_1:0')).toMatchObject({ kind: 'assistant_text', text: 'Looking at the folder.' })
  expect(byId(items, 'tu_1')).toMatchObject({ kind: 'tool_use', status: 'running' })
  expect(notifies(s2.events)).toEqual([])
  expect(lines(home, chat.id)).toBe(before)

  // Answered on server 2, the answer reaches Claude Code in the host.
  s2.m.respondPermission(chat.id, 'req-1', { decision: 'allow' })
  expect(await allowed).toMatchObject({ behavior: 'allow' })

  // Another restart mid-turn: what the turn does while no server is there is told by the next one.
  host.fake.push(toolResult('tu_1', 'a.txt\nb.txt'))
  await waitFor(() => (byId(s2.m.listItems(chat.id), 'tu_1') as { status?: string } | undefined)?.status === 'done')
  await s2.m.closeAll()
  host.fake.push(text('msg_2', 'Two files: a.txt and b.txt.'), result(0.25), state('idle'))
  await new Promise((r) => setTimeout(r, 50))

  const s3 = desk(home, deps)
  expect(await s3.m.attachHosts()).toBe(1)
  expect(s3.m.get(chat.id)).toMatchObject({ status: 'idle', costUsd: 0.25 })
  const after = s3.m.listItems(chat.id)
  expect(byId(after, 'msg_2:0')).toMatchObject({ text: 'Two files: a.txt and b.txt.' })
  expect(after.filter((i) => i.kind === 'result')).toHaveLength(1)
  expect(after.filter((i) => i.kind === 'user')).toHaveLength(1)
  // The turn finished while no server was there: this one says so, once.
  expect(notifies(s3.events)).toEqual(['finished'])

  // The next turn goes to the same process: one host for the chat's whole life.
  await s3.m.send(chat.id, 'and the hidden ones?')
  await waitFor(() => host.fake.sent.length === 2)
  expect(hosts).toHaveLength(1)
  host.fake.push(state('running'), text('msg_3', 'None.'), result(0.4), state('idle'))
  await waitFor(() => s3.m.get(chat.id).status === 'idle' && s3.m.get(chat.id).costUsd === 0.4)
})

test('a second server on the same folder leaves the chats running there alone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-hosts-'))
  temps.push(home)
  const { hosts, deps } = hostsIn(home)
  storeChats(home, [CHAT])
  const s1 = desk(home, deps)
  expect(await s1.m.attachHosts()).toBe(0) // the folder is s1's now
  await s1.m.send(CHAT, 'stay with me')
  await waitFor(() => hosts.length === 1 && hosts[0]!.fake?.sent.length === 1)
  // s1 as another process would hold it: alive, and answering on its port.
  const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true }) })
  cleanups.push(() => other.stop(true))
  writeFileSync(join(home, 'hosts', 'server.json'), JSON.stringify({ pid: process.ppid, port: other.port }))
  const s2 = desk(home, deps)
  expect(await s2.m.attachHosts()).toBe(0)
  expect(s2.m.get(CHAT).status).toBe('closed')
  // The chat is still s1's.
  hosts[0]!.fake.push(init(), state('running'), text('msg_1', 'Still here.'))
  await waitFor(() => s1.m.get(CHAT).status === 'working')
})

test("only a chat's own query runs in a host: a one-shot query (a title) runs here", async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-hosts-'))
  temps.push(home)
  const { hosts, deps } = hostsIn(home)
  const here: string[] = []
  const impl = chatQueryImpl(deps, {}, ({ prompt }) => {
    here.push(typeof prompt === 'string' ? prompt : 'stream')
    return new FakeQuery(prompt, {}) as unknown as Query
  })
  impl({ prompt: 'Name this chat: list the files' })
  expect(here).toEqual(['Name this chat: list the files'])
  const q = impl({ prompt: (async function* () {})(), chatId: CHAT, account: { id: 'default', label: 'Default', configDir: null } })
  await waitFor(() => hosts.length === 1)
  expect(here).toHaveLength(1)
  q.close()
  // Hosts off: a chat runs here too.
  chatQueryImpl(deps, { HYDRA_DESK_HOSTS: '0' }, ({ prompt }) => {
    here.push(typeof prompt === 'string' ? prompt : 'stream')
    return new FakeQuery(prompt, {}) as unknown as Query
  })({ prompt: (async function* () {})(), chatId: CHAT })
  expect(here).toEqual(['Name this chat: list the files', 'stream'])
})

test('closing a hosted chat ends its host; a server stop with chats ends them all', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-hosts-'))
  temps.push(home)
  const { hosts, deps } = hostsIn(home)
  storeChats(home, [CHAT, OTHER])
  const s1 = desk(home, deps)
  await s1.m.send(CHAT, 'one')
  await s1.m.send(OTHER, 'two')
  await waitFor(() => hosts.length === 2 && hosts.every((h) => h.fake?.sent.length === 1))
  await s1.m.delete(CHAT)
  await waitFor(() => hosts[0]!.exited !== null)
  expect(hosts[1]!.exited).toBeNull()
  await s1.m.closeAll({ chats: true })
  await waitFor(() => hosts[1]!.exited !== null)
  expect(s1.m.get(OTHER).status).toBe('closed')
  // Nothing is left for the next server.
  const s2 = desk(home, deps)
  expect(await s2.m.attachHosts()).toBe(0)
})
