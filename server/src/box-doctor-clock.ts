// The machine doctor's clock check (box-doctor.ts runs it): is this PC's clock right? A clock
// minutes off makes every age, schedule and token expiry wrong, and nothing else would say so.
//
// THE MACHINE'S OWN CLOCK IS NOT A REFERENCE. w32tm on a standalone PC reports `Source: Local CMOS
// Clock` (or `Free-running System Clock`, or ReferenceId LOCL) with a real "Last Successful Sync
// Time": the service synchronized with the clock under test. That is a note, never a pass. Local
// evidence (Project Hydra's newest reading, a commit) can only prove the clock BEHIND (a stamp in
// its future); AHEAD needs an outside reference: the time service's own offset or one NTP sample.
import type { BoxFinding } from './box-doctor'

/** Below five minutes no age anyone reads moves visibly, and cross-machine stamps differ by seconds. */
export const SKEW_TOLERANCE_S = 300
export const NTP_REFERENCE = 'time.windows.com'

export type Run = (cmd: string[]) => Promise<{ exitCode: number | null; stdout: string }>

/** What one reference says: `skew` (measured beyond tolerance), `ok`, `unsynced` (has no opinion),
 *  or `unknown` (could not be read). `detail` carries the numbers; it never goes into an incident. */
export interface ClockReading {
  verdict: 'skew' | 'ok' | 'unsynced' | 'unknown'
  detail: string
}

const KV_LINE = /^\s*([A-Za-z][A-Za-z ]+?)\s*:\s*(.*?)\s*$/
const SECONDS = /([+-]?\d+(?:\.\d+)?)s\b/
const LOCAL_REFERENCE = /local cmos clock|free-running system clock/i

/** `w32tm /query /status /verbose`'s `Key: value` block, read as a verdict. */
export function readW32tmStatus(text: string): ClockReading {
  // A stopped service is a real answer: nothing keeps this clock right. Any other
  // `The following error occurred: ...` parses as one field and says nothing about sync.
  if (/0x80070426|service has not been started/i.test(text))
    return { verdict: 'unsynced', detail: 'the Windows Time service is not running' }
  if (/error occurred/i.test(text))
    return { verdict: 'unknown', detail: 'w32tm reported an error instead of a status' }
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = KV_LINE.exec(line)
    if (m?.[1]) fields.set(m[1].trim().toLowerCase(), m[2] ?? '')
  }
  if (fields.size === 0)
    return { verdict: 'unknown', detail: 'w32tm printed no `Key: value` field' }
  const source = fields.get('source') ?? ''
  const last = fields.get('last successful sync time') ?? ''
  const leap = fields.get('leap indicator') ?? ''
  const local = LOCAL_REFERENCE.test(source) || (fields.get('referenceid') ?? '').includes('LOCL')
  if (leap.startsWith('3') || last.toLowerCase() === 'unspecified')
    return {
      verdict: 'unsynced',
      detail: 'the Windows Time service is running but not synchronized',
    }
  if (local)
    return {
      verdict: 'unsynced',
      detail: `the Windows Time service's source is ${source || 'LOCL'}, this PC's own clock`,
    }
  if (!leap && !source && !last)
    return {
      verdict: 'unsynced',
      detail: 'w32tm named no source, no last sync and no leap indicator',
    }
  const offset = SECONDS.exec(fields.get('phase offset') ?? '')
  const offsetS = offset?.[1] ? Number(offset[1]) : null
  if (offsetS !== null && Math.abs(offsetS) > SKEW_TOLERANCE_S)
    return {
      verdict: 'skew',
      detail: `the time service's own phase offset is ${offsetS.toFixed(1)}s`,
    }
  return {
    verdict: 'ok',
    detail: `synchronized with ${source || '?'}${last ? `, last sync ${last}` : ''}`,
  }
}

/** `w32tm /stripchart ... /dataonly`'s last `HH:MM:SS, +00.0034567s` line: reference minus this
 *  clock, so negative means this clock is AHEAD. */
