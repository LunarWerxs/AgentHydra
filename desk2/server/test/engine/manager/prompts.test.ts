// Prompts through the real server (SPEC "Prompts"): the elicitation answer route, and a request a dead
// process left 'pending' on disk, which is settled when the chat's items are read.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ElicitationResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { createServer, type DeskServer } from '../../../src/index'
import { fakeBridge, fakeQueries } from './fakes'

const PLUGIN = join(import.meta.dir, '..', '..', '..', 'src', 'plugins', '20-engine.ts')
const SID = 'prompts-session-0001'

const temps: string[] = []
const servers: DeskServer[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

async function boot(home = temp('desk-prompts-home-')) {
  const plugins = temp('desk-prompts-plugins-')
  writeFileSync(join(plugins, '20-engine.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const q = fakeQueries()
  const desk = await createServer({
    port: 0,
    home,
    pluginsDir: plugins,
    deps: { newChats: 'sdk', queryImpl: q.queryImpl, bridge: fakeBridge().bridge, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 },
  })
  servers.push(desk)
  return { desk, home, ...q }
}

async function call<T = any>(desk: DeskServer, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await fetch(desk.url + path, init)
  return { status: res.status, body: (await res.json()) as T }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const state = (s: 'running' | 'idle'): SDKMessage => ({ type: 'system', subtype: 'session_state_changed', state: s, uuid: `s-${s}-${Date.now()}`, session_id: SID }) as unknown as SDKMessage

describe('POST /api/chats/:id/elicitation/:requestId', () => {
  test('a bad body or a refused form answer is a 400 and leaves it open; the right answer goes back; a second one is a 404', async () => {
    const t = await boot()
    const { body: chat } = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd: temp('desk-cwd-'), prompt: 'go' })
    const fake = t.last()
    fake.push(state('running'))
    await waitFor(() => fake.sent.length === 1)

    const decision = fake.options.onElicitation!(
      {
        serverName: 'connections',
        message: 'Pick a workspace',
        requestedSchema: { properties: { workspace: { type: 'string', title: 'Workspace', enum: ['a', 'b'] } }, required: ['workspace'] },
      },
      { signal: new AbortController().signal, requestId: 'r1' },
    ) as Promise<ElicitationResult>
    const items = async () => (await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${chat.id}/items`)).body
    const open = (await items()).find((i) => i.kind === 'elicitation')!
    expect(open).toMatchObject({ state: 'pending', serverName: 'connections' })
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chat.id}`)).body.pendingCount).toBe(1)
    const path = `/api/chats/${chat.id}/elicitation/${open.id}`

    const noAction = await call(t.desk, 'POST', path, { values: {} })
    expect(noAction.status).toBe(400)
    expect(noAction.body.error).toBe('action must be accept or decline')
    const badValues = await call(t.desk, 'POST', path, { action: 'accept', values: ['a'] })
    expect(badValues.status).toBe(400)
    const missing = await call(t.desk, 'POST', path, { action: 'accept', values: {} })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('Workspace is required')
    expect((await items()).find((i) => i.id === open.id)).toMatchObject({ state: 'pending' })

    const ok = await call(t.desk, 'POST', path, { action: 'accept', values: { workspace: 'b', stray: true } })
    expect(ok.body).toEqual({ ok: true })
    expect(await decision).toEqual({ action: 'accept', content: { workspace: 'b' } })
    expect((await items()).find((i) => i.id === open.id)).toMatchObject({ state: 'accepted', values: { workspace: 'b' } })

    const again = await call(t.desk, 'POST', path, { action: 'decline' })
    expect(again.status).toBe(404)
    expect(again.body.error).toMatch(/no pending elicitation request/)
  })
})

describe('a request left pending by a process that died', () => {
  test('is expired when the items are read, on disk too, and its chat answers 404 rather than hanging', async () => {
    const home = temp('desk-prompts-home-')
    const cwd = temp('desk-cwd-')
    const chatId = 'c0ffee00-0000-4000-8000-000000000001'
    const stored = {
      id: chatId,
      sessionId: SID,
      title: 'Killed mid-prompt',
      cwd,
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
    }
    const lines: TranscriptItem[] = [
      { kind: 'user', id: 'u1', ts: 1, text: 'push it' },
      { kind: 'permission', id: 'p1', ts: 2, toolName: 'Bash', input: { command: 'git push' }, canAlwaysAllow: false, state: 'pending' },
      { kind: 'elicitation', id: 'e1', ts: 3, serverName: 'connections', message: 'Sign in', mode: 'url', state: 'pending' },
      { kind: 'plan', id: 'pl1', ts: 4, plan: 'p', state: 'approved' },
    ]
    writeFileSync(join(home, 'chats.json'), JSON.stringify([stored]))
    mkdirSync(join(home, 'chats'), { recursive: true })
    writeFileSync(join(home, 'chats', `${chatId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const t = await boot(home)
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chatId}`)).body).toMatchObject({ status: 'closed', pendingCount: 0 })
    const items = (await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${chatId}/items`)).body
    expect(items.map((i) => [i.id, 'state' in i ? i.state : null])).toEqual([
      ['u1', null],
      ['p1', 'expired'],
      ['e1', 'expired'],
      ['pl1', 'approved'],
    ])
    // written back once: the next read finds them settled without appending again
    const file = join(home, 'chats', `${chatId}.jsonl`)
    const written = readFileSync(file, 'utf8').trim().split('\n').length
    expect(written).toBe(6)
    await call(t.desk, 'GET', `/api/chats/${chatId}/items`)
    expect(readFileSync(file, 'utf8').trim().split('\n').length).toBe(written)

    const answer = await call(t.desk, 'POST', `/api/chats/${chatId}/permission/p1`, { decision: 'allow' })
    expect(answer.status).toBe(404)
  })
})
