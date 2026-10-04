// The chat host's core (SPEC "Chat hosts"): the journal a restarted server replays, what the host keeps for the
// next server, when it ends on its own, and the last word a server says before it lets go.

import { afterEach, expect, test } from 'bun:test'
import type { CanUseTool, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { HostConnection } from '../../src/host/client'
import { HostCore, type ServerLink } from '../../src/host/core'
import { HOST_PROTOCOL, type HostMessage, type HostSpec, type JournalEntry } from '../../src/host/protocol'
import { serveHost } from '../../src/host/serve'
import { FakeQuery } from '../engine/manager/fakes'

const cores: HostCore[] = []
afterEach(() => {
  for (const c of cores.splice(0)) c.shutdown(0)
})

function host(o: { orphanMinutes?: number; maxJournal?: number } = {}) {
  const spec = {
    protocol: HOST_PROTOCOL,
    chatId: 'chat-1',
    token: 'secret',
    dir: '',
    account: { id: 'a', label: 'a', configDir: null },
    options: {},
    orphanMinutes: o.orphanMinutes ?? 30,
    carry: { first: true },
  } as unknown as HostSpec
  const state = { fake: null as unknown as FakeQuery, exited: null as number | null }
  const core = new HostCore({
    spec,
    queryImpl: ({ prompt, options }) => {
      state.fake = new FakeQuery(prompt, options)
      return state.fake as unknown as Query
    },
    exit: (code) => {
      state.exited = code
    },
    maxJournal: o.maxJournal,
  })
  cores.push(core)
  core.start()
  return { core, spec, state }
}

/** A server's end of a connection, recording what the host sends it. */
function link() {
  const got: HostMessage[] = []
  const l: ServerLink & { got: HostMessage[]; closed: boolean } = {
    got,
    closed: false,
    send: (m) => void got.push(m),
    close: () => {
      l.closed = true
    },
  }
  return l
}

const hello = (l: { got: HostMessage[] }) => l.got.find((m): m is Extract<HostMessage, { type: 'hello' }> => m.type === 'hello')!
const replayed = (l: { got: HostMessage[] }) => l.got.flatMap((m) => (m.type === 'replay' ? [m.entry] : []))
const kinds = (entries: JournalEntry[]) => entries.map((e) => (e.kind === 'sdk' ? (e.msg as { type: string }).type : e.kind))
const tick = () => new Promise((r) => setTimeout(r, 5))
const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage
const input = (uuid: string) => ({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, uuid }) as never

test('an ack drops the journal up to its entry but the sends a later turn may need, and the next server gets its carry', async () => {
  const { core, state } = host()
  const a = link()
  core.attach(a)
  expect(hello(a)).toMatchObject({ acked: 0, carry: { first: true } })
  core.receive({ type: 'input', msg: input('u1') }, a)
  core.receive({ type: 'input', msg: input('u2') }, a)
  state.fake.push(sdk({ type: 'assistant', message: { id: 'm1', content: [] } }), sdk({ type: 'result', subtype: 'success' }))
  await tick()
  const result = a.got.flatMap((m) => (m.type === 'entry' ? [m.entry] : [])).at(-1)!
  core.receive({ type: 'ack', upTo: result.seq, keepInputs: ['u2'], carry: { status: 'limited' } }, a)
  state.fake.push(sdk({ type: 'system', subtype: 'status' }))
  await tick()

  const b = link()
  core.attach(b)
  expect(hello(b)).toMatchObject({ acked: result.seq, carry: { status: 'limited' } })
  expect(kinds(replayed(b))).toEqual(['input', 'system'])
  expect((replayed(b)[0] as { msg: { uuid: string } }).msg.uuid).toBe('u2')
  expect(a.closed).toBe(true) // the newer server took over
})

test('a No that stops the turn is journaled as a Stop, so a restarted server replays the turn as stopped', async () => {
  const { core, state } = host()
  const a = link()
  core.attach(a)
  const asked = (state.fake.options.canUseTool as CanUseTool)('Bash', {}, { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' })
  expect(a.got.find((m) => m.type === 'request')).toMatchObject({ request: { callId: 'r1', kind: 'tool', toolName: 'Bash' } })
  core.receive({ type: 'answer', callId: 'r1', result: { behavior: 'deny', message: 'no', interrupt: true } }, a)
  expect(await asked).toMatchObject({ behavior: 'deny', interrupt: true })
  const b = link()
  core.attach(b)
  expect(kinds(replayed(b))).toEqual(['interrupt'])
})

test('with no server the host waits for one while the chat works, and ends once it has been idle that long', async () => {
  const { core, state } = host({ orphanMinutes: 0.001 }) // 60 ms
  const a = link()
  core.attach(a)
  core.receive({ type: 'input', msg: input('u1') }, a)
  core.detach(a)
  await new Promise((r) => setTimeout(r, 150))
  expect(state.exited).toBeNull() // a turn runs: it goes on alone
  state.fake.push(sdk({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))
  await new Promise((r) => setTimeout(r, 150))
  expect(state.exited).toBe(0)
})

test('a long turn sheds text deltas and tool progress, keeping what lines the replay up', async () => {
  const { core, state } = host({ maxJournal: 6 })
  const a = link()
  core.attach(a)
  const ev = (type: string) => sdk({ type: 'stream_event', event: { type, index: 0 } })
  state.fake.push(
    ev('message_start'),
    ev('content_block_start'),
    ev('content_block_delta'),
    ev('content_block_delta'),
    sdk({ type: 'tool_progress', tool_use_id: 't1', elapsed_time_seconds: 1 }),
    sdk({ type: 'assistant', message: { id: 'm1', content: [] } }),
    ev('content_block_delta'),
  )
  await tick()
  const b = link()
  core.attach(b)
  const types = replayed(b).map((e) => {
    const m = (e as { msg: { type: string; event?: { type: string } } }).msg
    return m.event?.type ?? m.type
  })
  expect(types).toEqual(['message_start', 'content_block_start', 'assistant', 'content_block_delta'])
})

test("a server's last word reaches the host while the host is sending (Bun drops a frame a close follows then)", async () => {
  const { core, spec, state } = host()
  const server = serveHost(core, spec.token)
  try {
    const file = { protocol: HOST_PROTOCOL, chatId: spec.chatId, pid: process.pid, port: server.port as number, token: spec.token, startedAt: 0 }
    const c1 = await HostConnection.open(file)
    c1.setHandler(() => {})
    state.fake.push(sdk({ type: 'assistant', message: { id: 'm1', content: [] } }))
    await tick()
    // The server lets go having seen nothing, while the chat keeps streaming at it.
    const done = c1.sayLast({ type: 'detach', seen: 0, shown: [] })
    state.fake.push(sdk({ type: 'assistant', message: { id: 'm2', content: [] } }))
    await done
    const c2 = await HostConnection.open(file)
    expect(c2.hello.delivered).toBe(0)
    c2.close()
  } finally {
    server.stop(true)
  }
})