export function readNtpSample(text: string, reference = NTP_REFERENCE): ClockReading {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const sample = [...lines].reverse().find((l) => l.includes(',') && SECONDS.test(l))
  const m = sample ? SECONDS.exec(sample) : null
  if (!m?.[1] || /error/i.test(text))
    return { verdict: 'unknown', detail: `no sample from ${reference}` }
  const offset = Number(m[1])
  if (offset > SKEW_TOLERANCE_S)
    return { verdict: 'skew', detail: `this clock is BEHIND ${reference} by ${offset.toFixed(0)}s` }
  if (offset < -SKEW_TOLERANCE_S)
    return {
      verdict: 'skew',
      detail: `this clock is AHEAD of ${reference} by ${(-offset).toFixed(0)}s`,
    }
  return { verdict: 'ok', detail: `${reference} differs from this clock by ${offset.toFixed(2)}s` }
}

/** Stamps only Project Hydra can read (its newest reading, a few newest commits). Each one dated
 *  past this clock by more than the tolerance proves it BEHIND; none can prove it AHEAD. */
export function readLocalEvidence(
  stamps: ReadonlyArray<{ what: string; at: string }>,
  now: number,
): ClockReading {
  const dated = stamps.filter((s) => Number.isFinite(Date.parse(s.at)))
  if (dated.length === 0) return { verdict: 'unknown', detail: 'no local stamp to compare' }
  const future = dated.find((s) => Date.parse(s.at) - now > SKEW_TOLERANCE_S * 1000)
  if (future)
    return {
      verdict: 'skew',
      detail: `${future.what} is dated ${future.at}, ${Math.round((Date.parse(future.at) - now) / 1000)}s in this clock's future`,
    }
  return { verdict: 'ok', detail: `not behind ${dated.length} local stamp(s)` }
}

/** The clock check's findings from its readings, or null when nothing could be read (then an open
 *  clock incident stays open). */
export function clockFindings(readings: readonly ClockReading[]): BoxFinding[] | null {
  const read = readings.filter((r) => r.verdict !== 'unknown')
  if (read.length === 0) return null
  const skew = read.filter((r) => r.verdict === 'skew')
  if (skew.length)
    return [
      {
        key: 'clock',
        level: 'problem',
        message:
          "This PC's clock is more than five minutes off: every age, schedule and expiry read here is wrong. Resync it (w32tm /resync) and check that the Windows Time service syncs with an outside server.",
        detail: skew.map((r) => r.detail).join('; '),
      },
    ]
  // Right now is not kept right: an outside sample can agree today while nothing corrects the drift.
  const unsynced = read.filter((r) => r.verdict === 'unsynced')
  if (unsynced.length)
    return [
      {
        key: 'clock-unsynced',
        level: 'note',
        message:
          "Nothing keeps this PC's clock right: the Windows Time service is not synchronized with an outside server, so the clock drifts until someone resyncs it.",
        detail: read.map((r) => r.detail).join('; '),
      },
    ]
  return []
}

let ntpCache: { at: number; reading: ClockReading } | null = null
const NTP_EVERY_MS = 60 * 60_000

/** The time service, one NTP sample (at most hourly: it is the one network call here) and any
 *  local stamps, as findings. */
export async function checkClock(
  run: Run,
  stamps: ReadonlyArray<{ what: string; at: string }>,
  now = Date.now(),
): Promise<BoxFinding[] | null> {
  const status = await run(['w32tm', '/query', '/status', '/verbose'])
  // A stopped service exits non-zero with its reason on stdout, so any run that finished is read.
  const service: ClockReading =
    status.exitCode !== null
      ? readW32tmStatus(status.stdout)
      : { verdict: 'unknown', detail: 'w32tm /query /status could not be read' }
  let ntp = ntpCache && now - ntpCache.at <= NTP_EVERY_MS ? ntpCache.reading : null
  if (!ntp) {
    const out = await run([
      'w32tm',
      '/stripchart',
      `/computer:${NTP_REFERENCE}`,
      '/samples:1',
      '/dataonly',
      '/period:1',
    ])
    ntp =
      out.exitCode === 0
        ? readNtpSample(out.stdout)
        : { verdict: 'unknown', detail: `no sample from ${NTP_REFERENCE}` }
    // An unanswered sample is asked again next pass, not an hour later.
    ntpCache = ntp.verdict === 'unknown' ? null : { at: now, reading: ntp }
  }
  return clockFindings([service, ntp, readLocalEvidence(stamps, now)])
}
