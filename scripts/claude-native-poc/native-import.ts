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

async function importRuntime(
  request: NativeImportRequest,
  pin: typeof NATIVE_PROGRAM_PIN,
  approvedIds: readonly string[],
) {
  let dispatch = 'not-sent'
  let importedSessionId: string | undefined
  try {
    const fail = (reason: string): never => {
      throw Error(`NATIVE_IMPORT_REFUSAL: ${reason}`)
    }
    if (!approvedIds.includes(request.cliSessionId)) fail('not an approved disposable transcript')
    const proc = (globalThis as any).process
    const main = proc?.mainModule
    if (!main?.require) fail('CJS main module unavailable')
    const rootRequire = main.require.bind(main)
    const { app } = rootRequire('electron')
    const path = rootRequire('node:path')
    // Electron's mainModule.filename can be the synthetic name "electron". Anchor resolution
    // at the real, absolute app ASAR instead; createRequire still shares the existing cache.
    const require = rootRequire('node:module').createRequire(
      path.join(app.getAppPath(), 'package.json'),
    )
    const fs = require('node:fs')
    const crypto = require('node:crypto')
    const key = (value: string) => {
      const result = path.resolve(value).replace(/[\\/]+$/, '')
      return proc.platform === 'win32' ? result.toLowerCase() : result
    }
    const processGuard = () => {
      if (proc.pid !== request.pid || !app.isReady()) fail('wrong PID/state')
      if (key(app.getPath('userData')) !== key(request.profileDir)) fail('wrong profile')
    }
    processGuard()
    const digest = (bytes: any) => crypto.createHash('sha256').update(bytes).digest('hex')
    // Found by its export inside the already-loaded module cache of THIS app, never by a
    // bundle file name: those are content-hashed and change with every Claude release.
    const appPath = key(app.getAppPath())
    const managers = Object.keys(require.cache)
      .filter((name: string) => key(name).startsWith(appPath) && require.cache[name]?.loaded)
      .map((name: string) => ({
        filename: name,
        value: require.cache[name]?.exports?.[pin.managerExport],
      }))
      .filter((member: any) => member.value)
    const distinct = managers.filter(
      (member: any, at: number) =>
        managers.findIndex((other: any) => other.value === member.value) === at,
    )
    if (distinct.length > 1) fail('more than one native session manager is loaded')
    if (!distinct.length) fail('manager is not already initialized')
    const filename = distinct[0].filename
    const loaded = require.cache[filename]
    const managerSha256 = digest(fs.readFileSync(filename))
    const manager = distinct[0].value
    if (!manager) fail('native singleton unavailable')
    const identityGuard = () => {
      processGuard()
      if (require.cache[filename] !== loaded || loaded.exports?.[pin.managerExport] !== manager)
        fail('singleton changed')
      if (
        key(manager.userDataPath) !== key(request.profileDir) ||
        manager.currentAccountId !== request.accountId ||
        manager.currentOrgId !== request.orgId
      )
        fail('account/profile changed')
    }
    await manager.waitForInitialization()
    identityGuard()
    await manager.ensureArchivedSessionsLoaded('ownership')
    identityGuard()
    const expectedNativeId = `local_${request.cliSessionId}`
    const refuseExisting = () => {
      for (const session of manager.sessions.values()) {
        if (
          session.sessionId === expectedNativeId ||
          session.cliSessionId === request.cliSessionId ||
          manager.localLineageIds(session).includes(request.cliSessionId)
        )
          fail('destination already carries this CLI lineage; refusing automatic unarchive')
      }
    }
    refuseExisting()
    if ((manager.adoptingCliSessionIds.get(request.cliSessionId) ?? 0) > 0)
      fail('another import is in flight')
    // This is the app's fresh process-liveness check, also used by its Resume picker. It may
    // construct the ordinary discovery helper; it does not import another session manager.
    const discovery = await manager.getCliSessionDiscovery()
    const guardWriter = async () => {
      const refusal = await discovery.liveOwnershipRefusal(request.cliSessionId)
      if (refusal !== null) fail(`source writer is not confirmed stopped: ${refusal}`)
      identityGuard()
      refuseExisting()
    }
    await guardWriter()
    const projectDir = await manager.diskTranscript.resolveProjectDirForSession(
      request.cliSessionId,
    )
    if (!projectDir) fail('transcript not found')
    const transcriptPath = path.join(projectDir, `${request.cliSessionId}.jsonl`)
    const readTranscript = () => {
      const stat = fs.statSync(transcriptPath)
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
        fail('disposable transcript missing or unexpectedly large')
      return fs.readFileSync(transcriptPath)
    }
    const beforeHash = digest(readTranscript())
    if (request.expectedTranscriptSha256 && request.expectedTranscriptSha256 !== beforeHash)
      fail('transcript changed from caller evidence')
    const beforeWrite = async () => {
      await guardWriter()
      if (digest(readTranscript()) !== beforeHash) fail('transcript changed while importing')
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
      importedSessionId !== expectedNativeId ||
      !session ||
      session.cliSessionId !== request.cliSessionId
    )
      fail('import returned unexpected native identity')
    const afterHash = digest(readTranscript())
    const bystanderArchiveChanges: any[] = []
    for (const [id, archived] of flags) {
      const current = manager.sessions.get(id)
      if (!current || (current.isArchived === true) !== archived)
        bystanderArchiveChanges.push({
          sessionId: id,
          before: archived,
          after: current ? current.isArchived === true : null,
        })
    }
    const cwdMatches = !request.expectedCwd || key(session.cwd) === key(request.expectedCwd)
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
  return `(${importRuntime.toString()})(${JSON.stringify(request)},${JSON.stringify(NATIVE_PROGRAM_PIN)},${JSON.stringify(DISPOSABLE_IMPORT_IDS)})`
}
