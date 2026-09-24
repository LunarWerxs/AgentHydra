import { describe, expect, test } from 'bun:test'
import { win32 as path } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  NATIVE_PROOF_SETTINGS,
  type NativeSettingsRequest,
  nativeSettingsProgram,
} from './native-settings'

// This inert fixture tests the generated wrapper's guards, not Claude's native implementations.
// Hashes stand in for reviewed sources; no installed app, process connection, or bundle import.
function harness() {
  const profileDir = 'D:\\profiles\\target'
  const appPath = 'D:\\Claude\\app.asar'
  // Content-hashed bundle names: both modules must be found by what they export.
  const managerPath = path.join(appPath, '.vite/build/index.chunk-AAA.js')
  const mainPath = path.join(appPath, '.vite/build/index.chunk-BBB.js')
  const target: any = {
    ...NATIVE_PROOF_SETTINGS,
    title: 'Disposable migration proof',
    effort: undefined,
    permissionMode: 'acceptEdits',
    chromePermissionMode: undefined,
    sessionSettings: null,
    alwaysAllowedReasons: new Set(),
    sessionPermissionUpdates: [],
    backend: { kind: 'local' },
    isArchived: false,
    isRunning: false,
    query: null,
  }
  const other: any = {
    ...target,
    sessionId: 'local_bystander',
    cliSessionId: 'cli-bystander',
    title: 'Unrelated chat',
    alwaysAllowedReasons: new Set(),
    sessionPermissionUpdates: [],
  }
  const sessions = new Map([
    [target.sessionId, target],
    [other.sessionId, other],
  ])
  const calls: any[] = []
  const requireBases: string[] = []
  const discovery = { liveOwnershipRefusal: async (_id: string): Promise<string | null> => null }
  const manager: any = {
    sessions,
    userDataPath: profileDir,
    currentAccountId: 'account',
    currentOrgId: 'org',
    startingSessionIds: new Set(),
    sideSessionStartsInFlight: new Map(),
    permissionBroker: { hasPendingFor: () => false },
    userDialogBroker: { hasPendingFor: () => false },
    sideQuery: { sideChats: new Map() },
    waitForInitialization: async () => {},
    hasLosableWork: () => false,
    hasPendingUserInput: () => false,
    getChildSessions: () => [],
    offeredEffort: (_model: string, effort: string) => effort,
    getCliSessionDiscovery: async () => discovery,
    setEffort: async (id: string, effort: string) => {
      calls.push({ method: 'effort', id, effort })
      sessions.get(id)!.effort = effort
      return effort
    },
    setPermissionMode: async (id: string, mode: string, origin: string) => {
      calls.push({ method: 'permission', id, mode, origin })
      const session = sessions.get(id)!
      session.permissionMode = mode
      session.chromePermissionMode = NATIVE_PROOF_SETTINGS.chromePermissionMode
      return true
    },
  }
  const native: any = { io: () => true }
  const cache: any = {
    [managerPath]: { loaded: true, exports: { claudeCodeSessionManager: manager } },
    [mainPath]: { loaded: true, exports: native },
  }
  const require: any = (name: string) => {
    if (name === 'electron')
      return {
        app: {
          isReady: () => true,
          getVersion: () => '2.9999.0',
          getPath: () => profileDir,
          getAppPath: () => appPath,
        },
      }
    if (name === 'node:path') return path
    if (name === 'node:module')
      return {
        createRequire: (filename: string) => {
          requireBases.push(filename)
          return require
        },
      }
    throw Error(`Unexpected require; fixture must never import a bundle: ${name}`)
  }
  require.resolve = (name: string) => name
  require.cache = cache
  const process = {
    pid: 400,
    platform: 'win32',
    mainModule: { filename: 'electron', require },
  }
  const request: NativeSettingsRequest = {
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
    target,
    other,
    manager,
    native,
    discovery,
    calls,
    requireBases,
    cache,
    managerPath,
    mainPath,
    request,
    run: (patch: Partial<NativeSettingsRequest> = {}) =>
      runInNewContext(nativeSettingsProgram({ ...request, ...patch }), { process }),
  }
}

