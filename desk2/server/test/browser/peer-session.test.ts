import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPeerSessionLookup, parseNetstatPid, type PeerSession, resolvePeerSession, sessionForPid } from '../../src/browser/peer-session'

setDefaultTimeout(60_000)

const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       4000',
  '  TCP    127.0.0.1:52001        127.0.0.1:7798         ESTABLISHED     4242',
  '  TCP    127.0.0.1:52002        127.0.0.1:7798         TIME_WAIT       4243',
  '  TCP    127.0.0.1:7798         127.0.0.1:52001        ESTABLISHED     7000',
  '  TCP    [::1]:52003            [::1]:7798             ESTABLISHED     4244',
  '',
].join('\r\n')

let base: string
let rootA: string
let rootB: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'peer-session-'))
  rootA = join(base, 'config-a')
  rootB = join(base, 'config-b')
  mkdirSync(join(rootA, 'sessions'), { recursive: true })
  mkdirSync(join(rootB, 'sessions'), { recursive: true })
  writeFileSync(join(rootA, 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: 'grand-session', cwd: 'C:/Users/me/grand' }))
  writeFileSync(join(rootB, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'peer-session', cwd: 'C:/Users/me/proj' }))
  writeFileSync(join(rootB, 'sessions', '4500.json'), JSON.stringify({ pid: 9999, sessionId: 'mismatch', cwd: 'C:/Users/me/x' }))
  writeFileSync(join(rootB, 'sessions', '4600.json'), '{ not json')
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('netstat parsing', () => {
  test('finds the owner of the ESTABLISHED socket whose local port is the peer port', () => {
    expect(parseNetstatPid(NETSTAT, 52001, 7798)).toBe(4242)
  })

  test('an IPv6 ESTABLISHED line matches too', () => {
    expect(parseNetstatPid(NETSTAT, 52003, 7798)).toBe(4244)
  })

  test('a LISTENING, TIME_WAIT or line to another server port never matches', () => {
    expect(parseNetstatPid(NETSTAT, 52002, 7798)).toBeNull()
    expect(parseNetstatPid(NETSTAT, 52001, 7000)).toBeNull()
    expect(parseNetstatPid(NETSTAT, 8080, 0)).toBeNull()
  })
})

describe('session file lookup', () => {
  test('a pid names its session and folder from the first root that has it', () => {
    expect(sessionForPid([rootA, rootB], 4242)).toEqual({ sessionId: 'peer-session', cwd: 'C:/Users/me/proj' })
    expect(sessionForPid([rootA, rootB], 100)).toEqual({ sessionId: 'grand-session', cwd: 'C:/Users/me/grand' })
  })

  test('a file whose pid differs from its name, a broken file and an unknown pid give nothing', () => {
    expect(sessionForPid([rootB], 4500)).toBeNull()
    expect(sessionForPid([rootB], 4600)).toBeNull()
    expect(sessionForPid([rootB], 5555)).toBeNull()
  })
})

describe('parent hop', () => {
  const parents: Record<number, number> = { 300: 200, 200: 100 }
  const parentPidOf = async (pid: number) => parents[pid] ?? null

  test('a socket owned by a child of the claude process resolves through its parent', async () => {
    const session = await resolvePeerSession(52010, 7798, { roots: [rootA], owningPid: async () => 300, parentPidOf })
    expect(session).toEqual({ sessionId: 'grand-session', cwd: 'C:/Users/me/grand' })
  })

  test('no session within three hops gives nothing', async () => {
    const deep: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 100 }
    const session = await resolvePeerSession(52011, 7798, { roots: [rootA], owningPid: async () => 1, parentPidOf: async (p) => deep[p] ?? null })
    expect(session).toBeNull()
  })

  test('a peer with no owning process gives nothing', async () => {
    expect(await resolvePeerSession(52012, 7798, { roots: [rootA], owningPid: async () => null, parentPidOf })).toBeNull()
  })
})

describe('the peer lookup cache', () => {
  test('a peer port is resolved once for a minute, then again', async () => {
    let now = 0
    let calls = 0
    const answer: PeerSession = { sessionId: 's', cwd: 'C:/Users/me/p' }
    const lookup = createPeerSessionLookup(async () => {
      calls++
      return answer
    }, () => now)
    expect(await lookup(60001, 7798)).toEqual(answer)
    expect(await lookup(60001, 7798)).toEqual(answer)
    expect(calls).toBe(1)
    now = 61_000
    await lookup(60001, 7798)
    expect(calls).toBe(2)
  })
})

describe('a real loopback connection', () => {
  test('the claude-like child that holds a keep-alive connection is found from the peer port', async () => {
    let peerPort = 0
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        peerPort = srv.requestIP(req)?.port ?? 0
        return new Response('ok')
      },
    })
    const script = `const r = await fetch('http://127.0.0.1:${server.port}/'); await r.text(); console.log('ready'); await new Promise((done) => setTimeout(done, 20000))`
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'ignore' })
    try {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (!text.includes('ready')) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
      expect(text).toContain('ready')
      expect(peerPort).toBeGreaterThan(0)
      const roots = [join(base, 'loopback')]
      mkdirSync(join(roots[0], 'sessions'), { recursive: true })
      writeFileSync(join(roots[0], 'sessions', `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: 'loopback-session', cwd: 'C:/Users/me/loop' }))
      expect(await resolvePeerSession(peerPort, server.port as number, { roots })).toEqual({ sessionId: 'loopback-session', cwd: 'C:/Users/me/loop' })
    } finally {
      child.kill()
      server.stop(true)
    }
  })
})
