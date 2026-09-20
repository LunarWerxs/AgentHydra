/** Builds inspector expressions; importing this module never connects to Claude. */
export const NATIVE_PROGRAM_PIN = Object.freeze({
  version: '2.2553.1',
  managerMember: '.vite/build/index.chunk-BQEs5Gzg.js',
  managerSha256: '484ab045a1fbe63766a8f65d1258412c3943a60f21b8dcea3a8d63f1ed36a151',
  mainMember: '.vite/build/index.chunk-1pAtASm0.js',
  mainSha256: '92bdc38ead84f3b1e989f5e125b2d64ca832d7b3e34a97f29964015344f39fa3',
})

export interface NativeProgramRequest {
  action: 'inspect' | 'archive'
  pid: number
  profileDir: string
  accountId?: string
  orgId?: string
  /** Native Desktop ID, not a title or a CLI ID. */
  sessionId?: string
  /** Required current CLI ID for archive; rotation deliberately requires another inspection. */
  cliSessionId?: string
  expectedTitle?: string
}
export type NativeRequest = NativeProgramRequest

/** The runtime is deliberately self-contained: its source is evaluated in the inspected process. */
async function nativeRuntime(request: NativeProgramRequest, pin: typeof NATIVE_PROGRAM_PIN) {
  let dispatch: 'not-sent' | 'sent' = 'not-sent'
  try {
    const fail = (why: string): never => {
      throw new Error(`NATIVE_REFUSAL: ${why}`)
    }
    // Electron can name its CJS entrypoint just "electron". Bootstrap builtins through its
    // bound require, then create an absolute app require that shares the existing cache.
    // Never import a bundle: that could construct another manager or initialize new surfaces.
    const runtimeProcess = (globalThis as any).process
    const mainModule = runtimeProcess?.mainModule
    if (typeof mainModule?.require !== 'function') fail('CJS main module is unavailable')
    const rootRequire = mainModule.require.bind(mainModule)
    const { app } = rootRequire('electron')
    const path = rootRequire('node:path')
    const require = rootRequire('node:module').createRequire(
      path.join(app.getAppPath(), 'package.json'),
    )
    const fs = require('node:fs')
    const crypto = require('node:crypto')
    const pathKey = (value: string) => {
      const resolved = path.resolve(value).replace(/[\\/]+$/, '')
      return runtimeProcess.platform === 'win32' ? resolved.toLowerCase() : resolved
    }
    const checkProcess = () => {
      if (runtimeProcess.pid !== request.pid) fail('PID changed or wrong process')
      if (!app.isReady() || app.getVersion() !== pin.version) fail('unsupported app version/state')
      if (pathKey(app.getPath('userData')) !== pathKey(request.profileDir)) fail('wrong profile')
    }
    checkProcess()
    const filename = require.resolve(path.join(app.getAppPath(), pin.managerMember))
    const loaded = require.cache[filename]
    if (!loaded?.loaded) fail('manager chunk is not already initialized')
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    if (hash !== pin.managerSha256) fail('manager source does not match reviewed version')
    const manager = loaded.exports?.claudeCodeSessionManager
    if (!manager?.sessions?.get || !manager.sessions.values) fail('native singleton is unavailable')
    for (const name of [
      'waitForInitialization',
      'getSessionList',
      'archiveCascadeClosureOf',
      'losableWorkKind',
      'hasPendingUserInput',
      'archiveSession',
      'localLineageIds',
    ]) {
      if (typeof manager[name] !== 'function') fail(`native method unavailable: ${name}`)
    }
    const checkIdentity = () => {
      checkProcess()
      if (
        require.cache[filename] !== loaded ||
        loaded.exports.claudeCodeSessionManager !== manager
      ) {
        fail('native singleton changed')
      }
      if (!manager.currentAccountId || !manager.currentOrgId) fail('account is unavailable')
      if (pathKey(manager.userDataPath) !== pathKey(request.profileDir))
        fail('wrong manager profile')
      if (request.accountId && manager.currentAccountId !== request.accountId)
        fail('account changed')
      if (request.orgId && manager.currentOrgId !== request.orgId) fail('organization changed')
    }
    await manager.waitForInitialization()
    checkIdentity()
    const accountId = manager.currentAccountId
    const orgId = manager.currentOrgId
    const checkSettledIdentity = () => {
      checkIdentity()
      if (manager.currentAccountId !== accountId || manager.currentOrgId !== orgId) {
        fail('account changed while inspecting')
      }
    }
    const snapshot = (session: any) =>
      JSON.parse(
        JSON.stringify({
          sessionId: session.sessionId,
          cliSessionId: session.cliSessionId ?? null,
          lineageIds: manager.localLineageIds(session),
          title: session.title ?? null,
          isArchived: session.isArchived === true,
          isRunning: session.isRunning === true,
          isStopping: session.isStopping === true,
          hasQuery: session.query != null,
          starting: manager.startingSessionIds.has(session.sessionId),
          losableWork: manager.losableWorkKind(session.sessionId) ?? null,
          pendingInput: manager.hasPendingUserInput(session),
          pendingPermission: manager.permissionBroker.hasPendingFor(session.sessionId),
          pendingDialog: manager.userDialogBroker.hasPendingFor(session.sessionId),
          cascade: manager.archiveCascadeClosureOf(session).map((child: any) => child.sessionId),
          model: session.model ?? null,
          effort: session.effort ?? null,
          permissionMode: session.permissionMode ?? null,
          sessionSettings: session.sessionSettings ?? null,
          chromePermissionMode: session.chromePermissionMode ?? null,
          alwaysAllowedReasons: Array.from(session.alwaysAllowedReasons ?? []),
          sessionPermissionUpdates: session.sessionPermissionUpdates ?? [],
          cwd: session.cwd ?? null,
          originCwd: session.originCwd ?? null,
          worktreePath: session.worktreePath ?? null,
          backend: session.backend?.kind ?? null,
          lastActivityAt: session.lastActivityAt ?? null,
        }),
      )
    const select = () => {
      const session = manager.sessions.get(request.sessionId)
      if (!session || session.sessionId !== request.sessionId)
        fail('exact native session ID not found')
      if (request.cliSessionId && session.cliSessionId !== request.cliSessionId) {
        fail('current CLI session ID changed')
      }
      if (request.expectedTitle !== undefined && session.title !== request.expectedTitle) {
        fail('title changed')
      }
      return session
    }
    let mainHash: string | undefined
    const identity = () => ({
      pid: runtimeProcess.pid,
      profileDir: app.getPath('userData'),
      version: app.getVersion(),
      accountId: manager.currentAccountId,
      orgId: manager.currentOrgId,
      managerSha256: hash,
      ...(mainHash ? { mainSha256: mainHash } : {}),
    })
    // getSessionList is the app's list contract, but its folder checks await. Identity is checked
    // again and the selected object is read afresh after those awaits before any mutation.
    if (request.action === 'inspect') {
      if (typeof manager.ensureArchivedSessionsLoaded !== 'function')
        fail('native archived-session loader unavailable')
      await manager.ensureArchivedSessionsLoaded('ownership')
      checkSettledIdentity()
    }
    const list = await manager.getSessionList()
    checkSettledIdentity()
    if (request.action === 'inspect') {
      const sessions = request.sessionId ? [select()] : Array.from(manager.sessions.values())
      return {
        ok: true,
        verified: true,
        dispatch,
        action: 'inspect',
        identity: identity(),
        loadGeneration: list.loadGeneration,
        sessions: sessions.filter((s: any) => !s.prewarmHidden).map(snapshot),
        evidence: 'native manager state; not screenshot proof',
      }
    }
    if (request.action !== 'archive') fail('unsupported action')
    if (!request.accountId || !request.orgId || !request.sessionId || !request.cliSessionId) {
      fail('archive requires account, organization, native ID and current CLI ID')
    }
    const mainFilename = require.resolve(path.join(app.getAppPath(), pin.mainMember))
    const loadedMain = require.cache[mainFilename]
    if (!loadedMain?.loaded) fail('main chunk is not already initialized')
    mainHash = crypto.createHash('sha256').update(fs.readFileSync(mainFilename)).digest('hex')
    if (mainHash !== pin.mainSha256) fail('main source does not match reviewed version')
    const previewManager = loadedMain.exports?.Ac
    const checkMainIdentity = () => {
      if (require.cache[mainFilename] !== loadedMain || loadedMain.exports?.Ac !== previewManager) {
        fail('native preview singleton changed')
      }
    }
    const session = select()
    const before = snapshot(session)
    if (before.isArchived) {
      return {
        ok: true,
        verified: true,
        dispatch,
        action: 'archive',
        changed: false,
        identity: identity(),
        session: before,
        bystanderArchiveChanges: [],
        evidence: 'native manager state; not screenshot proof',
      }
    }
    if (
      session.prewarmHidden ||
      session.backend?.kind !== 'local' ||
      session.backend?.remoteTarget
    ) {
      fail('only ordinary local Desktop sessions are supported')
    }
    if (session.spawnedFrom && !session.lineageDetached)
      fail('attached parent could receive side effects')
    if (
      before.isRunning ||
      before.isStopping ||
      before.starting ||
      before.losableWork ||
      before.pendingInput ||
      before.pendingPermission ||
      before.pendingDialog ||
      session.startResumeInFlight ||
      manager.parked.has(session.sessionId) ||
      manager.movesInFlight.has(session.sessionId) ||
      manager.deletingSessionIds.has(session.sessionId) ||
      (manager.sideSessionStartsInFlight.get(session.sessionId) ?? 0) > 0
    ) {
      fail('session has live, pending, or transitioning work')
    }
    if (before.cascade.length) fail('archive would cascade to other sessions')
    const effectiveCwd = session.worktreePath || session.cwd
    if (typeof effectiveCwd !== 'string' || !effectiveCwd.trim())
      fail('session working directory is unavailable')
    const checkSharedPreviewSafety = () => {
      checkMainIdentity()
      for (const other of manager.sessions.values()) {
        if (other === session || other.isArchived || other.prewarmHidden) continue
        const otherCwd = other.worktreePath || other.cwd
        if (typeof otherCwd !== 'string' || pathKey(otherCwd) !== pathKey(effectiveCwd)) continue
        // The native registry uses raw strings. Do not infer resource ownership across aliases.
        if (otherCwd !== effectiveCwd) fail('shared working directory uses different path aliases')
      }
      // A prefix-matched HTML preview can belong to a different directory, even when no other
      // session shares this exact cwd. This POC requires no affected resources for every archive.
      if (
        typeof previewManager?.getServersForWorktree !== 'function' ||
        Object.prototype.toString.call(previewManager.htmlPreviews) !== '[object Map]'
      ) {
        fail('shared working directory preview manager is unavailable')
      }
      const servers = previewManager.getServersForWorktree(effectiveCwd)
      if (!Array.isArray(servers)) fail('shared working directory server state is invalid')
      if (servers.length) fail('shared working directory has servers that archive would stop')
      for (const preview of previewManager.htmlPreviews.values()) {
        if (typeof preview?.cwd !== 'string')
          fail('shared working directory preview state is invalid')
        // Pinned stopServersForWorktree uses this raw prefix, even without a path separator.
        if (preview.cwd.startsWith(effectiveCwd)) {
          fail('shared working directory has HTML previews that archive would stop')
        }
      }
    }
    const archiveFlags = new Map(
      Array.from(
        manager.sessions.values(),
        (s: any) => [s.sessionId, s.isArchived === true] as const,
      ),
    )
    checkSettledIdentity()
    if (select() !== session) fail('session object changed before archive')
    checkSharedPreviewSafety()
    // No await between the final guards and this native call. cleanupWorktree:false preserves
    // checkout files. The native method emits the same archived event used by the stock UI.
    dispatch = 'sent'
    await manager.archiveSession(session.sessionId, { cleanupWorktree: false })
    checkSettledIdentity()
    checkMainIdentity()
    if (select() !== session) fail('session object changed during archive')
    const after = snapshot(session)
    const bystanderArchiveChanges: any[] = []
    for (const [id, wasArchived] of archiveFlags) {
      if (id === session.sessionId) continue
      const current = manager.sessions.get(id)
      if (!current || (current.isArchived === true) !== wasArchived) {
        bystanderArchiveChanges.push({
          sessionId: id,
          before: wasArchived,
          after: current ? current.isArchived === true : null,
        })
      }
    }
    const preserved = [
      'cliSessionId',
      'lineageIds',
      'title',
      'model',
      'effort',
      'permissionMode',
      'sessionSettings',
      'chromePermissionMode',
      'alwaysAllowedReasons',
      'sessionPermissionUpdates',
      'cwd',
      'originCwd',
      'worktreePath',
    ] as const
    const changedFields = preserved.filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    const verified =
      after.isArchived && bystanderArchiveChanges.length === 0 && changedFields.length === 0
    return {
      ok: verified,
      verified,
      dispatch,
      reason: verified
        ? undefined
        : 'native state did not satisfy archive/preservation postconditions',
      action: 'archive',
      changed: after.isArchived,
      identity: identity(),
      session: after,
      bystanderArchiveChanges,
      changedFields,
      evidence: 'native manager state; not screenshot proof',
    }
  } catch (error) {
    return {
      ok: false,
      verified: false,
      dispatch,
      action: request.action,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function nativeProgram(request: NativeProgramRequest): string {
  if (!['inspect', 'archive'].includes(request.action)) throw Error('Unsupported native action')
  if (!Number.isSafeInteger(request.pid) || request.pid <= 0) throw Error('Expected positive PID')
  if (!request.profileDir?.trim()) throw Error('Expected exact profile directory')
  if (
    request.action === 'archive' &&
    (!request.accountId || !request.orgId || !request.sessionId || !request.cliSessionId)
  ) {
    throw Error('Archive requires accountId, orgId, sessionId and cliSessionId')
  }
  return `(${nativeRuntime.toString()})(${JSON.stringify(request)},${JSON.stringify(NATIVE_PROGRAM_PIN)})`
}
