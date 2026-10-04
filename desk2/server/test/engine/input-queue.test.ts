import { describe, expect, test } from 'bun:test'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { InputQueue, buildUserMessage } from '../../src/engine/input-queue'

function texts(msgs: SDKUserMessage[]): string[] {
  return msgs.map((m) => {
    const c = m.message.content
    return typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
  })
}

describe('buildUserMessage', () => {
  test('human origin, images as base64 blocks before the text', () => {
    const msg = buildUserMessage({ text: 'look', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }, { mediaType: 'image/png' }] }, '00000000-0000-4000-8000-000000000001')
    expect(msg).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'look' },
        ],
      },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      uuid: '00000000-0000-4000-8000-000000000001',
    })
  })
})

describe('InputQueue', () => {
  test('pushed before iterating, taken in order', async () => {
    const q = new InputQueue()
    q.push({ text: 'one' })
    q.push({ text: 'two' })
    q.close()
    const got: SDKUserMessage[] = []
    for await (const m of q) got.push(m)
    expect(texts(got)).toEqual(['one', 'two'])
  })

  test('a waiting iterator gets each push, close ends it', async () => {
    const q = new InputQueue()
    const got: SDKUserMessage[] = []
    const done = (async () => {
      for await (const m of q) got.push(m)
    })()
    await Bun.sleep(1)
    q.push({ text: 'a' })
    await Bun.sleep(1)
    q.push({ text: 'b' })
    q.push({ text: 'c' })
    q.close()
    await done
    expect(texts(got)).toEqual(['a', 'b', 'c'])
  })

  test('push after close throws; each message has its own uuid', () => {
    const q = new InputQueue()
    const a = q.push({ text: 'a' })
    const b = q.push({ text: 'b' })
    expect(a.uuid).not.toBe(b.uuid)
    q.close()
    expect(() => q.push({ text: 'c' })).toThrow()
  })
})
