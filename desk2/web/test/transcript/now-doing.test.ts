import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { nowDoing, runningFor } from '../../src/components/transcript/lib/now-doing'

const user = (id: string, ts: number, extra: Partial<Extract<TranscriptItem, { kind: 'user' }>> = {}): TranscriptItem => ({ id, ts, kind: 'user', text: 'go', ...extra })
const tool = (id: string, name: string, input: Record<string, unknown>, parentToolUseId?: string): TranscriptItem => ({
  id,
  ts: 1,
  kind: 'tool_use',
  name,
  input,
  status: 'running',
  startedAt: 1,
  parentToolUseId,
})
const text = (id: string, streaming = false): TranscriptItem => ({ id, ts: 1, kind: 'assistant_text', text: 'ok', streaming })

describe('nowDoing', () => {
  test("the line is the turn's newest main-thread step in its own words, and the clock starts at the person's last message", () => {
    const items: TranscriptItem[] = [
      user('u1', 100),
      tool('b', 'Bash', { command: 'git push', description: 'Land the tightened ceiling file alone' }),
      user('u2', 500),
      tool('g', 'Agent', { description: 'Reading how lastCwd and session files are derived' }),
      // The sub-agent's own steps, its prompt included, stay inside it.
      user('sub', 600, { parentToolUseId: 'g' }),
      tool('r', 'Read', { file_path: 'C:/Users/me/p/a.ts' }, 'g'),
      // A message queued for after the turn is not the one the clock counts from.
      user('q', 700, { queued: true }),
    ]
    // The line names the call it read the words from: the line's ">" opens that step.
    expect(nowDoing(items)).toEqual({ text: 'Reading how lastCwd and session files are derived', step: 'g', since: 500 })
    // A finished reply between calls keeps the line on the newest call; a reply streaming now says so.
    expect(nowDoing([...items, text('t')]).text).toBe('Reading how lastCwd and session files are derived')
    expect(nowDoing([...items, text('t', true)])).toEqual({ text: 'Writing', step: 't', since: 500 })
    // A call with no description says what kind of step it is.
    expect(nowDoing([user('u', 1), tool('e', 'Edit', { file_path: 'C:/Users/me/p/src/a.ts' })], 'C:/Users/me/p').text).toBe('Editing src/a.ts')
  })

  test("a program's note starts a turn: the earlier turn's call is not the line, and the clock stays on the person's message", () => {
    const note: TranscriptItem = { id: 'n', ts: 900, kind: 'note', from: 'AgentHydra', text: 'Ping' }
    const items: TranscriptItem[] = [user('u1', 100), tool('b', 'Bash', { command: 'bun test' }), note]
    expect(nowDoing(items)).toEqual({ text: null, step: null, since: 100 })
    expect(nowDoing([])).toEqual({ text: null, step: null, since: null })
  })
})

describe('runningFor', () => {
  test('counts as Claude Desktop does: seconds, then minutes and seconds, then hours, minutes and seconds', () => {
    expect([0, 33_400, 93_000, 548_000, 5_303_000].map(runningFor)).toEqual(['0s', '33s', '1m 33s', '9m 8s', '1h 28m 23s'])
  })
})
