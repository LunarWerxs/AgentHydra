// server/src/desktop-folder-move.ts - move ONE Claude Desktop Code chat into another working folder
// on the SAME profile (POST /api/sessions/:id/desktop-folder, MCP move_chat_folder).
//
// WHY A NEW SESSION ID. The running app holds one chat per CLI session id inside a profile: a
// second import of the same id returns the existing record, unchanged, even after a native archive
// (measured 2026-10-09 on a probe chat). Its folder is taken from the transcript when it lands, so
// the only way to land the same thread in another folder is a transcript under a NEW id. The owner
// accepted that the chat gets a new session id; the old chat is archived, never deleted.
//
// THE ORDER IS A MOVE'S ORDER (migrate's /migrate route): refuse every bad state before anything is
// written; write the new transcript; land it through the app's own import and read the landing back;
// only then stamp its title and carried settings and carry the per-chat marks; only then archive the
// old copy through the production native archive. A refusal before the write touches nothing. A
// refused import removes what this call wrote. Nothing is retried, and there is no UI fallback.

import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { type CarriedSettings, pickCarriedSettings } from './chat-settings-carry'
import { isGenericChatTitle } from './chat-title'
import { type NativeArchiveOutcome, tryNativeArchiveChat } from './claude-native-archive'
import { type NativeImportOutcome, tryNativeImport } from './claude-native-import'
import {
  getClaudeNativeProfileConfig,
  normalizeClaudeNativeProfile,
} from './claude-native-settings'
import { validateCwd } from './climayte-cwd'
import { CLAUDE_PROJECTS_ROOT } from './config'
import { connectClaudeInspector } from './core/claude-native/inspector-client'
import { nativeProgram } from './core/claude-native/native-program'
import { scanClaudeProcesses } from './core/process'
import { db, rememberMigratedSettings } from './db'
import { invalidateSessionMetaCache } from './instance-sessions'
import { samePathKey } from './path-key'
import {
  awaitChatRecord,
  findVisibleChatMetaPath,
  liveSessionEntry,
  reassertChatAutomation,
  reassertChatTitle,
  stampImportedChat,
} from './session-launch'
import { encodeCwdKey } from './transcript'

/** A chat used this recently (a person's or the engine's last activity) is not moved. */
export const FOLDER_MOVE_QUIET_MS = 10 * 60_000
const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/
const LANDING_DEADLINE_MS = 25_000

export interface FolderMoveInput {
  /** The chat's id as the route received it (its CLI session id, or its local_ id). */
  sessionId: string
  /** `desktop:<full profile directory>`, as the archive routes take it. */
  instanceRef: unknown
  /** The new working folder, an absolute path to an existing local folder. */
  cwd: unknown
}

export interface FolderMoveOutcome {
  status: number
  body: Record<string, unknown>
}

/** What the native inspection says about the chat being moved. */
export type NativeChatState =
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'ok'
      session: {
        isRunning?: boolean
        isStopping?: boolean
        starting?: boolean
        pendingInput?: boolean
        pendingPermission?: boolean
        pendingDialog?: boolean
        losableWork?: unknown
        lastActivityAt?: unknown
      }
    }

/** The Desk marks a chat carries (its sidebar group, pin and unread), read from Desk's own API. */
export interface DeskMarks {
  group: string | null
  pinned: boolean
  unread: boolean
}

export type DeskMarksRead =
  | { state: 'none' }
  | { state: 'ok'; marks: DeskMarks }
  | { state: 'unreachable'; reason: string }

