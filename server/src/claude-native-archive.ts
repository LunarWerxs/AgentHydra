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

/** Mutable per-call state; every step below reads and writes the same run object. */
interface NativeArchiveRun {
  started: number
  nativeOnly: boolean
  mutationSent: boolean
  lockedProfile?: string
  client?: ClaudeInspectorClient
}

type NativeArchiveResult = Extract<NativeArchiveOutcome, { kind: 'result' }>

type ScannedProcesses = Extract<
  Awaited<ReturnType<typeof scanClaudeProcesses>>,
  { ok: true }
>['processes']

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

function archiveResult(
  run: NativeArchiveRun,
  reason: string,
  dispatch: Dispatch = 'not-sent',
): NativeArchiveResult {
  return {
    kind: 'result',
    route: 'native',
    ok: false,
    verified: false,
    changed: false,
    dispatch,
    reason,
    timingsMs: { total: Math.round(performance.now() - run.started) },
  }
}

/** Only a caller that asked for native-only gets a result where it would have got "unavailable". */
function archiveUnavailable(run: NativeArchiveRun, reason: string): NativeArchiveOutcome {
  return run.nativeOnly
    ? archiveResult(run, reason)
    : { kind: 'unavailable', route: 'native', dispatch: 'not-sent', reason }
}

function nativeArchiveOwner(
  run: NativeArchiveRun,
  processes: ScannedProcesses,
  profile: string,
): { kind: 'owner'; pid: number } | { kind: 'outcome'; outcome: NativeArchiveOutcome } {
  const owners = processes.filter(
    (process) =>
      process.isMain && process.dir && normalizeClaudeNativeProfile(process.dir) === profile,
  )
  if (owners.length === 0) {
    return {
      kind: 'outcome',
      outcome: archiveUnavailable(run, 'The configured Claude profile is not running'),
    }
  }
  if (owners.length !== 1) {
    return {
      kind: 'outcome',
      outcome: archiveResult(run, 'Multiple main processes match this exact Claude profile'),
    }
  }
  return { kind: 'owner', pid: owners[0].pid }
}

async function nativeArchiveConnect(
  run: NativeArchiveRun,
  deps: NativeArchiveDeps,
  owner: { pid: number },
  profile: string,
  config: ClaudeNativeProfileConfig,
  remaining: number,
): Promise<NativeArchiveOutcome | undefined> {
  try {
    run.client = await (deps.connect ?? connectClaudeInspector)({
      pid: owner.pid,
      profile,
      port: config.port,
      connectTimeoutMs: remaining,
      callTimeoutMs: 10000,
    })
    return undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return reason.startsWith('Inspector discovery unavailable at ')
      ? archiveUnavailable(run, reason)
      : archiveResult(run, reason)
  }
}

/** The declared shape of an inspection: identity plus native session rows, or why it is unusable. */
function nativeArchiveInspectionShape(
  inspected: unknown,
): { reason: string } | { identity: Record<string, unknown>; sessions: any[] } {
  if (
    !record(inspected) ||
    inspected.ok !== true ||
    inspected.verified !== true ||
    !record(inspected.identity) ||
    !Array.isArray(inspected.sessions)
  ) {
    return {
      reason:
        record(inspected) && typeof inspected.reason === 'string'
          ? inspected.reason
          : 'Malformed native inspection response',
    }
  }
  return { identity: inspected.identity, sessions: inspected.sessions }
}

function nativeArchiveInspectionIdentity(
  identity: Record<string, unknown>,
  pid: number,
  profile: string,
): string | null {
  if (
    identity.pid !== pid ||
    typeof identity.profileDir !== 'string' ||
    normalizeClaudeNativeProfile(identity.profileDir) !== profile ||
    typeof identity.accountId !== 'string' ||
    !identity.accountId ||
    typeof identity.orgId !== 'string' ||
    !identity.orgId
  ) {
    return 'Native inspection returned an unexpected process or account identity'
  }
  return null
}

function nativeArchiveSessionShapes(sessions: any[]): string | null {
  for (const session of sessions) {
    if (
      !record(session) ||
      typeof session.sessionId !== 'string' ||
      !Array.isArray(session.lineageIds) ||
      session.lineageIds.some((id: unknown) => typeof id !== 'string')
    ) {
      return 'Malformed native session identities'
    }
  }
  return null
}

function nativeArchiveMatch(
  sessions: any[],
  requestedSessionId: string,
): { reason: string } | { session: any } {
  const matches = sessions.filter(
    (session) =>
      session.sessionId === requestedSessionId ||
      session.cliSessionId === requestedSessionId ||
      session.lineageIds.includes(requestedSessionId),
  )
  if (matches.length !== 1) {
    return { reason: `Expected one exact native session match, found ${matches.length}` }
  }
  const session = matches[0]
  if (typeof session.cliSessionId !== 'string' || !session.cliSessionId) {
    return { reason: 'Native session has no current CLI identity' }
  }
  return { session }
}

