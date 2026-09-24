import { NATIVE_PROGRAM_PIN } from './native-program'

/** Explicitly disposable transcripts created for this task; this POC is not a general move API. */
export const DISPOSABLE_IMPORT_IDS = [
  'b554be08-8a81-4711-b772-2d8b290b3844',
  'e765f244-5816-465f-909a-d3cfe161075f',
] as const

export interface NativeImportRequest {
  pid: number
  profileDir: string
  accountId: string
  orgId: string
  cliSessionId: string
  /** Native import uses this only when the transcript does not already supply a title. */
  title: string
  expectedCwd?: string
  expectedTranscriptSha256?: string
}

/** Raised inside the serialized program; the orchestrator turns it into a refusal result. */
function refuse(reason: string): never {
  throw Error(`NATIVE_IMPORT_REFUSAL: ${reason}`)
}

function pathKey(proc: any, path: any, value: string): string {
  const result = path.resolve(value).replace(/[\\/]+$/, '')
  return proc.platform === 'win32' ? result.toLowerCase() : result
}

function sha256(crypto: any, bytes: any): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/** Electron's mainModule.filename can be the synthetic name "electron". Anchor resolution
 * at the real, absolute app ASAR instead; createRequire still shares the existing cache. */
function appRequire(rootRequire: any, app: any, path: any): any {
  return rootRequire('node:module').createRequire(path.join(app.getAppPath(), 'package.json'))
}

/** Locates the already-loaded native manager by its export, never by a content-hashed name. */
function resolveNativeManager(
  require: any,
  fs: any,
  crypto: any,
  proc: any,
  path: any,
  app: any,
  pin: typeof NATIVE_PROGRAM_PIN,
) {
  // Found by its export inside the already-loaded module cache of THIS app, never by a
  // bundle file name: those are content-hashed and change with every Claude release.
  const appPath = pathKey(proc, path, app.getAppPath())
  const managers = Object.keys(require.cache)
    .filter((name: string) => {
      const at = pathKey(proc, path, name)
      return (at === appPath || at.startsWith(appPath + path.sep)) && require.cache[name]?.loaded
    })
    .map((name: string) => ({
      filename: name,
      value: require.cache[name]?.exports?.[pin.managerExport],
    }))
    .filter((member: any) => member.value)
  const distinct = managers.filter(
    (member: any, at: number) =>
      managers.findIndex((other: any) => other.value === member.value) === at,
  )
  if (distinct.length > 1) refuse('more than one native session manager is loaded')
  if (!distinct.length) refuse('manager is not already initialized')
  const filename = distinct[0].filename
  const loaded = require.cache[filename]
  const managerSha256 = sha256(crypto, fs.readFileSync(filename))
  const manager = distinct[0].value
  if (!manager) refuse('native singleton unavailable')
  return { filename, loaded, manager, managerSha256 }
}

function assertProcessIdentity(proc: any, app: any, path: any, request: NativeImportRequest): void {
  if (proc.pid !== request.pid || !app.isReady()) refuse('wrong PID/state')
  if (pathKey(proc, path, app.getPath('userData')) !== pathKey(proc, path, request.profileDir))
    refuse('wrong profile')
}

function assertManagerIdentity(ctx: {
  proc: any
  app: any
  path: any
  require: any
  request: NativeImportRequest
  pin: typeof NATIVE_PROGRAM_PIN
  filename: string
  loaded: any
  manager: any
}): void {
  assertProcessIdentity(ctx.proc, ctx.app, ctx.path, ctx.request)
  if (
    ctx.require.cache[ctx.filename] !== ctx.loaded ||
    ctx.loaded.exports?.[ctx.pin.managerExport] !== ctx.manager
  )
    refuse('singleton changed')
  if (
    pathKey(ctx.proc, ctx.path, ctx.manager.userDataPath) !==
      pathKey(ctx.proc, ctx.path, ctx.request.profileDir) ||
    ctx.manager.currentAccountId !== ctx.request.accountId ||
    ctx.manager.currentOrgId !== ctx.request.orgId
  )
    refuse('account/profile changed')
}

