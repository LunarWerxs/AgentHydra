import { describe, expect, test } from 'bun:test'
import { win32 as path } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  DISPOSABLE_IMPORT_IDS,
  type NativeImportRequest,
  nativeImportProgram,
} from './native-import'
import { NATIVE_PROGRAM_PIN } from './native-program'

// Inert runtime tests the safety wrapper, not Claude's importer implementation or live UI.
function fixture() {
  const request: NativeImportRequest = {
    pid: 321,
    profileDir: 'D:\\profiles\\proof',
    accountId: 'account',
    orgId: 'org',
    cliSessionId: DISPOSABLE_IMPORT_IDS[0],
    title: 'Fallback proof title',
  }
  const filename = path.join('D:\\Claude\\app.asar', NATIVE_PROGRAM_PIN.managerMember)
  const transcriptPath = path.join('D:\\transcripts', `${request.cliSessionId}.jsonl`)
  const other: any = { sessionId: 'local_other', cliSessionId: 'other-cli', isArchived: false }
  const sessions = new Map([[other.sessionId, other]])
  const calls: any[] = []
  let transcript = 'fixture-transcript'
  let refusal: string | null = null
  const manager: any = {
    userDataPath: request.profileDir,
    currentAccountId: 'account',
    currentOrgId: 'org',
    sessions,
    adoptingCliSessionIds: new Map(),
    waitForInitialization: async () => {},
    ensureArchivedSessionsLoaded: async () => {},
    localLineageIds: (s: any) => [s.cliSessionId],
    diskTranscript: { resolveProjectDirForSession: async () => 'D:\\transcripts' },
    getCliSessionDiscovery: async () => ({ liveOwnershipRefusal: async () => refusal }),
    importCliSession: async (id: string, options: any) => {
      calls.push({ id, options })
      await options.beforeWrite()
      const sessionId = `local_${id}`
      sessions.set(sessionId, {
        sessionId,
        cliSessionId: id,
        title: 'Existing transcript title',
        isArchived: false,
        isRunning: false,
        query: null,
        model: 'claude-opus-5',
        permissionMode: 'acceptEdits',
        cwd: 'D:\\work',
      })
      return sessionId
    },
  }
  const cache: any = {
    [filename]: { loaded: true, exports: { claudeCodeSessionManager: manager } },
  }
  const require: any = (name: string) => {
    if (name === 'node:module')
      return {
        createRequire: (base: string) => {
          if (!path.isAbsolute(base)) throw Error('createRequire needs an absolute app path')
          return require
        },
      }
    if (name === 'electron')
      return {
        app: {
          isReady: () => true,
          getVersion: () => NATIVE_PROGRAM_PIN.version,
          getPath: () => request.profileDir,
          getAppPath: () => 'D:\\Claude\\app.asar',
        },
      }
    if (name === 'node:path') return path
    if (name === 'node:fs')
      return {
        statSync: () => ({ isFile: () => true, size: 100 }),
        readFileSync: (file: string) =>
          file === filename
            ? 'manager'
            : file === transcriptPath
              ? transcript
              : (() => {
                  throw Error('Unexpected file')
                })(),
      }
    if (name === 'node:crypto')
      return {
        createHash: () => ({
          update: (bytes: string) => ({
            digest: () => (bytes === 'manager' ? NATIVE_PROGRAM_PIN.managerSha256 : bytes),
          }),
        }),
      }
    throw Error(`Unexpected require: ${name}`)
  }
  require.resolve = (file: string) => file
  require.cache = cache
  const process = {
    pid: request.pid,
    platform: 'win32',
    mainModule: { filename: 'electron', require },
  }
  return {
    request,
    manager,
    calls,
    other,
    sessions,
    refusal: (value: string | null) => {
      refusal = value
    },
    transcript: (value: string) => {
      transcript = value
    },
    run: (patch: Partial<NativeImportRequest> = {}) =>
      runInNewContext(nativeImportProgram({ ...request, ...patch }), { process }),
  }
}

describe('disposable native import wrapper (no app/network connection)', () => {
  test('imports only the exact disposable CLI ID without automatic trust or a prompt', async () => {
    const f = fixture()
    const result = await f.run()
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      dispatch: 'sent',
      sentPrompt: false,
      importedSessionId: `local_${f.request.cliSessionId}`,
      transcriptBytesPreserved: true,
      session: { title: 'Existing transcript title', hasQuery: false },
      bystanderArchiveChanges: [],
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].options).toMatchObject({ autoTrust: false, title: 'Fallback proof title' })
    expect(Object.keys(f.calls[0].options).sort()).toEqual(['autoTrust', 'beforeWrite', 'title'])
  })
  test('unknown transcript and incomplete identity are rejected before building code', () => {
    const f = fixture()
    expect(() => nativeImportProgram({ ...f.request, cliSessionId: 'other-chat' })).toThrow(
      'approved disposable',
    )
    expect(() => nativeImportProgram({ ...f.request, accountId: '' })).toThrow(
      'Exact import identity',
    )
  })
  test('existing archived lineage is refused rather than auto-unarchived', async () => {
    const f = fixture()
    f.other.isArchived = true
    f.other.cliSessionId = f.request.cliSessionId
    expect(await f.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
    expect(f.other.isArchived).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
  test('fresh unknown/live writer refuses and account changes are rechecked', async () => {
    for (const refusal of ['running', 'liveness_unknown']) {
      const f = fixture()
      f.refusal(refusal)
      expect(await f.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
      expect(f.calls).toHaveLength(0)
    }
    const f = fixture()
    f.manager.ensureArchivedSessionsLoaded = async () => {
      f.manager.currentAccountId = 'new-account'
    }
    expect(await f.run()).toMatchObject({ ok: false, dispatch: 'not-sent' })
    expect(f.calls).toHaveLength(0)
  })
  test('beforeWrite refuses a writer that resumes during the native import preparation', async () => {
    const f = fixture()
    f.manager.importCliSession = async (_id: string, options: any) => {
      f.refusal('running')
      await options.beforeWrite()
      throw Error('unreachable')
    }
    expect(await f.run()).toMatchObject({ ok: false, dispatch: 'sent' })
    expect(f.sessions.size).toBe(1)
  })
  test('changed transcript and bystander flags never produce verified success', async () => {
    const f = fixture()
    const original = f.manager.importCliSession
    f.manager.importCliSession = async (...args: any[]) => {
      const id = await original(...args)
      f.other.isArchived = true
      f.transcript('unexpected rewrite')
      return id
    }
    const result = await f.run()
    expect(result).toMatchObject({
      ok: false,
      verified: false,
      dispatch: 'sent',
      transcriptBytesPreserved: false,
    })
    expect(result.bystanderArchiveChanges).toEqual([
      { sessionId: 'local_other', before: false, after: true },
    ])
  })
})
