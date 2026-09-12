// server/tests/instance-pointer-recovery.test.ts - the two daemon-side halves of "a stale pointer
// must not make a second daemon" (2026-09-12):
//
//   findLiveOnDefaultPort   the boot guard asks the DEFAULT port when the pointer said nothing
//                           useful, and accepts only OUR service there;
//   reassertInstancePointer the running daemon rewrites a pointer that is missing or names a dead
//                           daemon, and never one that names a live other daemon.
//
// Runs against the suite's scratch AGENTHYDRA_HOME (tests/setup.ts), so the pointer file written
// here is never the developer's real one. fetch is stubbed per test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  DEFAULT_URL,
  findLiveOnDefaultPort,
  instanceFilePath,
  readInstanceInfo,
  reassertInstancePointer,
  writeInstanceInfo,
} from '../src/instance'

const originalFetch = globalThis.fetch
let calls: string[] = []

type Answer = { ok: boolean; body?: unknown } | 'refuse'

/** fetch stub: a map from url PREFIX to how it answers; anything unmatched refuses. */
function stubFetch(answers: Record<string, Answer>) {
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string) => {
    calls.push(String(url))
    const hit = Object.entries(answers).find(([prefix]) => String(url).startsWith(prefix))
    const answer = hit ? hit[1] : 'refuse'
    if (answer === 'refuse') throw new TypeError('fetch failed: connection refused')
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.ok ? 200 : 503 })
  }
}

function writeForeignPointer(url: string, pid = 99_999_999) {
  writeFileSync(instanceFilePath(), JSON.stringify({ port: 1, url, pid, startedAt: 1 }))
}

beforeEach(() => {
  calls = []
  rmSync(instanceFilePath(), { force: true })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(instanceFilePath(), { force: true })
})

describe('findLiveOnDefaultPort: the boot guard asks the default port when the pointer is no help', () => {
  test('no pointer, our service on the default port: found, and the pointer is NOT written here', async () => {
    stubFetch({ [DEFAULT_URL]: { ok: true, body: { ok: true, service: 'agenthydra', pid: 4242 } } })
    const live = await findLiveOnDefaultPort(500)
    expect(live).toMatchObject({ url: DEFAULT_URL, pid: 4242, foundOnDefaultPort: true })
    expect(existsSync(instanceFilePath())).toBe(false) // the live daemon owns its pointer
  })

  test('the pointer already names the default url: nothing new to learn, no probe at all', async () => {
    writeForeignPointer(DEFAULT_URL)
    stubFetch({ [DEFAULT_URL]: { ok: true, body: { ok: true, service: 'agenthydra' } } })
    expect(await findLiveOnDefaultPort(500)).toBeNull()
    expect(calls).toEqual([])
  })

  test("someone else's server on the default port is not us", async () => {
    stubFetch({ [DEFAULT_URL]: { ok: true, body: { ok: true, service: 'wrangler' } } })
    expect(await findLiveOnDefaultPort(500)).toBeNull()
  })

  test('nothing listening: null, quietly', async () => {
    stubFetch({})
    expect(await findLiveOnDefaultPort(500)).toBeNull()
    expect(calls).toHaveLength(1)
  })
})

describe('reassertInstancePointer: the running daemon keeps its own pointer honest', () => {
  const extra = () => ({ portableMode: false, hideTrayIcon: true })

  test('a missing pointer is rewritten for this process, extras included', async () => {
    stubFetch({})
    expect(await reassertInstancePointer(7787, extra)).toBe('rewritten')
    const info = readInstanceInfo()
    expect(info?.pid).toBe(process.pid)
    expect(info?.port).toBe(7787)
    expect(info?.hideTrayIcon).toBe(true)
    expect(calls).toEqual([]) // nothing to probe when there is no pointer
  })

  test("a pointer naming another LIVE daemon is that daemon's: left byte-for-byte alone", async () => {
    writeForeignPointer('http://127.0.0.1:7790')
    const before = readFileSync(instanceFilePath(), 'utf8')
    stubFetch({ 'http://127.0.0.1:7790': { ok: true, body: { ok: true, service: 'agenthydra' } } })
    expect(await reassertInstancePointer(7787, extra)).toBe('foreign-live')
    expect(readFileSync(instanceFilePath(), 'utf8')).toBe(before)
  })

  test('a pointer naming a DEAD daemon is rewritten', async () => {
    writeForeignPointer('http://127.0.0.1:7799')
    stubFetch({})
    expect(await reassertInstancePointer(7787, extra)).toBe('rewritten')
    expect(readInstanceInfo()?.pid).toBe(process.pid)
    expect(readInstanceInfo()?.url).toBe(DEFAULT_URL)
  })

  test('our own pointer is kept without a probe', async () => {
    writeInstanceInfo(7787, extra())
    stubFetch({})
    expect(await reassertInstancePointer(7787, extra)).toBe('kept')
    expect(calls).toEqual([])
  })
})
