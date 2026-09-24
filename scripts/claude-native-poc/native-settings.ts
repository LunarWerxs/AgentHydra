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

function settingsRefusal(why: string): never {
  throw Error(`NATIVE_SETTINGS_REFUSAL: ${why}`)
}

function settingsKey(proc: any, path: any, value: string) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '')
  return proc.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function settingsRootRequire() {
  const proc = (globalThis as any).process
  const main = proc?.mainModule
  if (typeof main?.require !== 'function') settingsRefusal('CJS main module unavailable')
  const rootRequire = main.require.bind(main)
  const { app } = rootRequire('electron')
  const path = rootRequire('node:path')
  const require = rootRequire('node:module').createRequire(
    path.join(app.getAppPath(), 'package.json'),
  )
  return { proc, app, path, require }
}

function settingsWithinApp(ctx: any, name: string) {
  const at = ctx.key(name)
  return Boolean(
    (at === ctx.appPath || at.startsWith(ctx.appPath + ctx.path.sep)) &&
      ctx.require.cache[name]?.loaded,
  )
}

function settingsListModules(ctx: any) {
  return Object.keys(ctx.require.cache)
    .filter((name: string) => settingsWithinApp(ctx, name))
    .map((name: string) => ({ filename: name, module: ctx.require.cache[name] }))
}

function settingsReadExport(module: any, name: string) {
  try {
    return module?.exports?.[name]
  } catch {
    return undefined
  }
}

function settingsSole(matches: any[], what: string) {
  const distinct = matches.filter(
    (match: any, at: number) =>
      matches.findIndex((other: any) => other.value === match.value) === at,
  )
  if (distinct.length !== 1)
    settingsRefusal(`expected exactly one ${what}, found ${distinct.length}`)
  return distinct[0]
}

// Bundle chunks are content-hashed, so a pinned file name and hash broke on every Claude
// release. Both modules are found among THIS app's already-loaded ones instead, and an
// ambiguous match fails closed. Reading an export never initializes a module.
function settingsResolveNative(ctx: any) {
  const cachedManager = settingsSole(
    settingsListModules(ctx)
      .map((member: any) => ({
        ...member,
        value: settingsReadExport(member.module, ctx.pin.managerExport),
      }))
      .filter((member: any) => member.value),
    'native session manager',
  )
  // The bypass-permissions predicate has no distinguishing shape, so this POC still leans on
  // its minified export name. That is a diagnostic harness limit, not the production path.
  const cachedMain = settingsSole(
    settingsListModules(ctx)
      .map((member: any) => ({
        ...member,
        value: settingsReadExport(member.module, ctx.pin.bypassExportHint),
      }))
      .filter((member: any) => typeof member.value === 'function' && member.value.length === 0),
    'native bypass-permissions predicate',
  )
  return {
    cachedManager,
    cachedMain,
    manager: cachedManager.value,
    native: cachedMain.module.exports,
  }
}

function settingsContext(request: any, pin: any, desired: any) {
  const { proc, app, path, require } = settingsRootRequire()
  const key = (value: string) => settingsKey(proc, path, value)
  const ctx: any = { request, pin, desired, proc, app, path, require, key }
  ctx.appPath = key(app.getAppPath())
  Object.assign(ctx, settingsResolveNative(ctx))
  return ctx
}

function guardNativeIdentity(ctx: any) {
  const { proc, app, require, manager, request } = ctx
  if (
    proc.pid !== request.pid ||
    !app.isReady() ||
    ctx.key(app.getPath('userData')) !== ctx.key(request.profileDir) ||
    ctx.key(manager.userDataPath) !== ctx.key(request.profileDir) ||
    manager.currentAccountId !== request.accountId ||
    manager.currentOrgId !== request.orgId
  )
    settingsRefusal('process/profile/account identity changed')
  if (
    require.cache[ctx.cachedManager.filename] !== ctx.cachedManager.module ||
    require.cache[ctx.cachedMain.filename] !== ctx.cachedMain.module ||
    settingsReadExport(ctx.cachedManager.module, ctx.pin.managerExport) !== manager ||
    ctx.cachedMain.module.exports !== ctx.native
  )
    settingsRefusal('native singleton changed')
}

