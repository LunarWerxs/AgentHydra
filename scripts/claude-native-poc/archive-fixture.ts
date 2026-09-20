/** Executes selected installed methods only; never imports/initializes the Electron bundle. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

const asarPath =
  process.env.CLAUDE_POC_ASAR ??
  (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'AnthropicClaude', 'app-2.2553.1', 'resources', 'app.asar')
    : undefined)
if (!asarPath) throw Error('Set CLAUDE_POC_ASAR to the reviewed Claude Desktop 2.2553.1 app.asar')
const archive = readFileSync(asarPath)
const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString())
const member = '.vite/build/index.chunk-BQEs5Gzg.js'
let entry = header
for (const part of member.split('/')) entry = entry.files[part]
const base = 8 + archive.readUInt32LE(4) + Number(entry.offset)
const source = archive.subarray(base, base + entry.size).toString()
const sha256 = createHash('sha256').update(source).digest('hex')
export const expectedSourceSha256 =
  '484ab045a1fbe63766a8f65d1258412c3943a60f21b8dcea3a8d63f1ed36a151'
if (sha256 !== expectedSourceSha256) {
  throw Error(
    `Untested Claude bundle ${sha256}: this POC only executes the reviewed 2.2553.1 source`,
  )
}

const boundaries = [
  ['async archiveSession(e,t){', 'async archiveSessionForAgent('],
  ['async teardownSession(e,i,a={}){', 'async cleanupRemoteBridgeSessions('],
  ['unarchiveSession(e){', 'async restoreRemoteCwdBeforeSpawn('],
  ['liveSideSessionsOf(e){', 'getChildSessions('],
  ['sideSessionGoesWithParent(e){', 'sideSessionOwnsOpenPr(e){'],
  ['archiveCascadeOf(e){', 'archiveCascadeClosureOf('],
  ['archiveCascadeClosureOf(e){', 'sideSessionsAtArchive('],
]
function extract(start: string, end: string) {
  const from = source.indexOf(start)
  if (from < 0 || source.indexOf(start, from + 1) >= 0)
    throw Error(`Ambiguous/missing method ${start}`)
  const to = source.indexOf(end, from + start.length)
  if (to < 0) throw Error(`Missing method boundary ${end}`)
  return source.slice(from, to)
}

export const provenance = {
  claudeVersion: '2.2553.1',
  asarPath,
  member,
  sha256,
  methods: boundaries.map(([start, end]) => {
    const code = extract(start, end)
    return {
      signature: start,
      characterOffset: source.indexOf(start),
      characters: code.length,
      sha256: createHash('sha256').update(code).digest('hex'),
    }
  }),
}

export function fixture() {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const spy =
    (name: string, value?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
      return value
    }
  const no = spy('inert lifecycle cleanup')
  // Explicit substitutions: disk, process/PTY, git, telemetry and lifecycle effects.
  // Unknown dependencies throw rather than silently becoming permissive mocks.
  const native = runInNewContext(
    `({${boundaries.map(([a, b]) => extract(a, b)).join(',')}})`,
    {
      t: {
        mv: { forgetSession: no },
        mU: { info: no, warn: no, error: no },
        Yh: no,
        jc: no,
        Ac: { stopServersForWorktree: no },
        Wd: no,
        JT: no,
      },
      n: { lo: { endSession: no }, ao: { clear: no }, gi: { clear: no } },
      w: { i: no },
      L: { v: no },
      f: {
        gitWorktreeManager: {
          removeWorktree: spy('removeWorktree', Promise.resolve()),
          getUncommittedChanges: spy('gitStatus', Promise.resolve([])),
        },
      },
      If: () => true,
      zr: no,
      Mb: spy('clear transcript release markers'),
    },
    { timeout: 1000 },
  )
  const sessions: any = new Map()
  sessions.referencing = (id: string) =>
    [...sessions.values()].filter((s: any) => s.spawnedFrom?.sessionId === id)
  const events: any[] = [],
    saved: any[] = []
  const manager: any = Object.assign(native, {
    sessions,
    parked: new Set(),
    clearAfterTurn: new Map(),
    movesInFlight: new Map(),
    startingSessionIds: new Set(),
    sessionPluginPaths: new Map(),
    sessionRegistryPluginCounts: new Map(),
    sessionOfficialPluginMcpServers: new Map(),
    remoteRootRealpathCache: new Map(),
    sideSessionStartsInFlight: new Map(),
    dirtyProbeUnanswered: new Set(),
    stopPageScopedWork: no,
    clearMovedToCloud: no,
    held: (id: string) => sessions.get(id),
    neverStarted: () => false,
    activityLedger: { clearSession: no },
    terminalActivity: { forgetSession: no },
    warmLifecycle: { unregisterSession: no, registerSession: no },
    previewIdleManager: { unregisterSession: no, registerSession: no },
    cliCrashLoopGuard: { forget: no },
    retireParkedSshProcess: no,
    mcpCoordinator: { unregisterRootsProvider: no },
    shellPty: { stopShellPty: no, stopBashPty: no },
    diskTranscript: { invalidate: spy('invalidate transcript cache') },
    fileAccess: { invalidateContainmentCache: no },
    lazyWorktrees: { forget: no },
    saveSession: (s: any) => saved.push(structuredClone(s)),
    formatSessionForEvent: (s: any) => structuredClone(s),
    emit: (_: string, event: any) => events.push(event),
    discardWaitingInputRecord: no,
    cascadeArchiveSideSessions: async (_: unknown, __: unknown, children: any[]) => {
      if (children.length) throw Error('Fixture requires bystander preflight before archive')
    },
    ensureRemoteWorktree: spy('ensureRemoteWorktree'),
    sideSessionBusy: () => false,
    sideSessionOwnsOpenPr: () => false,
    archiveCascadeSettled: () => true,
  })
  const add = (id: string, extra = {}) => {
    const session = {
      sessionId: id,
      cliSessionId: `cli-${id}`,
      title: 'Duplicate title',
      isArchived: false,
      isRunning: false,
      backend: { kind: 'local' },
      cwd: 'fixture://workspace',
      worktreePath: 'fixture://worktree',
      messageBuffer: [],
      ...extra,
    }
    sessions.set(id, session)
    return session
  }
  const guardedArchive = async (id: string) => {
    const session = sessions.get(id)
    if (!session) throw Error('Exact native session ID not found')
    // This is a POC harness guard, not a claim that the bundled archive method refuses
    // a live session. The real method can stop a running query during teardown.
    if (session.isRunning || session.query || manager.startingSessionIds.has(id)) {
      throw Error('Fixture archive requires a stopped session')
    }
    const cascade = manager.archiveCascadeClosureOf(session)
    if (cascade.length)
      throw Error(`Refusing cascade: ${cascade.map((s: any) => s.sessionId).join(',')}`)
    await manager.archiveSession(id, { cleanupWorktree: false })
  }
  return { manager, sessions, events, saved, calls, add, guardedArchive }
}
