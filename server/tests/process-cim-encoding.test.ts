// server/tests/process-cim-encoding.test.ts — one stray byte must not blind the fleet.
//
// Found live 2026-08-25: a claude.exe whose command line contained "→" (part of a prompt)
// came back from Windows PowerShell 5.1 as a raw 0x1A SUB byte (legacy-codepage stdout), which
// made the whole ConvertTo-Json document unparseable. The CIM path then returned null, the
// wmic fallback does not exist on current Windows, and EVERY instance read as not-running —
// the app saw a fleet of zero open accounts while five desktop apps were on screen.
// The fix is layered (UTF-8 preamble in the script + this sanitizer); the sanitizer is the
// layer a unit test can pin.
import { expect, test } from 'bun:test'
import { sanitizeCimJson } from '../src/core/process'

const SUB = String.fromCharCode(0x1a)

test('a raw SUB byte inside a CommandLine string no longer unparses the document', () => {
  const doc = `[{"ProcessId":1,"CommandLine":"claude 589 ${SUB} 25 files","WorkingSetSize":5}]`
  expect(() => JSON.parse(doc)).toThrow() // the untreated document really is broken
  const parsed = JSON.parse(sanitizeCimJson(doc))
  expect(parsed[0].ProcessId).toBe(1)
  expect(parsed[0].CommandLine).toContain('589   25 files')
})

test('clean documents pass through byte-identical; escapes and whitespace survive', () => {
  const doc = '[{"ProcessId":2,"CommandLine":"a\\u001ab\\nc","WorkingSetSize":1}]\r\n'
  expect(sanitizeCimJson(doc)).toBe(doc)
  expect(JSON.parse(sanitizeCimJson(doc).trim())[0].CommandLine).toBe(`a${SUB}b\nc`)
})
