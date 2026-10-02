// server/tests/hands-on.test.ts — when a hand last used a desktop app, read from its main.log
// (src/core/hands-on.ts). The log writes local wall-clock time: read as UTC, a person's last click
// lands hours away, and CliMayte places work on the account they are typing in.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handsOnAgoMs } from '../src/core/hands-on'

/** A log line's timestamp, as the desktop app writes it: local time, to the second. */
function local(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

describe('handsOnAgoMs', () => {
  test('the newest message sent or chat clicked within ten minutes, in local time', () => {
    const now = Date.now()
    const dirs: string[] = []
    const profile = (lines: string[]): string => {
      const dir = mkdtempSync(join(tmpdir(), 'hands-on-'))
      dirs.push(dir)
      mkdirSync(join(dir, 'logs'))
      writeFileSync(join(dir, 'logs', 'main.log'), lines.join('\n'))
      return dir
    }
    const old = `${local(now - 20 * 60_000)} [info] LocalSessions.sendMessage: local_old`
    try {
      const recent = profile([
        old,
        `${local(now - 3 * 60_000)} [info] [CCD] LocalSessions.setFocusedSession: sessionId=local_abc`,
        `${local(now - 60_000)} [info] Something unrelated to a hand`,
      ])
      const ago = handsOnAgoMs(recent, now) ?? -1
      expect(ago).toBeGreaterThanOrEqual(3 * 60_000)
      expect(ago).toBeLessThan(3 * 60_000 + 1000)
      expect(handsOnAgoMs(profile([old]), now)).toBeNull()
      expect(handsOnAgoMs(join(tmpdir(), 'hands-on-no-such-profile'), now)).toBeNull()
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    }
  })
})
