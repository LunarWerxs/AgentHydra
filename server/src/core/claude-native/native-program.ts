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
  action: 'inspect' | 'archive' | 'ultracode' | 'idle' | 'pause' | 'import'
  /** idle only: how long a chat that is not on screen keeps its idle engine before the app's own
   *  pause releases it. Applies only where the app's own setting is "never" (0). */
  idleMs?: number
  /** pause only: chats to release now - native ids (local_...) or CLI session ids. */
  pauseIds?: string[]
  /** pause only: how long to wait for an engine that is still starting before pausing it. */
  waitMs?: number
  /** ultracode only: the effort to land (low..max; ultracode on needs xhigh or max). */
  effort?: string
  /** ultracode only: the ultracode flag to land. Default true; false lands a source that ran
   *  without it, so a moved chat keeps the level it had (owner, 2026-09-26). */
  ultracode?: boolean
  /** ultracode only: also put the chat on Bypass permissions through the app's own picker call,
   *  so a move confirms the mode in memory instead of clicking the picker (5.5s a chat). */
  bypass?: boolean
  /** archive only: CLI ids of chats leaving this profile in the same move; their servers are
   *  not bystanders of this archive. */
  leavingCliSessionIds?: string[]
  /** archive only: the source account is at its usage limit, so a move off it ALWAYS archives
   *  the source row (owner, 2026-09-26). Servers and HTML previews another chat owns under the
   *  cwd are stopped by that archive, and the result names each one (`stoppedBystanders`). */
  sourceAtLimit?: boolean
  /** archive only: a move's source row, sent only once the target landing is verified (2026-10-08).
   *  The archive goes ahead over an attached parent (named as `attachedParent`) and over the HTML
   *  previews and servers another chat owns (named as `stoppedBystanders`), as sourceAtLimit does. */
  sourceSuperseded?: boolean
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

/** The effort levels the app's picker offers; the ultracode action accepts exactly these. */
export const NATIVE_EFFORTS: readonly string[] = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

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
    'archiveSession',
  ]
  for (const name of methods) {
    if (typeof manager[name] !== 'function') nativeRefuse(`native method unavailable: ${name}`)
  }
  nativePendingInput(manager)
  nativeLineageIds(manager)
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
  if (!manager.currentAccountId || !manager.currentOrgId) {
    // A signed-out app loaded no chats, so it has nothing to write over an archive flag; the
    // caller may flag the record instead (routes/desktop-sessions.ts). The text is matched there.
    nativeRefuse(
      manager.sessions.size === 0 ? 'signed out, no chats loaded' : 'account is unavailable',
    )
  }
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

/**
 * The ids of sessions mid-start. Older builds keep them on the manager as a Set; 2.9939.4 moved
 * them to `manager.inFlightStarts.startingSessionIds` (a Map), and reading the old field threw
 * "Cannot read properties of undefined (reading 'has')" on every archive (2026-09-28).
 */
function nativeStartingIds(manager: any): { has(id: string): boolean } {
  const starting = manager.startingSessionIds ?? manager.inFlightStarts?.startingSessionIds
  if (typeof starting?.has !== 'function') nativeRefuse('native starting-session state unavailable')
  return starting
}

/**
 * The pending-input check. Older builds keep it on the manager; 2.26454.0 moved it to
 * `manager.heldInputChecks`, and asking the manager for it refused every archive with
 * "native method unavailable: hasPendingUserInput" (2026-10-07).
 */
function nativePendingInput(manager: any): (session: any) => boolean {
  if (typeof manager.hasPendingUserInput === 'function')
    return (session) => manager.hasPendingUserInput(session)
  const checks = manager.heldInputChecks
  if (typeof checks?.hasPendingUserInput === 'function')
    return (session) => checks.hasPendingUserInput(session)
  nativeRefuse('native method unavailable: hasPendingUserInput')
}

/**
 * A chat's earlier CLI ids. Older builds keep the lookup on the manager; 2.31226.0 moved it to
 * `manager.transcriptIdClaims`, and asking the manager for it refused every archive with
 * "native method unavailable: localLineageIds" (2026-10-09: 15 moved chats left visible).
 */
