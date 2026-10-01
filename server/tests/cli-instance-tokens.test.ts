// The CLI table's Tokens column (core/cli-instance-tokens.ts): one usage per reply, never one per
// streamed line, summed over every transcript under the instance's own projects folder.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliInstanceTokens, refreshCliInstanceTokens } from '../src/core/cli-instance-tokens'
import { createCliInstance, deleteCliInstance } from '../src/core/cli-instances'

const created: { id: string; name: string }[] = []
afterAll(() => {
  for (const { id, name } of created) deleteCliInstance(id, name)
})

const usage = (input: number, output: number, read: number, write: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})
const line = (o: unknown) => `${JSON.stringify(o)}\n`

describe('cliInstanceTokens', () => {
  test('counts each reply once, by its last usage, across every transcript of the instance', async () => {
    const name = `cli-tokens-${crypto.randomUUID().slice(0, 8)}`
    const made = createCliInstance(name)
    expect(made.ok).toBe(true)
    created.push({ id: made.data?.id as string, name })
    const projects = join(made.dir as string, 'projects')
    mkdirSync(join(projects, 'a', 'subagents'), { recursive: true })
    // One reply streamed as three lines, each repeating its usage (the last one is final), then a
    // second reply, and lines that carry no assistant usage.
    writeFileSync(
      join(projects, 'a', 's1.jsonl'),
      line({ type: 'user', message: { content: 'hi', usage: usage(9, 9, 9, 9) } }) +
        line({ type: 'assistant', message: { id: 'm1', usage: usage(3, 1, 100, 10) } }) +
        line({ type: 'assistant', message: { id: 'm1', usage: usage(3, 1, 100, 10) } }) +
        line({ type: 'assistant', message: { id: 'm1', usage: usage(3, 40, 100, 10) } }) +
        line({ type: 'assistant', message: { id: 'm2', usage: usage(2, 5, 200, 0) } }) +
        'not json\n',
    )
    writeFileSync(
      join(projects, 'a', 'subagents', 'agent-1.jsonl'),
      line({ type: 'assistant', message: { id: 'm3', usage: usage(1, 2, 30, 4) } }),
    )
    await refreshCliInstanceTokens()
    expect(cliInstanceTokens(made.dir as string)).toEqual({
      input: 6,
      output: 47,
      cacheRead: 330,
      cacheWrite: 14,
      total: 397,
    })
  })
})
