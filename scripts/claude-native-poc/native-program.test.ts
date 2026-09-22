import { describe, expect, test } from 'bun:test'
import { win32 as path } from 'node:path'
import { runInNewContext } from 'node:vm'
import { type NativeRequest, nativeProgram } from './native-program'

// Tests the generated program's own guards in an inert runtime. Actual installed archive
// behavior is separately tested by native-archive.poc.ts; this suite needs no installed app.
function harness() {
  const profileDir = 'D:\\profiles\\target'
  // Content-hashed bundle names: the program must find these by export, not by file name.
  const appPath = 'D:\\Claude\\app.asar'
  const managerPath = path.join(appPath, '.vite', 'build', 'index.chunk-AAA.js')
  const mainPath = path.join(appPath, '.vite', 'build', 'index.chunk-BBB.js')
  const strayPath = path.join('D:\\elsewhere', 'index.chunk-CCC.js')
  const target: any = {
    sessionId: 'local_target',
    cliSessionId: 'cli-target',
    title: 'Same title',
    isArchived: false,
    isRunning: false,
    query: null,
    backend: { kind: 'local' },
    cwd: 'D:\\work\\target',
    model: 'claude-opus-5',
    effort: 'max',
    permissionMode: 'acceptEdits',
    sessionSettings: { ultracode: true },
    alwaysAllowedReasons: new Set(['fixture']),
    sessionPermissionUpdates: [],
  }
  const other: any = {
    ...target,
    sessionId: 'local_other',
    cliSessionId: 'cli-other',
    cwd: 'D:\\work\\other',
    sessionSettings: { ultracode: true },
  }
  const sessions = new Map([
    [target.sessionId, target],
    [other.sessionId, other],
  ])
  const calls: any[] = []
  const requireBases: string[] = []
  const manager: any = {
    sessions,
    currentAccountId: 'account',
    currentOrgId: 'org',
    userDataPath: profileDir,
    startingSessionIds: new Set(),
    parked: new Set(),
    movesInFlight: new Map(),
    deletingSessionIds: new Map(),
    sideSessionStartsInFlight: new Map(),
    permissionBroker: { hasPendingFor: () => false },
    userDialogBroker: { hasPendingFor: () => false },
    waitForInitialization: async () => {},
    ensureArchivedSessionsLoaded: async () => {},
    getSessionList: async () => ({ sessions: [], loadGeneration: 7 }),
    archiveCascadeClosureOf: () => [],
    losableWorkKind: () => undefined,
    hasPendingUserInput: () => false,
    localLineageIds: (s: any) => [s.cliSessionId],
    archiveSession: async (id: string, options: any) => {
      calls.push({ id, options })
      sessions.get(id)!.isArchived = true
    },
  }
  let version = '2.9999.0'
  let hash = 'manager-source-hash'
  let mainHash = 'main-source-hash'
  const previews: any = {
    getServersForWorktree: () => [],
    stopServersForWorktree: () => {},
    htmlPreviews: new Map(),
  }
  const cache: any = {
    [managerPath]: { loaded: true, exports: { claudeCodeSessionManager: manager } },
    [mainPath]: { loaded: true, exports: { Ac: previews } },
    // Another application's module, and an unfinished one, are both out of scope for discovery.
    [strayPath]: { loaded: true, exports: { claudeCodeSessionManager: {}, Ac: previews } },
  }
  const require: any = (name: string) => {
    if (name === 'node:module')
      return {
        createRequire: (filename: string) => {
          requireBases.push(filename)
          return require
        },
      }
    if (name === 'electron')
      return {
        app: {
          isReady: () => true,
          getVersion: () => version,
          getPath: () => profileDir,
          getAppPath: () => 'D:\\Claude\\app.asar',
        },
      }
    if (name === 'node:path') return path
    if (name === 'node:fs') return { readFileSync: (filename: string) => filename }
    if (name === 'node:crypto')
      return {
        createHash: () => ({
          update: (filename: string) => ({
            digest: () => (filename === mainPath ? mainHash : hash),
          }),
        }),
      }
    throw Error(`Unexpected require; fixture must never load a manager: ${name}`)
  }
  require.resolve = (name: string) => name
  require.cache = cache
  const process = {
    pid: 400,
    platform: 'win32',
    mainModule: { filename: 'electron', require },
  }
  const request: NativeRequest = {
    action: 'archive',
    pid: 400,
    profileDir,
    accountId: 'account',
    orgId: 'org',
    sessionId: target.sessionId,
    cliSessionId: target.cliSessionId,
    expectedTitle: target.title,
  }
  return {
    appPath,
    manager,
    target,
    other,
    calls,
    requireBases,
    cache,
    managerPath,
    mainPath,
    strayPath,
    previews,
    request,
    version: (v: string) => {
      version = v
    },
    hash: (h: string) => {
      hash = h
    },
    mainHash: (h: string) => {
      mainHash = h
    },
    run: (patch: Partial<NativeRequest> = {}) =>
      runInNewContext(nativeProgram({ ...request, ...patch }), { process }),
  }
}

