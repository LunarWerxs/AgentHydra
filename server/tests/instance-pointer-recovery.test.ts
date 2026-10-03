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
import { createServer, type Server } from 'node:net'
import { DB_PATH, PORT } from '../src/config'
import {
  DEFAULT_URL,
  findLiveOnDefaultPort,
  findPeerDaemon,
  findStalledOwner,
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

// 2026-10-02 22:58Z: the daemon on 7787 froze for 25.6 s, the tray started another, and that one's
// boot probes all timed out, so it hopped to 7788 and took the pointer. Two daemons then ran one
// store: every MCP tool read 7788 while workers POSTed to 7787 did not exist there, and both
// resumed the same workers on two accounts (docs/CLIMAYTE-FIELD-NOTES.md, note 62).
describe('findStalledOwner: a frozen daemon is not "nothing running"', () => {
  /** A port that accepts connections and never answers them: a daemon whose loop is blocked. */
  async function silentPort(): Promise<{ server: Server; port: number }> {
    const server = createServer(() => {})
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    return { server, port: typeof addr === 'object' && addr ? addr.port : 0 }
  }
  /** Another live process, standing in for the frozen daemon's pid. */
  const otherProcess = () =>
    Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore' })

  test('the pointer names a live process whose port still accepts: that daemon owns the store', async () => {
    const { server, port } = await silentPort()
    const other = otherProcess()
    try {
      const url = `http://127.0.0.1:${port}`
      writeFileSync(instanceFilePath(), JSON.stringify({ port, url, pid: other.pid, startedAt: 1 }))
      expect(await findStalledOwner(1000)).toMatchObject({ url, pid: other.pid })
    } finally {
      other.kill()
      server.close()
    }
  })

  test('a crashed daemon (its pid gone) or a closed port is no owner: the boot goes on', async () => {
    const { server, port } = await silentPort()
    const other = otherProcess()
    try {
      const url = `http://127.0.0.1:${port}`
      writeForeignPointer(url, 99_999_999)
      expect(await findStalledOwner(1000)).toBeNull()
      server.close()
      writeFileSync(instanceFilePath(), JSON.stringify({ port, url, pid: other.pid, startedAt: 1 }))
      expect(await findStalledOwner(1000)).toBeNull()
    } finally {
      other.kill()
      server.close()
    }
  })
})

describe('findPeerDaemon: a second live daemon on this store is found and named', () => {
  const health = (pid: number, dbPath = DB_PATH) => ({
    ok: true,
    body: { ok: true, service: 'agenthydra', pid, dbPath },
  })
  const HOPPED = 'http://127.0.0.1:7790'

  test('the pointer names another live daemon on the same store: that is the peer', async () => {
    writeForeignPointer(HOPPED, 4242)
    stubFetch({ [HOPPED]: health(4242) })
    expect(await findPeerDaemon(PORT, 500)).toEqual({ url: HOPPED, pid: 4242 })
  })

  // Seen live 2026-10-02 23:50Z: 7787 restarted onto the fix and took the pointer back, so the stray
  // on 7788 was named nowhere, and the daemon on the default port reported no peer.
  test('the daemon on the default port finds a twin that hopped to the next port', async () => {
    writeInstanceInfo(PORT, {})
    const next = `http://127.0.0.1:${PORT + 1}`
    stubFetch({ [next]: health(4444) })
    expect(await findPeerDaemon(PORT, 500)).toEqual({ url: next, pid: 4444 })
  })

  test('a daemon that hopped off the default port finds the one still on it', async () => {
    writeInstanceInfo(7790, {})
    stubFetch({ [DEFAULT_URL]: health(4343) })
    expect(await findPeerDaemon(7790, 500)).toEqual({ url: DEFAULT_URL, pid: 4343 })
  })

  test('a daemon on another store (a side-run) or nothing live is no peer', async () => {
    writeForeignPointer(HOPPED, 4242)
    stubFetch({ [HOPPED]: health(4242, 'X:/scratch/agenthydra.db') })
    expect(await findPeerDaemon(PORT, 500)).toBeNull()
    stubFetch({})
    expect(await findPeerDaemon(PORT, 500)).toBeNull()
  })
})
