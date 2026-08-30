// server/tests/courier-deliver.test.ts - the courier's hands pinned: aim proof derived from
// the target's OWN transcript, refusals that leave a row pending instead of guessing, and a
// hard cap so one pass can never spray the fleet.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CourierDeliverDeps,
  deliverPendingRows,
  deriveVerifyText,
  distinctInstances,
} from '../src/courier-deliver'

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

test('the aim proof comes from the target chat OWN first user turn', () => {
  const p = transcript([
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'Fix the widget pipeline please' }] },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Ready.' }] } },
  ])
  expect(deriveVerifyText(p)).toBe('Fix the widget pipeline please')
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