describe('native inspector program guards (inert runtime, no connection)', () => {
  test('inspection loads archived records and rechecks account identity afterward', async () => {
    const h = harness()
    h.manager.sessions.delete(h.target.sessionId)
    h.manager.ensureArchivedSessionsLoaded = async (reason: string) => {
      expect(reason).toBe('ownership')
      h.target.isArchived = true
      h.manager.sessions.set(h.target.sessionId, h.target)
    }
    const inspected = await h.run({ action: 'inspect', sessionId: undefined })
    expect(
      inspected.sessions.find((session: any) => session.sessionId === h.target.sessionId)
        .isArchived,
    ).toBe(true)
    expect(await h.run()).toMatchObject({ ok: true, changed: false, dispatch: 'not-sent' })
    expect(h.calls).toEqual([])
    h.manager.ensureArchivedSessionsLoaded = async () => {
      h.manager.currentAccountId = 'changed'
    }
    expect(await h.run({ action: 'inspect' })).toMatchObject({ ok: false, dispatch: 'not-sent' })
  })
  test('inspection uses loaded singleton and returns native evidence without a mutation', async () => {
    const h = harness()
    delete h.cache[h.mainPath]
    const result = await h.run({ action: 'inspect', sessionId: undefined })
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      dispatch: 'not-sent',
      loadGeneration: 7,
    })
    expect(result.sessions).toHaveLength(2)
    expect(result.evidence).toContain('not screenshot proof')
    expect(h.calls).toEqual([])
    expect(h.requireBases).toEqual(['D:\\Claude\\app.asar\\package.json'])
  })
  test('wrong process, profile, account, organization and CLI ID refuse without archive', async () => {
    for (const patch of [
      { pid: 401 },
      { profileDir: 'D:\\wrong' },
      { accountId: 'wrong' },
      { orgId: 'wrong' },
      { cliSessionId: 'rotated-cli' },
      { sessionId: 'Same title' },
    ]) {
      const h = harness()
      expect(await h.run(patch)).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(h.calls).toEqual([])
    }
  })
  test('unloaded, missing and ambiguous singletons fail closed, never importing another', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        delete h.cache[h.managerPath]
      },
      (h: ReturnType<typeof harness>) => {
        delete h.cache[h.mainPath]
      },
      (h: ReturnType<typeof harness>) => {
        h.cache[h.managerPath].loaded = false
      },
      (h: ReturnType<typeof harness>) => {
        h.cache[h.mainPath].loaded = false
      },
      // A second in-app module exporting a DIFFERENT manager is ambiguous, so nothing is chosen.
      (h: ReturnType<typeof harness>) => {
        h.cache[path.join(h.appPath, 'rival.js')] = {
          loaded: true,
          exports: { claudeCodeSessionManager: { sessions: new Map() } },
        }
      },
      (h: ReturnType<typeof harness>) => {
        h.cache[path.join(h.appPath, 'rival.js')] = {
          loaded: true,
          exports: { Ac: { ...h.previews, htmlPreviews: new Map() } },
        }
      },
    ]) {
      const h = harness()
      change(h)
      expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(h.calls).toEqual([])
    }
  })

  test('a new Claude version needs no code change, and its bundle members are reported', async () => {
    const h = harness()
    h.version('3.0.0-brand-new')
    const result: any = await h.run({ action: 'inspect', sessionId: undefined })
    expect(result).toMatchObject({ ok: true, verified: true })
    expect(result.identity).toMatchObject({
      version: '3.0.0-brand-new',
      managerMember: path.join('.vite', 'build', 'index.chunk-AAA.js'),
      managerSha256: 'manager-source-hash',
    })
  })

  test('the preview manager is found by shape even when its export is renamed', async () => {
    const h = harness()
    const renamed = { ...h.cache[h.mainPath].exports.Ac }
    h.cache[h.mainPath].exports = { Zz: renamed }
    const result: any = await h.run()
    expect(result).toMatchObject({ ok: true, verified: true, changed: true })
    expect(result.identity.mainMember).toBe(path.join('.vite', 'build', 'index.chunk-BBB.js'))
  })
  test('account switch and resumed turn during async list read are checked before mutation', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        h.manager.currentAccountId = 'new'
      },
      (h: ReturnType<typeof harness>) => {
        h.target.isRunning = true
      },
    ]) {
      const h = harness()
      h.manager.getSessionList = async () => {
        change(h)
        return { sessions: [], loadGeneration: 8 }
      }
      expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(h.calls).toEqual([])
    }
  })
  test('cascade, pending start/input and attached parent refuse conservatively', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        h.manager.archiveCascadeClosureOf = () => [h.other]
      },
      (h: ReturnType<typeof harness>) => {
        h.manager.startingSessionIds.add(h.target.sessionId)
      },
      (h: ReturnType<typeof harness>) => {
        h.manager.hasPendingUserInput = () => true
      },
      (h: ReturnType<typeof harness>) => {
        h.target.spawnedFrom = { sessionId: 'parent' }
      },
    ]) {
      const h = harness()
      change(h)
      expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(h.calls).toEqual([])
    }
  })
  test('shared cwd is allowed when native server and HTML preview registries are empty', async () => {
    const h = harness()
    h.other.cwd = h.target.cwd
    const result = await h.run()
    expect(result).toMatchObject({ ok: true, dispatch: 'sent', bystanderArchiveChanges: [] })
    expect(result.identity.mainSha256).toBe('main-source-hash')
    expect(h.calls).toEqual([{ id: 'local_target', options: { cleanupWorktree: false } }])
    expect(h.other.isArchived).toBe(false)
  })
  test('shared cwd refuses registry servers regardless of state or owner', async () => {
    const h = harness()
    h.other.cwd = h.target.cwd
    h.previews.getServersForWorktree = (cwd: string) => {
      expect(cwd).toBe(h.target.cwd)
      return [{ serverId: 'other-server', sessionId: h.other.sessionId, status: 'stopped' }]
    }
    expect(await h.run()).toMatchObject({
      ok: false,
      dispatch: 'not-sent',
      reason: 'NATIVE_REFUSAL: shared working directory has servers that archive would stop',
    })
    expect(h.calls).toEqual([])
  })
  test('shared cwd HTML guard preserves native prefix matching even without a separator', async () => {
    for (const suffix of ['', '\\nested', '-unrelated-sibling']) {
      const h = harness()
      h.other.cwd = h.target.cwd
      h.previews.htmlPreviews.set('html-preview-other', { cwd: h.target.cwd + suffix })
      expect(await h.run()).toMatchObject({
        ok: false,
        dispatch: 'not-sent',
        reason:
          'NATIVE_REFUSAL: shared working directory has HTML previews that archive would stop',
      })
      expect(h.calls).toEqual([])
    }
  })
  test('unrelated HTML previews do not block an otherwise empty shared cwd', async () => {
    const h = harness()
    h.other.cwd = h.target.cwd
    h.previews.htmlPreviews.set('html-preview-unrelated', { cwd: 'D:\\elsewhere' })
    expect(await h.run()).toMatchObject({ ok: true, dispatch: 'sent' })
    expect(h.calls).toHaveLength(1)
  })
  test('HTML prefix bystanders are protected even without another session sharing exact cwd', async () => {
    const h = harness()
    h.other.cwd = `${h.target.cwd}-unrelated-sibling`
    h.previews.htmlPreviews.set('html-preview-other', { cwd: h.other.cwd })
    expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
    expect(h.calls).toEqual([])
  })
  test('shared cwd aliases, missing managers and malformed resource state fail closed', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        h.other.cwd = h.target.cwd.toLowerCase()
      },
      (h: ReturnType<typeof harness>) => {
        delete h.cache[h.mainPath].exports.Ac
      },
      (h: ReturnType<typeof harness>) => {
        h.previews.getServersForWorktree = undefined
      },
      (h: ReturnType<typeof harness>) => {
        h.previews.getServersForWorktree = () => null
      },
      (h: ReturnType<typeof harness>) => {
        h.previews.htmlPreviews = []
      },
      (h: ReturnType<typeof harness>) => {
        h.previews.htmlPreviews.set('malformed', {})
      },
    ]) {
      const h = harness()
      h.other.cwd = h.target.cwd
      change(h)
      expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(h.calls).toEqual([])
    }
  })
  test('shared preview state is checked after the awaited native list refresh', async () => {
    const h = harness()
    h.other.cwd = h.target.cwd
    h.manager.getSessionList = async () => {
      h.previews.htmlPreviews.set('new-preview', { cwd: h.target.cwd })
      return { sessions: [], loadGeneration: 8 }
    }
    expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
    expect(h.calls).toEqual([])
  })
  test('archive targets native ID despite duplicate titles and disables worktree cleanup', async () => {
    const h = harness()
    expect(await h.run()).toMatchObject({
      ok: true,
      verified: true,
      dispatch: 'sent',
      changed: true,
      bystanderArchiveChanges: [],
      changedFields: [],
    })
    expect(h.calls).toEqual([{ id: 'local_target', options: { cleanupWorktree: false } }])
    expect(h.other.isArchived).toBe(false)
    expect(await h.run()).toMatchObject({ ok: true, dispatch: 'not-sent', changed: false })
    expect(h.calls).toHaveLength(1)
  })
  test('bystander archive and in-place settings changes produce failed postconditions', async () => {
    const h = harness()
    h.manager.archiveSession = async () => {
      h.target.isArchived = true
      h.other.isArchived = true
      h.target.sessionSettings.ultracode = false
    }
    const result = await h.run()
    expect(result).toMatchObject({ ok: false, verified: false, dispatch: 'sent', changed: true })
    expect(result.bystanderArchiveChanges).toEqual([
      { sessionId: 'local_other', before: false, after: true },
    ])
    expect(result.changedFields).toContain('sessionSettings')
  })
  test('errors after dispatch retain sent status rather than suggesting a safe retry', async () => {
    const h = harness()
    h.manager.archiveSession = async () => {
      h.target.isArchived = true
      throw Error('save response lost')
    }
    const result = await h.run()
    expect(result).toMatchObject({ ok: false, verified: false, dispatch: 'sent' })
    expect(result.reason).toContain('save response lost')
  })
  test('serialized identifiers cannot inject additional inspector code', async () => {
    const h = harness()
    const value = 'local_target");globalThis.injected=true;//'
    expect(await h.run({ sessionId: value })).toMatchObject({ ok: false, dispatch: 'not-sent' })
    expect(h.calls).toEqual([])
    expect(() => nativeProgram({ ...h.request, action: 'delete' as any })).toThrow('Unsupported')
  })
})