/** Every effect and read this move makes, injectable so the sequence is tested without an app. */
export interface FolderMoveDeps {
  nativeConfigured(profile: string): boolean
  findRecord(
    profile: string,
    sessionId: string,
  ): { metaPath: string; meta: Record<string, unknown> } | null
  liveEngine(cliSessionId: string): boolean
  inspect(profile: string, cliSessionId: string): Promise<NativeChatState>
  /** Writes the new transcript (and its sidecar folder) under `cwd`'s project folder. */
  forkTranscript(
    oldCliSessionId: string,
    newCliSessionId: string,
    cwd: string,
  ): { written: string[] } | { missing: true }
  /** Removes what forkTranscript wrote. */
  dropFiles(paths: string[]): void
  importChat(profile: string, newCliSessionId: string): Promise<NativeImportOutcome>
  /** True once the new record is on disk where the app keeps it. */
  awaitLanded(profile: string, newCliSessionId: string): Promise<boolean>
  /** Title and carried settings onto the new record. Returns whether the title was written. */
  stampLanded(
    profile: string,
    newCliSessionId: string,
    title: string,
    carried: CarriedSettings,
  ): Promise<boolean>
  /** The daemon's own per-chat state keyed by session id (its done mark) follows the new id. */
  carryDaemonState(
    oldCliSessionId: string,
    newCliSessionId: string,
    profile: string,
    carried: CarriedSettings,
  ): void
  deskMarksRead(cliSessionId: string): Promise<DeskMarksRead>
  deskMarksWrite(
    cliSessionId: string,
    marks: DeskMarks,
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  archiveChat(profile: string, cliSessionId: string): Promise<NativeArchiveOutcome>
  invalidate(): void
  newSessionId(): string
  now(): number
}

function refuse(
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): FolderMoveOutcome {
  return { status, body: { ok: false, refused: code, error, ...extra } }
}

/** The exact-one native match rule the archive uses: a chat is its session id, its CLI id or a lineage id. */
function matchNativeChat(sessions: unknown[], cliSessionId: string): Record<string, any> | null {
  const matches = sessions.filter((s): s is Record<string, any> => {
    if (!s || typeof s !== 'object') return false
    const row = s as Record<string, any>
    return (
      row.cliSessionId === cliSessionId ||
      (Array.isArray(row.lineageIds) && row.lineageIds.includes(cliSessionId))
    )
  })
  return matches.length === 1 ? matches[0] : null
}

/** The chat's folder move, as the checks before any write make it: the instance, the chat, and what it is doing. */
type Ready = {
  profile: string
  cwd: string
  meta: Record<string, unknown>
  oldCli: string
  title: string
  recordCwd: string
}

/** The move itself. Every refusal is a status and a reason, and returns before anything is written. */
export async function moveDesktopChatFolder(
  input: FolderMoveInput,
  deps: FolderMoveDeps = defaultFolderMoveDeps(),
): Promise<FolderMoveOutcome> {
  const target = targetOf(input, deps)
  if ('refused' in target) return target.refused
  const { profile, cwd } = target
  const record = deps.findRecord(profile, input.sessionId)
  if (!record)
    return refuse(404, 'chat-not-found', 'no chat with that id is on screen in this profile')
  const chat = chatOf(record.meta, cwd, deps)
  if ('refused' in chat) return chat.refused
  const state = await deps.inspect(profile, chat.oldCli)
  if (state.kind === 'unavailable') return refuse(409, 'native-unavailable', state.reason)
  const idle = idleRefusal(state.session as Record<string, unknown>, deps)
  if (idle) return idle

  // Nothing above has written anything. From here on, a refusal must undo what this call wrote.
  return writeMove(input, deps, { profile, cwd, ...chat, meta: record.meta })
}

/** The instance profile and the folder a move goes to, or the refusal for one that is missing or not usable. */
function targetOf(
  input: FolderMoveInput,
  deps: FolderMoveDeps,
): { profile: string; cwd: string } | { refused: FolderMoveOutcome } {
  const ref = typeof input.instanceRef === 'string' ? input.instanceRef.trim() : ''
  const profileRaw = ref.startsWith('desktop:') ? ref.slice('desktop:'.length) : ''
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/i.test(profileRaw))
    return {
      refused: refuse(
        400,
        'bad-request',
        "instance_ref must be 'desktop:<full profile directory>'",
      ),
    }
  if (!SESSION_ID.test(input.sessionId))
    return { refused: refuse(400, 'bad-request', 'session id is not a valid session identifier') }
  let cwd: string
  try {
    cwd = validateCwd(input.cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      refused: message.includes('not an existing folder')
        ? refuse(422, 'folder-missing', message)
        : refuse(400, 'bad-request', message),
    }
  }
  const profile = normalizeClaudeNativeProfile(profileRaw)
  if (!deps.nativeConfigured(profile))
    return {
      refused: refuse(
        409,
        'no-native-control',
        'native control is not configured for this profile, so the chat cannot be moved natively',
      ),
    }
  return { profile, cwd }
}

