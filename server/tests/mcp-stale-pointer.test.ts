// server/tests/mcp-stale-pointer.test.ts - the MCP client's half of the 2026-09-12 stale-pointer
// defect, and the side-run notice.
//
// Before: with ~/.agenthydra/runtime.json naming a dead port, every tool said "couldn't reach the
// AgentHydra daemon ... Start it" while the real daemon answered on 7787 - advice that makes a
// second daemon. Now a refused pointer-named port is named as such, the default port is asked once,
// and the process switches to it if it answers as us. An explicit AGENTHYDRA_URL/PORT is the
// caller's word and is never second-guessed.
//
// The pointer file is the suite's scratch one (tests/setup.ts sets AGENTHYDRA_HOME), fetch is a
// stub keyed by url prefix, and every case starts from a clean resolution.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { PORT } from '../src/config'
import { instanceFilePath } from '../src/instance'
import { daemonBase, resetDaemonResolutionForTests, TOOLS, withDaemonWarning } from '../src/mcp'

const DEFAULT_BASE = `http://127.0.0.1:${PORT}`
const DEAD = 'http://127.0.0.1:1'

const originalFetch = globalThis.fetch
const origUrl = process.env.AGENTHYDRA_URL
const origPort = process.env.AGENTHYDRA_PORT
let calls: string[] = []

type Answer = { body: unknown; headers?: Record<string, string> } | 'refuse'

function stubFetch(answers: Record<string, Answer>) {
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string) => {
    calls.push(String(url))
    const hit = Object.entries(answers).find(([prefix]) => String(url).startsWith(prefix))
    const answer = hit ? hit[1] : 'refuse'
    if (answer === 'refuse') throw new TypeError('fetch failed: connection refused')
    return new Response(JSON.stringify(answer.body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
    })
  }
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no MCP tool named ${name}`)
  return t
}

function writePointer(url: string) {
  writeFileSync(instanceFilePath(), JSON.stringify({ port: 1, url, pid: 1, startedAt: 1 }))
}

/** The message a tool call fails with, or null when it succeeds. */
async function failureOf(call: unknown): Promise<string | null> {
  try {
    await call
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const HEALTHY = { ok: true, service: 'agenthydra', version: 'test' }

beforeEach(() => {
  calls = []
  delete process.env.AGENTHYDRA_URL
  delete process.env.AGENTHYDRA_PORT
  rmSync(instanceFilePath(), { force: true })
  resetDaemonResolutionForTests()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(instanceFilePath(), { force: true })
  resetDaemonResolutionForTests()
  if (origUrl === undefined) delete process.env.AGENTHYDRA_URL
  else process.env.AGENTHYDRA_URL = origUrl
  if (origPort === undefined) delete process.env.AGENTHYDRA_PORT
  else process.env.AGENTHYDRA_PORT = origPort
})

describe('a pointer naming a port that refuses', () => {
  test('is named as possibly stale, the default port is asked once, and the process switches to it', async () => {
    writePointer(DEAD)
    stubFetch({ [DEAD]: 'refuse', [DEFAULT_BASE]: { body: HEALTHY } })
    expect(daemonBase()).toBe(DEAD)

    await tool('list_queue').run({})
    expect(calls).toEqual([
      `${DEAD}/api/queue`,
      `${DEFAULT_BASE}/api/health`,
      `${DEFAULT_BASE}/api/queue`,
    ])
    expect(daemonBase()).toBe(DEFAULT_BASE)

    // The switch sticks: the next call goes straight to the default, no re-probe.
    calls = []
    await tool('list_queue').run({})
    expect(calls).toEqual([`${DEFAULT_BASE}/api/queue`])
  })

  test('with nothing on the default port either: the error names the file, the port, and both facts', async () => {
    writePointer(DEAD)
    stubFetch({})
    const err = await failureOf(tool('list_queue').run({}))
    expect(err).toContain(
      `${instanceFilePath()} names ${DEAD}, nothing is listening there, and it may be stale`,
    )
    expect(err).toContain(`The default port ${PORT} did not answer either`)
    expect(calls).toEqual([`${DEAD}/api/queue`, `${DEFAULT_BASE}/api/health`])
  })

  test('that IS the default port: named as stale, but there is no second port to try', async () => {
    writePointer(DEFAULT_BASE)
    stubFetch({})
    const err = await failureOf(tool('list_queue').run({}))
    expect(err).toContain('may be stale')
    expect(calls).toEqual([`${DEFAULT_BASE}/api/queue`])
  })
})

describe("an explicit AGENTHYDRA_URL is the caller's word", () => {
  test('a refused explicit url is reported plainly: no pointer talk, no default-port probe', async () => {
    process.env.AGENTHYDRA_URL = 'http://127.0.0.1:2'
    writePointer(DEAD) // present, and must be ignored
    stubFetch({ [DEFAULT_BASE]: { body: HEALTHY } })
    const err = await failureOf(tool('list_queue').run({}))
    expect(err).toContain("couldn't reach the AgentHydra daemon at http://127.0.0.1:2")
    expect(err).not.toContain('may be stale')
    expect(calls).toEqual(['http://127.0.0.1:2/api/queue'])
  })
})

describe('a side-run daemon is announced on every wrapped tool result', () => {
  const STORE = 'X:/scratch/probe-data/agenthydra.db'

  test('the header on any answer sets the warning; wrapped tools carry it, bare TOOLS do not', async () => {
    stubFetch({
      [DEFAULT_BASE]: { body: { ok: true }, headers: { 'x-agenthydra-side-run': STORE } },
    })
    const wrapped = withDaemonWarning(TOOLS)
    const first = (await wrapped.find((t) => t.name === 'list_queue')?.run({})) as Record<
      string,
      unknown
    >
    expect(String(first.daemonWarning)).toContain('SIDE-RUN DAEMON')
    expect(String(first.daemonWarning)).toContain(STORE)

    const bare = (await tool('list_queue').run({})) as Record<string, unknown>
    expect('daemonWarning' in bare).toBe(false)
  })

  test('no header, no warning key', async () => {
    stubFetch({ [DEFAULT_BASE]: { body: { ok: true } } })
    const wrapped = withDaemonWarning(TOOLS)
    const result = (await wrapped.find((t) => t.name === 'list_queue')?.run({})) as Record<
      string,
      unknown
    >
    expect('daemonWarning' in result).toBe(false)
  })
})
