/**
 * Builds inspector expressions; importing this module never connects to Claude.
 *
 * Nothing here names a Claude release. Its bundle chunks are content-hashed, so their file
 * names and hashes changed on every update and pinning them stopped every native-control
 * instance until a person re-measured the new build. The runtime finds the same two singletons
 * by shape instead, inside the loaded module cache, and refuses anything ambiguous. The export
 * names below are hints that shorten the search, never the thing that is trusted.
 */
export const NATIVE_PROGRAM_PIN = Object.freeze({
  managerExport: 'claudeCodeSessionManager',
  previewExportHint: 'Ac',
  /** Only the settings POC needs this one; it has no shape of its own to recognize. */
  bypassExportHint: 'io',
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

/**
 * The runtime is deliberately self-contained: its source is evaluated in the inspected process.
 *
 * Every function from here down to {@link nativeRuntime} is shipped into that process by source,
 * so it may only reference the other functions in this group and its own arguments - a module
 * binding would not exist over there. The split into named top-level pieces is what keeps each
 * of them small enough to reason about on its own; the expression below reassembles them into the
 * single closure the inspector evaluates.
 */

function nativeRefuse(why: string): never {
  throw new Error(`NATIVE_REFUSAL: ${why}`)
}

/**
 * Electron can name its CJS entrypoint just "electron". Bootstrap builtins through its bound
 * require, then create an absolute app require that shares the existing cache. Never import a
 * bundle: that could construct another manager or initialize new surfaces.
 */
function nativeOpenEnv(request: any): any {
  const runtimeProcess = (globalThis as any).process
  const mainModule = runtimeProcess?.mainModule
  if (typeof mainModule?.require !== 'function') nativeRefuse('CJS main module is unavailable')
  const rootRequire = mainModule.require.bind(mainModule)
  const { app } = rootRequire('electron')
  const path = rootRequire('node:path')
  const require = rootRequire('node:module').createRequire(
    path.join(app.getAppPath(), 'package.json'),
  )
  const env = {
    runtimeProcess,
    app,
    path,
    require,
    fs: require('node:fs'),
    crypto: require('node:crypto'),
    appPath: '',
  }
  nativeCheckProcess(env, request)
  env.appPath = nativePathKey(env, app.getAppPath())
  return env
}

function nativePathKey(env: any, value: string): string {
  const resolved = env.path.resolve(value).replace(/[\\/]+$/, '')
  return env.runtimeProcess.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function nativeCheckProcess(env: any, request: any): void {
  if (env.runtimeProcess.pid !== request.pid) nativeRefuse('PID changed or wrong process')
  if (!env.app.isReady()) nativeRefuse('unsupported app state')
  if (nativePathKey(env, env.app.getPath('userData')) !== nativePathKey(env, request.profileDir)) {
    nativeRefuse('wrong profile')
  }
}

/**
 * Only already-initialized modules of THIS application are considered, and a module is read
 * through its own export, never constructed: discovery must not initialize anything.
 */
function nativeLoadedMembers(env: any): any[] {
  return Object.keys(env.require.cache)
    .filter((name: string) => {
      const key = nativePathKey(env, name)
      return (
        (key === env.appPath || key.startsWith(env.appPath + env.path.sep)) &&
        env.require.cache[name]?.loaded
      )
    })
    .map((name: string) => ({ filename: name, module: env.require.cache[name] }))
}

function nativeExported(module: any, name: string): any {
  try {
    return module?.exports?.[name]
  } catch {
    return undefined
  }
}

/** One distinct value or nothing: two different candidates mean the shape is ambiguous. */
function nativeOnly(matches: any[], what: string): any {
  const distinct = matches.filter(
    (match: any, at: number) =>
      matches.findIndex((other: any) => other.value === match.value) === at,
  )
  if (distinct.length > 1) nativeRefuse(`more than one ${what} is loaded`)
  return distinct[0]
}

function nativeFindManager(env: any, pin: any): any {
  const match = nativeOnly(
    nativeLoadedMembers(env)
      .map((member: any) => ({
        ...member,
        value: nativeExported(member.module, pin.managerExport),
      }))
      .filter((member: any) => member.value),
    'native session manager',
  )
  if (!match) nativeRefuse('manager chunk is not already initialized')
  const manager = match.value
  const filename = match.filename
  const loaded = match.module
  const hash = env.crypto.createHash('sha256').update(env.fs.readFileSync(filename)).digest('hex')
  if (!manager?.sessions?.get || !manager.sessions.values) {
    nativeRefuse('native singleton is unavailable')
  }
  const methods = [
    'waitForInitialization',
    'getSessionList',
    'archiveCascadeClosureOf',
    'losableWorkKind',
    'hasPendingUserInput',
    'archiveSession',
    'localLineageIds',
  ]
  for (const name of methods) {
    if (typeof manager[name] !== 'function') nativeRefuse(`native method unavailable: ${name}`)
  }
  return { manager, filename, loaded, hash, exportName: pin.managerExport }
}

/**
 * Re-checks the process, the module cache and the account. `settled` is the account/organization
 * captured after initialization: passing it also requires those to be unchanged since.
 */
function nativeCheckIdentity(env: any, found: any, request: any, settled?: any): void {
  nativeCheckProcess(env, request)
  const manager = found.manager
  if (
    env.require.cache[found.filename] !== found.loaded ||
    nativeExported(found.loaded, found.exportName) !== manager
  ) {
    nativeRefuse('native singleton changed')
  }
  if (!manager.currentAccountId || !manager.currentOrgId) nativeRefuse('account is unavailable')
  if (nativePathKey(env, manager.userDataPath) !== nativePathKey(env, request.profileDir)) {
    nativeRefuse('wrong manager profile')
  }
  if (request.accountId && manager.currentAccountId !== request.accountId)
    nativeRefuse('account changed')
  if (request.orgId && manager.currentOrgId !== request.orgId) nativeRefuse('organization changed')
  if (!settled) return
  if (manager.currentAccountId !== settled.accountId || manager.currentOrgId !== settled.orgId) {
    nativeRefuse('account changed while inspecting')
  }
}

function nativeSnapshot(manager: any, session: any): any {
  return JSON.parse(
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
}

function nativeSelect(manager: any, request: any): any {
  const session = manager.sessions.get(request.sessionId)
  if (!session || session.sessionId !== request.sessionId)
    nativeRefuse('exact native session ID not found')
  if (request.cliSessionId && session.cliSessionId !== request.cliSessionId) {
    nativeRefuse('current CLI session ID changed')
  }
  if (request.expectedTitle !== undefined && session.title !== request.expectedTitle) {
    nativeRefuse('title changed')
  }
  return session
}

function nativeIdentity(env: any, found: any, mainInfo: any): any {
  const identity = {
    pid: env.runtimeProcess.pid,
    profileDir: env.app.getPath('userData'),
    version: env.app.getVersion(),
    accountId: found.manager.currentAccountId,
    orgId: found.manager.currentOrgId,
    // Recorded, not compared: this is the evidence of which bundle actually answered.
    managerMember: env.path.relative(env.app.getAppPath(), found.filename),
    managerSha256: found.hash,
  }
  if (!mainInfo) return identity
  return { ...identity, mainSha256: mainInfo.hash, mainMember: mainInfo.member }
}

function nativeIsPreviewManager(value: any): boolean {
  return (
    !!value &&
    typeof value.getServersForWorktree === 'function' &&
    typeof value.stopServersForWorktree === 'function' &&
    Object.prototype.toString.call(value.htmlPreviews) === '[object Map]'
  )
}

/**
 * The preview manager is the one singleton whose state archive can disturb, so it is identified
 * by the exact surface archive depends on, not by a bundle file name.
 */
function nativeFindPreviewManager(env: any, pin: any): any {
  const previewMatches: any[] = []
  for (const member of nativeLoadedMembers(env)) {
    const hinted = nativeExported(member.module, pin.previewExportHint)
    const hintMatched = nativeIsPreviewManager(hinted)
    if (hintMatched) {
      previewMatches.push({ ...member, name: pin.previewExportHint, value: hinted })
    }
    let names: string[]
    try {
      names = Object.keys(member.module.exports ?? {})
    } catch {
      continue
    }
    for (const name of names) {
      if (hintMatched && name === pin.previewExportHint) continue
      const value = nativeExported(member.module, name)
      if (nativeIsPreviewManager(value)) previewMatches.push({ ...member, name, value })
    }
  }
  const previewMatch = nativeOnly(previewMatches, 'native preview manager')
  if (!previewMatch) nativeRefuse('main chunk is not already initialized')
  return {
    filename: previewMatch.filename,
    loaded: previewMatch.module,
    value: previewMatch.value,
    exportName: previewMatch.name,
  }
}

function nativeSourceOf(fn: unknown): string {
  try {
    return typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''
  } catch {
    return ''
  }
}

/**
 * What the guards below assume about Claude's own code, read from that code now that no hash
 * pins it: archive must still forward cleanupWorktree (false is what keeps the checkout's
 * files), and stopping a worktree's previews must still match by raw prefix, which is exactly
 * what checkSharedPreviewSafety models. A build that moved either refuses here, before any
 * dispatch. Minified bundles keep property and method names, so these reads survive a rebuild.
 */
function nativeCheckArchiveContract(found: any, preview: any): void {
  const archiveSource = nativeSourceOf(found.manager.archiveSession)
  if (!archiveSource.includes('cleanupWorktree')) {
    nativeRefuse('native archive no longer takes cleanupWorktree')
  }
  if (
    archiveSource.includes('teardownSession') &&
    !nativeSourceOf(found.manager.teardownSession).includes('cleanupWorktree')
  ) {
    nativeRefuse('native teardown no longer reads cleanupWorktree')
  }
  if (!nativeSourceOf(preview.value.stopServersForWorktree).includes('.startsWith(')) {
    nativeRefuse('native preview cleanup no longer matches worktrees by prefix')
  }
}

function nativeCheckMainIdentity(env: any, preview: any): void {
  if (
    env.require.cache[preview.filename] !== preview.loaded ||
    nativeExported(preview.loaded, preview.exportName) !== preview.value
  ) {
    nativeRefuse('native preview singleton changed')
  }
}

function nativeCheckSiblingSessions(
  env: any,
  manager: any,
  session: any,
  effectiveCwd: string,
): void {
  for (const other of manager.sessions.values()) {
    if (other === session || other.isArchived || other.prewarmHidden) continue
    const otherCwd = other.worktreePath || other.cwd
    if (
      typeof otherCwd !== 'string' ||
      nativePathKey(env, otherCwd) !== nativePathKey(env, effectiveCwd)
    ) {
      continue
    }
    // The native registry uses raw strings. Do not infer resource ownership across aliases.
    if (otherCwd !== effectiveCwd)
      nativeRefuse('shared working directory uses different path aliases')
  }
}

function nativeCheckPreviewPrefixes(previewManager: any, effectiveCwd: string): void {
  for (const preview of previewManager.htmlPreviews.values()) {
    if (typeof preview?.cwd !== 'string') {
      nativeRefuse('shared working directory preview state is invalid')
    }
    // Pinned stopServersForWorktree uses this raw prefix, even without a path separator.
    if (preview.cwd.startsWith(effectiveCwd)) {
      nativeRefuse('shared working directory has HTML previews that archive would stop')
    }
  }
}

/**
 * A prefix-matched HTML preview can belong to a different directory, even when no other session
 * shares this exact cwd. This POC requires no affected resources for every archive.
 */
function nativeCheckSharedPreviewSafety(
  env: any,
  preview: any,
  manager: any,
  session: any,
  effectiveCwd: string,
): void {
  nativeCheckMainIdentity(env, preview)
  nativeCheckSiblingSessions(env, manager, session, effectiveCwd)
  const previewManager = preview.value
  if (
    typeof previewManager?.getServersForWorktree !== 'function' ||
    Object.prototype.toString.call(previewManager.htmlPreviews) !== '[object Map]'
  ) {
    nativeRefuse('shared working directory preview manager is unavailable')
  }
  const servers = previewManager.getServersForWorktree(effectiveCwd)
  if (!Array.isArray(servers)) nativeRefuse('shared working directory server state is invalid')
  if (servers.length) nativeRefuse('shared working directory has servers that archive would stop')
  nativeCheckPreviewPrefixes(previewManager, effectiveCwd)
}

function nativeMainInfo(env: any, preview: any): any {
  return {
    hash: env.crypto
      .createHash('sha256')
      .update(env.fs.readFileSync(preview.filename))
      .digest('hex'),
    member: env.path.relative(env.app.getAppPath(), preview.filename),
  }
}

function nativeRequireArchiveRequest(request: any): void {
  if (!request.accountId || !request.orgId || !request.sessionId || !request.cliSessionId) {
    nativeRefuse('archive requires account, organization, native ID and current CLI ID')
  }
}

/** Session-side evidence that archive would interrupt work rather than a settled idle session. */
function nativeSessionIsBusy(before: any, session: any): boolean {
  return (
    before.isRunning ||
    before.isStopping ||
    before.starting ||
    before.losableWork ||
    before.pendingInput ||
    before.pendingPermission ||
    before.pendingDialog ||
    session.startResumeInFlight
  )
}

/** Manager-side in-flight bookkeeping for the same session. */
function nativeManagerIsBusy(manager: any, sessionId: string): boolean {
  return (
    manager.parked.has(sessionId) ||
    manager.movesInFlight.has(sessionId) ||
    manager.deletingSessionIds.has(sessionId) ||
    (manager.sideSessionStartsInFlight.get(sessionId) ?? 0) > 0
  )
}

function nativeArchivePreconditions(found: any, session: any, before: any): void {
  if (session.prewarmHidden || session.backend?.kind !== 'local' || session.backend?.remoteTarget) {
    nativeRefuse('only ordinary local Desktop sessions are supported')
  }
  if (session.spawnedFrom && !session.lineageDetached) {
    nativeRefuse('attached parent could receive side effects')
  }
  if (
    nativeSessionIsBusy(before, session) ||
    nativeManagerIsBusy(found.manager, session.sessionId)
  ) {
    nativeRefuse('session has live, pending, or transitioning work')
  }
  if (before.cascade.length) nativeRefuse('archive would cascade to other sessions')
}

function nativeArchiveFlags(manager: any): Map<string, boolean> {
  return new Map(
    Array.from(
      manager.sessions.values(),
      (session: any) => [session.sessionId, session.isArchived === true] as const,
    ),
  )
}

function nativeBystanderChanges(
  manager: any,
  sessionId: string,
  flags: Map<string, boolean>,
): any[] {
  const bystanderArchiveChanges: any[] = []
  for (const [id, wasArchived] of flags) {
    if (id === sessionId) continue
    const current = manager.sessions.get(id)
    if (!current || (current.isArchived === true) !== wasArchived) {
      bystanderArchiveChanges.push({
        sessionId: id,
        before: wasArchived,
        after: current ? current.isArchived === true : null,
      })
    }
  }
  return bystanderArchiveChanges
}

function nativePreservedFieldChanges(before: any, after: any): string[] {
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
  ]
  return preserved.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
}

function nativeArchiveAlreadyResult(
  env: any,
  found: any,
  before: any,
  mainInfo: any,
  state: any,
): any {
  return {
    ok: true,
    verified: true,
    dispatch: state.dispatch,
    action: 'archive',
    changed: false,
    identity: nativeIdentity(env, found, mainInfo),
    session: before,
    bystanderArchiveChanges: [],
    evidence: 'native manager state; not screenshot proof',
  }
}

function nativeArchiveResult(
  env: any,
  found: any,
  session: any,
  before: any,
  after: any,
  flags: Map<string, boolean>,
  mainInfo: any,
  state: any,
): any {
  const bystanderArchiveChanges = nativeBystanderChanges(found.manager, session.sessionId, flags)
  const changedFields = nativePreservedFieldChanges(before, after)
  const verified =
    after.isArchived && bystanderArchiveChanges.length === 0 && changedFields.length === 0
  return {
    ok: verified,
    verified,
    dispatch: state.dispatch,
    reason: verified
      ? undefined
      : 'native state did not satisfy archive/preservation postconditions',
    action: 'archive',
    changed: after.isArchived,
    identity: nativeIdentity(env, found, mainInfo),
    session: after,
    bystanderArchiveChanges,
    changedFields,
    evidence: 'native manager state; not screenshot proof',
  }
}

function nativeInspectResult(env: any, found: any, request: any, list: any, state: any): any {
  const manager = found.manager
  const sessions = request.sessionId
    ? [nativeSelect(manager, request)]
    : Array.from(manager.sessions.values())
  return {
    ok: true,
    verified: true,
    dispatch: state.dispatch,
    action: 'inspect',
    identity: nativeIdentity(env, found, null),
    loadGeneration: list.loadGeneration,
    sessions: sessions
      .filter((session: any) => !session.prewarmHidden)
      .map((session: any) => nativeSnapshot(manager, session)),
    evidence: 'native manager state; not screenshot proof',
  }
}

async function nativeArchive(
  env: any,
  found: any,
  request: any,
  settled: any,
  state: any,
  pin: any,
): Promise<any> {
  if (request.action !== 'archive') nativeRefuse('unsupported action')
  nativeRequireArchiveRequest(request)
  const preview = nativeFindPreviewManager(env, pin)
  const mainInfo = nativeMainInfo(env, preview)
  nativeCheckArchiveContract(found, preview)
  const manager = found.manager
  const session = nativeSelect(manager, request)
  const before = nativeSnapshot(manager, session)
  if (before.isArchived) return nativeArchiveAlreadyResult(env, found, before, mainInfo, state)
  nativeArchivePreconditions(found, session, before)
  const effectiveCwd = session.worktreePath || session.cwd
  if (typeof effectiveCwd !== 'string' || !effectiveCwd.trim()) {
    nativeRefuse('session working directory is unavailable')
  }
  const flags = nativeArchiveFlags(manager)
  nativeCheckIdentity(env, found, request, settled)
  if (nativeSelect(manager, request) !== session)
    nativeRefuse('session object changed before archive')
  nativeCheckSharedPreviewSafety(env, preview, manager, session, effectiveCwd)
  // No await between the final guards and this native call. cleanupWorktree:false preserves
  // checkout files. The native method emits the same archived event used by the stock UI.
  state.dispatch = 'sent'
  await manager.archiveSession(session.sessionId, { cleanupWorktree: false })
  nativeCheckIdentity(env, found, request, settled)
  nativeCheckMainIdentity(env, preview)
  if (nativeSelect(manager, request) !== session)
    nativeRefuse('session object changed during archive')
  const after = nativeSnapshot(manager, session)
  return nativeArchiveResult(env, found, session, before, after, flags, mainInfo, state)
}

async function nativeRun(request: any, pin: any, state: any): Promise<any> {
  const env = nativeOpenEnv(request)
  const found = nativeFindManager(env, pin)
  await found.manager.waitForInitialization()
  nativeCheckIdentity(env, found, request)
  const settled = {
    accountId: found.manager.currentAccountId,
    orgId: found.manager.currentOrgId,
  }
  const manager = found.manager
  // getSessionList is the app's list contract, but its folder checks await. Identity is checked
  // again and the selected object is read afresh after those awaits before any mutation.
  if (request.action === 'inspect') {
    if (typeof manager.ensureArchivedSessionsLoaded !== 'function') {
      nativeRefuse('native archived-session loader unavailable')
    }
    await manager.ensureArchivedSessionsLoaded('ownership')
    nativeCheckIdentity(env, found, request, settled)
  }
  const list = await manager.getSessionList()
  nativeCheckIdentity(env, found, request, settled)
  if (request.action === 'inspect') return nativeInspectResult(env, found, request, list, state)
  return await nativeArchive(env, found, request, settled, state, pin)
}

async function nativeRuntime(request: any, pin: any): Promise<any> {
  const state = { dispatch: 'not-sent' }
  try {
    return await nativeRun(request, pin, state)
  } catch (error) {
    return {
      ok: false,
      verified: false,
      dispatch: state.dispatch,
      action: request.action,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Assembles the evaluated expression out of the runtime group above: each part is shipped as its
 * own source text, so the closure the inspector runs is the same code this module is measured on.
 */
function nativeRuntimeExpression(request: NativeProgramRequest): string {
  const parts = [
    nativeRefuse,
    nativeOpenEnv,
    nativePathKey,
    nativeCheckProcess,
    nativeLoadedMembers,
    nativeExported,
    nativeOnly,
    nativeFindManager,
    nativeCheckIdentity,
    nativeSnapshot,
    nativeSelect,
    nativeIdentity,
    nativeIsPreviewManager,
    nativeFindPreviewManager,
    nativeSourceOf,
    nativeCheckArchiveContract,
    nativeCheckMainIdentity,
    nativeCheckSiblingSessions,
    nativeCheckPreviewPrefixes,
    nativeCheckSharedPreviewSafety,
    nativeMainInfo,
    nativeRequireArchiveRequest,
    nativeSessionIsBusy,
    nativeManagerIsBusy,
    nativeArchivePreconditions,
    nativeArchiveFlags,
    nativeBystanderChanges,
    nativePreservedFieldChanges,
    nativeArchiveAlreadyResult,
    nativeArchiveResult,
    nativeInspectResult,
    nativeArchive,
    nativeRun,
    nativeRuntime,
  ]
  const source = parts.map((part) => part.toString()).join('\n')
  return `(() => {\n${source}\nreturn nativeRuntime(${JSON.stringify(request)}, ${JSON.stringify(NATIVE_PROGRAM_PIN)})\n})()`
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
  return nativeRuntimeExpression(request)
}
