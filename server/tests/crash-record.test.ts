// server/tests/crash-record.test.ts - regression for docs/todo/TODO.md "Overnight orchestration
// run": the daemon died silently three times overnight (09:14:17Z, 01:10Z, 04:23Z) with no error
// line in daemon.log at all. index.ts's uncaughtException/unhandledRejection handlers already
// existed but only ever logged the bare error object, with no pid or uptime and a stack trace left
// multi-line - which the file's one-event-per-line shape (see log-file.mjs) makes hard to grep for
// reliably. crashRecordLine/exitRecordLine are the format those handlers now use; this file pins
// that format directly, without booting the whole daemon (index.ts can't be imported by a test at
// all - it opens the db and binds a port as an import-time side effect).
import { describe, expect, test } from 'bun:test'
import { crashRecordLine, exitRecordLine } from '../src/crash-record'

describe('crashRecordLine', () => {
  test("carries the reason, this process's pid and a numeric uptime", () => {
    const line = crashRecordLine('uncaughtException', new Error('boom'))
    expect(line).toContain('reason=uncaughtException')
    expect(line).toContain(`pid=${process.pid}`)
    expect(line).toMatch(/uptimeMs=\d+/)
    expect(line).toContain('message=boom')
  })

  test('flattens a multi-line stack into the SAME single line - never a raw newline', () => {
    const err = new Error('deep failure')
    err.stack = 'Error: deep failure\n    at a (x.ts:1:1)\n    at b (y.ts:2:2)\n    at c (z.ts:3:3)'
    const line = crashRecordLine('unhandledRejection', err)
    // The whole point: daemon.log is one event per line, so a record that reintroduces the
    // stack's own newlines would split mid-search for anyone grepping "CRASH reason=".
    expect(line.includes('\n')).toBe(false)
    expect(line).toContain('at a (x.ts:1:1)')
    expect(line).toContain('at b (y.ts:2:2)')
    expect(line).toContain('at c (z.ts:3:3)')
  })

  test('a non-Error rejection reason (string, object, undefined) still produces one clean line', () => {
    expect(crashRecordLine('unhandledRejection', 'plain string reason')).toContain(
      'message=plain string reason',
    )
    expect(crashRecordLine('unhandledRejection', { code: 'ECONNRESET' })).toContain('message=')
    expect(crashRecordLine('unhandledRejection', undefined)).toContain('message=undefined')
  })

  test('a fatal signal is recorded the same way an uncaught throw is', () => {
    const line = crashRecordLine('signal:SIGBREAK', new Error('process received SIGBREAK'))
    expect(line).toContain('reason=signal:SIGBREAK')
    expect(line).toContain('message=process received SIGBREAK')
  })
})

describe('exitRecordLine', () => {
  test('records the exit code, pid and uptime on one line, for every exit - not just a crash', () => {
    const line = exitRecordLine(0)
    expect(line).toContain('exiting code=0')
    expect(line).toContain(`pid=${process.pid}`)
    expect(line).toMatch(/uptimeMs=\d+/)
    expect(line.includes('\n')).toBe(false)
  })

  test('a null code (signal-terminated) is still a valid, readable record', () => {
    expect(exitRecordLine(null)).toContain('exiting code=null')
  })
})
