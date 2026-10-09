// The judge's answer is read strictly: a verdict the model did not name, a stray field or a text that is not one JSON
// object is an error, never a guess. The model itself is never reached here: judgeChat takes an injected ask.

import { expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { JUDGE_CHARS, JUDGE_INSTRUCTIONS, judgeChat, MESSAGE_CHARS, parseJudgment, recentText, type JudgeBrief } from '../../src/orchestrator/judge'

const brief: JudgeBrief = {
  id: 'chat-1', title: 'Example chat', source: 'desk', status: 'working', ask: 'Fix the example parser.', recent: '(no transcript yet)',
  workingMinutes: 12, signals: ['spinning: the same Bash call failed 3 times'], notesThisHour: 0, continuesThisHour: 0
}

test('a well-formed answer parses into its verdict, message and why', () => {
  expect(parseJudgment('{"verdict":"nudge","message":"Read the error first.","why":"the same test fails again"}')).toEqual({
    ok: true,
    judgment: { verdict: 'nudge', message: 'Read the error first.', why: 'the same test fails again' }
  })
  expect(parseJudgment('{"verdict":"continue","message":"Carry on.","why":"stopped on a timeout"}')).toMatchObject({ ok: true, judgment: { verdict: 'continue' } })
})

test('fine and leave send nothing, whatever message the model wrote', () => {
  expect(parseJudgment('{"verdict":"fine","message":"","why":"moving"}')).toEqual({ ok: true, judgment: { verdict: 'fine', message: '', why: 'moving' } })
  expect(parseJudgment('{"verdict":"leave","message":"Approve the plan?","why":"a plan waits for the owner"}')).toEqual({
    ok: true,
    judgment: { verdict: 'leave', message: '', why: 'a plan waits for the owner' }
  })
})

test('an answer that is not JSON, or is not one object, is an error', () => {
  for (const text of ['', 'nudge: read the error', '```json\n{"verdict":"fine","message":"","why":"x"}\n```', '["fine"]', 'null']) {
    expect(parseJudgment(text)).toMatchObject({ ok: false })
  }
})

test('a verdict the model did not name is an error', () => {
  expect(parseJudgment('{"verdict":"restart","message":"","why":"x"}')).toMatchObject({ ok: false, error: expect.stringContaining('verdict') })
  expect(parseJudgment('{"verdict":"Nudge","message":"Hi","why":"x"}')).toMatchObject({ ok: false })
})

test('a stray or missing field is an error, so the answer is never half read', () => {
  expect(parseJudgment('{"verdict":"fine","message":"","why":"x","confidence":0.9}')).toMatchObject({ ok: false })
  expect(parseJudgment('{"verdict":"fine","why":"x"}')).toMatchObject({ ok: false })
})

test('nudge and continue need a message to send, and a message stays under the limit', () => {
  expect(parseJudgment('{"verdict":"nudge","message":"  ","why":"x"}')).toMatchObject({ ok: false })
  expect(parseJudgment(`{"verdict":"continue","message":"${'x'.repeat(MESSAGE_CHARS + 1)}","why":"x"}`)).toMatchObject({ ok: false })
  expect(parseJudgment('{"verdict":"fine","message":"","why":"  "}')).toMatchObject({ ok: false })
})

test('judgeChat returns the parsed judgment and the model the SDK resolved', async () => {
  const seen: { model: string; system: string }[] = []
  const ask = async (req: { model: string; system: string; brief: JudgeBrief }) => {
    seen.push({ model: req.model, system: req.system })
    return { text: '{"verdict":"nudge","message":"Stop the loop.","why":"repeats a failing test"}', resolved: 'claude-opus-5-5' }
  }
  const result = await judgeChat(brief, 'opus', ask)
  expect(result).toEqual({ ok: true, judgment: { verdict: 'nudge', message: 'Stop the loop.', why: 'repeats a failing test' }, resolved: 'claude-opus-5-5' })
  expect(seen).toEqual([{ model: 'opus', system: JUDGE_INSTRUCTIONS }])
})

test('a model call that never answers in time is an error and sends nothing', async () => {
  const hang = ({ signal }: { signal: AbortSignal }) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  const result = await judgeChat(brief, 'opus', hang, 20)
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('no answer within') })
})

test('a failed model call is an error, never a guess', async () => {
  const down = async () => {
    throw new Error('model down')
  }
  expect(await judgeChat(brief, 'opus', down)).toEqual({ ok: false, error: 'model down', resolved: null })
})

test('the transcript read by the judge stays within its budget and keeps the newest items', () => {
  const long = (i: number): TranscriptItem => ({ id: `u${i}`, ts: i, kind: 'user', text: `message ${i} ${'x'.repeat(1_500)}` })
  const items = Array.from({ length: 30 }, (_, i) => long(i))
  const text = recentText(items)
  expect(text.length).toBeLessThanOrEqual(JUDGE_CHARS)
  expect(text).toContain('message 29 ')
  expect(text).not.toContain('message 0 ')
  expect(recentText([])).toBe('(no transcript yet)')
})
