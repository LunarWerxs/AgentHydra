// server/src/core/cli-reset-sweep.ts — a safe daily check of every signed-in CLI account's limit reset.
//
// Each CLI row shows whether the account has a limit reset, from the CLI's own `/limit-reset`
// (core/cli-limit-reset.ts). The weekly session reset is claimed only when the CLI's own state is
// at its 5-hour limit, so a check (it backs out of a banked reset's question) spends nothing while
// the account's 5-hour usage is known and below that limit. This pass therefore checks an account
// only with a fresh 5-hour reading well under the limit, and never at it.
import { climayteLiveReadings } from '../climayte'
import { latestUsage } from '../climayte-core'
import type { CliInstance, UsageSnapshot } from '../types'
import { allCachedUsage } from '../usage-cache'
import { withLiveReading } from '../usage-live'
import { getCliInstance, listCliInstances, setCliInstanceLimitReset } from './cli-instances'
import { runCliLimitReset } from './cli-limit-reset'

const DAY_MS = 24 * 3_600_000
/** A check is only safe below the 5-hour limit (the one case it could spend the weekly reset), and
 *  usage climbs between reads, so a reading must be this fresh... */
export const READING_MAX_AGE_MS = 30 * 60_000
/** ...and at least this far under 100%. */
export const MAX_SESSION_PCT = 90

type Reading = (id: string) => UsageSnapshot | null

/** True when `snap` is a 5-hour reading fresh enough and far enough under the limit for a check. */
function readingIsSafe(snap: UsageSnapshot | null, now: number): boolean {
  if (!snap?.session) return false
  const at = Date.parse(snap.capturedAt)
  if (!Number.isFinite(at) || now - at > READING_MAX_AGE_MS) return false
  const resetsAt = snap.session.resetsAt ? Date.parse(snap.session.resetsAt) : Number.NaN
  const walled = snap.session.severity === 'critical' || snap.session.pct >= 100
  if (walled || !(snap.session.pct < MAX_SESSION_PCT)) return false
  // A window that already rolled over still shows its old percent; that is not a reading of now.
  return !(Number.isFinite(resetsAt) && resetsAt <= now)
}

/** Whether this one account qualifies right now. */
function isDue(
  i: Pick<CliInstance, 'id' | 'loggedIn' | 'movedAway' | 'lastLimitReset'>,
  reading: Reading,
  now: number,
): boolean {
  if (!i.loggedIn || i.movedAway) return false
  if (i.lastLimitReset && now - i.lastLimitReset.at < DAY_MS) return false
  return readingIsSafe(reading(i.id), now)
}

/** The ids due for a check. Pure: the reading lookup and the clock come in. */
export function cliResetChecksDue(
  instances: Array<Pick<CliInstance, 'id' | 'loggedIn' | 'movedAway' | 'lastLimitReset'>>,
  reading: Reading,
  now: number,
): string[] {
  return instances.filter((i) => isDue(i, reading, now)).map((i) => i.id)
}

/** The freshest reading of a login: cached usage or a manual check, with a newer live stream over it. */
function readingOf(id: string): UsageSnapshot | null {
  const inst = getCliInstance(id)
  const snap = latestUsage(id, inst?.lastUsageCheck, allCachedUsage())
  return withLiveReading(snap, climayteLiveReadings().get(id))
}

let passRunning = false

/** One pass: the due accounts, one at a time, each re-read right before its run. Never throws. */
export async function runCliResetSweep(): Promise<void> {
  if (passRunning) return
  passRunning = true
  let checked = 0
  let available = 0
  let skipped = 0
  try {
    for (const id of cliResetChecksDue(listCliInstances(), readingOf, Date.now())) {
      const inst = getCliInstance(id)
      if (!inst || !isDue(inst, readingOf, Date.now())) {
        skipped++
        continue
      }
      try {
        const result = await runCliLimitReset(inst.configDir, { confirm: false })
        if (result.outcome === 'error') {
          skipped++
          continue
        }
        setCliInstanceLimitReset(id, result)
        checked++
        if (result.outcome === 'available') available++
      } catch {
        skipped++
      }
    }
  } catch (err) {
    console.error('[cli-reset-sweep] pass failed:', err instanceof Error ? err.message : err)
  } finally {
    passRunning = false
  }
  console.log(`[cli-reset-sweep] checked ${checked}, available ${available}, skipped ${skipped}`)
}

const FIRST_PASS_MS = 10 * 60_000
const PASS_EVERY_MS = 3_600_000

let firstPass: ReturnType<typeof setTimeout> | null = null
let everyPass: ReturnType<typeof setInterval> | null = null

/** Start the daily check (called once at daemon boot). Off under tests, like the usage refresh. */
export function startCliResetSweep(): void {
  if (process.env.NODE_ENV === 'test' || firstPass) return
  const pass = () => void runCliResetSweep()
  firstPass = setTimeout(() => {
    pass()
    everyPass = setInterval(() => {
      try {
        pass()
      } catch (err) {
        console.error('[cli-reset-sweep] tick failed:', err instanceof Error ? err.message : err)
      }
    }, PASS_EVERY_MS)
    everyPass.unref?.()
  }, FIRST_PASS_MS)
  firstPass.unref?.()
}

/** Stop the daily check (daemon shutdown). */
export function stopCliResetSweep(): void {
  if (firstPass) clearTimeout(firstPass)
  if (everyPass) clearInterval(everyPass)
  firstPass = null
  everyPass = null
}