function selectProofSession(ctx: any) {
  guardNativeIdentity(ctx)
  const s = ctx.manager.sessions.get(ctx.request.sessionId)
  if (
    !s ||
    s.sessionId !== ctx.request.sessionId ||
    s.cliSessionId !== ctx.request.cliSessionId ||
    (ctx.request.expectedTitle !== undefined && s.title !== ctx.request.expectedTitle)
  )
    settingsRefusal('exact session identity/title changed')
  return s
}

function snapshotSession(s: any) {
  return JSON.parse(
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
}

function guardSessionIdle(ctx: any, s: any) {
  const manager = ctx.manager
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
    settingsRefusal('session is not an isolated idle local import')
}

function guardSourceSettings(ctx: any, s: any) {
  const { desired, native, manager } = ctx
  if (
    s.model !== desired.model ||
    ctx.key(s.cwd) !== ctx.key(desired.cwd) ||
    s.sessionSettings != null ||
    (s.alwaysAllowedReasons?.size ?? 0) !== 0 ||
    (s.sessionPermissionUpdates?.length ?? 0) !== 0
  )
    settingsRefusal('model/cwd/settings/grants differ from the known source')
  if (typeof native.io !== 'function' || native.io() !== true)
    settingsRefusal('target account does not offer bypass permissions')
  if (manager.offeredEffort(s.model, desired.effort) !== desired.effort)
    settingsRefusal('target model would clamp the requested effort')
  if (s.permissionMode !== 'acceptEdits' && s.permissionMode !== desired.permissionMode)
    settingsRefusal('unexpected initial permission mode')
  if (s.permissionMode === 'acceptEdits' && s.chromePermsBeforeUnsupervised != null)
    settingsRefusal('existing Chrome mode restoration state would prevent the expected transition')
  if (
    s.permissionMode === desired.permissionMode &&
    s.chromePermissionMode !== desired.chromePermissionMode
  )
    settingsRefusal('cannot restore Chrome mode through an unchanged permission transition')
}

async function applyProofSettings(ctx: any, s: any, state: any) {
  const { manager, desired } = ctx
  if (s.effort !== desired.effort) {
    state.dispatch = 'sent'
    const applied = await manager.setEffort(s.sessionId, desired.effort)
    if (applied !== desired.effort)
      settingsRefusal('native effort setter returned a different value')
  }
  if (selectProofSession(ctx) !== s) settingsRefusal('session changed during effort update')
  guardSessionIdle(ctx, s)
  guardSourceSettings(ctx, s)
  if (s.permissionMode !== desired.permissionMode) {
    state.dispatch = 'sent'
    // With no query this setter neither restarts nor sends to the engine. Its native
    // acceptEdits -> bypass transition also sets Chrome to skip_all_permission_checks.
    if ((await manager.setPermissionMode(s.sessionId, desired.permissionMode, 'picker')) !== true)
      settingsRefusal('native permission setter refused')
  }
  if (selectProofSession(ctx) !== s) settingsRefusal('session changed during permission update')
  guardSessionIdle(ctx, s)
}

function settingsBystanders(ctx: any) {
  return new Map(
    Array.from(
      ctx.manager.sessions.values(),
      (other: any) => [other.sessionId, JSON.stringify(snapshotSession(other))] as const,
    ),
  )
}

function settingsBystanderChanges(ctx: any, s: any, bystanders: Map<string, string>) {
  const bystanderChanges: string[] = []
  for (const [id, state] of bystanders) {
    if (id === s.sessionId) continue
    const current = ctx.manager.sessions.get(id)
    if (!current || JSON.stringify(snapshotSession(current)) !== state) bystanderChanges.push(id)
  }
  return bystanderChanges
}

function settingsChangedFields(before: any, after: any) {
  return Object.keys(after).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  )
}

