// server/tests/new-chat-defaults.test.ts - the owner's 2026-08-30 rule pinned: every automated
// NEW chat starts "Opus 5 Ultra code" = model opus + the ultracode keyword; explicit caller
// choice is the compelling-reason escape; resumes are untouched.
import { expect, test } from 'bun:test'
import { db } from '../src/db'
import {
  applyNewChatDefaults,
  defaultNewChatModel,
  newChatUltracodeEnabled,
  withUltracode,
} from '../src/new-chat-defaults'

test('absent settings read the documented defaults: model opus, ultracode on', () => {
  db.query("delete from settings where key like 'new_chat_%'").run()
  expect(defaultNewChatModel()).toBe('opus')
  expect(newChatUltracodeEnabled()).toBe(true)
})

test('a new chat with no model gets opus and the keyword on its own line', () => {
  const r = applyNewChatDefaults({ newChat: true, model: null, prompt: 'Fix the parser.' })
  expect(r.model).toBe('opus')
  expect(r.prompt).toBe('ultracode\n\nFix the parser.')
})

test('explicit choice is the compelling-reason escape - it always wins', () => {
  const r = applyNewChatDefaults({ newChat: true, model: 'haiku', prompt: 'quick check' })
  expect(r.model).toBe('haiku')
  const noUltra = applyNewChatDefaults({
    newChat: true,
    model: null,
    prompt: 'quick check',
    ultracode: false,
  })
  expect(noUltra.prompt).toBe('quick check')
})

test('a RESUME is not a new chat - nothing is touched', () => {
  const r = applyNewChatDefaults({ newChat: false, model: null, prompt: 'resume' })
  expect(r.model).toBe(null)
  expect(r.prompt).toBe('resume')
})

test('the keyword is idempotent - a prompt already carrying it is never doubled', () => {
  expect(withUltracode('ultracode\n\ndo the thing')).toBe('ultracode\n\ndo the thing')
  expect(withUltracode('Please ULTRACODE this audit')).toBe('Please ULTRACODE this audit')
  expect(withUltracode('no keyword here').startsWith('ultracode\n\n')).toBe(true)
})
