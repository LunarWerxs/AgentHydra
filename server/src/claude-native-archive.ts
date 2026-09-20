import {
  type ClaudeNativeProfileConfig,
  getClaudeNativeProfileConfig,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import {
  type ClaudeInspectorClient,
  connectClaudeInspector,
} from './core/claude-native/inspector-client'
import { nativeProgram } from './core/claude-native/native-program'
import { scanClaudeProcesses } from './core/process'

type Dispatch = 'not-sent' | 'sent' | 'unknown'

const activeProfiles = new Set<string>()

export type NativeArchiveOutcome =
  | { kind: 'unavailable'; route: 'native'; dispatch: 'not-sent'; reason: string }
  | {
      kind: 'result'
      route: 'native'
      ok: boolean
      verified: boolean
      changed: boolean
      dispatch: Dispatch
      reason?: string
      identity?: Record<string, unknown>
      session?: Record<string, unknown>
      timingsMs: { total: number }
    }

export interface NativeArchiveDeps {
  getConfig?: (profileDir: string) => ClaudeNativeProfileConfig | null
  scan?: typeof scanClaudeProcesses
  connect?: typeof connectClaudeInspector
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error('Native Claude process discovery timed out')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function tryNativeArchiveChat(
  profileDir: string,
  requestedSessionId: string,
  options: { nativeOnly?: boolean } = {},
  deps: NativeArchiveDeps = {},
): Promise<NativeArchiveOutcome> {
  const started = performance.now()
  let client: ClaudeInspectorClient | undefined
  let mutationSent = false
  let lockedProfile: string | undefined
  let nativeOnly = options.nativeOnly === true
  const result = (
    reason: string,
    dispatch: Dispatch = 'not-sent',
  ): Extract<NativeArchiveOutcome, { kind: 'result' }> => ({
    kind: 'result',
    route: 'native',
    ok: false,
    verified: false,
    changed: false,
    dispatch,
    reason,
    timingsMs: { total: Math.round(performance.now() - started) },
  })
  const unavailable = (reason: string): NativeArchiveOutcome =>
    nativeOnly
      ? result(reason)
      : { kind: 'unavailable', route: 'native', dispatch: 'not-sent', reason }
  try {
    const config = (deps.getConfig ?? getClaudeNativeProfileConfig)(profileDir)
    if (!config) return unavailable('Native control is not configured for this profile')
    nativeOnly ||= config.mode === 'native-only'
    const profile = normalizeClaudeNativeProfile(profileDir)
    if (!requestedSessionId || !/^[A-Za-z0-9_-]{1,160}$/.test(requestedSessionId)) {
      return result('Invalid exact session identifier')
    }
    if (activeProfiles.has(profile)) {
      return result('A native archive is already in progress for this profile')
    }
    activeProfiles.add(profile)
    lockedProfile = profile
    const deadline = Date.now() + 2000
    const scan = await within((deps.scan ?? scanClaudeProcesses)({ fresh: true }), 2000)
    if (!scan.ok) return result(`Could not establish the current Claude process: ${scan.reason}`)
    const processes = scan.processes.filter(
      (process) =>
        process.isMain && process.dir && normalizeClaudeNativeProfile(process.dir) === profile,
    )
    if (processes.length === 0) return unavailable('The configured Claude profile is not running')
    if (processes.length !== 1)
      return result('Multiple main processes match this exact Claude profile')
    const owner = processes[0]
    const remaining = deadline - Date.now()
    if (remaining <= 0) return result('Native Claude connection deadline expired')
    try {
      client = await (deps.connect ?? connectClaudeInspector)({
        pid: owner.pid,
        profile,
        port: config.port,
        connectTimeoutMs: remaining,
        callTimeoutMs: 10000,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return reason.startsWith('Inspector discovery unavailable at ')
        ? unavailable(reason)
        : result(reason)
    }
    const inspected = await client.evaluate<unknown>(
      nativeProgram({ action: 'inspect', pid: owner.pid, profileDir: profile }),
    )
    if (
      !record(inspected) ||
      inspected.ok !== true ||
      inspected.verified !== true ||
      !record(inspected.identity) ||
      !Array.isArray(inspected.sessions)
    ) {
      return result(
        record(inspected) && typeof inspected.reason === 'string'
          ? inspected.reason
          : 'Malformed native inspection response',
      )
    }
    const identity = inspected.identity
    if (
      identity.pid !== owner.pid ||
      typeof identity.profileDir !== 'string' ||
      normalizeClaudeNativeProfile(identity.profileDir) !== profile ||
      typeof identity.accountId !== 'string' ||
      !identity.accountId ||
      typeof identity.orgId !== 'string' ||
      !identity.orgId
    )
      return result('Native inspection returned an unexpected process or account identity')
    const sessions = inspected.sessions
    if (
      sessions.some(
        (session) =>
          !record(session) ||
          typeof session.sessionId !== 'string' ||
          !Array.isArray(session.lineageIds) ||
          session.lineageIds.some((id) => typeof id !== 'string'),
      )
    ) {
      return result('Malformed native session identities')
    }
    const matches = sessions.filter(
      (session) =>
        session.sessionId === requestedSessionId ||
        session.cliSessionId === requestedSessionId ||
        session.lineageIds.includes(requestedSessionId),
    )
    if (matches.length !== 1)
      return result(`Expected one exact native session match, found ${matches.length}`)
    const session = matches[0]
    if (typeof session.cliSessionId !== 'string' || !session.cliSessionId) {
      return result('Native session has no current CLI identity')
    }
    const expression = nativeProgram({
      action: 'archive',
      pid: owner.pid,
      profileDir: profile,
      accountId: identity.accountId,
      orgId: identity.orgId,
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
    })
    mutationSent = true
    const archived = await client.evaluate<unknown>(expression)
    if (!record(archived) || (archived.dispatch !== 'not-sent' && archived.dispatch !== 'sent')) {
      return result('Malformed native archive response', 'unknown')
    }
    if (archived.ok !== true || archived.verified !== true) {
      return {
        ...result(
          typeof archived.reason === 'string'
            ? archived.reason
            : 'Native archive refused or could not be verified',
          archived.dispatch,
        ),
        changed: archived.changed === true,
      }
    }
    if (
      !record(archived.session) ||
      archived.session.sessionId !== session.sessionId ||
      archived.session.cliSessionId !== session.cliSessionId ||
      archived.session.isArchived !== true
    ) {
      return result('Native archive returned an unexpected session state', archived.dispatch)
    }
    return {
      kind: 'result',
      route: 'native',
      ok: true,
      verified: true,
      changed: archived.changed === true,
      dispatch: archived.dispatch,
      identity,
      session: archived.session,
      timingsMs: { total: Math.round(performance.now() - started) },
    }
  } catch (error) {
    return result(
      error instanceof Error ? error.message : String(error),
      mutationSent ? 'unknown' : 'not-sent',
    )
  } finally {
    try {
      client?.close()
    } finally {
      if (lockedProfile) activeProfiles.delete(lockedProfile)
    }
  }
}
