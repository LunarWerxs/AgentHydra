// server/tests/chat-title.test.ts - Piece 5 pinned: every door of the naming contract.
import { expect, test } from 'bun:test'
import { isGenericChatTitle, resolveRequiredTitle } from '../src/chat-title'

test('generic detection: the manufactured non-names, plumbing, and emptiness', () => {
  for (const t of [
    'Untitled',
    'untitled',
    'General Coding Session',
    'New chat',
    'New Session',
    '',
    '   ',
    null,
    undefined,
    '[orchestrator] seeded thing',
  ])
    expect(isGenericChatTitle(t as string | null | undefined)).toBe(true)
  for (const t of [
    'Postal Kumo warmup feature',
    'Migration drill 0829',
    'untitled thoughts on naming',
  ])
    expect(isGenericChatTitle(t)).toBe(false)
})

test('zero-width and doubled-whitespace disguises of generic names are still generic', () => {
  expect(isGenericChatTitle('Untitled​')).toBe(true)
  expect(isGenericChatTitle('​Untitled')).toBe(true)
  expect(isGenericChatTitle('new  chat')).toBe(true)
  expect(isGenericChatTitle('New Session'.replace(' ', ' '))).toBe(true)
  expect(isGenericChatTitle('General  Coding  Session')).toBe(true)
  expect(resolveRequiredTitle({ title: 'Untitled​', currentTitle: null }).ok).toBe(false)
})

test('a real new title is accepted, trimmed', () => {
  const r = resolveRequiredTitle({ title: '  Fix the widget pipeline  ', currentTitle: null })
  expect(r).toEqual({ ok: true, title: 'Fix the widget pipeline' })
})

test('a generic or overlong new title is refused', () => {
  expect(resolveRequiredTitle({ title: 'Untitled', currentTitle: null }).ok).toBe(false)
  expect(resolveRequiredTitle({ title: 'new session', currentTitle: null }).ok).toBe(false)
  expect(resolveRequiredTitle({ title: '[orchestrator] x', currentTitle: null }).ok).toBe(false)
  expect(resolveRequiredTitle({ title: 'x'.repeat(201), currentTitle: null }).ok).toBe(false)
})

test('confirming the existing title works only with an exact restatement', () => {
  const ok = resolveRequiredTitle({
    confirmTitle: 'Real work thread',
    currentTitle: 'Real work thread',
  })
  expect(ok).toEqual({ ok: true, title: 'Real work thread' })
  const wrong = resolveRequiredTitle({
    confirmTitle: 'Real work',
    currentTitle: 'Real work thread',
  })
  expect(wrong.ok).toBe(false)
  // The refusal must NOT leak the actual title - review is proven by reading, not by copying
  // it out of the error.
  if (!wrong.ok) expect(wrong.error.includes('Real work thread')).toBe(false)
})

test('confirming a generic current title is refused - a real name is required', () => {
  const r = resolveRequiredTitle({ confirmTitle: 'Untitled', currentTitle: 'Untitled' })
  expect(r.ok).toBe(false)
})

test('no decision at all is refused with the contract spelled out', () => {
  const r = resolveRequiredTitle({ currentTitle: 'Something' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('title decision is required')
})

test('a supplied title wins over a confirm when both are present', () => {
  const r = resolveRequiredTitle({ title: 'New name', confirmTitle: 'Old', currentTitle: 'Old' })
  expect(r).toEqual({ ok: true, title: 'New name' })
})

test('the PowerShell tool carries the canonical generic/plumbing patterns verbatim', () => {
  // misc/Manage-DesktopChat.ps1 refuses generic rename targets with a hand-copied regex; this
  // guard fails the moment chat-title.ts's canonical patterns change without that copy - an
  // unenforced keep-in-sync comment is not a mechanism (consolidation review, 2026-08-29).
  const { GENERIC_CHAT_TITLE, PLUMBING_CHAT_TITLE } = require('../src/chat-title')
  const ps1 = require('node:fs').readFileSync(
    require('node:path').join(import.meta.dir, '..', '..', 'misc', 'Manage-DesktopChat.ps1'),
    'utf8',
  )
  expect(ps1.includes(GENERIC_CHAT_TITLE.source)).toBe(true)
  expect(ps1.includes(PLUMBING_CHAT_TITLE.source)).toBe(true)
})