function nativeLineageIds(manager: any): (session: any) => string[] {
  if (typeof manager.localLineageIds === 'function')
    return (session) => manager.localLineageIds(session)
  const claims = manager.transcriptIdClaims
  if (typeof claims?.localLineageIds === 'function')
    return (session) => claims.localLineageIds(session)
  nativeRefuse('native method unavailable: localLineageIds')
}

function nativeSnapshot(manager: any, session: any): any {
  return JSON.parse(
    JSON.stringify({
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId ?? null,
      lineageIds: nativeLineageIds(manager)(session),
      title: session.title ?? null,
      isArchived: session.isArchived === true,
      isRunning: session.isRunning === true,
      isStopping: session.isStopping === true,
      hasQuery: session.query != null,
      starting: nativeStartingIds(manager).has(session.sessionId),
      losableWork: manager.losableWorkKind(session.sessionId) ?? null,
      pendingInput: nativePendingInput(manager)(session),
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

function nativeCheckPreviewPrefixes(
  previewManager: any,
  effectiveCwd: string,
  overBystanders = false,
): any[] {
  const stopping: any[] = []
  for (const [previewId, preview] of previewManager.htmlPreviews.entries()) {
    if (typeof preview?.cwd !== 'string') {
      nativeRefuse('shared working directory preview state is invalid')
    }
    // Pinned stopServersForWorktree uses this raw prefix, even without a path separator.
    if (preview.cwd.startsWith(effectiveCwd)) {
      if (!overBystanders) {
        nativeRefuse('shared working directory has HTML previews that archive would stop')
      }
      stopping.push({ kind: 'html-preview', id: String(previewId), cwd: preview.cwd })
    }
  }
  return stopping
}

/**
 * A prefix-matched HTML preview can belong to a different directory, even when no other session
 * shares this exact cwd. No archive may stop a resource another chat owns: HTML previews under
 * the prefix refuse, and registry servers refuse unless the archived chat owns them all.
 * The exception is `overBystanders` (a source at its usage limit, or a superseded move source):
 * the owner's order is that a move always archives the source row, so what the archive will stop
 * is returned for the result instead of refused.
 */
function nativeCheckSharedPreviewSafety(
  env: any,
  preview: any,
  manager: any,
  session: any,
  effectiveCwd: string,
  leavingCliSessionIds: string[] = [],
  overBystanders = false,
): any[] {
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
  // A server the archived chat started itself is stopped by the app's own archive of that chat,
  // the same as when a person archives it. So is one whose owner is already archived here, or
  // is leaving this profile in the same move (the caller names those by CLI id): a batch of
  // chats sharing one cwd otherwise refused each archive over its siblings' servers and left
  // every source row visible. Only a server whose owner stays - or cannot be read - is a
  // bystander (2026-09-26).
  const bystander = (server: any) => {
    if (server?.sessionId === session.sessionId) return false
    const owner = manager.sessions.get(server?.sessionId)
    if (!owner) return true
    return owner.isArchived !== true && !leavingCliSessionIds.includes(owner.cliSessionId)
  }
  const bystanders = servers.filter(bystander)
  if (bystanders.length && !overBystanders) {
    nativeRefuse('shared working directory has servers that archive would stop')
  }
  return [
    ...bystanders.map((server: any) => ({
      kind: 'server',
      id: String(server?.serverId ?? ''),
      sessionId: server?.sessionId ?? null,
    })),
    ...nativeCheckPreviewPrefixes(previewManager, effectiveCwd, overBystanders),
  ]
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

/** Which of the busy flags above are set, by name, so a refusal says what held it (2026-10-08: a
 *  move leftover with no engine was refused as busy, and nothing said which flag was set). */
function nativeBusyFlags(manager: any, before: any, session: any): string[] {
  const id = session.sessionId
  const flags: Record<string, unknown> = {
    isRunning: before.isRunning,
    isStopping: before.isStopping,
    starting: before.starting,
    losableWork: before.losableWork,
    pendingInput: before.pendingInput,
    pendingPermission: before.pendingPermission,
    pendingDialog: before.pendingDialog,
    startResumeInFlight: session.startResumeInFlight,
    parked: manager.parked?.has?.(id),
    moveInFlight: manager.movesInFlight?.has?.(id),
    deleting: manager.deletingSessionIds?.has?.(id),
    sideSessionStarting: (manager.sideSessionStartsInFlight?.get?.(id) ?? 0) > 0,
  }
  return Object.keys(flags).filter((name) => !!flags[name])
}

function nativeArchivePreconditions(
  found: any,
  session: any,
  before: any,
  sourceSuperseded: boolean,
): void {
  if (session.prewarmHidden || session.backend?.kind !== 'local' || session.backend?.remoteTarget) {
    nativeRefuse('only ordinary local Desktop sessions are supported')
  }
  if (session.spawnedFrom && !session.lineageDetached && !sourceSuperseded) {
    nativeRefuse('attached parent could receive side effects')
  }
  if (
    nativeSessionIsBusy(before, session) ||
    nativeManagerIsBusy(found.manager, session.sessionId)
  ) {
    nativeRefuse(
      `session has live, pending, or transitioning work (${nativeBusyFlags(found.manager, before, session).join(', ')})`,
    )
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
  nativeArchivePreconditions(found, session, before, request.sourceSuperseded === true)
  const attachedParent =
    session.spawnedFrom && !session.lineageDetached ? (session.spawnedFrom.sessionId ?? null) : null
  const effectiveCwd = session.worktreePath || session.cwd
  if (typeof effectiveCwd !== 'string' || !effectiveCwd.trim()) {
    nativeRefuse('session working directory is unavailable')
  }
  const flags = nativeArchiveFlags(manager)
  nativeCheckIdentity(env, found, request, settled)
  if (nativeSelect(manager, request) !== session)
    nativeRefuse('session object changed before archive')
  const stoppedBystanders = nativeCheckSharedPreviewSafety(
    env,
    preview,
    manager,
    session,
    effectiveCwd,
    Array.isArray(request.leavingCliSessionIds) ? request.leavingCliSessionIds : [],
    request.sourceAtLimit === true || request.sourceSuperseded === true,
  )
  // No await between the final guards and this native call. cleanupWorktree:false preserves
  // checkout files. The native method emits the same archived event used by the stock UI.
  state.dispatch = 'sent'
  await manager.archiveSession(session.sessionId, { cleanupWorktree: false })
  nativeCheckIdentity(env, found, request, settled)
  nativeCheckMainIdentity(env, preview)
  if (nativeSelect(manager, request) !== session)
    nativeRefuse('session object changed during archive')
  const after = nativeSnapshot(manager, session)
  const result = nativeArchiveResult(env, found, session, before, after, flags, mainInfo, state)
  return {
    ...result,
    ...(stoppedBystanders.length ? { stoppedBystanders } : {}),
    ...(attachedParent ? { attachedParent } : {}),
  }
}

/**
 * One chat's effort and ultracode flag, through the app's own manager.applyFlagSettings - the
 * call its effort picker makes, so memory, the saved record and a running engine all get it. A
 * disk stamp alone cannot do this while the app runs: the app holds the chat in memory and
 * writes its own copy back (2026-09-26: four moved chats booted with ultracode off). The flag
 * defaults to on; a move passes the source's own flag and effort so the chat keeps its level.
 */
async function nativeUltracode(env: any, found: any, request: any, settled: any, state: any) {
  const manager = found.manager
  if (typeof manager.applyFlagSettings !== 'function') {
    nativeRefuse('native applyFlagSettings unavailable')
  }
  // Only the two fields this action sets are read. nativeSnapshot also reads the archive-only
  // busy bookkeeping (startingSessionIds and the rest), which an app update can rename: on
  // 2026-09-28 it threw "reading 'has'" before dispatch and no chat's ultracode could change.
  const pick = (s: any) => ({
    effort: s.effort ?? null,
    ultracode: s.sessionSettings?.ultracode ?? null,
    ...(request.bypass === true ? { permissionMode: s.permissionMode ?? null } : {}),
  })
  const session = nativeSelect(manager, request)
  const before = pick(session)
  const wantUltracode = request.ultracode !== false
  state.dispatch = 'sent'
  await manager.applyFlagSettings(session.sessionId, {
    ultracode: wantUltracode,
    effortLevel: request.effort,
  })
  nativeCheckIdentity(env, found, request, settled)
  // The picker's own path ('picker'): the app refuses it for a root or remote-spawned chat, and
  // the read-back below is what says whether it took.
  if (request.bypass === true && session.permissionMode !== 'bypassPermissions') {
    if (typeof manager.setPermissionMode !== 'function')
      nativeRefuse('native method unavailable: setPermissionMode')
    await manager.setPermissionMode(session.sessionId, 'bypassPermissions', 'picker')
    nativeCheckIdentity(env, found, request, settled)
  }
  const after = pick(nativeSelect(manager, request))
  const verified =
    (after.ultracode === true) === wantUltracode &&
    after.effort === request.effort &&
    (request.bypass !== true || after.permissionMode === 'bypassPermissions')
  return {
    ok: verified,
    verified,
    dispatch: state.dispatch,
    action: 'ultracode',
    identity: nativeIdentity(env, found, null),
    before,
    after,
    evidence: "native manager state read back after the app's own applyFlagSettings",
  }
}

/**
 * The app's own idle pause. Every Code chat keeps its engine (~260 MB) for as long as the app runs:
 * the warm lifecycle pauses a chat that is not on screen only after `idleTimeoutMs`, and that
 * comes from a remote flag which is 0 ("Idle timeout disabled, not arming" in main.log), so the
 * app never releases one below its cap of one engine per 3 GB of RAM (21 on a 64 GB PC).
 */
function nativeIdleLifecycle(manager: any): any {
  const lifecycle = manager.warmLifecycle
  if (
    !lifecycle?.config ||
    Object.prototype.toString.call(lifecycle.sessions) !== '[object Map]' ||
    typeof lifecycle.startIdleTimeout !== 'function' ||
    typeof lifecycle.getTimeoutMs !== 'function' ||
    typeof manager.pauseSession !== 'function'
  ) {
    nativeRefuse('native idle lifecycle unavailable')
  }
  return lifecycle
}

function nativeShellManager(manager: any): any {
  const shells = manager.shellPty
  if (
    !shells ||
    typeof shells.stopShellPty !== 'function' ||
    Object.prototype.toString.call(shells.shellPtyProcesses) !== '[object Map]' ||
    Object.prototype.toString.call(shells.shellPtyStats) !== '[object Map]'
  ) {
    nativeRefuse('native shell manager unavailable')
  }
  return shells
}

/** The app's own test for "this chat is on screen" (its QS: visibility known and the tab shown). */
function nativeOnScreen(lifecycle: any, sessionId: string): boolean {
  const state = lifecycle.sessions.get(sessionId)
  return !!(state?.visibilityKnown && state?.isTabVisible)
}

/**
 * Stops a chat's terminal shells that the app started ahead of time ("prewarm") and nobody has
 * typed into or read, once the app has had the chat off screen for `hiddenForMs`. The app opens
 * one PowerShell (~85 MB) for every chat it shows and keeps it until the chat is archived, engine
 * or not; showing the chat again prewarms a new one. A stopped shell's ConPTY conhost (~8 MB) is
 * never closed by the app, so a chat someone keeps returning to keeps its shell: stopping it each
 * time left a conhost per return (measured 2026-10-07). A shell anyone used, one the app opened
 * for any other reason, or one of a chat whose visibility the app has not reported is left alone.
 */
function nativeStopPrewarmShells(
  shells: any,
  lifecycle: any,
  sessionId: string,
  hiddenForMs: number,
): string[] {
  const entry = lifecycle.sessions.get(sessionId)
  if (!entry?.visibilityKnown || entry.isTabVisible) return []
  const now = Date.now()
  const stopped: string[] = []
  for (const key of [...shells.shellPtyProcesses.keys()]) {
    if (key !== sessionId && !key.startsWith(`${sessionId}::`)) continue
    const stats = shells.shellPtyStats.get(key)
    if (stats?.spawnReason !== 'prewarm' || stats.hadInput !== false || stats.reads) continue
    if (now - (entry.lastHiddenTime ?? stats.startedAt ?? now) < hiddenForMs) continue
    shells.stopShellPty(key, { noSweep: true })
    stopped.push(key)
  }
  return stopped
}

/**
 * Switches the app's own idle pause on for chats that are not on screen, in this app process only
 * (a restart reverts it, so the daemon re-applies it on every pass). A non-zero value the app
 * already has wins. Unarmed idle chats are armed at once instead of at the app's next 15-minute
 * recheck. The pause itself is the app's (pauseSession), which declines any chat that is running,
 * has a turn, background task, cron, loop wakeup or Remote Control bridge in flight. Then stops
 * never-used prewarmed shells of chats off screen for as long, with or without an engine: the
 * shell only serves the terminal pane, which opens a new one when the chat is shown again.
 */
async function nativeIdle(env: any, found: any, request: any, settled: any, state: any) {
  const manager = found.manager
  const lifecycle = nativeIdleLifecycle(manager)
  const shells = nativeShellManager(manager)
  const current = lifecycle.config.idleTimeoutMs
  const original = current?.agentHydraOriginal ?? current
  const policy: any = (sessionId: string) => {
    const own = typeof original === 'function' ? original(sessionId) : original
    return typeof own === 'number' && own > 0 ? own : policy.agentHydraIdleMs
  }
  policy.agentHydraOriginal = original
  policy.agentHydraIdleMs = request.idleMs
  state.dispatch = 'sent'
  lifecycle.config.idleTimeoutMs = policy
  const armed: string[] = []
  const skipped: Record<string, number> = {}
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1
  }
  for (const sessionId of [...lifecycle.sessions.keys()]) {
    const entry = lifecycle.sessions.get(sessionId)
    const session = manager.sessions.get(sessionId)
    if (!session?.query) skip('noEngine')
    else if (entry?.idleTimeoutId) skip('alreadyArmed')
    else if (entry?.isWarmingUp) skip('warmingUp')
    else if (nativeOnScreen(lifecycle, sessionId)) skip('onScreen')
    else if (session.isRunning) skip('running')
    else {
      lifecycle.startIdleTimeout(sessionId)
      if (lifecycle.sessions.get(sessionId)?.idleTimeoutId) armed.push(sessionId)
      else skip('appDeclined')
    }
  }
  const shellsStopped: string[] = []
  const shellChats = new Set<string>(
    [...shells.shellPtyProcesses.keys()].map((key: string) => key.split('::')[0]),
  )
  for (const sessionId of shellChats)
    shellsStopped.push(...nativeStopPrewarmShells(shells, lifecycle, sessionId, request.idleMs))
  nativeCheckIdentity(env, found, request, settled)
  const sessions = [...manager.sessions.values()]
  return {
    ok: lifecycle.config.idleTimeoutMs === policy,
    verified: lifecycle.config.idleTimeoutMs === policy,
    dispatch: state.dispatch,
    action: 'idle',
    identity: nativeIdentity(env, found, null),
    idleMs: request.idleMs,
    armed,
    skipped,
    shellsStopped,
    engines: sessions.filter((s: any) => s.query).length,
    shells: shells.shellPtyProcesses.size,
    evidence: "the app's warm lifecycle reads its idle timeout through this policy",
  }
}

/**
 * Releases named chats now through the app's own pauseSession - what its idle timer and its
 * engine cap call - so the chat shows as paused, not crashed, and its next message starts a fresh
 * engine. Killing the engine process from outside instead leaves the chat on the app's "restart
 * Claude Code" error (2026-10-07: 13 migrated chats). A chat whose engine is still starting is
 * waited for, then paused; the app declines a chat with work in flight, and the result says so.
 */
async function nativePause(env: any, found: any, request: any, settled: any, state: any) {
  const manager = found.manager
  const lifecycle = nativeIdleLifecycle(manager)
  const shells = nativeShellManager(manager)
  const starting = nativeStartingIds(manager)
  const find = (id: string): any => {
    const direct = manager.sessions.get(id) ?? manager.sessions.get(`local_${id}`)
    if (direct) return direct
    const matches = [...manager.sessions.values()].filter((s: any) => s.cliSessionId === id)
    return matches.length === 1 ? matches[0] : null
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const deadline = Date.now() + request.waitMs
  const results: any[] = []
  for (const id of request.pauseIds) {
    let session = find(id)
    if (!session) {
      results.push({ id, paused: false, why: 'not loaded in this app' })
      continue
    }
    const sessionId = session.sessionId
    while (
      Date.now() < deadline &&
      (starting.has(sessionId) || session.lifecycleState === 'initializing')
    ) {
      await sleep(250)
      session = manager.sessions.get(sessionId) ?? session
    }
    nativeCheckIdentity(env, found, request, settled)
    const hadEngine = session.query != null
    if (hadEngine) {
      state.dispatch = 'sent'
      lifecycle.disarmIdle?.(sessionId)
      await manager.pauseSession(sessionId, 'idle_timeout')
    }
    const after = manager.sessions.get(sessionId)
    const paused = !after?.query
    const shellsStopped = paused ? nativeStopPrewarmShells(shells, lifecycle, sessionId, 0) : []
    results.push({
      id,
      sessionId,
      paused,
      hadEngine,
      shellsStopped,
      ...(paused ? {} : { why: 'the app kept the engine: work is in flight' }),
    })
  }
  nativeCheckIdentity(env, found, request, settled)
  return {
    ok: results.every((r) => r.paused),
    verified: true,
    dispatch: state.dispatch,
    action: 'pause',
    identity: nativeIdentity(env, found, null),
    results,
    evidence: "each chat's engine read back after the app's own pauseSession",
  }
}

/**
 * Lands a CLI transcript as a chat in this app: the exact call the app's claude://resume handler
 * makes (importCliSession, source deep_link), minus the window it then navigates. The deep link
 * needed a second claude.exe started per chat only to hand the URL over (~4.5s a chat,
 * 2026-10-09). The app's own call is idempotent: a chat it already holds is unarchived and its
 * id returned. The landing is read back from the manager's memory.
 */
async function nativeImport(env: any, found: any, request: any, settled: any, state: any) {
  const manager = found.manager
  if (typeof manager.importCliSession !== 'function')
    nativeRefuse('native method unavailable: importCliSession')
  state.dispatch = 'sent'
  const importedSessionId = await manager.importCliSession(request.cliSessionId, {
    source: 'deep_link',
  })
  nativeCheckIdentity(env, found, request, settled)
  const session = manager.sessions.get(importedSessionId)
  const verified =
    !!session && session.cliSessionId === request.cliSessionId && session.isArchived !== true
  return {
    ok: verified,
    verified,
    dispatch: state.dispatch,
    action: 'import',
    importedSessionId: importedSessionId ?? null,
    reason: verified ? undefined : 'the app did not hold the imported chat unarchived',
    identity: nativeIdentity(env, found, null),
    session: session
      ? {
          sessionId: session.sessionId,
          cliSessionId: session.cliSessionId ?? null,
          title: session.title ?? null,
          isArchived: session.isArchived === true,
          permissionMode: session.permissionMode ?? null,
          cwd: session.cwd ?? null,
        }
      : null,
    evidence: "native manager state read back after the app's own importCliSession",
  }
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
  if (request.action === 'ultracode')
    return await nativeUltracode(env, found, request, settled, state)
  if (request.action === 'idle') return await nativeIdle(env, found, request, settled, state)
  if (request.action === 'pause') return await nativePause(env, found, request, settled, state)
  if (request.action === 'import') return await nativeImport(env, found, request, settled, state)
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
    nativeStartingIds,
    nativePendingInput,
    nativeLineageIds,
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
    nativeBusyFlags,
    nativeArchivePreconditions,
    nativeArchiveFlags,
    nativeBystanderChanges,
    nativePreservedFieldChanges,
    nativeArchiveAlreadyResult,
    nativeArchiveResult,
    nativeInspectResult,
    nativeArchive,
    nativeUltracode,
    nativeIdleLifecycle,
    nativeShellManager,
    nativeOnScreen,
    nativeStopPrewarmShells,
    nativeIdle,
    nativePause,
    nativeImport,
    nativeRun,
    nativeRuntime,
  ]
  const source = parts.map((part) => part.toString()).join('\n')
  return `(() => {\n${source}\nreturn nativeRuntime(${JSON.stringify(request)}, ${JSON.stringify(NATIVE_PROGRAM_PIN)})\n})()`
}

export function nativeProgram(request: NativeProgramRequest): string {
  if (!['inspect', 'archive', 'ultracode', 'idle', 'pause', 'import'].includes(request.action))
    throw Error('Unsupported native action')
  if (
    request.action === 'import' &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(request.cliSessionId),
    )
  )
    throw Error('Import requires the CLI session id (a UUID)')
  checkIdleAndPause(request)
  if (!Number.isSafeInteger(request.pid) || request.pid <= 0) throw Error('Expected positive PID')
  if (!request.profileDir?.trim()) throw Error('Expected exact profile directory')
  checkArchiveAndUltracode(request)
  checkOptionalFields(request)
  return nativeRuntimeExpression(request)
}

function checkIdleAndPause(request: NativeProgramRequest): void {
  if (
    request.action === 'idle' &&
    !(
      Number.isSafeInteger(request.idleMs) &&
      request.idleMs! >= 60_000 &&
      request.idleMs! <= 86_400_000
    )
  ) {
    throw Error('Idle requires idleMs between one minute and one day')
  }
  if (request.action === 'pause') {
    if (
      !Array.isArray(request.pauseIds) ||
      request.pauseIds.length === 0 ||
      !request.pauseIds.every((id) => /^(local_)?[A-Za-z0-9-]{8,160}$/.test(String(id)))
    ) {
      throw Error('Pause requires pauseIds: native (local_...) or CLI session ids')
    }
    if (
      !(Number.isSafeInteger(request.waitMs) && request.waitMs! >= 0 && request.waitMs! <= 30_000)
    )
      throw Error('Pause requires waitMs between 0 and 30000')
  }
}

function checkArchiveAndUltracode(request: NativeProgramRequest): void {
  if (
    request.action === 'archive' &&
    (!request.accountId || !request.orgId || !request.sessionId || !request.cliSessionId)
  ) {
    throw Error('Archive requires accountId, orgId, sessionId and cliSessionId')
  }
  if (request.action === 'ultracode') {
    if (!request.sessionId || !NATIVE_EFFORTS.includes(String(request.effort)))
      throw Error(`Ultracode requires sessionId and an effort of ${NATIVE_EFFORTS.join('/')}`)
    if (request.ultracode !== undefined && typeof request.ultracode !== 'boolean')
      throw Error('ultracode must be a boolean')
    if (request.bypass !== undefined && typeof request.bypass !== 'boolean')
      throw Error('bypass must be a boolean')
    if (request.ultracode !== false && !['xhigh', 'max'].includes(String(request.effort)))
      throw Error('Ultracode on requires an effort of xhigh or max')
  }
}

function checkOptionalFields(request: NativeProgramRequest): void {
  if (request.sourceAtLimit !== undefined && typeof request.sourceAtLimit !== 'boolean') {
    throw Error('sourceAtLimit must be a boolean')
  }
  if (request.sourceSuperseded !== undefined && typeof request.sourceSuperseded !== 'boolean') {
    throw Error('sourceSuperseded must be a boolean')
  }
  if (
    request.leavingCliSessionIds !== undefined &&
    !(
      Array.isArray(request.leavingCliSessionIds) &&
      request.leavingCliSessionIds.every((id) => /^[A-Za-z0-9-]{8,80}$/.test(String(id)))
    )
  ) {
    throw Error('leavingCliSessionIds must be a list of CLI session ids')
  }
}
