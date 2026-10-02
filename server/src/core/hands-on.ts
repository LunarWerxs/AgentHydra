// When a hand last used a Claude Desktop app, read from the app's own log: main.log records every
// chat someone sends to or clicks into (LocalSessions.sendMessage, setFocusedSession), in local
// wall-clock time. The TypeScript twin of orchestrator/scripts/fan_out.py hands_on_secs_ago. A
// person at the keyboard is not room (2026-09-15: a fan-out spawned into the account the owner was
// typing in), so CliMayte reads this before it places work (climayte-core.ts signedInAccounts).
// The tick asks often, so a profile's log is read at most once every CACHE_MS.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** How recent a hand's use counts as now. */
export const HANDS_ON_MS = 10 * 60_000
const TAIL_BYTES = 512 * 1024
const CACHE_MS = 30_000
const LINE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[info\] (?:LocalSessions\.sendMessage:|\[CCD\] LocalSessions\.setFocusedSession: sessionId=local_)/

/** The end of a long-lived log: a profile's main.log runs to tens of MB. */
function readTail(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function newestHandsOn(text: string): number | null {
  let latest: number | null = null
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    if (!m) continue
    // No zone on purpose: the log writes local time, and a date-time string without one parses
    // as local time.
    const at = new Date(`${m[1]}T${m[2]}`).getTime()
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at
  }
  return latest
}

const seen = new Map<string, { readAt: number; at: number | null }>()

/** How long ago a hand last used the desktop app in `profileDir` (ms), or null when that was more
 *  than HANDS_ON_MS ago, there is no such app, or its log cannot be read. */
export function handsOnAgoMs(
  profileDir: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!profileDir) return null
  let hit = seen.get(profileDir)
  if (!hit || now - hit.readAt > CACHE_MS) {
    const text = readTail(join(profileDir, 'logs', 'main.log'))
    hit = { readAt: now, at: text === null ? null : newestHandsOn(text) }
    seen.set(profileDir, hit)
  }
  if (hit.at === null) return null
  const age = now - hit.at
  return age <= HANDS_ON_MS ? Math.max(0, age) : null
}
