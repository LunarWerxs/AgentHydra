// The dry run's one promise is READ-ONLY: same classifications as the live wake, zero writes.
// These tests pin the classification half (shared with the real ack path by construction) and
// the owner-facing rendering.
import { describe, expect, test } from 'bun:test'
import type { DryRun } from '../src/orchestrator-worklist'
import { classifyAutoAck, renderDryRunText } from '../src/orchestrator-worklist'
import type { AttentionItem } from '../src/types'

const att = (kind: string, detail: Record<string, unknown> = {}, sessionId = 's1'): AttentionItem =>
  ({ key: `${kind}:${sessionId}`, kind, sessionId, summary: kind, detail }) as AttentionItem

describe('classifyAutoAck', () => {
  test('the no-action kinds classify without writing', () => {
    expect(classifyAutoAck(att('orphaned'), 'rev', [])?.action).toBe('auto:see-proposal')
    expect(classifyAutoAck(att('interrupted'), 'rev', [])?.action).toBe('auto:human-interrupted')
    expect(classifyAutoAck(att('limit_stopped'), 'rev', [])?.action).toBe(
      'auto:monitor-jurisdiction',
    )
    expect(classifyAutoAck(att('errored', { ending: 'error' }), 'rev', [])?.action).toBe(
      'auto:needs-owner',
    )
  })

  test('items about the reviewer itself always classify as self', () => {
    expect(classifyAutoAck(att('idle_pending', {}, 'rev'), 'rev', [])?.action).toBe(
      'auto:self-reviewer',
    )
  })

  test('judgment items classify as null - they reach the reviewer', () => {
    expect(classifyAutoAck(att('errored', { ending: 'overload' }), 'rev', [])).toBeNull()
    expect(classifyAutoAck(att('idle_pending', { recapDetected: true }), 'rev', [])).toBeNull()
  })
})

describe('renderDryRunText', () => {
  test('renders every section the owner needs to veto from', () => {
    const d: DryRun = {
      generatedAt: '2026-08-29T02:00:00.000Z',
      workMode: 'react',
      reviewer: { lastSeenAt: '2026-08-29T01:10:00.000Z', presentWithin20m: false },
      instances: [
        {
          instance: '5claude',
          weeklyPct: 16,
          band: 'ok',
          archivedCount: 3,
          chats: [
            {
              title: 'Some chat',
              chatId: 'local_x',
              sessionId: 'x',
              cwd: 'D:\\repo',
              lastActivityAt: '2026-08-29T01:28:00.000Z',
              done: true,
              live: { pid: 123, peerName: 'p-1' },
              permissionMode: 'bypassPermissions',
            },
          ],
          agentChat: null,
        },
      ],
      wouldAsk: [
        {
          id: 'i1',
          kind: 'revive',
          title: 'Dead chat',
          question: 'Revive it?',
          evidence: { summary: 'died 22m ago' },
          constraintsApplied: [],
          serverOnly: false,
          unreachable: 'no live chat in that app',
        },
      ],
      wouldAutoHandle: ['orphan:x -> auto:see-proposal'],
      wouldSuppress: ['repo:y -> collision-suppressed (two live chats in that repo)'],
      inFlight: [{ itemId: 'i2', phase: 'closeout-delivered', targetSessionId: 't' }],
      pendingRenames: [{ sessionId: 'abcdefgh-rest', title: 'New name' }],
      placement: null,
      unreachable: [],
      note: 'READ-ONLY PLAN.',
    }
    const text = renderDryRunText(d)
    expect(text).toContain('reviewer: NONE')
    expect(text).toContain('5claude (16% weekly, ok)')
    expect(text).toContain('Some chat - LIVE pid 123 - done-marked')
    expect(text).toContain('(+3 archived)')
    // The courier line is ALWAYS printed: "no agent chat" and "quiet instance" must never look
    // alike - that hole is what the seed-agent item exists to fill.
    expect(text).toContain('agent chat: NONE')
    expect(text).toContain('WOULD ASK THE REVIEWER (1)')
    expect(text).toContain('[revive] Dead chat')
    expect(text).toContain('UNREACHABLE: no live chat in that app')
    expect(text).toContain('WOULD HANDLE ITSELF, NO REVIEWER INVOLVED (1)')
    expect(text).toContain('WOULD SUPPRESS (1)')
    expect(text).toContain('MID-DELIVERY FROM AN EARLIER WAKE (1)')
    expect(text).toContain('PENDING RENAMES (1)')
    expect(text).toContain('READ-ONLY PLAN.')
  })
})
