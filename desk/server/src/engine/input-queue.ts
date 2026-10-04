// The streaming-input prompt of a chat's query(): an AsyncIterable<SDKUserMessage> that stays open for
// the chat's life. push() a message at any time (the CLI queues it behind a running turn); close() ends it.

import { randomUUID, type UUID } from 'node:crypto'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ImageRef } from '@shared/protocol'

export interface QueuedInput {
  text: string
  images?: ImageRef[]
}

type ContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number]

/** One SDKUserMessage as sdk.d.ts wants it: origin human, images as base64 blocks before the text. */
export function buildUserMessage(input: QueuedInput, uuid: string = randomUUID()): SDKUserMessage {
  const blocks: ContentBlock[] = []
  for (const img of input.images ?? []) {
    if (!img.dataBase64) continue
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType as 'image/png', data: img.dataBase64 },
    })
  }
  if (input.text) blocks.push({ type: 'text', text: input.text })
  return {
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    // A named id comes from the send queue's saved file, so it is a plain string: the SDK types it as a UUID.
    uuid: uuid as UUID,
  }
}

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  /** Queues a message and returns it (its uuid comes back on the SDK's replies as user_message_uuid); `uuid` names it, else a new one. */
  push(input: QueuedInput, uuid?: string): SDKUserMessage {
    if (this.closed) throw new Error('input queue is closed')
    const msg = buildUserMessage(input, uuid)
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: msg, done: false })
    } else {
      this.items.push(msg)
    }
    return msg
  }

  /** Ends the iteration once what is already queued has been taken. */
  close(): void {
    this.closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  get pending(): number {
    return this.items.length
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const head = this.items.shift()
        if (head) return Promise.resolve({ value: head, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