function nativeArchiveFinal(
  run: NativeArchiveRun,
  archived: unknown,
  identity: Record<string, unknown>,
  session: any,
): NativeArchiveOutcome {
  if (!record(archived) || (archived.dispatch !== 'not-sent' && archived.dispatch !== 'sent')) {
    return archiveResult(run, 'Malformed native archive response', 'unknown')
  }
  const dispatch = archived.dispatch
  if (archived.ok !== true || archived.verified !== true) {
    return {
      ...archiveResult(
        run,
        typeof archived.reason === 'string'
          ? archived.reason
          : 'Native archive refused or could not be verified',
        dispatch,
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
    return archiveResult(run, 'Native archive returned an unexpected session state', dispatch)
  }
  return {
    kind: 'result',
    route: 'native',
    ok: true,
    verified: true,
    changed: archived.changed === true,
    dispatch,
    identity,
    session: archived.session,
    timingsMs: { total: Math.round(performance.now() - run.started) },
  }
}

/**
 * One archive attempt: resolve the profile's single main process, inspect it, then dispatch the
 * mutation through a freshly built expression. Every early exit is an outcome, never a throw.
 */
async function nativeArchiveAttempt(
  run: NativeArchiveRun,
  profileDir: string,
  requestedSessionId: string,
  deps: NativeArchiveDeps,
): Promise<NativeArchiveOutcome> {
  const config = (deps.getConfig ?? getClaudeNativeProfileConfig)(profileDir)
  if (!config) return archiveUnavailable(run, 'Native control is not configured for this profile')
  if (config.mode === 'native-only') run.nativeOnly = true
  const profile = normalizeClaudeNativeProfile(profileDir)
  if (!requestedSessionId || !/^[A-Za-z0-9_-]{1,160}$/.test(requestedSessionId)) {
    return archiveResult(run, 'Invalid exact session identifier')
  }
  if (activeProfiles.has(profile)) {
    return archiveResult(run, 'A native archive is already in progress for this profile')
  }
  activeProfiles.add(profile)
  run.lockedProfile = profile
  const deadline = Date.now() + 2000
  const scan = await within((deps.scan ?? scanClaudeProcesses)({ fresh: true }), 2000)
  if (!scan.ok)
    return archiveResult(run, `Could not establish the current Claude process: ${scan.reason}`)
  const owner = nativeArchiveOwner(run, scan.processes, profile)
  if (owner.kind === 'outcome') return owner.outcome
  const remaining = deadline - Date.now()
  if (remaining <= 0) return archiveResult(run, 'Native Claude connection deadline expired')
  const connectFailure = await nativeArchiveConnect(run, deps, owner, profile, config, remaining)
  if (connectFailure) return connectFailure
  const client = run.client as ClaudeInspectorClient
  const inspected = await client.evaluate<unknown>(
    nativeProgram({ action: 'inspect', pid: owner.pid, profileDir: profile }),
  )
  const shape = nativeArchiveInspectionShape(inspected)
  if ('reason' in shape) return archiveResult(run, shape.reason)
  const identity = shape.identity
  const identityProblem = nativeArchiveInspectionIdentity(identity, owner.pid, profile)
  if (identityProblem) return archiveResult(run, identityProblem)
  const sessionsProblem = nativeArchiveSessionShapes(shape.sessions)
  if (sessionsProblem) return archiveResult(run, sessionsProblem)
  const match = nativeArchiveMatch(shape.sessions, requestedSessionId)
  if ('reason' in match) return archiveResult(run, match.reason)
  const session = match.session
  const expression = nativeProgram({
    action: 'archive',
    pid: owner.pid,
    profileDir: profile,
    accountId: identity.accountId as string,
    orgId: identity.orgId as string,
    sessionId: session.sessionId,
    cliSessionId: session.cliSessionId,
  })
  run.mutationSent = true
  const archived = await client.evaluate<unknown>(expression)
  return nativeArchiveFinal(run, archived, identity, session)
}

export async function tryNativeArchiveChat(
  profileDir: string,
  requestedSessionId: string,
  options: { nativeOnly?: boolean } = {},
  deps: NativeArchiveDeps = {},
): Promise<NativeArchiveOutcome> {
  const run: NativeArchiveRun = {
    started: performance.now(),
    nativeOnly: options.nativeOnly === true,
    mutationSent: false,
  }
  try {
    return await nativeArchiveAttempt(run, profileDir, requestedSessionId, deps)
  } catch (error) {
    return archiveResult(
      run,
      error instanceof Error ? error.message : String(error),
      run.mutationSent ? 'unknown' : 'not-sent',
    )
  } finally {
    try {
      run.client?.close()
    } finally {
      if (run.lockedProfile) activeProfiles.delete(run.lockedProfile)
    }
  }
}