/** The chat as it can move: it has a CLI transcript, is not archived, has a real name, and is not in that folder already. */
function chatOf(
  meta: Record<string, unknown>,
  cwd: string,
  deps: FolderMoveDeps,
): { oldCli: string; title: string; recordCwd: string } | { refused: FolderMoveOutcome } {
  const oldCli =
    typeof meta.cliSessionId === 'string' && SESSION_ID.test(meta.cliSessionId)
      ? meta.cliSessionId
      : null
  if (!oldCli)
    return { refused: refuse(409, 'no-cli-transcript', 'this chat has no CLI transcript to move') }
  if (meta.isArchived === true)
    return {
      refused: refuse(409, 'archived', 'the chat is archived; unarchive it in the app first'),
    }
  const title = typeof meta.title === 'string' ? meta.title.trim() : ''
  if (!title || isGenericChatTitle(title))
    return {
      refused: refuse(
        409,
        'no-real-title',
        'the chat has no real name; rename it before moving its folder',
      ),
    }
  const recordCwd = typeof meta.cwd === 'string' ? meta.cwd : ''
  if (recordCwd && samePathKey(recordCwd, cwd))
    return { refused: refuse(409, 'same-folder', 'the chat already works in that folder') }
  if (deps.liveEngine(oldCli))
    return {
      refused: refuse(
        409,
        'engine-running',
        'the chat has a running engine; let its turn finish before moving it',
      ),
    }
  return { oldCli, title, recordCwd }
}

/** The refusal when the chat is busy with live work or was used in the last few minutes; null when it may move. */
function idleRefusal(s: Record<string, unknown>, deps: FolderMoveDeps): FolderMoveOutcome | null {
  const busy = [
    'isRunning',
    'isStopping',
    'starting',
    'pendingInput',
    'pendingPermission',
    'pendingDialog',
  ].filter((k) => s[k] === true)
  if (s.losableWork != null) busy.push('losableWork')
  if (busy.length)
    return refuse(
      409,
      'chat-busy',
      `the chat has live, pending or transitioning work (${busy.join(', ')})`,
    )
  if (s.lastActivityAt != null) {
    const active =
      typeof s.lastActivityAt === 'number' ? s.lastActivityAt : Date.parse(String(s.lastActivityAt))
    if (Number.isNaN(active))
      return refuse(
        409,
        'activity-unknown',
        'the app reported a last activity time this move cannot read, so the chat is not moved',
      )
    if (deps.now() - active < FOLDER_MOVE_QUIET_MS)
      return refuse(
        409,
        'used-recently',
        'the chat was used in the last 10 minutes; move it once it has been quiet',
      )
  }
  return null
}

/** Copies the chat into the folder, then archives the old one. Every refusal after the first write says what was undone. */
async function writeMove(
  input: FolderMoveInput,
  deps: FolderMoveDeps,
  ready: Ready,
): Promise<FolderMoveOutcome> {
  const { profile, cwd, meta, oldCli, title, recordCwd } = ready
  const newCli = deps.newSessionId()
  const fork = deps.forkTranscript(oldCli, newCli, cwd)
  if ('missing' in fork)
    return refuse(
      422,
      'transcript-not-found',
      "the chat's transcript is not in the CLI projects store",
    )
  const desk = await deps.deskMarksRead(oldCli)

  const imported = await deps.importChat(profile, newCli)
  if (!imported.ok) {
    if (imported.unavailable) {
      deps.dropFiles(fork.written)
      return refuse(
        409,
        'native-unavailable',
        imported.reason ?? 'the app did not take the import',
        { sessionId: input.sessionId },
      )
    }
    // Sent and not confirmed: the app may hold the new row, so its files stay and nothing is retried.
    return refuse(
      502,
      'import-unconfirmed',
      imported.reason ?? 'the app did not confirm the import',
      {
        sessionId: input.sessionId,
        newSessionId: newCli,
      },
    )
  }
  if (!imported.cwd || !samePathKey(imported.cwd, cwd)) {
    // The app landed the copy somewhere else. Archive that copy (this call created it), never the old chat.
    const undone = await deps.archiveChat(profile, newCli)
    deps.invalidate()
    return refuse(
      409,
      'landed-in-other-folder',
      'the app landed the new copy in a different folder, so the move was undone',
      {
        sessionId: input.sessionId,
        newSessionId: newCli,
        landedCwd: imported.cwd ?? null,
        copyArchived: undone.kind === 'result' && undone.ok && undone.verified,
      },
    )
  }
  if (!(await deps.awaitLanded(profile, newCli)))
    return refuse(
      422,
      'landing-unverified',
      'the new copy did not appear in the app store; the old chat was left as it was',
      {
        sessionId: input.sessionId,
        newSessionId: newCli,
      },
    )

  const carried: CarriedSettings = { ...pickCarriedSettings(meta), cwd }
  const titled = await deps.stampLanded(profile, newCli, title, carried)
  deps.carryDaemonState(oldCli, newCli, profile, carried)
  const deskCarried = await carryDeskMarks(deps, desk, newCli)

  const archived = await deps.archiveChat(profile, oldCli)
  deps.invalidate()
  if (archived.kind !== 'result' || !archived.ok || !archived.verified)
    return refuse(
      409,
      'old-copy-not-archived',
      archived.kind === 'result'
        ? (archived.reason ?? 'the native archive was not verified')
        : archived.reason,
      {
        sessionId: input.sessionId,
        newSessionId: newCli,
        cwd,
        note: 'the new chat exists and the old one is still on screen; no retry was made',
      },
    )

  return {
    status: 200,
    body: {
      ok: true,
      verified: true,
      sessionId: input.sessionId,
      newSessionId: newCli,
      title,
      titled,
      cwd,
      previousCwd: recordCwd || null,
      carried: Object.keys(carried),
      archivedOld: true,
      deskMarks: deskCarried,
      native: {
        import: {
          importedSessionId: imported.importedSessionId ?? null,
          cwd: imported.cwd ?? null,
        },
        archive: { changed: archived.changed, verified: archived.verified },
      },
    },
  }
}

