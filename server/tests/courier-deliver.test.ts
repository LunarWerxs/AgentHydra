// server/tests/courier-deliver.test.ts - the courier's hands pinned: aim proof derived from
// the target's OWN transcript, refusals that leave a row pending instead of guessing, and a
// hard cap so one pass can never spray the fleet.
import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CourierDeliverDeps,
  clearRecentlySent,
  deliverPendingRows,
  deriveVerifyCandidates,
  deriveVerifyText,
  distinctInstances,
} from '../src/courier-deliver'

// The post-send cooldown is module-global (one daemon process), so each test starts from a
// clean slate - otherwise an earlier delivery silently suppresses a later test's.
beforeEach(() => clearRecentlySent())

const T0 = Date.parse('2026-08-30T12:00:00Z')

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-aim-'))
  const p = join(dir, 'session.jsonl')
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return p
}

function row(
  over: Partial<{ session_id: string; prompt: string; instance_ref: string | null }> = {},
) {
  return {
    session_id: 's-1',
    prompt: 'resume where you left off',
    instance_ref: 'desktop:C:/i/work',
    staged_at: T0,
    ...over,
  }
}

function deps(over: Partial<CourierDeliverDeps> = {}): CourierDeliverDeps {
  return {
    pending: () => [row()],
    chatOf: () => ({ title: 'A real chat name', instance: 'C:/i/work' }),
    transcriptOf: () =>
      transcript([
        {
          type: 'user',
          message: {
            content: [{ type: 'text', text: 'This is the chat about the widget pipeline' }],
          },
        },
      ]),
    deliver: async () => ({ ok: true, outcome: 'delivered', detail: 'DELIVERED' }),
    ...over,
  }
}

test('the aim proof comes from the target chat OWN user turns', () => {
  const p = transcript([
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'Fix the widget pipeline please' }] },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Ready.' }] } },
  ])
  expect(deriveVerifyText(p)).toBe('Fix the widget pipeline please')
})

test('the NEWEST turn leads the ladder - a bottom-scrolled pane shows the end, not the start', () => {
  // Measured 2026-08-31: the first-turn rule refused every long chat on the fleet, because
  // the conversation pane opens scrolled to the bottom and the opening turn is far above it.
  const p = transcript([
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'The very first instruction of this chat' }] },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } },
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'A later correction only this chat received' }] },
    },
  ])
  expect(deriveVerifyCandidates(p)).toEqual([
    'A later correction only this chat received',
    'The very first instruction of this chat',
  ])
})

test('[agenthydra] boilerplate is never the aim proof - it is identical across resumed chats', () => {
  const p = transcript([
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'Convert the corpus, worst-first, until zero' }] },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '[agenthydra] Gate verdict: crashed (mid-turn) - this chat stopped without finishing its last turn.',
          },
        ],
      },
    },
  ])
  expect(deriveVerifyCandidates(p)).toEqual(['Convert the corpus, worst-first, until zero'])
})

test('a large transcript is read from the TAIL - the head is beyond the viewport anyway', () => {
  // Regression pin for the offset bug: TAIL_BYTES was read from position 0, so on any
  // transcript past 256KB the aim proof came from turns the pane could not possibly show.
  const pad = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] },
  }
  const lines: object[] = [
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'HEAD marker turn, long gone off screen' }] },
    },
  ]
  for (let i = 0; i < 80; i++) lines.push(pad)
  lines.push({
    type: 'user',
    message: { content: [{ type: 'text', text: 'TAIL marker turn, the one actually visible' }] },
  })
  const p = transcript(lines)
  const c = deriveVerifyCandidates(p)
  expect(c[0]).toBe('TAIL marker turn, the one actually visible')
  expect(c).not.toContain('HEAD marker turn, long gone off screen')
})

test('a too-short or missing user turn yields NO aim proof - never a guess', () => {
  expect(deriveVerifyText(transcript([{ type: 'user', message: { content: 'hi' } }]))).toBeNull()
  expect(
    deriveVerifyText(
      transcript([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(40) }] } },
      ]),
    ),
  ).toBeNull()
  expect(deriveVerifyText(join(tmpdir(), 'definitely-missing.jsonl'))).toBeNull()
})

test('the aim snippet is one flat line and bounded, because the app renders one string', () => {
  const p = transcript([
    {
      type: 'user',
      message: { content: [{ type: 'text', text: `multi\n  line   text ${'y'.repeat(200)}` }] },
    },
  ])
  const v = deriveVerifyText(p) as string
  expect(v).not.toContain('\n')
  expect(v.length).toBeLessThanOrEqual(60)
  expect(v.startsWith('multi line text')).toBe(true)
})

