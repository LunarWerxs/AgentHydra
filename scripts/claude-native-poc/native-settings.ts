import { NATIVE_PROGRAM_PIN } from './native-program'

/** Only the disposable import used in this live proof may receive these known source settings. */
export const NATIVE_PROOF_SETTINGS = Object.freeze({
  sessionId: 'local_b554be08-8a81-4711-b772-2d8b290b3844',
  cliSessionId: 'b554be08-8a81-4711-b772-2d8b290b3844',
  model: 'claude-opus-5',
  effort: 'xhigh',
  permissionMode: 'bypassPermissions',
  chromePermissionMode: 'skip_all_permission_checks',
  cwd: 'D:\\NEWProjects\\shared\\Connections',
})

export interface NativeSettingsRequest {
  pid: number
  profileDir: string
  accountId: string
  orgId: string
  sessionId: string
  cliSessionId: string
  expectedTitle?: string
}

async function settingsRuntime(
  request: NativeSettingsRequest,
  pin: typeof NATIVE_PROGRAM_PIN,
  desired: typeof NATIVE_PROOF_SETTINGS,
) {
  let dispatch = 'not-sent'
  let before: any
  try {
    const fail = (why: string): never => {
      throw Error(`NATIVE_SETTINGS_REFUSAL: ${why}`)
    }
    if (request.sessionId !== desired.sessionId || request.cliSessionId !== desired.cliSessionId)
      fail('not the disposable proof import')
    const proc = (globalThis as any).process
    const main = proc?.mainModule
    if (typeof main?.require !== 'function') fail('CJS main module unavailable')
    const rootRequire = main.require.bind(main)
    const { app } = rootRequire('electron')
    const path = rootRequire('node:path')
    const require = rootRequire('node:module').createRequire(
      path.join(app.getAppPath(), 'package.json'),
    )
    const key = (value: string) => {
      const resolved = path.resolve(value).replace(/[\\/]+$/, '')
      return proc.platform === 'win32' ? resolved.toLowerCase() : resolved
    }
    // Bundle chunks are content-hashed, so a pinned file name and hash broke on every Claude
    // release. Both modules are found among THIS app's already-loaded ones instead, and an
    // ambiguous match fails closed. Reading an export never initializes a module.
    const appPath = key(app.getAppPath())
    const members = () =>
      Object.keys(require.cache)
        .filter((name: string) => key(name).startsWith(appPath) && require.cache[name]?.loaded)
        .map((name: string) => ({ filename: name, module: require.cache[name] }))
    const sole = (matches: any[], what: string) => {
      const distinct = matches.filter(
        (match: any, at: number) =>
          matches.findIndex((other: any) => other.value === match.value) === at,
      )
      if (distinct.length !== 1) fail(`expected exactly one ${what}, found ${distinct.length}`)
      return distinct[0]
    }
    const read = (module: any, name: string) => {
      try {
        return module?.exports?.[name]
      } catch {
        return undefined
      }
    }
    const cachedManager = sole(
      members()
        .map((member: any) => ({ ...member, value: read(member.module, pin.managerExport) }))
        .filter((member: any) => member.value),
      'native session manager',
    )
    // The bypass-permissions predicate has no distinguishing shape, so this POC still leans on
    // its minified export name. That is a diagnostic harness limit, not the production path.
    const cachedMain = sole(
      members()
        .map((member: any) => ({ ...member, value: read(member.module, pin.bypassExportHint) }))
        .filter((member: any) => typeof member.value === 'function' && member.value.length === 0),
      'native bypass-permissions predicate',
    )
    const manager = cachedManager.value
    const native = cachedMain.module.exports
    const guardIdentity = () => {
      if (
        proc.pid !== request.pid ||
        !app.isReady() ||
        key(app.getPath('userData')) !== key(request.profileDir) ||
        key(manager.userDataPath) !== key(request.profileDir) ||
        manager.currentAccountId !== request.accountId ||
        manager.currentOrgId !== request.orgId
      )
        fail('process/profile/account identity changed')
      if (
        require.cache[cachedManager.filename] !== cachedManager.module ||
        require.cache[cachedMain.filename] !== cachedMain.module ||
        read(cachedManager.module, pin.managerExport) !== manager ||
        cachedMain.module.exports !== native
      )
        fail('native singleton changed')
    }
    await manager.waitForInitialization()
    guardIdentity()
    const select = () => {
      guardIdentity()
      const s = manager.sessions.get(request.sessionId)
      if (
        !s ||
        s.sessionId !== request.sessionId ||
        s.cliSessionId !== request.cliSessionId ||
        (request.expectedTitle !== undefined && s.title !== request.expectedTitle)
      )
        fail('exact session identity/title changed')
      return s
    }
    const snapshot = (s: any) =>
      JSON.parse(
        JSON.stringify({
          sessionId: s.sessionId,
          cliSessionId: s.cliSessionId,
          title: s.title ?? null,
          model: s.model ?? null,
          effort: s.effort ?? null,
          permissionMode: s.permissionMode ?? null,
          chromePermissionMode: s.chromePermissionMode ?? null,
          sessionSettings: s.sessionSettings ?? null,
          alwaysAllowedReasons: Array.from(s.alwaysAllowedReasons ?? []),
          sessionPermissionUpdates: s.sessionPermissionUpdates ?? [],
          cwd: s.cwd,
          isArchived: s.isArchived === true,
          isRunning: s.isRunning === true,
          hasQuery: s.query != null,
        }),
      )
    const guardIdle = (s: any) => {
      if (
        s.isArchived ||
        s.isRunning ||
        s.isStopping ||
        s.query != null ||
        s.startResumeInFlight ||
        s.backend?.kind !== 'local' ||
        s.backend?.remoteTarget ||
        s.rootDetected ||
        s.remoteControlSpawn ||
        manager.startingSessionIds.has(s.sessionId) ||
        manager.hasLosableWork(s.sessionId) ||
        manager.hasPendingUserInput(s) ||
        manager.permissionBroker.hasPendingFor(s.sessionId) ||
        manager.userDialogBroker.hasPendingFor(s.sessionId) ||
        manager.sideQuery.sideChats.has(s.sessionId) ||
        manager.getChildSessions(s.sessionId).length ||
        (manager.sideSessionStartsInFlight.get(s.sessionId) ?? 0) > 0
      )
        fail('session is not an isolated idle local import')
    }
    const guardSettings = (s: any) => {
      if (
        s.model !== desired.model ||
        key(s.cwd) !== key(desired.cwd) ||
        s.sessionSettings != null ||
        (s.alwaysAllowedReasons?.size ?? 0) !== 0 ||
        (s.sessionPermissionUpdates?.length ?? 0) !== 0
      )
        fail('model/cwd/settings/grants differ from the known source')
      if (typeof native.io !== 'function' || native.io() !== true)
        fail('target account does not offer bypass permissions')
      if (manager.offeredEffort(s.model, desired.effort) !== desired.effort)
        fail('target model would clamp the requested effort')
      if (s.permissionMode !== 'acceptEdits' && s.permissionMode !== desired.permissionMode)
        fail('unexpected initial permission mode')
      if (s.permissionMode === 'acceptEdits' && s.chromePermsBeforeUnsupervised != null)
        fail('existing Chrome mode restoration state would prevent the expected transition')
      if (
        s.permissionMode === desired.permissionMode &&
        s.chromePermissionMode !== desired.chromePermissionMode
      )
        fail('cannot restore Chrome mode through an unchanged permission transition')
    }
    const discovery = await manager.getCliSessionDiscovery()
    const writerRefusal = await discovery.liveOwnershipRefusal(request.cliSessionId)
    if (writerRefusal !== null)
      fail(`source or target engine is not confirmed stopped: ${writerRefusal}`)
    const s = select()
    guardIdle(s)
    guardSettings(s)
    before = snapshot(s)
    const bystanders = new Map(
      Array.from(
        manager.sessions.values(),
        (other: any) => [other.sessionId, JSON.stringify(snapshot(other))] as const,
      ),
    )
    if (s.effort !== desired.effort) {
      dispatch = 'sent'
      const applied = await manager.setEffort(s.sessionId, desired.effort)
      if (applied !== desired.effort) fail('native effort setter returned a different value')
    }
    if (select() !== s) fail('session changed during effort update')
    guardIdle(s)
    guardSettings(s)
    if (s.permissionMode !== desired.permissionMode) {
      dispatch = 'sent'
      // With no query this setter neither restarts nor sends to the engine. Its native
      // acceptEdits -> bypass transition also sets Chrome to skip_all_permission_checks.
      if ((await manager.setPermissionMode(s.sessionId, desired.permissionMode, 'picker')) !== true)
        fail('native permission setter refused')
    }
    if (select() !== s) fail('session changed during permission update')
    guardIdle(s)
    const after = snapshot(s)
    const bystanderChanges: string[] = []
    for (const [id, state] of bystanders) {
      if (id === s.sessionId) continue
      const current = manager.sessions.get(id)
      if (!current || JSON.stringify(snapshot(current)) !== state) bystanderChanges.push(id)
    }
    const changedFields = Object.keys(after).filter(
      (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
    )
    const verified =
      after.model === desired.model &&
      after.effort === desired.effort &&
      after.permissionMode === desired.permissionMode &&
      after.chromePermissionMode === desired.chromePermissionMode &&
      after.sessionSettings === null &&
      after.alwaysAllowedReasons.length === 0 &&
      after.sessionPermissionUpdates.length === 0 &&
      key(after.cwd) === key(desired.cwd) &&
      !after.isRunning &&
      !after.hasQuery &&
      bystanderChanges.length === 0 &&
      changedFields.every((field) =>
        ['effort', 'permissionMode', 'chromePermissionMode'].includes(field),
      )
    return {
      ok: verified,
      verified,
      dispatch,
      before,
      after,
      changedFields,
      bystanderChanges,
      reason: verified ? undefined : 'native settings preservation postconditions failed',
      sentPrompt: false,
      evidence: 'native manager settings readback; not screenshot proof',
    }
  } catch (error) {
    return {
      ok: false,
      verified: false,
      dispatch,
      before,
      reason: error instanceof Error ? error.message : String(error),
      sentPrompt: false,
    }
  }
}

export function nativeSettingsProgram(request: NativeSettingsRequest): string {
  if (
    !Number.isSafeInteger(request.pid) ||
    request.pid <= 0 ||
    !request.profileDir?.trim() ||
    !request.accountId ||
    !request.orgId
  )
    throw Error('Exact settings target identity required')
  if (
    request.sessionId !== NATIVE_PROOF_SETTINGS.sessionId ||
    request.cliSessionId !== NATIVE_PROOF_SETTINGS.cliSessionId
  )
    throw Error('Only the disposable proof import may receive these settings')
  return `(${settingsRuntime.toString()})(${JSON.stringify(request)},${JSON.stringify(NATIVE_PROGRAM_PIN)},${JSON.stringify(NATIVE_PROOF_SETTINGS)})`
}