/** The desk marks (group, pin, unread) carried to the new chat, or why they were not. */
async function carryDeskMarks(
  deps: FolderMoveDeps,
  desk: Awaited<ReturnType<FolderMoveDeps['deskMarksRead']>>,
  newCli: string,
): Promise<'ok' | 'none' | 'unreachable' | 'not-written'> {
  if (desk.state === 'unreachable') return 'unreachable'
  if (desk.state !== 'ok' || !(desk.marks.group || desk.marks.pinned || desk.marks.unread))
    return 'none'
  const written = await deps.deskMarksWrite(newCli, desk.marks)
  return written.ok ? 'ok' : 'not-written'
}

// --- the real effects ---------------------------------------------------------------------------

function findTranscriptFile(cliSessionId: string): string | null {
  try {
    for (const d of readdirSync(CLAUDE_PROJECTS_ROOT)) {
      const f = join(CLAUDE_PROJECTS_ROOT, d, `${cliSessionId}.jsonl`)
      if (existsSync(f)) return f
    }
  } catch {
    // no projects store: nothing to find
  }
  return null
}

/** The transcript under a new id and the new folder: every line's own sessionId and cwd are rewritten,
 *  everything else is kept. The old file and its sidecar are not touched. `wx` refuses an overwrite. */
function forkTranscriptFile(
  oldCli: string,
  newCli: string,
  cwd: string,
): { written: string[] } | { missing: true } {
  const oldFile = findTranscriptFile(oldCli)
  if (!oldFile) return { missing: true }
  const destDir = join(CLAUDE_PROJECTS_ROOT, encodeCwdKey(cwd))
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, `${newCli}.jsonl`)
  const rewritten = readFileSync(oldFile, 'utf8')
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      try {
        const obj = JSON.parse(line)
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return line
        if (obj.sessionId === oldCli) obj.sessionId = newCli
        if ('cwd' in obj) obj.cwd = cwd
        return JSON.stringify(obj)
      } catch {
        return line
      }
    })
  writeFileSync(dest, rewritten.join('\n'), { flag: 'wx' })
  const written = [dest]
  const sidecar = join(dirname(oldFile), oldCli)
  if (existsSync(sidecar)) {
    const destSidecar = join(destDir, newCli)
    cpSync(sidecar, destSidecar, { recursive: true, errorOnExist: true, force: false })
    written.push(destSidecar)
  }
  return { written }
}

