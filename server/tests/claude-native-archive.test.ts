import { describe, expect, test } from 'bun:test'
import { type NativeArchiveDeps, tryNativeArchiveChat } from '../src/claude-native-archive'
import type { ClaudeNativeProfileConfig } from '../src/claude-native-settings'
import type { ClaudeInspectorClient } from '../src/core/claude-native/inspector-client'
import type { ClaudeProcessScan } from '../src/core/process'

const PROFILE = 'C:\\Profiles\\Native'
const SESSION = {
  sessionId: 'local_exact',
  cliSessionId: 'cli-current',
  lineageIds: ['cli-original'],
  title: 'Duplicate',
  isArchived: false,
}

function fixture() {
  const state = {
    config: { port: 9229, mode: 'prefer-native' } as ClaudeNativeProfileConfig | null,
    scan: {
      ok: true,
      processes: [
        {
          pid: 5678,
          dir: PROFILE,
          isMain: true,
          cmdline: 'claude --user-data-dir=C:\\Profiles\\Native',
        },
      ],
    } as ClaudeProcessScan,
    inspection: {
      ok: true,
      verified: true,
      dispatch: 'not-sent',
      identity: { pid: 5678, profileDir: PROFILE, accountId: 'account', orgId: 'organization' },
      sessions: [
        { ...SESSION },
        { ...SESSION, sessionId: 'local_other', cliSessionId: 'other-cli', lineageIds: [] },
      ],
    } as Record<string, any>,
    archive: {
      ok: true,
      verified: true,
      dispatch: 'sent',
      changed: true,
      session: { ...SESSION, isArchived: true },
    } as unknown,
    connectError: null as Error | null,
    mutationError: null as Error | null,
    scans: 0,
    connects: 0,
    closes: 0,
    expressions: [] as string[],
  }
  const client: ClaudeInspectorClient = {
    identity: { pid: 5678, argv: [], electron: '44.2.0', profile: PROFILE, version: '2.2553.1' },
    evaluate: async <T>(expression: string) => {
      state.expressions.push(expression)
      if (state.expressions.length === 1) return state.inspection as T
      if (state.mutationError) throw state.mutationError
      return state.archive as T
    },
    close: () => {
      state.closes++
    },
  }
  const deps: NativeArchiveDeps = {
    getConfig: () => state.config,
    scan: async (options) => {
      expect(options).toEqual({ fresh: true })
      state.scans++
      return state.scan
    },
    connect: async (options) => {
      state.connects++
      expect(options.pid).toBe(5678)
      expect(options.profile).toBe('c:\\profiles\\native')
      expect(options.port).toBe(9229)
      if (state.connectError) throw state.connectError
      return client
    },
  }
  return {
    state,
    deps,
    run: (id = 'cli-original', options = {}) => tryNativeArchiveChat(PROFILE, id, options, deps),
  }
}

