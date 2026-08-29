// A courier RUN does not exit when it finishes (measured 2026-08-29: 13 of 14 leftover courier
// chats were live, idle 8-15 minutes, processes never terminating). The sweep therefore has to
// stop them - and must never touch a run that is still working, nor anything that is not ours.
import { describe, expect, test } from 'bun:test'
import type { LiveSession } from '../src/orchestrator'
import { courierQuietMs } from '../src/orchestrator'
import { isCourierRunTitle } from '../src/orchestrator-courier'

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  pid: 4242,
  sessionId: 's1',
  cwd: 'C:\\Users\\x\\.claude-instances\\2claude',
  name: 'peer-01',
  startedAt: Date.now() - 600_000,
  transcriptPath: 'C:\\fake\\t.jsonl',
  ...over,
})

describe('courier zombie sweep', () => {
  test('quiet time comes from the transcript, and unreadable means LEAVE IT ALONE', () => {
    const now = Date.parse('2026-08-29T06:00:00.000Z')
    expect(
      courierQuietMs(session(), now, () => ({ lastEventAt: '2026-08-29T05:50:00.000Z' })),
    ).toBe(600_000)
    // Every "cannot tell" path returns null - absence of evidence must never justify a kill.
    expect(
      courierQuietMs(session({ transcriptPath: null }), now, () => ({ lastEventAt: 'x' })),
    ).toBeNull()
    expect(courierQuietMs(session(), now, () => ({ lastEventAt: null }))).toBeNull()
    expect(courierQuietMs(session(), now, () => ({ lastEventAt: 'not-a-date' }))).toBeNull()
    expect(
      courierQuietMs(session(), now, () => {
        throw new Error('unreadable')
      }),
    ).toBeNull()
  })

  test('a run still working is not stale by the five-minute floor', () => {
    const now = Date.parse('2026-08-29T06:00:00.000Z')
    const quiet = courierQuietMs(session(), now, () => ({
      lastEventAt: '2026-08-29T05:58:30.000Z',
    }))
    expect(quiet).not.toBeNull()
    expect((quiet as number) < 5 * 60_000).toBe(true)
  })

  test('the title marker admits ONLY courier runs', () => {
    expect(isCourierRunTitle('Orch courier 2claude')).toBe(true)
    expect(isCourierRunTitle('orch courier anything')).toBe(true)
    // Real work, and the agent chat, must never be swept by this.
    expect(isCourierRunTitle('Orchestrator agent - do not use')).toBe(false)
    expect(isCourierRunTitle('99 Bricks game recreation')).toBe(false)
    expect(isCourierRunTitle('Courier tracking feature')).toBe(false)
    expect(isCourierRunTitle(null)).toBe(false)
  })
})