test('a pending row is delivered with its own prompt, title and derived aim proof', async () => {
  type Sent = { title: string; message: string; verifyText: string; instanceDir: string }
  const sent: Sent[] = []
  const out = await deliverPendingRows(
    deps({
      deliver: async (o) => {
        sent.push({
          title: o.title,
          message: o.message,
          verifyText: o.verifyText,
          instanceDir: o.instanceDir,
        })
        return { ok: true, outcome: 'delivered', detail: 'DELIVERED' }
      },
    }),
  )
  expect(out[0]?.outcome).toBe('delivered')
  expect(sent.length).toBe(1)
  expect(sent[0]?.title).toBe('A real chat name')
  expect(sent[0]?.message).toBe('resume where you left off')
  expect(sent[0]?.instanceDir).toBe('C:/i/work')
  expect(sent[0]?.verifyText).toContain('widget pipeline')
})

test('no rendered title = no delivery - an Untitled import must be renamed first', async () => {
  let delivered = false
  const out = await deliverPendingRows(
    deps({
      chatOf: () => ({ title: null, instance: 'C:/i/work' }),
      deliver: async () => {
        delivered = true
        return { ok: true, outcome: 'delivered', detail: '' }
      },
    }),
  )
  expect(out[0]?.outcome).toBe('no-title')
  expect(delivered).toBe(false)
})

test('no derivable aim proof = no delivery, row left pending', async () => {
  let delivered = false
  const out = await deliverPendingRows(
    deps({
      transcriptOf: () => null,
      deliver: async () => {
        delivered = true
        return { ok: true, outcome: 'delivered', detail: '' }
      },
    }),
  )
  expect(out[0]?.outcome).toBe('no-aim-proof')
  expect(out[0]?.detail).toContain('not aiming blind')
  expect(delivered).toBe(false)
})

test('no known instance = no delivery', async () => {
  const out = await deliverPendingRows(
    deps({
      pending: () => [row({ instance_ref: null })],
      chatOf: () => null,
    }),
  )
  expect(out[0]?.outcome).toBe('no-home')
})

test('a refusing actuator is reported verbatim, never retried blind', async () => {
  let calls = 0
  const out = await deliverPendingRows(
    deps({
      deliver: async () => {
        calls++
        return { ok: false, outcome: 'wrong-chat', detail: 'REFUSED: conversation mismatch' }
      },
    }),
  )
  expect(out[0]?.outcome).toBe('wrong-chat')
  expect(out[0]?.detail).toContain('REFUSED')
  expect(calls).toBe(1)
})

test('the per-pass cap stops one sweep from spraying the fleet', async () => {
  const many = Array.from({ length: 9 }, (_, i) => row({ session_id: `s-${i}` }))
  let calls = 0
  const out = await deliverPendingRows(
    deps({
      pending: () => many,
      deliver: async () => {
        calls++
        return { ok: true, outcome: 'delivered', detail: '' }
      },
      max: 3,
    }),
  )
  expect(out.length).toBe(3)
  expect(calls).toBe(3)
})

test('distinctInstances counts apps touched, case/slash-insensitively', () => {
  expect(
    distinctInstances([
      { instanceDir: 'C:/i/work' },
      { instanceDir: String.raw`c:\I\WORK` },
      { instanceDir: 'C:/i/other' },
      { instanceDir: null },
    ]),
  ).toBe(3)
})

test('a compaction-summary preamble is NEVER the aim proof - it is identical across chats', () => {
  // ~8% of sessions open with Claude Code's synthetic "This session is being continued from
  // a previous conversation..." record, flagged isCompactSummary. Using it would let the
  // actuator verify itself against a DIFFERENT chat and type there (review-confirmed).
  const p = transcript([
    {
      type: 'user',
      isCompactSummary: true,
      message: {
        content: [
          { type: 'text', text: 'This session is being continued from a previous conversation...' },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'Now fix the widget pipeline for real' }] },
    },
  ])
  expect(deriveVerifyText(p)).toBe('Now fix the widget pipeline for real')
})

test('a wrong-chat refusal walks the ladder: the next candidate is tried, and it delivers', async () => {
  // The refusal PROVED nothing was typed, so trying an older turn is free - and it is the
  // difference between rescuing a long chat and stranding it forever.
  const tried: string[] = []
  const p = transcript([
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'The opening instruction, still on screen' }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'The newest turn, mid-render right now' }] },
    },
  ])
  const out = await deliverPendingRows(
    deps({
      transcriptOf: () => p,
      deliver: async (o) => {
        tried.push(o.verifyText)
        if (tried.length === 1)
          return { ok: false, outcome: 'wrong-chat', detail: 'REFUSED: not visible' }
        return { ok: true, outcome: 'delivered', detail: 'DELIVERED' }
      },
    }),
  )
  expect(tried).toEqual([
    'The newest turn, mid-render right now',
    'The opening instruction, still on screen',
  ])
  expect(out[0]?.outcome).toBe('delivered')
})

