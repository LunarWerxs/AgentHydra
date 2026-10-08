// server/src/claude-native-idle.ts - release idle Claude engines and unused terminals, the app's way.
//
// Every Code chat the app shows gets an engine (claude.exe, ~260 MB) and a prewarmed PowerShell
// terminal (~90 MB + a conhost), and the app keeps both until it quits: its idle pause is driven
// by a remote flag that is 0 ("Idle timeout disabled, not arming"), and its engine cap is one per
// 3 GB of RAM (21 on a 64 GB PC). On 2026-10-07 one 13-chat move left 13 of each running, 4.9 GB.
// Killing engines from outside is not the answer: the app shows each such chat as crashed.
//
// The native route switches the app's own idle pause on (pauseSession: the call its own timer and
// cap make, which declines any chat with work in flight) and stops never-used prewarmed shells of
// chats that are off screen. It changes only the running process, so the sweep below re-applies
// it every pass and after every relaunch. Owner, 2026-10-07: "figure out how to not spin up all
// these Claude executables and ... significantly reduce overhead for using Claude".
import {
  getClaudeNativeProfileConfig,
  getClaudeNativeSettings,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import { connectClaudeInspector } from './core/claude-native/inspector-client'
import { nativeProgram } from './core/claude-native/native-program'
import { scanClaudeProcesses } from './core/process'
import { getSetting } from './db'

/** Minutes an off-screen idle chat keeps its engine. Setting `claudeNativeIdleMinutes`; 0 = off. */
export const DEFAULT_IDLE_MINUTES = 10
const IDLE_SETTING = 'claudeNativeIdleMinutes'
const SWEEP_MS = 5 * 60_000
const FIRST_SWEEP_DELAY_MS = 45_000

export function idleMinutes(): number {
  const raw = getSetting(IDLE_SETTING)
  if (raw === '') return DEFAULT_IDLE_MINUTES
  const minutes = Number(raw)
  return Number.isFinite(minutes) && minutes >= 0
    ? Math.min(Math.round(minutes), 1440)
    : DEFAULT_IDLE_MINUTES
}

export interface NativeIdleOutcome {
  ok: boolean
  reason?: string
  result?: Record<string, any>
}

/** Run one native request against the profile's running app. Never throws. */
async function runNative(
  profileDir: string,
  build: (pid: number, profile: string) => string,
  callTimeoutMs = 20_000,
): Promise<NativeIdleOutcome> {
  const config = getClaudeNativeProfileConfig(profileDir)
  if (!config) return { ok: false, reason: 'native control is not configured for this profile' }
  const profile = normalizeClaudeNativeProfile(profileDir)
  const scan = await scanClaudeProcesses({ fresh: true })
  if (!scan.ok) return { ok: false, reason: `could not read the Claude processes: ${scan.reason}` }
  const owners = scan.processes.filter(
    (p) => p.isMain && p.dir && normalizeClaudeNativeProfile(p.dir) === profile,
  )
  if (owners.length === 0) return { ok: false, reason: 'the app is not running' }
  if (owners.length > 1) return { ok: false, reason: 'several main processes match this profile' }
  let client: Awaited<ReturnType<typeof connectClaudeInspector>> | undefined
  // The connect budget spans discovery and the handshake, and this daemon's event loop stalls for
  // seconds at a time (6.5 s of 10 s logged on 2026-10-07): a 3 s budget timed out on every sweep
  // of one app. A failed connect ran nothing in the app, so it alone is tried a second time.
  const connect = () =>
    connectClaudeInspector({
      pid: owners[0].pid,
      profile,
      port: config.port,
      connectTimeoutMs: 10_000,
      callTimeoutMs,
    })
  try {
    client = await connect().catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return connect()
    })
    const result = await client.evaluate<Record<string, any>>(build(owners[0].pid, profile))
    if (result?.ok === true) return { ok: true, result }
    return { ok: false, reason: String(result?.reason ?? 'the app did not confirm'), result }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    client?.close()
  }
}

/** Switch the app's idle pause on and stop unused prewarmed shells of off-screen chats. */
export function tryNativeIdle(
  profileDir: string,
  minutes = idleMinutes(),
): Promise<NativeIdleOutcome> {
  return runNative(profileDir, (pid, profile) =>
    nativeProgram({ action: 'idle', pid, profileDir: profile, idleMs: minutes * 60_000 }),
  )
}

/** Pause named chats now (native or CLI ids), waiting up to `waitMs` for an engine still starting. */
export function tryNativePause(
  profileDir: string,
  ids: string[],
  waitMs = 20_000,
): Promise<NativeIdleOutcome> {
  return runNative(
    profileDir,
    (pid, profile) =>
      nativeProgram({ action: 'pause', pid, profileDir: profile, pauseIds: ids, waitMs }),
    // The inspector client caps one call at 60s; the wait is shared by every chat in the call.
    Math.min(60_000, waitMs + 30_000),
  )
}

/** One pass over every running app under native control. */
export async function runIdleSweep(): Promise<Record<string, NativeIdleOutcome>> {
  const minutes = idleMinutes()
  const out: Record<string, NativeIdleOutcome> = {}
  if (minutes <= 0) return out
  let profiles: string[]
  try {
    profiles = Object.keys(getClaudeNativeSettings())
  } catch {
    return out
  }
  for (const profile of profiles) {
    const outcome = await tryNativeIdle(profile, minutes)
    if (outcome.ok || outcome.reason !== 'the app is not running') out[profile] = outcome
  }
  return out
}

let timer: ReturnType<typeof setInterval> | null = null
let firstRun: ReturnType<typeof setTimeout> | null = null

function tick(): void {
  try {
    runIdleSweep()
      .then((results) => {
        for (const [profile, r] of Object.entries(results)) {
          if (!r.ok) console.warn(`[agenthydra] idle sweep: ${profile}: ${r.reason}`)
          else if (r.result?.armed?.length || r.result?.shellsStopped?.length)
            console.log(
              `[agenthydra] idle sweep: ${profile}: armed ${r.result.armed.length} idle engine(s), stopped ${r.result.shellsStopped.length} unused terminal(s); ${r.result.engines} engine(s) left`,
            )
        }
      })
      .catch((err) => console.error('[agenthydra] idle sweep error:', err))
  } catch (err) {
    console.error('[agenthydra] idle sweep error:', err)
  }
}

/** Every 5 minutes (first pass 45s after start), like the other standing sweeps: never keeps the
 *  process alive, and a throw before the chain starts is caught too, so a failed tick is skipped. */
export function startIdleSweep(): void {
  if (timer) return
  firstRun = setTimeout(tick, FIRST_SWEEP_DELAY_MS)
  firstRun.unref()
  timer = setInterval(tick, SWEEP_MS)
  timer.unref()
}

export function stopIdleSweep(): void {
  if (firstRun) clearTimeout(firstRun)
  if (timer) clearInterval(timer)
  firstRun = null
  timer = null
}