function assertNoExistingLineage(manager: any, request: NativeImportRequest): void {
  const expectedNativeId = `local_${request.cliSessionId}`
  for (const session of manager.sessions.values()) {
    if (
      session.sessionId === expectedNativeId ||
      session.cliSessionId === request.cliSessionId ||
      manager.localLineageIds(session).includes(request.cliSessionId)
    )
      refuse('destination already carries this CLI lineage; refusing automatic unarchive')
  }
}

function collectBystanderArchiveChanges(flags: Map<string, boolean>, manager: any): any[] {
  const changes: any[] = []
  for (const [id, archived] of flags) {
    const current = manager.sessions.get(id)
    if (!current || (current.isArchived === true) !== archived)
      changes.push({
        sessionId: id,
        before: archived,
        after: current ? current.isArchived === true : null,
      })
  }
  return changes
}

function buildImportResult(input: {
  request: NativeImportRequest
  proc: any
  app: any
  path: any
  manager: any
  session: any
  importedSessionId: string
  dispatch: string
  transcriptPath: string
  beforeHash: string
  afterHash: string
  bystanderArchiveChanges: any[]
  managerSha256: string
}) {
  const { request, proc, app, path, manager, session, importedSessionId, dispatch } = input
  const { transcriptPath, beforeHash, afterHash, bystanderArchiveChanges, managerSha256 } = input
  const cwdMatches =
    !request.expectedCwd ||
    pathKey(proc, path, session.cwd) === pathKey(proc, path, request.expectedCwd)
  const verified =
    session.isArchived !== true &&
    session.isRunning !== true &&
    beforeHash === afterHash &&
    cwdMatches &&
    bystanderArchiveChanges.length === 0
  return {
    ok: verified,
    verified,
    dispatch,
    importedSessionId,
    reason: verified ? undefined : 'native import/preservation postconditions failed',
    identity: {
      pid: proc.pid,
      profileDir: app.getPath('userData'),
      accountId: manager.currentAccountId,
      orgId: manager.currentOrgId,
      version: app.getVersion(),
      managerSha256,
    },
    session: {
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      title: session.title ?? null,
      isArchived: session.isArchived === true,
      isRunning: session.isRunning === true,
      hasQuery: session.query != null,
      model: session.model ?? null,
      effort: session.effort ?? null,
      permissionMode: session.permissionMode ?? null,
      sessionSettings: session.sessionSettings ?? null,
      cwd: session.cwd,
      originCwd: session.originCwd ?? null,
    },
    requestedFallbackTitle: request.title,
    transcriptPath,
    beforeHash,
    afterHash,
    transcriptBytesPreserved: beforeHash === afterHash,
    bystanderArchiveChanges,
    sentPrompt: false,
    evidence: 'native manager import; not screenshot proof',
  }
}

