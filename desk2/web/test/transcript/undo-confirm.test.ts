import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { undoCount } from '../../src/components/transcript/lib/undo-count'

const user = (id: string, ts: number, text = 'a note of mine'): TranscriptItem => ({ id, ts, kind: 'user', text })
const reply = (id: string, ts: number): TranscriptItem => ({ id, ts, kind: 'assistant_text', text: 'an invented reply' })
const tool = (id: string, ts: number): TranscriptItem => ({ id, ts, kind: 'tool_use', name: 'Read', input: {} }) as unknown as TranscriptItem
const thinking = (id: string, ts: number): TranscriptItem => ({ id, ts, kind: 'thinking', text: 'invented thinking' })
const note = (id: string, ts: number): TranscriptItem => ({ id, ts, kind: 'note', from: 'ping', text: 'invented note' })

const chat: TranscriptItem[] = [
  user('u1', 1),
  thinking('t1', 2),
  tool('k1', 3),
  reply('r1', 4),
  user('u2', 5),
  tool('k2', 6),
  note('n1', 7),
  reply('r2', 8),
  user('u3', 9),
  thinking('t2', 10),
  reply('r3', 11),
]

describe('undoCount', () => {
  it('the last message of yours takes out just itself', () => {
    expect(undoCount(chat, 'u3')).toEqual({ yours: 1, replies: 1, total: 2 })
  })

  it('an earlier message counts itself and everything after it, not the tool, thinking or note rows', () => {
    expect(undoCount(chat, 'u2')).toEqual({ yours: 2, replies: 2, total: 4 })
    expect(undoCount(chat, 'u1')).toEqual({ yours: 3, replies: 3, total: 6 })
  })

  it('a reply counts from the message it answers, so the reply is never left out of the total', () => {
    expect(undoCount(chat, 'u2')).toEqual({ yours: 2, replies: 2, total: 4 })
    expect(undoCount(chat, 'u3')).toEqual({ yours: 1, replies: 1, total: 2 })
  })

  it('sub-agent rows are not messages', () => {
    const nested = { ...reply('sub1', 12), parentToolUseId: 'agent-1' } as TranscriptItem
    expect(undoCount([...chat, nested], 'u3')).toEqual({ yours: 1, replies: 1, total: 2 })
  })

  it('an unknown id is null', () => {
    expect(undoCount(chat, 'nope')).toBeNull()
    expect(undoCount([], 'u1')).toBeNull()
  })
})

describe('the Undo confirmation is wired', () => {
  const actions = readFileSync(join(import.meta.dir, '../../src/components/transcript/parts/MessageActions.vue'), 'utf8')
  const view = readFileSync(join(import.meta.dir, '../../src/components/transcript/TranscriptView.vue'), 'utf8')

  it('the Undo button asks first instead of rewinding directly', () => {
    expect(actions).toContain('@click="askOrUndo"')
    expect(actions).not.toContain('@click="undo"')
    expect(actions).toContain('if ((undoTakes.value?.yours ?? 0) > 1) askUndo.value = true')
  })

  it('the dialog puts Cancel first, so the initial focus lands there and never on Undo', () => {
    const cancel = actions.indexOf('>Cancel</button>')
    const fork = actions.indexOf('>Fork instead</button>')
    const undoButton = actions.indexOf('@click="confirmUndo">Undo {{ undoTakes?.total }} messages</button>')
    expect(cancel).toBeGreaterThan(0)
    expect(fork).toBeGreaterThan(cancel)
    expect(undoButton).toBeGreaterThan(fork)
  })

  it('Fork instead uses the undo point and the reply-aware text', () => {
    expect(actions).toContain('void forkBefore(at, props.resend.text)')
  })

  it('the transcript hands its items to the message actions', () => {
    expect(view).toContain('items: computed(() => props.items),')
  })
})
