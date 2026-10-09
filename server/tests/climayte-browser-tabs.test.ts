// server/tests/climayte-browser-tabs.test.ts — a CliMayte worker that ends closes only the browser tabs
// its own sessions opened in the Connections profiles, and nothing else.
//
// The profile's Chrome is a local server answering the DevTools HTTP endpoints; the ledger and
// DevToolsActivePort are fabricated in a temp profiles root.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeWorkerTabs,
  endedForGood,
  sessionIdsOf,
  type TabsWorker,
} from '../src/climayte-browser-tabs'

const MINE = '11111111-1111-4111-8111-111111111111'
const MINE_RETRY = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

const root = mkdtempSync(join(tmpdir(), 'climayte-tabs-'))
const servers: { stop(): void }[] = []

type Target = { id: string; type: string; url: string }

function fakeChrome(targets: Target[]) {
  const closed: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/json/version') return Response.json({ Browser: 'Fake/1' })
      if (path === '/json/list') return Response.json(targets)
      const close = path.match(/^\/json\/close\/(.+)$/)
      if (close) {
        const id = decodeURIComponent(close[1])
        const i = targets.findIndex((t) => t.id === id)
        if (i >= 0) targets.splice(i, 1)
        closed.push(id)
        return new Response(`Target is closing`)
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return { port: server.port as number, closed }
}

function profile(workspace: string, name: string) {
  const dir = join(root, 'ws', workspace, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeLedger(dir: string, tabs: Record<string, { chat: string; at: string }>) {
  writeFileSync(join(dir, '.connections-tabs.json'), JSON.stringify({ v: 1, tabs }))
}

function writePort(dir: string, port: number) {
  writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc\n`)
}

function worker(over: Partial<TabsWorker> & Pick<TabsWorker, 'status'>): TabsWorker {
  return { id: 'w1', sessionId: MINE, attempts: [{ sessionId: MINE }], ...over }
}

beforeEach(() => {
  rmSync(join(root, 'ws'), { recursive: true, force: true })
})

afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('closeWorkerTabs', () => {
  test('closes only the worker sessions tabs; other owners and untagged pages stay', async () => {
    const targets: Target[] = [
      { id: 'mine-a', type: 'page', url: 'https://example.test/a' },
      { id: 'mine-b', type: 'page', url: 'https://example.test/b' },
      { id: 'other', type: 'page', url: 'https://example.test/other' },
      { id: 'mcp', type: 'page', url: 'https://example.test/mcp' },
      { id: 'pid', type: 'page', url: 'https://example.test/pid' },
      { id: 'untagged', type: 'page', url: 'https://example.test/untagged' },
      { id: 'mine-sw', type: 'service_worker', url: 'https://example.test/sw' },
    ]
    const chrome = fakeChrome(targets)
    const dir = profile('ws1', 'p1')
    writePort(dir, chrome.port)
    writeLedger(dir, {
      'mine-a': { chat: MINE, at: '2026-10-09T10:00:00.000Z' },
      'mine-b': { chat: MINE_RETRY, at: '2026-10-09T10:01:00.000Z' },
      other: { chat: OTHER, at: '2026-10-09T10:02:00.000Z' },
      mcp: { chat: 'mcp:abc123', at: '2026-10-09T10:03:00.000Z' },
      pid: { chat: 'pid:4242', at: '2026-10-09T10:04:00.000Z' },
      'mine-sw': { chat: MINE, at: '2026-10-09T10:05:00.000Z' },
    })

    const w = worker({ status: 'done', sessionId: MINE, attempts: [{ sessionId: MINE_RETRY }] })
    expect(await closeWorkerTabs(w, root)).toBe(2)
    expect(chrome.closed.sort()).toEqual(['mine-a', 'mine-b'])
    expect(targets.map((t) => t.id)).toEqual(['other', 'mcp', 'pid', 'untagged', 'mine-sw'])
  })

  test('closes the tabs of a retry session recorded only on an attempt', async () => {
    const targets: Target[] = [{ id: 'retry-tab', type: 'page', url: 'https://example.test/r' }]
    const chrome = fakeChrome(targets)
    const dir = profile('ws1', 'p1')
    writePort(dir, chrome.port)
    writeLedger(dir, { 'retry-tab': { chat: MINE_RETRY, at: '2026-10-09T10:00:00.000Z' } })

    const w = worker({ status: 'failed', sessionId: MINE, attempts: [{ sessionId: MINE_RETRY }] })
    expect(await closeWorkerTabs(w, root)).toBe(1)
    expect(chrome.closed).toEqual(['retry-tab'])
  })

  test('skips a profile with no running Chrome or no ledger, without throwing', async () => {
    const live: Target[] = [{ id: 'mine-live', type: 'page', url: 'https://example.test/l' }]
    const chrome = fakeChrome(live)
    const liveDir = profile('ws1', 'live')
    writePort(liveDir, chrome.port)
    writeLedger(liveDir, { 'mine-live': { chat: MINE, at: '2026-10-09T10:00:00.000Z' } })

    const stale = profile('ws1', 'stale')
    const deadPort = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const deadNumber = deadPort.port as number
    deadPort.stop()
    writePort(stale, deadNumber)
    writeLedger(stale, { 'stale-tab': { chat: MINE, at: '2026-10-09T10:00:00.000Z' } })

    const noLedger = profile('ws2', 'bare')
    writePort(noLedger, chrome.port)

    expect(await closeWorkerTabs(worker({ status: 'cancelled' }), root)).toBe(1)
    expect(chrome.closed).toEqual(['mine-live'])
  })

  test('a missing profiles root closes nothing', async () => {
    expect(await closeWorkerTabs(worker({ status: 'done' }), join(root, 'absent'))).toBe(0)
  })

  test('non-terminal states and a question pause close nothing', async () => {
    const targets: Target[] = [{ id: 'mine-a', type: 'page', url: 'https://example.test/a' }]
    const chrome = fakeChrome(targets)
    const dir = profile('ws1', 'p1')
    writePort(dir, chrome.port)
    writeLedger(dir, { 'mine-a': { chat: MINE, at: '2026-10-09T10:00:00.000Z' } })

    for (const status of ['queued', 'running', 'waiting', 'checking'] as const) {
      expect(await closeWorkerTabs(worker({ status }), root)).toBe(0)
    }
    expect(
      await closeWorkerTabs(worker({ status: 'done', question: { text: 'which?' } }), root),
    ).toBe(0)
    expect(chrome.closed).toEqual([])
    expect(targets).toHaveLength(1)
  })

  test('each ended state is terminal', () => {
    expect(endedForGood({ status: 'done' })).toBe(true)
    expect(endedForGood({ status: 'failed' })).toBe(true)
    expect(endedForGood({ status: 'cancelled' })).toBe(true)
    expect(endedForGood({ status: 'done', question: 'x' })).toBe(false)
    expect(endedForGood({ status: 'running' })).toBe(false)
  })

  test('session ids are every attempts session, once each, without empties or owners', () => {
    expect(
      sessionIdsOf({
        sessionId: MINE,
        attempts: [{ sessionId: MINE }, { sessionId: MINE_RETRY }, { sessionId: null }, {}],
      }),
    ).toEqual([MINE, MINE_RETRY])
    expect(sessionIdsOf({ sessionId: null, attempts: [] })).toEqual([])
  })
})
