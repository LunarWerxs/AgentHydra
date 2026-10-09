// server/src/claude-native-send.ts - send a message into a desktop chat through the RUNNING app.
//
// The peer pipe reaches only a chat whose engine is live, and the composer route types into the
// app's window. A chat a usage limit stopped has neither a live engine nor anyone at the window, so
// the babysitter's continues all came back "no peer pipe" overnight (44 of them, 2026-10-09). The
// app's own peer-message delivery (what one chat's SendMessage calls to reach another) starts the
// chat's engine itself; the native send makes that call, as a message from another session.
import {
  getClaudeNativeProfileConfig,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import { connectClaudeInspector } from './core/claude-native/inspector-client'
import { nativeProgram } from './core/claude-native/native-program'
import { scanClaudeProcesses } from './core/process'

export interface NativeSendOutcome {
  ok: boolean
  /** True when nothing reached the app (not configured, not running, no connection, refused before
   *  sending): the caller may try another route. False once the send was made: never resend it. */
  unavailable: boolean
  /** The app's receipt: delivered (a turn started on it), queued (it runs when the chat is free), or
   *  sent (in the app's hands, no answer within the program's 45s wait). */
  delivery?: 'delivered' | 'queued' | 'sent' | null
  reason?: string
}

/** The inspector's ceiling: the program stops waiting for the app's answer at 45s, inside it. */
const SEND_CALL_TIMEOUT_MS = 60_000

export async function tryNativeSend(
  profileDir: string,
  cliSessionId: string,
  text: string,
  fromName: string,
): Promise<NativeSendOutcome> {
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
      callTimeoutMs: SEND_CALL_TIMEOUT_MS,
    })
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error))
  }
  try {
    const result = await client.evaluate<Record<string, any>>(
      nativeProgram({
        action: 'send',
        pid: owners[0].pid,
        profileDir: profile,
        cliSessionId,
        text,
        fromName,
      }),
    )
    if (result?.ok === true && (result.verified === true || result.delivery === 'sent'))
      return { ok: true, unavailable: false, delivery: result.delivery ?? null }
    return {
      ok: false,
      unavailable: result?.dispatch === 'not-sent',
      delivery: result?.delivery ?? null,
      reason: String(result?.reason ?? 'the app did not confirm the message'),
    }
  } catch (error) {
    // A lost reply after sending: the message may have gone in, so no other route retries it.
    return {
      ok: false,
      unavailable: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    client.close()
  }
}