describe('native archive coordinator', () => {
  test.each([false, true])(
    'serializes normalized profiles and releases the guard after failure=%s',
    async (failFirst) => {
      const proof = fixture()
      let resolveScan!: (scan: ClaudeProcessScan) => void
      let rejectScan!: (error: Error) => void
      const scanGate = new Promise<ClaudeProcessScan>((resolve, reject) => {
        resolveScan = resolve
        rejectScan = reject
      })
      proof.deps.scan = async () => scanGate
      const first = proof.run()
      const concurrent = await tryNativeArchiveChat(
        'c:/PROFILES/native/',
        'other-cli',
        {},
        proof.deps,
      )
      expect(concurrent).toMatchObject({
        kind: 'result',
        ok: false,
        verified: false,
        dispatch: 'not-sent',
      })
      expect(concurrent.reason).toContain('already in progress')
      expect(proof.state.connects).toBe(0)
      if (failFirst) rejectScan(new Error('scan failed'))
      else resolveScan(proof.state.scan)
      expect(await first).toMatchObject({ kind: 'result', ok: !failFirst })
      const next = fixture()
      expect(await next.run()).toMatchObject({ kind: 'result', ok: true, verified: true })
    },
  )
  test('unconfigured non-Windows paths and labels leave the existing archive path untouched', async () => {
    for (const profile of ['/home/user/.config/Claude', 'existing-label']) {
      let scans = 0
      const outcome = await tryNativeArchiveChat(
        profile,
        'legacy id',
        {},
        {
          getConfig: () => null,
          scan: async () => {
            scans++
            return { ok: true, processes: [] }
          },
        },
      )
      expect(outcome).toMatchObject({ kind: 'unavailable', dispatch: 'not-sent' })
      expect(scans).toBe(0)
    }
  })
  test('missing opt-in is unavailable without process or transport work', async () => {
    const proof = fixture()
    proof.state.config = null
    expect(await proof.run()).toMatchObject({ kind: 'unavailable', dispatch: 'not-sent' })
    expect(proof.state.scans).toBe(0)
    expect(proof.state.connects).toBe(0)
    expect(await proof.run('cli-original', { nativeOnly: true })).toMatchObject({
      kind: 'result',
      ok: false,
      dispatch: 'not-sent',
    })
  })

  test('maps unique lineage to current native tuple despite duplicate titles', async () => {
    const proof = fixture()
    expect(await proof.run()).toMatchObject({
      kind: 'result',
      route: 'native',
      ok: true,
      verified: true,
      changed: true,
      dispatch: 'sent',
    })
    expect(proof.state.expressions).toHaveLength(2)
    expect(proof.state.expressions[1]).toContain('"sessionId":"local_exact"')
    expect(proof.state.expressions[1]).toContain('"cliSessionId":"cli-current"')
    expect(proof.state.expressions[1]).toContain('"accountId":"account"')
    expect(proof.state.expressions[1]).not.toContain('"expectedTitle"')
    expect(proof.state.closes).toBe(1)
  })

  test('refuses scan failures and ambiguous main processes before connecting', async () => {
    const failed = fixture()
    failed.state.scan = { ok: false, reason: 'CIM unavailable' }
    expect(await failed.run()).toMatchObject({ kind: 'result', ok: false, dispatch: 'not-sent' })
    expect(failed.state.connects).toBe(0)
    const duplicate = fixture()
    if (duplicate.state.scan.ok)
      duplicate.state.scan.processes.push({ ...duplicate.state.scan.processes[0], pid: 9999 })
    expect(await duplicate.run()).toMatchObject({ kind: 'result', ok: false, dispatch: 'not-sent' })
    expect(duplicate.state.connects).toBe(0)
  })

  test('closed profile and unavailable endpoint follow only the configured fallback policy', async () => {
    for (const mode of ['prefer-native', 'native-only'] as const) {
      const closed = fixture()
      closed.state.config = { port: 9229, mode }
      closed.state.scan = { ok: true, processes: [] }
      expect(await closed.run()).toMatchObject({
        kind: mode === 'prefer-native' ? 'unavailable' : 'result',
        dispatch: 'not-sent',
      })
      const unavailable = fixture()
      unavailable.state.config = { port: 9229, mode }
      unavailable.state.connectError = new Error(
        'Inspector discovery unavailable at 127.0.0.1:9229: refused',
      )
      expect(await unavailable.run()).toMatchObject({
        kind: mode === 'prefer-native' ? 'unavailable' : 'result',
        dispatch: 'not-sent',
      })
    }
  })

  test('wrong inspector identity is terminal even with prefer-native policy', async () => {
    const proof = fixture()
    proof.state.connectError = new Error(
      'Inspector PID or profile does not match the requested instance',
    )
    expect(await proof.run()).toMatchObject({ kind: 'result', ok: false, dispatch: 'not-sent' })
    expect(proof.state.expressions).toHaveLength(0)
  })

  test('ambiguous lineage and missing current CLI identity never dispatch archive', async () => {
    const ambiguous = fixture()
    ambiguous.state.inspection.sessions[1].lineageIds = ['cli-original']
    expect(await ambiguous.run()).toMatchObject({ kind: 'result', ok: false, dispatch: 'not-sent' })
    expect(ambiguous.state.expressions).toHaveLength(1)
    const missing = fixture()
    missing.state.inspection.sessions[0].cliSessionId = null
    expect(await missing.run()).toMatchObject({ kind: 'result', ok: false, dispatch: 'not-sent' })
    expect(missing.state.expressions).toHaveLength(1)
  })

  test('native busy or version refusal stays terminal without suggesting UI fallback', async () => {
    const proof = fixture()
    proof.state.archive = {
      ok: false,
      verified: false,
      dispatch: 'not-sent',
      reason: 'NATIVE_REFUSAL: session has live work',
    }
    expect(await proof.run()).toMatchObject({
      kind: 'result',
      ok: false,
      dispatch: 'not-sent',
      reason: 'NATIVE_REFUSAL: session has live work',
    })
  })

  test('lost or malformed mutation replies are unknown and terminal', async () => {
    const lost = fixture()
    lost.state.mutationError = new Error('Inspector connection closed')
    expect(await lost.run()).toMatchObject({ kind: 'result', ok: false, dispatch: 'unknown' })
    const malformed = fixture()
    malformed.state.archive = { ok: true }
    expect(await malformed.run()).toMatchObject({ kind: 'result', ok: false, dispatch: 'unknown' })
  })

  test('native already-archived result remains a verified no-op', async () => {
    const proof = fixture()
    proof.state.inspection.sessions[0].isArchived = true
    proof.state.archive = {
      ok: true,
      verified: true,
      changed: false,
      dispatch: 'not-sent',
      session: { ...SESSION, isArchived: true },
    }
    expect(await proof.run()).toMatchObject({
      kind: 'result',
      ok: true,
      verified: true,
      changed: false,
      dispatch: 'not-sent',
    })
  })

  test('postcondition failure preserves sent status and changed evidence', async () => {
    const proof = fixture()
    proof.state.archive = {
      ok: false,
      verified: false,
      changed: true,
      dispatch: 'sent',
      reason: 'bystander changed',
    }
    expect(await proof.run()).toMatchObject({
      kind: 'result',
      ok: false,
      verified: false,
      changed: true,
      dispatch: 'sent',
    })
  })
})
