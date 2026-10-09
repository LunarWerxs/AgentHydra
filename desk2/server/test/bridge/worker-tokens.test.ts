import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliMayteWorker } from '@shared/protocol'
import type { AhWorker } from '../../src/bridge/client'
import { createWorkerTokens } from '../../src/bridge/worker-tokens'

const home = mkdtempSync(join(tmpdir(), 'desk-worker-tokens-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const configDir = join(home, 'cli-7')
const project = join(configDir, 'projects', 'C--work-alpha')
mkdirSync(project, { recursive: true })

const assistant = (id: string, usage: Record<string, number>) =>
  `${JSON.stringify({ type: 'assistant', message: { id, usage } })}\n`

const raw = (over: Partial<AhWorker> = {}): AhWorker => ({
  id: 'w1',
  group: 'g',
  title: 't',
  cwd: 'C:/work/alpha',
  prompt: 'p',
  status: 'running',
  sessionId: 'sess-1',
  accountId: 'cli-7',
  account: '#7 x',
  model: null,
  effort: null,
  result: null,
  error: null,
  lastActivity: null,
  createdAt: 1,
  updatedAt: 10,
  ...over,
})

const mapped = (over: Partial<CliMayteWorker> = {}): CliMayteWorker =>
  ({ id: 'w1', active: true, tokens: null, ...over }) as CliMayteWorker

describe('worker tokens from the transcript', () => {
  const dirs = new Map([['cli-7', configDir]])
  const file = join(project, 'sess-1.jsonl')
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'user', message: { content: 'go' } })}\n` +
      assistant('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }) +
      assistant('m1', { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }) +
      assistant('m2', { input_tokens: 1, output_tokens: 2 }),
  )

  test('sums each assistant message once, at its largest figure', async () => {
    const wt = createWorkerTokens()
    const list = [mapped()]
    await wt.apply(list, [raw()], dirs)
    expect(list[0].tokens).toBe(37 + 3)
  })

  test('reads only what was appended, and only when updatedAt moved', async () => {
    const wt = createWorkerTokens()
    const a = [mapped()]
    await wt.apply(a, [raw()], dirs)
    appendFileSync(file, assistant('m3', { input_tokens: 1000 }))
    const same = [mapped()]
    await wt.apply(same, [raw()], dirs)
    expect(same[0].tokens).toBe(40)
    const moved = [mapped()]
    await wt.apply(moved, [raw({ updatedAt: 11 })], dirs)
    expect(moved[0].tokens).toBe(1040)
  })

  test('keeps the settled figure when it is larger, and when no transcript is found', async () => {
    const wt = createWorkerTokens()
    const big = [mapped({ tokens: 5000 })]
    await wt.apply(big, [raw({ updatedAt: 12 })], dirs)
    expect(big[0].tokens).toBe(5000)
    const lost = [mapped({ tokens: null })]
    await wt.apply(lost, [raw({ sessionId: 'nowhere', updatedAt: 13 })], dirs)
    expect(lost[0].tokens).toBeNull()
  })

  test('leaves settled workers alone', async () => {
    const wt = createWorkerTokens()
    const done = [mapped({ active: false, tokens: 42 })]
    await wt.apply(done, [raw({ status: 'done' })], dirs)
    expect(done[0].tokens).toBe(42)
  })
})