/** A chat's native state, read through the app's own inspection: one main process, one exact match. */
async function inspectNativeChat(profile: string, cliSessionId: string): Promise<NativeChatState> {
  const config = getClaudeNativeProfileConfig(profile)
  if (!config)
    return { kind: 'unavailable', reason: 'native control is not configured for this profile' }
  const scan = await scanClaudeProcesses({ fresh: true })
  if (!scan.ok)
    return { kind: 'unavailable', reason: `could not read the Claude processes: ${scan.reason}` }
  const owners = scan.processes.filter(
    (p) => p.isMain && p.dir && normalizeClaudeNativeProfile(p.dir) === profile,
  )
  if (owners.length !== 1)
    return {
      kind: 'unavailable',
      reason: owners.length ? 'several main processes match' : 'the app is not running',
    }
  let client: Awaited<ReturnType<typeof connectClaudeInspector>> | undefined
  try {
    client = await connectClaudeInspector({
      pid: owners[0].pid,
      profile,
      port: config.port,
      connectTimeoutMs: 3000,
      callTimeoutMs: 10000,
    })
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
  try {
    const inspected = await client.evaluate<Record<string, any>>(
      nativeProgram({ action: 'inspect', pid: owners[0].pid, profileDir: profile }),
    )
    if (inspected?.ok !== true || inspected.verified !== true || !Array.isArray(inspected.sessions))
      return {
        kind: 'unavailable',
        reason: String(inspected?.reason ?? 'the app did not return its session list'),
      }
    const row = matchNativeChat(inspected.sessions, cliSessionId)
    if (!row)
      return {
        kind: 'unavailable',
        reason: 'the app does not hold this chat as exactly one session',
      }
    return { kind: 'ok', session: row }
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    client.close()
  }
}

function deskBase(): string {
  return `http://127.0.0.1:${process.env.HYDRA_DESK_PORT || 7798}`
}

async function readDeskMarks(cliSessionId: string): Promise<DeskMarksRead> {
  try {
    const res = await fetch(
      `${deskBase()}/api/external/sessions/${encodeURIComponent(cliSessionId)}`,
      {
        signal: AbortSignal.timeout(3000),
      },
    )
    if (res.status === 404) return { state: 'none' }
    if (!res.ok) return { state: 'unreachable', reason: `Desk answered HTTP ${res.status}` }
    const s = (await res.json()) as Record<string, unknown>
    return {
      state: 'ok',
      marks: {
        group: typeof s.group === 'string' ? s.group : null,
        pinned: s.pinned === true,
        unread: s.unread === true,
      },
    }
  } catch (error) {
    return { state: 'unreachable', reason: error instanceof Error ? error.message : String(error) }
  }
}

async function writeDeskMarks(
  cliSessionId: string,
  marks: DeskMarks,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(
      `${deskBase()}/api/external/sessions/${encodeURIComponent(cliSessionId)}/meta`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: marks.group, pinned: marks.pinned, unread: marks.unread }),
        signal: AbortSignal.timeout(3000),
      },
    )
    return res.ok ? { ok: true } : { ok: false, reason: `Desk answered HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The daemon's per-chat state keyed by session id: its done mark follows the thread, and the settings
 *  the landing carried are kept for the new id so the standing sweep keeps them in place. */
function carryDaemonState(
  oldCli: string,
  newCli: string,
  profile: string,
  carried: CarriedSettings,
): void {
  const row = db
    .query<{ done: number }, [string]>('select done from session_marks where session_id = ?')
    .get(oldCli)
  if (row)
    db.query(
      'insert into session_marks (session_id, done, updated_at) values (?, ?, ?) on conflict(session_id) do update set done = excluded.done, updated_at = excluded.updated_at',
    ).run(newCli, row.done, Date.now())
  if (Object.keys(carried).length) rememberMigratedSettings(newCli, profile, carried)
}

export function defaultFolderMoveDeps(): FolderMoveDeps {
  return {
    nativeConfigured: (profile) => getClaudeNativeProfileConfig(profile) !== null,
    findRecord: (profile, sessionId) => {
      const metaPath = findVisibleChatMetaPath(profile, sessionId)
      if (!metaPath) return null
      try {
        return {
          metaPath,
          meta: JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>,
        }
      } catch {
        return null
      }
    },
    liveEngine: (cliSessionId) => liveSessionEntry(cliSessionId) !== null,
    inspect: inspectNativeChat,
    forkTranscript: forkTranscriptFile,
    dropFiles: (paths) => {
      for (const p of paths) rmSync(p, { recursive: true, force: true })
    },
    importChat: (profile, newCli) => tryNativeImport(profile, newCli),
    awaitLanded: async (profile, newCli) =>
      (await awaitChatRecord(profile, newCli, { deadlineMs: LANDING_DEADLINE_MS })) !== null,
    stampLanded: async (profile, newCli, title, carried) => {
      const titled = await stampImportedChat(profile, newCli, title, undefined, undefined, carried)
      void reassertChatTitle(profile, newCli, title).catch(() => {})
      void reassertChatAutomation(profile, newCli).catch(() => {})
      return titled
    },
    carryDaemonState,
    deskMarksRead: readDeskMarks,
    deskMarksWrite: writeDeskMarks,
    archiveChat: (profile, cliSessionId) => tryNativeArchiveChat(profile, cliSessionId),
    invalidate: () => invalidateSessionMetaCache(),
    newSessionId: () => randomUUID(),
    now: () => Date.now(),
  }
}