function settingsVerified(ctx: any, before: any, after: any, bystanderChanges: string[]) {
  const desired = ctx.desired
  return (
    after.model === desired.model &&
    after.effort === desired.effort &&
    after.permissionMode === desired.permissionMode &&
    after.chromePermissionMode === desired.chromePermissionMode &&
    after.sessionSettings === null &&
    after.alwaysAllowedReasons.length === 0 &&
    after.sessionPermissionUpdates.length === 0 &&
    ctx.key(after.cwd) === ctx.key(desired.cwd) &&
    !after.isRunning &&
    !after.hasQuery &&
    bystanderChanges.length === 0 &&
    settingsChangedFields(before, after).every((field) =>
      ['effort', 'permissionMode', 'chromePermissionMode'].includes(field),
    )
  )
}

async function settingsPoc(request: any, pin: any, desired: any, state: any) {
  if (request.sessionId !== desired.sessionId || request.cliSessionId !== desired.cliSessionId)
    settingsRefusal('not the disposable proof import')
  const ctx = settingsContext(request, pin, desired)
  await ctx.manager.waitForInitialization()
  guardNativeIdentity(ctx)
  const discovery = await ctx.manager.getCliSessionDiscovery()
  const writerRefusal = await discovery.liveOwnershipRefusal(request.cliSessionId)
  if (writerRefusal !== null)
    settingsRefusal(`source or target engine is not confirmed stopped: ${writerRefusal}`)
  const s = selectProofSession(ctx)
  guardSessionIdle(ctx, s)
  guardSourceSettings(ctx, s)
  state.before = snapshotSession(s)
  const bystanders = settingsBystanders(ctx)
  await applyProofSettings(ctx, s, state)
  const after = snapshotSession(s)
  const bystanderChanges = settingsBystanderChanges(ctx, s, bystanders)
  const before = state.before
  const changedFields = settingsChangedFields(before, after)
  const verified = settingsVerified(ctx, before, after, bystanderChanges)
  return {
    ok: verified,
    verified,
    dispatch: state.dispatch,
    before,
    after,
    changedFields,
    bystanderChanges,
    reason: verified ? undefined : 'native settings preservation postconditions failed',
    sentPrompt: false,
    evidence: 'native manager settings readback; not screenshot proof',
  }
}

async function settingsRuntime(
  request: NativeSettingsRequest,
  pin: typeof NATIVE_PROGRAM_PIN,
  desired: typeof NATIVE_PROOF_SETTINGS,
) {
  const state = { dispatch: 'not-sent', before: undefined as any }
  try {
    return await settingsPoc(request, pin, desired, state)
  } catch (error) {
    return {
      ok: false,
      verified: false,
      dispatch: state.dispatch,
      before: state.before,
      reason: error instanceof Error ? error.message : String(error),
      sentPrompt: false,
    }
  }
}

/** Every module-level function the generated program calls, in source order. */
const SETTINGS_RUNTIME_PARTS = [
  settingsRefusal,
  settingsKey,
  settingsRootRequire,
  settingsWithinApp,
  settingsListModules,
  settingsReadExport,
  settingsSole,
  settingsResolveNative,
  settingsContext,
  guardNativeIdentity,
  selectProofSession,
  snapshotSession,
  guardSessionIdle,
  guardSourceSettings,
  applyProofSettings,
  settingsBystanders,
  settingsBystanderChanges,
  settingsChangedFields,
  settingsVerified,
  settingsPoc,
  settingsRuntime,
]

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
  const runtime = SETTINGS_RUNTIME_PARTS.map((part) => part.toString()).join('\n')
  return `(function(){${runtime}\nreturn settingsRuntime(${JSON.stringify(request)},${JSON.stringify(NATIVE_PROGRAM_PIN)},${JSON.stringify(NATIVE_PROOF_SETTINGS)})})()`
}
