// server/tests/dsh-sessions.test.ts — the DeepSeek Harness reader (server/src/dsh-sessions.ts).
//
// The fixture is a REAL store: real directories, real multi-frame zstd, real projection-cache JSON,
// written with the same layout `@deepseek-ai/dsh` writes. Nothing here is mocked, because every bug
// this reader can have is a bug about bytes on disk — a frame boundary, a torn tail, a file name one
// version behind — and a mock of the store would agree with whatever the reader believed.
//
// The event vocabulary used below is the harness's own (dsh-session/lib/types/known-event-types.js
// carries all 56), narrowed to the records that decide what a transcript shows.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { scanSessionAnalytics } from '../src/analytics'
import { listDshSessions, readDshLog, readDshSession, readDshUsage } from '../src/dsh-sessions'
import { priceTokens } from '../src/pricing'

function newHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-home-'))
}

/** One record per zstd FRAME, concatenated — the harness flushes in batches, so a reader that only
 *  decodes the first frame passes a single-record fixture and fails every real log. */
function framed(records: unknown[]): Buffer {
  return Buffer.concat(records.map((r) => zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`))))
}

interface WriteOpts {
  /** Defaults to `session.v3.jsonl.zstd`; override to test generation precedence or `compression: 'none'`. */
  fileName?: string
  compressed?: boolean
}

function writeSession(
  home: string,
  projectKey: string,
  sessionId: string,
  records: unknown[],
  opts: WriteOpts = {},
): string {
  const dir = join(home, 'sessions', projectKey, sessionId)
  mkdirSync(dir, { recursive: true })
  const name = opts.fileName ?? 'session.v3.jsonl.zstd'
  const path = join(dir, name)
  const body =
    opts.compressed === false
      ? Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join(''))
      : framed(records)
  writeFileSync(path, body)
  return path
}

function writeProjection(home: string, sessionId: string, record: unknown): void {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ version: 7, record }))
}

function writeWorkspace(home: string, archivedSessionIds: string[]): void {
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({ global: { initialized: true, archivedSessionIds } }),
  )
}

const HEADER = {
  type: 'session',
  version: 3,
  id: 'session-aaa',
  createdAt: 1_700_000_000_000,
  cwd: 'D:\\work\\scratch',
  isSeeded: false,
}

/** A one-turn conversation with everything a transcript should show and several things it should
 *  not: the system prompt, the harness's own injected runtime-context snapshot, and step/turn
 *  bookkeeping. */
const CONVERSATION: unknown[] = [
  HEADER,
  {
    type: 'permission/preset',
    seq: 0,
    time: 1_700_000_000_100,
    data: { preset: 'workspace-write' },
  },
  { type: 'turn/start', seq: 1, time: 1_700_000_000_200, data: { turn: 1 } },
  {
    type: 'system/message',
    seq: 2,
    time: 1_700_000_000_300,
    data: {
      message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent.' }] },
    },
  },
  {
    type: 'user/message',
    seq: 3,
    time: 1_700_000_000_400,
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'count the files' }],
      source: { kind: 'user' },
    },
  },
  {
    type: 'user/message',
    seq: 4,
    time: 1_700_000_000_450,
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'Current runtime context. Sandbox: workspace-write.' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    },
  },
  {
    type: 'tool/call',
    seq: 5,
    time: 1_700_000_000_500,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'bash',
      arguments: '{"command":"ls | wc -l"}',
    },
  },
  {
    type: 'tool/result',
    seq: 6,
    time: 1_700_000_000_600,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            callId: 'call-1',
            isError: false,
            content: [{ type: 'text', text: '12' }],
          },
        ],
      },
    },
  },
  {
    type: 'assistant/message',
    seq: 7,
    time: 1_700_000_000_700,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'The listing shows twelve entries.' },
          { type: 'text', text: 'There are 12 files.' },
        ],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
      },
      usage: {
        inputTokens: 8000,
        outputTokens: 40,
        totalTokens: 8240,
        cacheReadTokens: 200,
        reasoningTokens: 15,
      },
    },
  },
  {
    type: 'turn/end',
    seq: 8,
    time: 1_700_000_000_800,
    data: { turn: 1, reason: { kind: 'completed' } },
  },
]

describe('listDshSessions: what is on disk, named by the projection when there is one', () => {
  test('a session lists with its title, cwd, workspace folder and archive state', () => {
    const home = newHome()
    writeSession(home, '--D-work-scratch--', 'session-aaa', CONVERSATION)
    writeProjection(home, 'session-aaa', {
      identity: { createdAt: 1_700_000_000_000, cwd: 'D:\\work\\scratch', formatVersion: 3 },
      rows: {
        title: { val: 'Counting files' },
        sessionListMetadata: { val: { blank: false, lastPromptAt: 1_700_000_000_400 } },
      },
    })
    writeWorkspace(home, [])

    const [session, ...rest] = listDshSessions(home)
    expect(rest).toHaveLength(0)
    expect(session?.session_id).toBe('session-aaa')
    expect(session?.title).toBe('Counting files')
    expect(session?.cwd).toBe('D:\\work\\scratch')
    // The workspace FOLDER, not the lossy project-key directory name.
    expect(session?.project).toBe('scratch')
    expect(session?.created_at).toBe(1_700_000_000_000)
    expect(session?.archived).toBe(false)
    expect(session?.size_bytes).toBeGreaterThan(0)
  })

  test('no projection: cwd and created-at come from the log header instead of being lost', () => {
    const home = newHome()
    writeSession(home, '--D-work-scratch--', 'session-aaa', CONVERSATION)
    const [session] = listDshSessions(home)
    expect(session?.cwd).toBe('D:\\work\\scratch')
    expect(session?.created_at).toBe(1_700_000_000_000)
    // No projection means no title of its own; the session still lists, and naming it is the
    // caller's job (the index falls back to the first thing said).
    expect(session?.title).toBe('')
  })

  test("the workspace store's archived ids are honoured — archive state here is real, not assumed", () => {
    const home = newHome()
    writeSession(home, '--D-work-scratch--', 'session-aaa', CONVERSATION)
    writeWorkspace(home, ['session-aaa'])
    expect(listDshSessions(home)[0]?.archived).toBe(true)
  })

  test('the HIGHEST format generation wins when an older one is still on disk', () => {
    const home = newHome()
    writeSession(
      home,
      '--D-work-scratch--',
      'session-aaa',
      [{ ...HEADER, version: 2, cwd: 'D:\\old' }],
      {
        fileName: 'session.v2.jsonl.zstd',
      },
    )
    writeSession(home, '--D-work-scratch--', 'session-aaa', CONVERSATION)
    const [session] = listDshSessions(home)
    expect(session?.path.endsWith('session.v3.jsonl.zstd')).toBe(true)
    expect(session?.cwd).toBe('D:\\work\\scratch')
  })

  test('a home with no sessions directory, or none at all, is empty rather than an error', () => {
    expect(listDshSessions(newHome())).toEqual([])
    expect(listDshSessions(join(tmpdir(), `dsh-missing-${crypto.randomUUID()}`))).toEqual([])
  })

  test('a session directory with no log file at all is not a session', () => {
    const home = newHome()
    mkdirSync(join(home, 'sessions', '--D-work-scratch--', 'session-empty'), { recursive: true })
    expect(listDshSessions(home)).toEqual([])
  })
})

describe('readDshLog: multi-frame zstd, torn tails and the uncompressed spelling', () => {
  test('every frame is decoded, not just the first', () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION)
    expect(readDshLog(path)).toHaveLength(CONVERSATION.length)
  })

  test('a half-written final frame costs that record and nothing else', () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION)
    const whole = framed(CONVERSATION)
    const torn = framed([
      { type: 'turn/start', seq: 9, time: 1_700_000_000_900, data: { turn: 2 } },
    ])
    // Half of the last frame: exactly what a reader finds when it looks while the harness writes.
    writeFileSync(path, Buffer.concat([whole, torn.subarray(0, Math.floor(torn.length / 2))]))
    const records = readDshLog(path)
    expect(records).toHaveLength(CONVERSATION.length)
    expect(records.at(-1)?.type).toBe('turn/end')
  })

  test("compression: 'none' writes plain JSONL, and that is a log too", () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION, {
      fileName: 'session.v3.jsonl',
      compressed: false,
    })
    expect(readDshLog(path)).toHaveLength(CONVERSATION.length)
    expect(readDshSession(path)?.messageCount).toBe(2)
  })

  test('a missing file, an empty one and a garbage one never throw', () => {
    const home = newHome()
    expect(readDshLog(join(home, 'nope.jsonl.zstd'))).toEqual([])
    const empty = writeSession(home, '--p--', 'session-empty', [])
    expect(readDshLog(empty)).toEqual([])
    const garbage = join(home, 'garbage.jsonl.zstd')
    writeFileSync(garbage, Buffer.from('not zstd at all'))
    expect(readDshLog(garbage)).toEqual([])
    expect(readDshSession(garbage)).toBeNull()
    expect(readDshUsage(garbage)).toEqual([])
  })
})

describe('readDshSession: who said what, and what is deliberately not shown', () => {
  test('the human turn, the reasoning, the reply and the tool pair — in order', () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION)
    const content = readDshSession(path)
    expect(content?.events.map((e) => [e.role, e.kind, e.tool_name])).toEqual([
      ['user', 'text', null],
      ['assistant', 'tool_use', 'bash'],
      ['user', 'tool_result', 'bash'],
      ['assistant', 'thinking', null],
      ['assistant', 'text', null],
    ])
    expect(content?.events[0]?.text).toBe('count the files')
    expect(content?.events[1]?.text).toContain('ls | wc -l')
    expect(content?.events[2]?.text).toBe('12')
    expect(content?.events[4]?.text).toBe('There are 12 files.')
    // Two spoken messages: the human's and the model's. Thinking and tool traffic are not turns.
    expect(content?.messageCount).toBe(2)
  })

  test("the harness's own injected user message is not shown as something the user typed", () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION)
    const texts = readDshSession(path)?.events.map((e) => e.text) ?? []
    expect(texts.some((t) => t.includes('Current runtime context'))).toBe(false)
  })

  test('the system prompt stays out of the transcript', () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION)
    const texts = readDshSession(path)?.events.map((e) => e.text) ?? []
    expect(texts.some((t) => t.includes('You are an AI agent'))).toBe(false)
  })

  test('an unknown event type from a newer harness is skipped, not fatal', () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', [
      ...CONVERSATION,
      { type: 'team/message/delivered', seq: 9, time: 1_700_000_000_900, data: { whatever: true } },
    ])
    expect(readDshSession(path)?.messageCount).toBe(2)
  })
})

describe('readDshUsage: disjoint counts, one row per accounted turn', () => {
  test('input excludes cache reads, reasoning is reported separately, and the route is named', () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION)
    expect(readDshUsage(path)).toEqual([
      {
        model: 'deepseek-official/deepseek-flash',
        tokens_input: 8000,
        tokens_output: 40,
        tokens_reasoning: 15,
        tokens_cache_read: 200,
        tokens_cache_write: null,
        time_ms: 1_700_000_000_700,
      },
    ])
  })

  test('a turn the adapter reported no accounting for produces no row rather than a zero', () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', [
      HEADER,
      {
        type: 'assistant/message',
        seq: 1,
        time: 1_700_000_000_700,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'no accounting for this one' }],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
          },
        },
      },
    ])
    expect(readDshUsage(path)).toEqual([])
  })
})

describe('analytics: a DSH session reaches the spend charts, priced', () => {
  test('tokens land under the route it ran on, on the day it ran', async () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION)
    const analytics = await scanSessionAnalytics(path, 'dsh', 'session-aaa')
    const spend = analytics.tokens['deepseek-official/deepseek-flash']
    expect(spend?.input).toBe(8000)
    expect(spend?.output).toBe(40)
    expect(spend?.cacheRead).toBe(200)
    expect(analytics.firstTs).toBe(1_700_000_000_700)
    expect(analytics.lastTs).toBe(1_700_000_000_700)
    expect(Object.keys(analytics.days)).toHaveLength(1)
  })

  test('deepseek-flash is priced rather than reported unpriced', async () => {
    const home = newHome()
    const path = writeSession(home, '--p--', 'session-aaa', CONVERSATION)
    const analytics = await scanSessionAnalytics(path, 'dsh', 'session-aaa')
    const priced = priceTokens(analytics.tokens, 1_700_000_000_700)
    expect(priced.unpriced).toEqual([])
    expect(priced.costUsd).not.toBeNull()
    // 8000 input @ $0.30/M + 200 cache read @ $0.006/M + 40 output @ $1.20/M.
    expect(priced.costUsd).toBeCloseTo(8000 * 3e-7 + 200 * 6e-9 + 40 * 1.2e-6, 10)
  })
})
