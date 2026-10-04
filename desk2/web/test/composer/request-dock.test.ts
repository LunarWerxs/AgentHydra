import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatStatus, TranscriptItem } from '@shared/protocol'
import { dockedRequest, pendingRequest } from '../../src/components/composer/logic'

// Which request the composer docks in place of the box: the oldest open one, never one of a closed chat.
const perm = (id: string): TranscriptItem => ({ id, ts: 1, kind: 'permission', toolName: 'Bash', input: {}, canAlwaysAllow: false, state: 'pending' })
const form = (id: string, state: 'pending' | 'accepted'): TranscriptItem => ({ id, ts: 2, kind: 'elicitation', serverName: 'connections', message: 'Pick', mode: 'form', fields: [], state })
const chat = (status: ChatStatus) => ({ status })

describe('dockedRequest', () => {
  it('an MCP elicitation docks like the other requests, oldest first', () => {
    expect(pendingRequest([form('e1', 'pending'), perm('p1')])?.id).toBe('e1')
    expect(pendingRequest([form('e1', 'accepted'), perm('p1')])?.id).toBe('p1')
  })

  it('a closed chat docks nothing: a request a dead process left cannot be answered and must not hide the box', () => {
    const items = [perm('p1')]
    expect(dockedRequest(chat('closed'), items)).toBeNull()
    expect(dockedRequest(null, items)).toBeNull()
    for (const status of ['starting', 'working', 'needs_you', 'idle', 'stopped', 'error', 'limited'] as ChatStatus[]) {
      expect(dockedRequest(chat(status), items)?.id).toBe('p1')
    }
  })

  it('the composer docks through it, and every request kind has its card', () => {
    const composer = readFileSync(join(import.meta.dir, '../../src/components/composer/Composer.vue'), 'utf8')
    expect(composer).toContain('dockedRequest(props.chat, shellItems.value.get(chatId.value) ?? [])')
    expect(composer).toContain(`<PlanCard v-else-if="request.kind === 'plan'" :item="request" docked />`)
    expect(composer).toContain('<ElicitationCard v-else :item="request" docked />')
  })
})
