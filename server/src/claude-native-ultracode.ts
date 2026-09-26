// server/src/claude-native-ultracode.ts - turn ultracode ON for one chat inside a RUNNING app.
//
// A disk stamp (stamplib) cannot do this while the app runs: the app holds each chat in memory
// and writes its own copy back, and the engine takes its effort from the app, never from the
// file. On 2026-09-26 four chats moved into a running app booted with ultracode off although
// every landed record said ultracode:true. The app's own manager.applyFlagSettings - the call
// its effort picker makes - sets memory, the saved record and a running engine in one go, and
// the native route runs it without touching the screen.
import {
  getClaudeNativeProfileConfig,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import { connectClaudeInspector } from './core/claude-native/inspector-client'
import { nativeProgram } from './core/claude-native/native-program'
import { scanClaudeProcesses } from './core/process'

export interface NativeUltracodeOutcome {
  ok: boolean
  /** Why it did not run or did not verify; absent on success. */
  reason?: string
  before?: { effort: string | null; ultracode: boolean | null }
  after?: { effort: string | null; ultracode: boolean | null }
}

export async function tryNativeUltracode(
  profileDir: string,
  sessionId: string,
  effort: 'xhigh' | 'max' = 'xhigh',
): Promise<NativeUltracodeOutcome> {
  if (!/^local_[A-Za-z0-9_-]{1,160}$/.test(sessionId)) {
    return { ok: false, reason: 'expected the exact native chat id (local_...)' }
  }
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
  try {
    client = await connectClaudeInspector({
      pid: owners[0].pid,
      profile,
      port: config.port,
      connectTimeoutMs: 3000,
      callTimeoutMs: 20000,
    })
    const result = await client.evaluate<Record<string, any>>(
      nativeProgram({
        action: 'ultracode',
        pid: owners[0].pid,
        profileDir: profile,
        sessionId,
        effort,
      }),
    )
    if (result?.ok === true && result.verified === true) {
      return { ok: true, before: result.before, after: result.after }
    }
    return {
      ok: false,
      reason: String(result?.reason ?? 'the app did not read back ultracode on'),
      before: result?.before,
      after: result?.after,
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    client?.close()
  }
}
