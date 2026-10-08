// server/src/claude-native-prewarm.ts - have the managed Claude copy ready before an Open needs it.
//
// A managed (debugger) Open launches Claude from a copy of the newest installed build
// (claude-native-launch.ts). Copies used to be made only by the Open that found none, so the first
// Open after every Claude update waited for 600 MB to be copied and hashed: 27 s on 2026-10-08,
// thirty minutes after Claude updated itself (owner: "it's fucking taking a goddamn decade. This
// should take one second."). This looks once a minute and builds the copy as soon as a new build is
// installed. When the copy is already there it only stats a few files.

import { prewarmClaudeNativeCopy } from './claude-native-launch'
import { getClaudeNativeSettings } from './claude-native-settings'
import { resolveLaunchBinary } from './core/paths'

const FIRST_PREWARM_MS = 20_000
const PREWARM_EVERY_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null
let firstRun: ReturnType<typeof setTimeout> | null = null
let running = false
/** The last failure logged, so a refusal that repeats every minute is logged once. */
let lastFailure = ''

/** Whether any profile launches through a managed copy; with none, no copy is ever needed. */
function managedLaunchesConfigured(): boolean {
  try {
    return Object.values(getClaudeNativeSettings()).some((config) => config.launchDebugger === true)
  } catch {
    return false
  }
}

async function prewarmOnce(): Promise<void> {
  try {
    if (running || process.platform !== 'win32' || !managedLaunchesConfigured()) return
    running = true
    const started = Date.now()
    try {
      const binary = await resolveLaunchBinary()
      if (!binary) return
      const result = await prewarmClaudeNativeCopy(binary)
      lastFailure = ''
      if (result.built)
        console.log(
          `[claude-native] prepared the managed copy of Claude ${result.version} ahead of the next Open (${((Date.now() - started) / 1000).toFixed(1)} s)`,
        )
    } finally {
      running = false
    }
  } catch (error) {
    // The Open that needs the copy makes it itself and reports any refusal to the person opening.
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastFailure)
      console.warn(`[claude-native] managed copy not prepared ahead: ${message}`)
    lastFailure = message
  }
}

export function startClaudeNativePrewarm(): void {
  if (timer) return
  // This process exits on an unhandled rejection: prewarmOnce never rejects, and neither timer
  // keeps the process alive.
  firstRun = setTimeout(prewarmOnce, FIRST_PREWARM_MS)
  firstRun.unref()
  timer = setInterval(prewarmOnce, PREWARM_EVERY_MS)
  timer.unref()
}

export function stopClaudeNativePrewarm(): void {
  if (firstRun) clearTimeout(firstRun)
  if (timer) clearInterval(timer)
  firstRun = null
  timer = null
}
