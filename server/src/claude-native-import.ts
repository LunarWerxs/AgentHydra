// server/src/claude-native-import.ts - land a CLI transcript as a chat inside a RUNNING app.
//
// The claude://resume deep link calls the app's own importCliSession, but reaching it meant
// starting a second claude.exe per chat only to hand the URL to the running one over Electron's
// single-instance lock, then polling for the record: ~4.5s a chat, 68s of a 15-chat move on
// 2026-10-09. The native route makes the same call directly and reads the landing back.
import {
  getClaudeNativeProfileConfig,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import { connectClaudeInspector } from './core/claude-native/inspector-client'
import { nativeProgram } from './core/claude-native/native-program'
import { scanClaudeProcesses } from './core/process'

export interface NativeImportOutcome {
  ok: boolean
  /** True when nothing reached the app (not configured, not running, no connection): the
   *  caller may use the deep link. False once the import was sent: never retry it another way. */
  unavailable: boolean
  reason?: string
  importedSessionId?: string
  permissionMode?: string | null
  /** The folder the app's record landed with, read back from its manager (folder moves compare it). */
  cwd?: string | null
}

export async function tryNativeImport(
  profileDir: string,
  cliSessionId: string,
): Promise<NativeImportOutcome> {
  const unavailable = (reason: string) => ({ ok: false, unavailable: true, reason })
  const config = getClaudeNativeProfileConfig(profileDir)
  if (!config) return unavailable('native control is not configured for this profile')
  const profile = normalizeClaudeNativeProfile(profileDir)
  const scan = await scanClaudeProcesses({ fresh: true })
  if (!scan.ok) return unavailable(`could not read the Claude processes: ${scan.reason}`)
  const owners = scan.processes.filter(
    (p) => p.isMain && p.dir && normalizeClaudeNativeProfile(p.dir) === profile,
  )
  if (owners.length !== 1)
    return unavailable(owners.length ? 'several main processes match' : 'the app is not running')
  let client: Awaited<ReturnType<typeof connectClaudeInspector>> | undefined
  try {
    client = await connectClaudeInspector({
      pid: owners[0].pid,
      profile,
      port: config.port,
      connectTimeoutMs: 3000,
      callTimeoutMs: 30000,
    })
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error))
  }
  try {
    const result = await client.evaluate<Record<string, any>>(
      nativeProgram({ action: 'import', pid: owners[0].pid, profileDir: profile, cliSessionId }),
    )
    if (result?.ok === true && result.verified === true)
      return {
        ok: true,
        unavailable: false,
        importedSessionId: result.importedSessionId,
        permissionMode: result.session?.permissionMode ?? null,
        cwd: result.session?.cwd ?? null,
      }
    return {
      ok: false,
      unavailable: result?.dispatch === 'not-sent',
      reason: String(result?.reason ?? 'the app did not confirm the import'),
    }
  } catch (error) {
    // A lost reply after sending: the import may have happened, so no deep-link retry.
    return {
      ok: false,
      unavailable: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    client.close()
  }
}