async function importRuntime(
  request: NativeImportRequest,
  pin: typeof NATIVE_PROGRAM_PIN,
  approvedIds: readonly string[],
) {
  let dispatch = 'not-sent'
  let importedSessionId: string | undefined
  try {
    if (!approvedIds.includes(request.cliSessionId)) refuse('not an approved disposable transcript')
    const proc = (globalThis as any).process
    const main = proc?.mainModule
    if (!main?.require) refuse('CJS main module unavailable')
    const rootRequire = main.require.bind(main)
    const { app } = rootRequire('electron')
    const path = rootRequire('node:path')
    const require = appRequire(rootRequire, app, path)
    const fs = require('node:fs')
    const crypto = require('node:crypto')
    assertProcessIdentity(proc, app, path, request)
    const resolution = resolveNativeManager(require, fs, crypto, proc, path, app, pin)
    const { filename, loaded, manager, managerSha256 } = resolution
    const identityGuard = () =>
      assertManagerIdentity({ proc, app, path, require, request, pin, filename, loaded, manager })
    await manager.waitForInitialization()
    identityGuard()
    await manager.ensureArchivedSessionsLoaded('ownership')
    identityGuard()
    const refuseExisting = () => assertNoExistingLineage(manager, request)
    refuseExisting()
    if ((manager.adoptingCliSessionIds.get(request.cliSessionId) ?? 0) > 0)
      refuse('another import is in flight')
    // This is the app's fresh process-liveness check, also used by its Resume picker. It may
    // construct the ordinary discovery helper; it does not import another session manager.
    const discovery = await manager.getCliSessionDiscovery()
    const guardWriter = async () => {
      const refusal = await discovery.liveOwnershipRefusal(request.cliSessionId)
      if (refusal !== null) refuse(`source writer is not confirmed stopped: ${refusal}`)
      identityGuard()
      refuseExisting()
    }
    await guardWriter()
    const projectDir = await manager.diskTranscript.resolveProjectDirForSession(
      request.cliSessionId,
    )
    if (!projectDir) refuse('transcript not found')
    const transcriptPath = path.join(projectDir, `${request.cliSessionId}.jsonl`)
    const readTranscript = () => {
      const stat = fs.statSync(transcriptPath)
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
        refuse('disposable transcript missing or unexpectedly large')
      return fs.readFileSync(transcriptPath)
    }
    const beforeHash = sha256(crypto, readTranscript())
    if (request.expectedTranscriptSha256 && request.expectedTranscriptSha256 !== beforeHash)
      refuse('transcript changed from caller evidence')
    const beforeWrite = async () => {
      await guardWriter()
      if (sha256(crypto, readTranscript()) !== beforeHash)
        refuse('transcript changed while importing')
    }
    const flags = new Map(
      Array.from(
        manager.sessions.values(),
        (session: any) => [session.sessionId, session.isArchived === true] as const,
      ),
    )
    identityGuard()
    refuseExisting()
    dispatch = 'sent'
    importedSessionId = await manager.importCliSession(request.cliSessionId, {
      autoTrust: false,
      title: request.title,
      beforeWrite,
    })
    identityGuard()
    const session = manager.sessions.get(importedSessionId)
    if (
      importedSessionId !== `local_${request.cliSessionId}` ||
      !session ||
      session.cliSessionId !== request.cliSessionId
    )
      refuse('import returned unexpected native identity')
    const afterHash = sha256(crypto, readTranscript())
    const bystanderArchiveChanges = collectBystanderArchiveChanges(flags, manager)
    return buildImportResult({
      request,
      proc,
      app,
      path,
      manager,
      session,
      importedSessionId,
      dispatch,
      transcriptPath,
      beforeHash,
      afterHash,
      bystanderArchiveChanges,
      managerSha256,
    })
  } catch (error) {
    return {
      ok: false,
      verified: false,
      dispatch,
      importedSessionId,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function nativeImportProgram(request: NativeImportRequest): string {
  if (
    !Number.isSafeInteger(request.pid) ||
    request.pid <= 0 ||
    !request.profileDir?.trim() ||
    !request.accountId ||
    !request.orgId ||
    !request.title?.trim()
  )
    throw Error('Exact import identity and fallback title required')
  if (!(DISPOSABLE_IMPORT_IDS as readonly string[]).includes(request.cliSessionId))
    throw Error('Only the approved disposable transcripts may be imported by this POC')
  if (request.expectedTranscriptSha256 && !/^[0-9a-f]{64}$/i.test(request.expectedTranscriptSha256))
    throw Error('Invalid transcript SHA256')
  return `${importRuntimeHelpers()}\n(${importRuntime.toString()})(${JSON.stringify(request)},${JSON.stringify(NATIVE_PROGRAM_PIN)},${JSON.stringify(DISPOSABLE_IMPORT_IDS)})`
}

/** Module-level functions referenced by the serialized `importRuntime`, emitted into the program. */
function importRuntimeHelpers(): string {
  return [
    refuse,
    pathKey,
    sha256,
    appRequire,
    resolveNativeManager,
    assertProcessIdentity,
    assertManagerIdentity,
    assertNoExistingLineage,
    collectBystanderArchiveChanges,
    buildImportResult,
  ]
    .map((fn) => fn.toString())
    .join('\n')
}
