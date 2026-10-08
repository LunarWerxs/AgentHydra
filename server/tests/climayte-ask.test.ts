// server/tests/climayte-ask.test.ts — a headless worker asks its origin a question (climayte_ask).
//
// Owner, 2026-10-04: a worker cannot ask, so it guesses. It asks through climayte_ask; the question
// is recorded on the worker, pinged to the chat (or parent worker) that dispatched it, and the
// answer is the existing climayte_send. Transports are injected; nothing messages a real chat.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  climayteCancel,
  climayteGet,
  climaytePing,
  climayteReady,
  climayteRun,
  climayteSend,
  setCliMayteAccountsProvider,
  setCliMaytePingDeps,
  startCliMayte,
  stopCliMaytePing,
} from '../src/climayte'
import { askTools, registerAskMcpRoute } from '../src/climayte-ask-mcp'
import { notify, workers } from '../src/climayte-core'
import type { CliMayteAttempt } from '../src/climayte-lib'

const SID = '12345678-aaaa-4bbb-8ccc-1234567890ab'
const HOME = 'C:/ask-test-home'
const TRANSCRIPT = `${HOME}/projects/p/${SID}.jsonl`
const delivered: Array<{ sessionId: string; text: string }> = []

beforeAll(async () => {
  setCliMayteAccountsProvider(() => [])
  setCliMaytePingDeps({
    deliverPeer: async (sessionId, _transcript, text) => {
      delivered.push({ sessionId, text })
      return { ok: true, reason: 'delivered' }
    },
    composer: undefined,
    toast: async () => undefined,
    journal: () => undefined,
  })
  startCliMayte()
  await climayteReady()
})

afterAll(() => {
  for (const group of ['og-ask', 'og-ask2']) climayteCancel({ group })
  setCliMaytePingDeps(null)
  stopCliMaytePing()
  setCliMayteAccountsProvider(null)
})

const task = (title: string) => ({
  prompt: `do ${title}`,
  cwd: process.cwd(),
  title,
  size: 'whole',
})

describe('a worker asks its origin a question (climayte_ask)', () => {
  test('sets the question, pings the origin, and the climayte_send answer clears it and resumes', async () => {
    const id = climayteRun({
      tasks: [task('ask me')],
      group: 'og-ask',
      origin: { kind: 'chat', sessionId: SID, home: HOME, transcript: TRANSCRIPT, how: 'x' },
    }).workers[0].id
    const w = workers.get(id)
    if (!w) throw new Error('worker missing')
    w.status = 'running'
    const ask = askTools(id)[0]
    expect(ask.name).toBe('climayte_ask')
    const r = (await ask.run({ question: 'Keep the old API?', options: ['keep', 'drop'] })) as {
      ok: boolean
      message: string
    }
    expect(r.ok).toBe(true)
    expect(r.message).toContain('End your turn')
    expect(w.question).toMatchObject({ text: 'Keep the old API?', options: ['keep', 'drop'] })
    expect((climayteGet(id) as { question?: unknown }).question).toBeTruthy()

    // The question reaches the origin at once, naming the worker, and the turn that ends after it
    // is no "needs your verdict" and does not settle the group.
    notify(w)
    w.status = 'done'
    notify(w)
    const before = delivered.length
    await climaytePing()?.flushNow()
    const text = delivered
      .slice(before)
      .map((d) => d.text)
      .join('\n')
    expect(text).toContain(`${id} "ask me": asks: Keep the old API? Options: keep | drop`)
    expect(text).toContain('climayte_send')
    expect(text).not.toContain('needs your verdict')
    // Only this group: an earlier test's cancelled groups can share the same batched ping.
    expect(text).not.toContain('Group og-ask settled')

    // The answer is the existing climayte_send: the same session resumes and the question clears.
    expect(climayteSend(id, 'keep it').ok).toBe(true)
    expect(w.question).toBeUndefined()
    expect(workers.get(id)?.status).toBe('queued')
    expect(w.pending).toEqual(['keep it'])
    expect(w.revived).toBe(true)
    climayteCancel({ group: 'og-ask' })
    workers.delete(id)
  })

  test('only a running worker asks, and the endpoint refuses a caller that is not its CLI', async () => {
    const id = climayteRun({ tasks: [task('ask no')], group: 'og-ask2' }).workers[0].id
    expect((await askTools(id)[0].run({ question: 'q?' })) as { ok: boolean }).toMatchObject({
      ok: false,
    })
    const w = workers.get(id)
    if (!w) throw new Error('worker missing')
    w.attempts = [
      {
        pid: 777,
        outcome: 'done',
        account: { id: 'ask-test', num: 9999, name: 'ask-test' },
      } as unknown as CliMayteAttempt,
    ]
    const asked = (pid: number | null) => {
      const a = new Hono()
      registerAskMcpRoute(a, async () => pid)
      return a.fetch(
        new Request(`http://127.0.0.1/api/corch/ask/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      )
    }
    // A refusal is a 404: Claude Code reads a 401 or 403 as "needs authorization" and caches it.
    expect((await asked(1)).status).toBe(404)
    expect((await asked(null)).status).toBe(404)
    expect((await asked(777)).status).toBe(200)

    // The CLI connects before the daemon has read its pid off the runner's pid file: the worker's
    // own CLI passes on the pid its runner wrote, and another caller is still refused.
    const dir = mkdtempSync(join(tmpdir(), 'ah-ask-pid-'))
    try {
      const pidFile = join(dir, 'runner.pid.json')
      writeFileSync(pidFile, JSON.stringify({ runner: 4242, child: 888 }))
      w.attempts = [
        {
          pid: null,
          outcome: 'running',
          runner: { pid: null, pidFile },
          account: { id: 'ask-test', num: 9999, name: 'ask-test' },
        } as unknown as CliMayteAttempt,
      ]
      expect((await asked(888)).status).toBe(200)
      expect((await asked(4242)).status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    climayteCancel({ group: 'og-ask2' })
    workers.delete(id)
  })
})