describe('native settings proof wrapper (inert runtime, no connection)', () => {
  test('applies effort then permission/Chrome while preserving source settings and bystanders', async () => {
    const h = harness()
    const result = await h.run()
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      dispatch: 'sent',
      sentPrompt: false,
      bystanderChanges: [],
      changedFields: ['effort', 'permissionMode', 'chromePermissionMode'],
      after: { ...NATIVE_PROOF_SETTINGS, sessionSettings: null, hasQuery: false, isRunning: false },
    })
    expect(h.calls).toEqual([
      { method: 'effort', id: h.target.sessionId, effort: 'xhigh' },
      { method: 'permission', id: h.target.sessionId, mode: 'bypassPermissions', origin: 'picker' },
    ])
    expect(h.requireBases).toEqual(['D:\\Claude\\app.asar\\package.json'])
    expect(h.target.query).toBeNull()
    expect(h.other.permissionMode).toBe('acceptEdits')
    expect(h.other.effort).toBeUndefined()
  })
  test('already matching settings return verified without dispatch', async () => {
    const h = harness()
    Object.assign(h.target, NATIVE_PROOF_SETTINGS)
    expect(await h.run()).toMatchObject({ ok: true, dispatch: 'not-sent', changedFields: [] })
    expect(h.calls).toEqual([])
  })
  test('policy clamps, unavailable bypass, root and side-chat refuse before either mutation', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        h.manager.offeredEffort = () => 'high'
      },
      (h: ReturnType<typeof harness>) => {
        h.native.io = () => false
      },
      (h: ReturnType<typeof harness>) => {
        h.target.rootDetected = true
      },
      (h: ReturnType<typeof harness>) => {
        h.target.remoteControlSpawn = {}
      },
      (h: ReturnType<typeof harness>) => {
        h.manager.sideQuery.sideChats.set(h.target.sessionId, {})
      },
      (h: ReturnType<typeof harness>) => {
        h.manager.getChildSessions = () => [h.other]
      },
      (h: ReturnType<typeof harness>) => {
        h.manager.hasPendingUserInput = () => true
      },
      (h: ReturnType<typeof harness>) => {
        h.target.query = {}
      },
    ]) {
      const h = harness()
      change(h)
      expect(await h.run()).toMatchObject({
        ok: false,
        verified: false,
        dispatch: 'not-sent',
        sentPrompt: false,
      })
      expect(h.calls).toEqual([])
    }
  })
  test('unknown source settings and unusable Chrome transition refuse before mutation', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        h.target.model = 'different-model'
      },
      (h: ReturnType<typeof harness>) => {
        h.target.cwd = 'D:\\elsewhere'
      },
      (h: ReturnType<typeof harness>) => {
        h.target.sessionSettings = { ultracode: true }
      },
      (h: ReturnType<typeof harness>) => {
        h.target.alwaysAllowedReasons.add('existing-grant')
      },
      (h: ReturnType<typeof harness>) => {
        h.target.sessionPermissionUpdates.push({ type: 'existing-grant' })
      },
      (h: ReturnType<typeof harness>) => {
        h.target.chromePermsBeforeUnsupervised = {}
      },
      (h: ReturnType<typeof harness>) => {
        h.target.permissionMode = 'bypassPermissions'
      },
    ]) {
      const h = harness()
      change(h)
      expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(h.calls).toEqual([])
    }
  })
  test('unloaded, ambiguous or wrong-identity sources refuse before mutation', async () => {
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
      // A second in-app module exporting another manager leaves the choice ambiguous.
      (h: ReturnType<typeof harness>) => {
        h.cache[path.join(h.appPath, 'rival.js')] = {
          loaded: true,
          exports: { claudeCodeSessionManager: { sessions: new Map() } },
        }
      },
      (h: ReturnType<typeof harness>) => {
        h.cache[path.join(h.appPath, 'rival.js')] = { loaded: true, exports: { io: () => false } }
      },
      (h: ReturnType<typeof harness>) => {
        h.manager.currentAccountId = 'different'
      },
      (h: ReturnType<typeof harness>) => {
        h.target.cliSessionId = 'rotated-cli'
      },
    ]) {
      const h = harness()
      change(h)
      expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(h.calls).toEqual([])
    }
  })
  test('a live or indeterminate transcript owner prevents settings dispatch', async () => {
    for (const refusal of ['running', 'indeterminate']) {
      const h = harness()
      h.discovery.liveOwnershipRefusal = async (id) => {
        expect(id).toBe(NATIVE_PROOF_SETTINGS.cliSessionId)
        return refusal
      }
      expect(await h.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(h.calls).toEqual([])
    }
  })
  test('query or account changes after effort report sent failure and never set permission', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        h.target.query = {}
      },
      (h: ReturnType<typeof harness>) => {
        h.manager.currentAccountId = 'changed-account'
      },
      (h: ReturnType<typeof harness>) => {
        h.native.io = () => false
      },
    ]) {
      const h = harness()
      const original = h.manager.setEffort
      h.manager.setEffort = async (id: string, effort: string) => {
        const result = await original(id, effort)
        change(h)
        return result
      }
      expect(await h.run()).toMatchObject({
        ok: false,
        verified: false,
        dispatch: 'sent',
        sentPrompt: false,
      })
      expect(h.calls.map((call) => call.method)).toEqual(['effort'])
      expect(h.target.permissionMode).toBe('acceptEdits')
    }
  })
  test('permission refusal after applied effort retains sent failure', async () => {
    const h = harness()
    h.manager.setPermissionMode = async () => {
      h.calls.push({ method: 'permission-refused' })
      return false
    }
    const result = await h.run()
    expect(result).toMatchObject({
      ok: false,
      verified: false,
      dispatch: 'sent',
      sentPrompt: false,
    })
    expect(result.reason).toContain('native permission setter refused')
    expect(h.target.effort).toBe('xhigh')
    expect(h.target.permissionMode).toBe('acceptEdits')
    expect(h.calls.map((call) => call.method)).toEqual(['effort', 'permission-refused'])
  })
  test('postconditions detect another record changing or a missing Chrome update', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        h.other.title = 'Unexpectedly changed'
      },
      (h: ReturnType<typeof harness>) => {
        h.target.chromePermissionMode = undefined
      },
    ]) {
      const h = harness()
      const original = h.manager.setPermissionMode
      h.manager.setPermissionMode = async (...args: any[]) => {
        const result = await original(...args)
        change(h)
        return result
      }
      expect(await h.run()).toMatchObject({
        ok: false,
        verified: false,
        dispatch: 'sent',
        reason: 'native settings preservation postconditions failed',
      })
    }
  })
  test('only exact disposable IDs can generate a program and title cannot inject code', async () => {
    const h = harness()
    for (const patch of [{ sessionId: 'local_other' }, { cliSessionId: 'other-cli' }]) {
      expect(() => nativeSettingsProgram({ ...h.request, ...patch })).toThrow('Only the disposable')
    }
    expect(() => nativeSettingsProgram({ ...h.request, pid: 0 })).toThrow('Exact settings target')
    expect(await h.run({ expectedTitle: '");globalThis.injected=true;//' })).toMatchObject({
      ok: false,
      dispatch: 'not-sent',
    })
    expect(h.calls).toEqual([])
  })
})
