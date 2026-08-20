// web/tests/session-clipboard.test.ts — what "copy the session file location" puts on the clipboard
// (web/src/lib/session-clipboard.ts).
//
// The path alone is a fact about the disk; what people do next is hand the session to another agent
// and ask it to carry on, which needs the conversation's NAME and a sentence to open with. Both are
// settings and both default on.
//
// THE PROPERTY WORTH BREAKING A BUILD OVER is the last test: with both extras off, the result has
// to be the bare path, byte for byte. This action existed before the settings did, and someone
// pasting into a terminal is entitled to get a path and nothing else.

import { expect, test } from 'bun:test'
import { composeSessionPathClipboard } from '../src/lib/session-clipboard'

const PATH = 'C:\\Users\\you\\.claude\\projects\\my-repo\\a1b2c3d4.jsonl'
const base = {
  path: PATH,
  title: 'Postal server connection setup',
  includeName: true,
  includePrompt: true,
  prompt: 'Resume where we left off',
}

test('everything on: prompt, blank line, name, then the path', () => {
  expect(composeSessionPathClipboard(base)).toBe(
    `Resume where we left off\n\nPostal server connection setup\n${PATH}`,
  )
})

test('the prompt comes FIRST, so the paste can be sent as it stands', () => {
  // An instruction that arrives after its own context reads as an afterthought, and this text is
  // meant to be pasted straight into another agent.
  expect(composeSessionPathClipboard(base).split('\n')[0]).toBe('Resume where we left off')
})

test('a custom prompt is used verbatim', () => {
  const out = composeSessionPathClipboard({ ...base, prompt: 'Pick this back up and finish it' })
  expect(out.startsWith('Pick this back up and finish it\n\n')).toBe(true)
})

test('name only', () => {
  expect(composeSessionPathClipboard({ ...base, includePrompt: false })).toBe(
    `Postal server connection setup\n${PATH}`,
  )
})

test('prompt only', () => {
  expect(composeSessionPathClipboard({ ...base, includeName: false })).toBe(
    `Resume where we left off\n\n${PATH}`,
  )
})

test('both off is the bare path, byte for byte', () => {
  // The regression that would matter most: this action shipped long before these settings, and a
  // path with anything appended stops working the moment it is pasted into a terminal.
  const out = composeSessionPathClipboard({ ...base, includeName: false, includePrompt: false })
  expect(out).toBe(PATH)
  expect(out.includes('\n')).toBe(false)
})

test('an empty prompt adds nothing, not a blank line', () => {
  // Someone who clears the field has effectively turned the prompt off; honouring the toggle alone
  // would put a stray blank line at the top of every paste.
  for (const prompt of ['', '   ', '\n']) {
    expect(composeSessionPathClipboard({ ...base, prompt, includeName: false })).toBe(PATH)
  }
})

test('an untitled session contributes no blank line either', () => {
  expect(composeSessionPathClipboard({ ...base, title: '  ', includePrompt: false })).toBe(PATH)
})

test('surrounding whitespace on the prompt is trimmed', () => {
  expect(composeSessionPathClipboard({ ...base, prompt: '  Resume where we left off  ' })).toBe(
    `Resume where we left off\n\nPostal server connection setup\n${PATH}`,
  )
})

test('the path is never altered, whatever is around it', () => {
  // Windows paths carry backslashes and can carry spaces; nothing here may escape or quote them.
  const spaced = 'D:\\My Projects\\pap3r rotate2\\x.jsonl'
  expect(composeSessionPathClipboard({ ...base, path: spaced }).endsWith(spaced)).toBe(true)
})
