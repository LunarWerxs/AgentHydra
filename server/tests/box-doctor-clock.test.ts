// server/src/box-doctor-clock.ts - what counts as a clock reference, which way an NTP offset points,
// and that a clock nobody could read never resolves an open clock incident.
import { describe, expect, test } from 'bun:test'
import {
  clockFindings,
  readLocalEvidence,
  readNtpSample,
  readW32tmStatus,
} from '../src/box-doctor-clock'

const W32TM = (
  source: string,
  offset = '0.0012345s',
  ref = '0x14E8E8F0 (source IP:  20.101.57.9)',
) =>
  [
    'Leap Indicator: 0(no warning)',
    'Stratum: 4 (secondary reference - syncd by (S)NTP)',
    `ReferenceId: ${ref}`,
    'Last Successful Sync Time: 10/10/2026 1:02:03 AM',
    `Source: ${source}`,
    `Phase Offset: ${offset}`,
  ].join('\r\n')

describe('readW32tmStatus', () => {
  test("a service synced only with this PC's own clock, or not running, is never a pass; an error is unknown, not ok", () => {
    expect(readW32tmStatus(W32TM('time.windows.com,0x9')).verdict).toBe('ok')
    expect(readW32tmStatus(W32TM('Local CMOS Clock')).verdict).toBe('unsynced')
    expect(readW32tmStatus(W32TM('Free-running System Clock')).verdict).toBe('unsynced')
    expect(readW32tmStatus(W32TM('', '0.1s', '0x4C4F434C (LOCL)')).verdict).toBe('unsynced')
    expect(readW32tmStatus(W32TM('time.windows.com,0x9', '-412.5s')).verdict).toBe('skew')
    // The same offset against a LOCAL source is the clock disagreeing with itself: no skew claimed.
    expect(readW32tmStatus(W32TM('Local CMOS Clock', '-412.5s')).verdict).toBe('unsynced')
    expect(
      readW32tmStatus(
        'The following error occurred: The service has not been started. (0x80070426)',
      ).verdict,
    ).toBe('unsynced')
    expect(
      readW32tmStatus('The following error occurred: Access is denied. (0x80070005)').verdict,
    ).toBe('unknown')
  })
})

describe('readNtpSample', () => {
  test('the offset is reference minus this clock: positive is BEHIND, negative is AHEAD, an error is unknown', () => {
    const line = (o: string) => `Tracking time.windows.com [20.101.57.9:123].\r\n01:02:03, ${o}`
    expect(readNtpSample(line('+412.0000000s')).detail).toContain('BEHIND')
    expect(readNtpSample(line('-412.0000000s')).detail).toContain('AHEAD')
    expect(readNtpSample(line('+00.0034567s')).verdict).toBe('ok')
    expect(readNtpSample('01:02:03, error: 0x800705B4').verdict).toBe('unknown')
  })
})

describe('clockFindings', () => {
  test('nothing readable holds the incident (null); any skew is the problem; unsynced is a note even when a sample agrees', () => {
    const unknown = { verdict: 'unknown' as const, detail: '' }
    expect(clockFindings([unknown, unknown])).toBeNull()
    expect(
      clockFindings([
        { verdict: 'ok', detail: '' },
        { verdict: 'skew', detail: 'behind by 412s' },
      ])?.map((f) => `${f.level}:${f.key}`),
    ).toEqual(['problem:clock'])
    expect(
      clockFindings([{ verdict: 'unsynced', detail: '' }, unknown])?.map((f) => f.key),
    ).toEqual(['clock-unsynced'])
    expect(
      clockFindings([
        { verdict: 'unsynced', detail: '' },
        { verdict: 'ok', detail: '' },
      ])?.map((f) => `${f.level}:${f.key}`),
    ).toEqual(['note:clock-unsynced'])
    expect(clockFindings([{ verdict: 'ok', detail: '' }, unknown])).toEqual([])
  })

  test("a local stamp proves the clock BEHIND only when it sits past the tolerance in this clock's future", () => {
    const now = Date.parse('2026-10-10T07:00:00Z')
    expect(readLocalEvidence([{ what: 'x', at: '2026-10-10T07:04:00Z' }], now).verdict).toBe('ok')
    expect(readLocalEvidence([{ what: 'x', at: '2026-10-10T07:06:00Z' }], now).verdict).toBe('skew')
    expect(readLocalEvidence([{ what: 'x', at: 'not a date' }], now).verdict).toBe('unknown')
  })
})
