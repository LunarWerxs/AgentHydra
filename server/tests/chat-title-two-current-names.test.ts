// server/tests/chat-title-two-current-names.test.ts - the naming door knows a chat by BOTH of
// its current names (server/src/chat-title.ts, resolveRequiredTitle).
//
// A chat has a transcript-derived title (the session list's) and the desktop app's own record
// title (the sidebar's, the Instances "Chats" list's). They routinely differ, and a door that
// accepted only the transcript's refused every move planned from the app's name with
// "confirm_title does not match" - on chats the person had just read by name (2026-09-08).
import { expect, test } from 'bun:test'
import { resolveRequiredTitle } from '../src/chat-title'

const transcript = 'Fix the widget pipeline'
const record = 'Widget pipeline (renamed in the app)'

test('the record title restated exactly is accepted, and the chat lands under it', () => {
  const r = resolveRequiredTitle({
    confirmTitle: record,
    currentTitle: transcript,
    recordTitle: record,
  })
  expect(r).toEqual({ ok: true, title: record })
})

test('the transcript title restated exactly is still accepted, unchanged', () => {
  const r = resolveRequiredTitle({
    confirmTitle: `  ${transcript}  `,
    currentTitle: transcript,
    recordTitle: record,
  })
  expect(r).toEqual({ ok: true, title: transcript })
})

test('a name that is neither is refused, without echoing either', () => {
  const r = resolveRequiredTitle({
    confirmTitle: 'Something else entirely',
    currentTitle: transcript,
    recordTitle: record,
  })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error).toContain('does not match')
  expect(r.error).not.toContain(transcript)
  expect(r.error).not.toContain(record)
})

test('confirming the app\'s "Untitled" beside a transcript with a real name lands under the real one', () => {
  // The Instances list shows the record's name; a record the app never named is "Untitled" there.
  // Confirming what was shown must not refuse the move when the other store knows the chat's
  // real name - and must never land the chat AS "Untitled".
  const r = resolveRequiredTitle({
    confirmTitle: 'Untitled',
    currentTitle: transcript,
    recordTitle: 'Untitled',
  })
  expect(r).toEqual({ ok: true, title: transcript })
})

test('two generic names are refused even when the confirmation matches one of them', () => {
  const r = resolveRequiredTitle({
    confirmTitle: 'Untitled',
    currentTitle: 'New chat',
    recordTitle: 'Untitled',
  })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error).toContain('generic')
})

test('with no record title the door behaves exactly as it always did', () => {
  expect(
    resolveRequiredTitle({ confirmTitle: transcript, currentTitle: transcript, recordTitle: null }),
  ).toEqual({ ok: true, title: transcript })
  expect(
    resolveRequiredTitle({ confirmTitle: 'nope', currentTitle: transcript, recordTitle: null }).ok,
  ).toBe(false)
  expect(
    resolveRequiredTitle({ confirmTitle: 'Untitled', currentTitle: 'Untitled', recordTitle: null })
      .ok,
  ).toBe(false)
})

test('a supplied new title outranks both current names, and is still held to the generic rule', () => {
  expect(
    resolveRequiredTitle({
      title: 'A brand new name',
      currentTitle: transcript,
      recordTitle: record,
    }),
  ).toEqual({ ok: true, title: 'A brand new name' })
  expect(
    resolveRequiredTitle({ title: 'Untitled', currentTitle: transcript, recordTitle: record }).ok,
  ).toBe(false)
})