test('a busy refusal does NOT walk the ladder - the aim was settled, the chat is just working', async () => {
  const tried: string[] = []
  const p = transcript([
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'First instruction of the chat' }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'Second instruction of the chat' }] },
    },
  ])
  const out = await deliverPendingRows(
    deps({
      transcriptOf: () => p,
      deliver: async (o) => {
        tried.push(o.verifyText)
        return { ok: false, outcome: 'chat-busy', detail: 'turn in flight' }
      },
    }),
  )
  expect(tried).toHaveLength(1)
  expect(out[0]?.outcome).toBe('chat-busy')
})

test('a row delivered moments ago is NOT re-sent - the receipt lags the send', async () => {
  let sends = 0
  const base = deps({
    deliver: async () => {
      sends++
      return { ok: true, outcome: 'delivered', detail: 'DELIVERED' }
    },
  })
  const first = await deliverPendingRows(base)
  expect(first[0]?.outcome).toBe('delivered')
  // The ledger still says pending (the app has not written the receipt yet) - a second pass
  // must refuse rather than type the same prompt again.
  const second = await deliverPendingRows(base)
  expect(second[0]?.outcome).toBe('recently-sent')
  expect(sends).toBe(1)
})

test('the cooldown is stamped only on SUCCESS - a refusal stays retryable', async () => {
  let sends = 0
  const base = deps({
    deliver: async () => {
      sends++
      return { ok: false, outcome: 'chat-busy', detail: 'ABORT' }
    },
  })
  await deliverPendingRows(base)
  const second = await deliverPendingRows(base)
  expect(second[0]?.outcome).toBe('chat-busy')
  expect(sends).toBe(2)
})

test('the cooldown expires, so a genuinely undelivered row is retried later', async () => {
  let t = 1_000_000
  let sends = 0
  const base = deps({
    nowMs: () => t,
    deliver: async () => {
      sends++
      return { ok: true, outcome: 'delivered', detail: 'DELIVERED' }
    },
  })
  await deliverPendingRows(base)
  t += 4 * 60_000 // past the 3-minute cooldown
  const later = await deliverPendingRows(base)
  expect(later[0]?.outcome).toBe('delivered')
  expect(sends).toBe(2)
})

// --- THE DELIVERY BREAKER ---------------------------------------------------------------
// Archive and surface have been behind the circuit breaker since it was built; DELIVERY, the
// one actuator that types into a real window, was not. Its only anti-repeat guard is stamped on
// success, so every failure outcome left the row eligible and the always-on 5-minute courier
// tick retyped into the same chat forever. Found by an adversarial audit 2026-08-30.

test('a chat that keeps refusing delivery is SUPPRESSED after the cap, not retyped forever', async () => {
  const { ATTEMPT_CAP, checkBreaker, clearAttempts } = await import('../src/breaker')
  const { db } = await import('../src/db')
  db.query('delete from action_attempt_log').run()
  clearAttempts('deliver', 's-1')
  const d = deps({
    deliver: async () => ({ ok: false, outcome: 'composer-refused', detail: 'no' }),
  })
  let refusals = 0
  for (let i = 0; i < ATTEMPT_CAP; i++) {
    clearRecentlySent()
    const rows = await deliverPendingRows(d)
    if (rows[0]?.outcome === 'composer-refused') refusals++
  }
  expect(refusals).toBe(ATTEMPT_CAP)
  clearRecentlySent()
  const capped = await deliverPendingRows(d)
  expect(capped[0]?.outcome).toBe('suppressed')
  expect(capped[0]?.detail).toContain('retry allowed after')
  expect(checkBreaker('deliver', 's-1', Date.now()).suppressed).toBe(true)
  db.query('delete from action_attempt_log').run()
})

test('a delivery that LANDS clears the count - the brake is for futility, not for work that works', async () => {
  const { checkBreaker, clearAttempts } = await import('../src/breaker')
  const { db } = await import('../src/db')
  db.query('delete from action_attempt_log').run()
  clearAttempts('deliver', 's-1')
  clearRecentlySent()
  await deliverPendingRows(
    deps({ deliver: async () => ({ ok: true, outcome: 'delivered', detail: 'sent' }) }),
  )
  expect(checkBreaker('deliver', 's-1', Date.now()).attempts).toBe(0)
  db.query('delete from action_attempt_log').run()
})

test('the attempt is counted BEFORE the send, so one that dies mid-send still counts', async () => {
  const { checkBreaker } = await import('../src/breaker')
  const { db } = await import('../src/db')
  db.query('delete from action_attempt_log').run()
  clearRecentlySent()
  await expect(
    deliverPendingRows(
      deps({
        deliver: async () => {
          throw new Error('the actuator died mid-send')
        },
      }),
    ),
  ).rejects.toThrow('the actuator died mid-send')
  expect(checkBreaker('deliver', 's-1', Date.now()).attempts).toBe(1)
  db.query('delete from action_attempt_log').run()
})
