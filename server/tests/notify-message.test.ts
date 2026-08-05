// The parts of the notification path that can be wrong without a network: the RFC 5322 message
// the SMTP client puts on the wire, and the PowerShell program the Windows toast path runs.
//
// Both are injection boundaries — the instance LABEL flows into a mail header and into a
// PowerShell string literal — so these are security tests wearing formatting-test clothes.
import { expect, test } from 'bun:test'
import { encodePowerShellCommand, windowsToastScript } from '../src/notify-os'
import { buildMessage, dotStuff } from '../src/notify-smtp'

const DATE = new Date(Date.UTC(2026, 7, 5, 12, 0, 0))

const msg = {
  from: 'agenthydra@example.com',
  to: 'me@example.com',
  subject: '4claude: 5-hour session limit reset',
  text: 'Your 5-hour quota window has rolled over.',
}

test('buildMessage produces headers, a blank line, then a base64 body', () => {
  const out = buildMessage(msg, DATE)
  expect(out).toContain('From: agenthydra@example.com\r\n')
  expect(out).toContain('To: me@example.com\r\n')
  expect(out).toContain('Content-Transfer-Encoding: base64\r\n')
  const [headers, body] = out.split('\r\n\r\n')
  expect(headers).toContain('Subject: 4claude: 5-hour session limit reset')
  expect(Buffer.from(body, 'base64').toString('utf8')).toBe(msg.text)
})

test('buildMessage refuses header injection through a crafted subject', () => {
  // An instance label is user-supplied and reaches the Subject header. A raw CRLF here would let it
  // append headers (a Bcc, a different To) to the outgoing message.
  const out = buildMessage({ ...msg, subject: 'reset\r\nBcc: attacker@example.com' }, DATE)
  const headers = (out.split('\r\n\r\n')[0] ?? '').split('\r\n')
  // The text survives, folded into the Subject VALUE — what must not survive is a header LINE.
  expect(headers.some((h) => h.startsWith('Bcc:'))).toBe(false)
  expect(headers).toContain('Subject: reset Bcc: attacker@example.com')
})

test('buildMessage refuses header injection through an address', () => {
  const out = buildMessage({ ...msg, to: 'me@example.com\r\nBcc: x@y.z' }, DATE)
  expect(out).not.toContain('\r\nBcc:')
})

test('buildMessage encodes a non-ASCII subject as an RFC 2047 word', () => {
  const out = buildMessage({ ...msg, subject: 'réinitialisé' }, DATE)
  expect(out).toContain('Subject: =?UTF-8?B?')
  expect(out).not.toContain('réinitialisé')
})

test('buildMessage wraps the base64 body at 76 columns', () => {
  const out = buildMessage({ ...msg, text: 'x'.repeat(500) }, DATE)
  const body = out.split('\r\n\r\n')[1] ?? ''
  for (const line of body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
})

test('dotStuff protects a line that would otherwise end the DATA block', () => {
  expect(dotStuff('a\n.\nb')).toBe('a\n..\nb')
  expect(dotStuff('.leading')).toBe('..leading')
  expect(dotStuff('mid.dle')).toBe('mid.dle')
})

// --- the Windows toast program ------------------------------------------------

test('windowsToastScript escapes a quote in the label instead of breaking out of the literal', () => {
  const script = windowsToastScript({ title: "it's here", body: 'ok' })
  // Doubled single-quote is the escape inside a PowerShell single-quoted literal.
  expect(script).toContain("it''s here")
})

test('windowsToastScript XML-escapes the payload', () => {
  const script = windowsToastScript({ title: '<b>&', body: 'ok' })
  expect(script).toContain('&lt;b&gt;&amp;')
})

test('windowsToastScript registers the AppUserModelID (without which nothing appears)', () => {
  const script = windowsToastScript({ title: 't', body: 'b' })
  expect(script).toContain('HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\$AppId')
  expect(script).toContain('CreateToastNotifier($AppId).Show($toast)')
})

test('a sticky toast uses the reminder scenario AND carries the action it requires', () => {
  const script = windowsToastScript({ title: 't', body: 'b', sticky: true })
  expect(script).toContain('scenario=&quot;reminder&quot;'.replace(/&quot;/g, '"'))
  // Windows silently drops a reminder-scenario toast that has no actions.
  expect(script).toContain('<actions>')
})

test('a normal toast is not sticky', () => {
  const script = windowsToastScript({ title: 't', body: 'b' })
  expect(script).not.toContain('scenario=')
  expect(script).not.toContain('<actions>')
})

test('encodePowerShellCommand emits base64 of UTF-16LE, which is what -EncodedCommand wants', () => {
  const encoded = encodePowerShellCommand('Write-Output 1')
  expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Write-Output 1')
})
