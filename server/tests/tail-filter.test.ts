// server/src/transcript.ts — what a transcript tail is allowed to show.
//
// These are display controls, but the interesting half of each one is a REFUSAL: reasoning blocks
// stay out unless asked for, `redacted_thinking` shows nothing even when asked (it carries no
// readable text), and "only what I typed" means only the USER's prose — not the user-role
// `tool_result` turns, which the transcript format also files under `user`.
//
// The predicate lives in one place (tailKeeper) precisely so the disk path and the OpenCode path
// cannot drift; these tests pin the rules it encodes.

import { describe, expect, test } from 'bun:test'
import { eventToTailEvents, tailKeeper } from '../src/transcript'
import type { TailEvent } from '../src/types'

const assistant = (...content: unknown[]) => ({
  type: 'assistant',
  timestamp: '2026-08-13T10:00:00.000Z',
  message: { role: 'assistant', content },
})

describe('reasoning blocks', () => {
  test('are dropped by default, which is the long-standing behaviour', () => {
    const events = eventToTailEvents(
      assistant({ type: 'thinking', thinking: 'let me consider' }, { type: 'text', text: 'Done.' }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('text')
  })

  test('are emitted as their own kind when asked for, keeping their order', () => {
    const events = eventToTailEvents(
      assistant({ type: 'thinking', thinking: 'let me consider' }, { type: 'text', text: 'Done.' }),
      { thinking: true },
    )
    expect(events.map((e) => e.kind)).toEqual(['thinking', 'text'])
    expect(events[0]?.text).toBe('let me consider')
    expect(events[0]?.role).toBe('assistant')
  })

  test('redacted reasoning shows nothing even when asked for: there is nothing to show', () => {
    const events = eventToTailEvents(
      assistant({ type: 'redacted_thinking', data: 'AAAAencryptedAAAA' }),
      { thinking: true },
    )
    expect(events).toEqual([])
  })

  test('an empty reasoning block does not become an empty bubble', () => {
    expect(
      eventToTailEvents(assistant({ type: 'thinking', thinking: '   ' }), { thinking: true }),
    ).toEqual([])
  })
})

describe('which turns survive the display filter', () => {
  const ev = (kind: TailEvent['kind'], role: TailEvent['role']): TailEvent => ({
    role,
    kind,
    text: 'x',
    tool_name: null,
    timestamp: null,
  })
  const all: TailEvent[] = [
    ev('text', 'user'),
    ev('text', 'assistant'),
    ev('thinking', 'assistant'),
    ev('tool_use', 'assistant'),
    ev('tool_result', 'user'),
  ]
  const kinds = (opts: Parameters<typeof tailKeeper>[0]) =>
    all.filter(tailKeeper(opts)).map((e) => `${e.role}:${e.kind}`)

  test('no filter keeps everything', () => {
    expect(kinds({})).toHaveLength(5)
  })

  test('textOnly drops tool traffic but keeps reasoning, which is not tool traffic', () => {
    expect(kinds({ textOnly: true })).toEqual(['user:text', 'assistant:text', 'assistant:thinking'])
  })

  test('humanOnly means the prose a person typed — not the user-role tool_result turns', () => {
    expect(kinds({ humanOnly: true })).toEqual(['user:text'])
  })

  test('humanOnly wins over textOnly, so the two cannot be combined into a surprise', () => {
    expect(kinds({ humanOnly: true, textOnly: true })).toEqual(['user:text'])
  })
})

describe('the other block types are unaffected by the new flag', () => {
  test('tool_use still collapses to a named tool event', () => {
    const events = eventToTailEvents(
      assistant({ type: 'tool_use', name: 'Read', input: { file: 'a.ts' } }),
      { thinking: true },
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('tool_use')
    expect(events[0]?.tool_name).toBe('Read')
  })

  test('a plain-string user message is still one text event', () => {
    const events = eventToTailEvents({
      type: 'user',
      timestamp: null,
      message: { role: 'user', content: 'do the thing' },
    })
    expect(events).toEqual([
      { role: 'user', kind: 'text', text: 'do the thing', tool_name: null, timestamp: null },
    ])
  })
})
