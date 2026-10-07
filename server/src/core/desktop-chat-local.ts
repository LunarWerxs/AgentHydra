// server/src/core/desktop-chat-local.ts — this PC's side of desktop chat sync (the ChatLocal in
// desktop-chat-types.ts): which desktop chats render here, their transcripts, the viewer's copies of
// other PCs' chats (REMOTE_CHATS_DIR), and taking back out of this PC's chat list a chat an earlier
// version landed there. Never opens or launches a desktop app, and never touches a chat through the
// UI or a menu: the archive goes through the production entry point the routes use.
//
// Hydra Desk's chats (Jacob's Desk and AgentHydra 2.0's window, each listing its chats in
// `<home>/chats.json`) are listed beside the desktop records: their transcripts are in the projects
// folder of the account each chat runs on (`account.configDir`, else ~/.claude). Only the real homes
// are read: a throwaway Desk's chats are never shared.

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { REMOTE_CHATS_DIR } from '../config'
import { collectChats } from './chat-store-scan'
import type { ChatLocal, LocalChat, RetireOutcome } from './desktop-chat-types'
import { defaultClaudeUserDataDir, instancesRoot } from './paths'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A plain folder name: letters, digits, `.`, `_`, `-`, space. No separator, drive colon or `..`. */
const PLAIN_NAME = /^[\p{L}\p{N}._ -]+$/u

const isUuid = (s: string | null | undefined): s is string => !!s && UUID.test(s)
const isPlainName = (s: string): boolean => PLAIN_NAME.test(s) && !/^\.+$/.test(s)

/** How long "no folder holds this transcript" is believed before folders are checked again. */
const MISS_MS = 5 * 60_000
/** A Hydra Desk chat idle this long is not sent for the first time: the store's room is shared, and
 *  the other PC wants what runs. */
export const DESK_IDLE_MS = 7 * 24 * 3600_000

export interface ChatLocalOpts {
  /** Desktop profile directories (default: the default install and every `~/.claude-instances/*`). */
  profileRoots?: () => string[]
  /** The folder holding `<project>/<sessionId>.jsonl` (default `~/.claude/projects`). */
  projectsDir?: string
  /** Hydra Desk data folders whose `chats.json` lists the chats run there (default `~/.hydra-desk` and
   *  `~/.hydra-desk-2`). */
  deskHomes?: string[]
  /** The viewer's folder of other PCs' chats, laid out the same way (default REMOTE_CHATS_DIR). */
  viewDir?: string
  /** The production archive of a chat already in `profile`. */
  archiveChat?: (profile: string, sessionId: string) => Promise<{ ok: boolean; reason?: string }>
}

function defaultProfileRoots(): string[] {
  const out = [defaultClaudeUserDataDir()]
  try {
    for (const e of readdirSync(instancesRoot(), { withFileTypes: true }))
      if (e.isDirectory()) out.push(join(instancesRoot(), e.name))
  } catch {
    /* no instances folder: the default profile alone */
  }
  return out
}

async function defaultIsRunning(profile: string): Promise<boolean> {
  const { isProfileRunning } = await import('../move-retire-on-close')
  // A scan that cannot answer reads as "not running": the caller then waits instead of acting.
  return isProfileRunning(profile, {}).catch(() => false)
}

/** The production archive: the running app's own native archive (ok AND verified, no fallback
 *  after a refusal), or the flag on disk for a closed app, as POST /desktop-archive does. */
async function defaultArchive(
  profile: string,
  sessionId: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (await defaultIsRunning(profile)) {
    const { tryNativeArchiveChat } = await import('../claude-native-archive')
    const r = await tryNativeArchiveChat(profile, sessionId)
    if (r.kind === 'unavailable') return { ok: false, reason: r.reason }
    return r.ok && r.verified
      ? { ok: true }
      : { ok: false, reason: r.reason ?? 'native archive was not verified' }
  }
  const { archiveDesktopChat } = await import('../session-launch')
  const r = await archiveDesktopChat(sessionId, true, [profile], async () => false)
  return { ok: r.ok, reason: r.reason }
}

const retry = (reason: string): RetireOutcome => ({ ok: false, reason, retry: true })

function accountOrgOf(metaPath: string): { account: string; org: string } | null {
  const parts = metaPath.split(/[\\/]/)
  const org = parts[parts.length - 2]
  const account = parts[parts.length - 3]
  return account && org ? { account, org } : null
}

function recordOf(c: {
  archived: boolean
  title?: string | null
  lastActivityAt?: string | null
  cwd?: string | null
  metaPath: string
}): Record<string, unknown> | null {
  if (!c.archived) {
    try {
      return JSON.parse(readFileSync(c.metaPath, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }
  const last = c.lastActivityAt ? Date.parse(c.lastActivityAt) : Number.NaN
  return {
    ...(c.title ? { title: c.title } : {}),
    isArchived: true,
    ...(Number.isFinite(last) ? { lastActivityAt: last } : {}),
    ...(c.cwd ? { cwd: c.cwd } : {}),
  }
}

/** The parts of a Hydra Desk chat (a `chats.json` row: desk/shared/protocol.ts ChatSummary without its
 *  live fields) the sync reads; anything else in it is left alone. */
interface DeskChat {
  id?: unknown
  sessionId?: unknown
  title?: unknown
  cwd?: unknown
  model?: unknown
  archived?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  account?: { id?: unknown; configDir?: unknown } | null
}

function readDeskChats(home: string): DeskChat[] {
  try {
    const v = JSON.parse(readFileSync(join(home, 'chats.json'), 'utf8')) as unknown
    return Array.isArray(v) ? v.filter((c): c is DeskChat => !!c && typeof c === 'object') : []
  } catch {
    return []
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function createChatLocal(opts: ChatLocalOpts = {}): ChatLocal {
  const roots = opts.profileRoots ?? defaultProfileRoots
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects')
  const viewDir = opts.viewDir ?? REMOTE_CHATS_DIR
  const archiveChat = opts.archiveChat ?? defaultArchive
  const deskHomes = opts.deskHomes ?? [
    join(homedir(), '.hydra-desk'),
    join(homedir(), '.hydra-desk-2'),
  ]

  /** Per projects folder and session: the project folder found, or none since `at`. */
  const projectOf = new Map<string, { project: string | null; at: number }>()
  const folders = new Map<string, { names: string[]; at: number }>()
  /** The projects folder of each Hydra Desk chat's session the last list() found, when not projectsDir. */
  const dirOf = new Map<string, string>()

  const fileIn = (dir: string, project: string, sessionId: string): string | null =>
    isPlainName(project) && isUuid(sessionId) ? join(dir, project, `${sessionId}.jsonl`) : null
  /** One of this PC's transcripts: a Hydra Desk chat's may be under its account's own folder. */
  const transcript = (project: string, sessionId: string) =>
    fileIn(dirOf.get(sessionId) ?? projectsDir, project, sessionId)
  const viewFile = (project: string, sessionId: string) => fileIn(viewDir, project, sessionId)
  const sizeOf = (path: string | null): number => {
    try {
      return path ? statSync(path).size : 0
    } catch {
      return 0
    }
  }

  function findProject(dir: string, sessionId: string, cwd: string | null): string | null {
    const key = `${dir}\0${sessionId}`
    const seen = projectOf.get(key)
    if (seen?.project && existsSync(join(dir, seen.project, `${sessionId}.jsonl`)))
      return seen.project
    if (seen && !seen.project && Date.now() - seen.at < MISS_MS) return null
    const found = (() => {
      // The folder is the chat's cwd with every non-alphanumeric turned to `-`: try it first.
      const guess = cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : null
      if (guess && existsSync(join(dir, guess, `${sessionId}.jsonl`))) return guess
      let names = folders.get(dir)
      if (!names || Date.now() - names.at > MISS_MS) {
        let list: string[]
        try {
          list = readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        } catch {
          list = []
        }
        names = { names: list, at: Date.now() }
        folders.set(dir, names)
      }
      return names.names.find((f) => existsSync(join(dir, f, `${sessionId}.jsonl`))) ?? null
    })()
    projectOf.set(key, { project: found, at: Date.now() })
    return found
  }

  /** Hydra Desk's chats, each session once and none a desktop record already lists (`listed`). */
  function deskChats(listed: Set<string>, now: number): LocalChat[] {
    const out: LocalChat[] = []
    for (const home of deskHomes) {
      for (const d of readDeskChats(home)) {
        const id = str(d.id)
        const sessionId = str(d.sessionId)
        if (!isUuid(id) || !isUuid(sessionId) || listed.has(sessionId)) continue
        listed.add(sessionId)
        const config = str(d.account?.configDir)
        const dir = config ? join(config, 'projects') : projectsDir
        const cwd = str(d.cwd)
        const project = findProject(dir, sessionId, cwd)
        if (project && dir !== projectsDir) dirOf.set(sessionId, dir)
        const archived = d.archived === true
        const at = num(d.updatedAt)
        const title = str(d.title)
        const model = str(d.model)
        const created = num(d.createdAt)
        out.push({
          id,
          sessionId,
          project,
          account: str(d.account?.id) ?? 'default',
          org: basename(home),
          record: {
            ...(title ? { title } : {}),
            ...(cwd ? { cwd } : {}),
            ...(model ? { model } : {}),
            isArchived: archived,
            ...(at !== null ? { lastActivityAt: at } : {}),
            ...(created !== null ? { createdAt: created } : {}),
          },
          archived,
          size: project ? sizeOf(fileIn(dir, project, sessionId)) : 0,
          ...(!archived && now - (at ?? 0) > DESK_IDLE_MS ? { holdBack: true } : {}),
        })
      }
    }
    return out
  }

  function list(): LocalChat[] {
    const dirs = roots()
    const out: LocalChat[] = []
    dirOf.clear()
    for (const c of collectChats(dirs.map((dir) => ({ dir, label: dir })))) {
      if (c.staleLogin || !isUuid(c.cliSessionId)) continue
      const id = c.chatId?.startsWith('local_') ? c.chatId.slice('local_'.length) : null
      if (!isUuid(id)) continue
      const where = accountOrgOf(c.metaPath)
      if (!where) continue
      const record = recordOf(c)
      if (!record) continue
      const project = findProject(projectsDir, c.cliSessionId, c.cwd)
      out.push({
        id,
        sessionId: c.cliSessionId,
        project,
        account: where.account,
        org: where.org,
        record,
        archived: c.archived,
        size: project ? sizeOf(fileIn(projectsDir, project, c.cliSessionId)) : 0,
      })
    }
    out.push(...deskChats(new Set(out.map((c) => c.sessionId)), Date.now()))
    return out
  }

  /** A transcript in ~/.claude/projects, where an earlier version landed other PCs' chats. */
  const ownSize = (project: string, sessionId: string): number =>
    sizeOf(fileIn(projectsDir, project, sessionId))

  function read(project: string, sessionId: string, from: number, to: number): Uint8Array {
    const path = transcript(project, sessionId)
    if (!path) throw new Error('not a transcript of this PC')
    const fd = openSync(path, 'r')
    try {
      const end = Math.min(to, fstatSync(fd).size)
      const buf = new Uint8Array(Math.max(0, end - from))
      let got = 0
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, from + got)
        if (n <= 0) break
        got += n
      }
      return got === buf.length ? buf : buf.subarray(0, got)
    } finally {
      closeSync(fd)
    }
  }

  const viewSize = (project: string, sessionId: string): number =>
    sizeOf(viewFile(project, sessionId))

  function viewWrite(project: string, sessionId: string, at: number, bytes: Uint8Array): boolean {
    const path = viewFile(project, sessionId)
    if (!path || (at !== 0 && viewSize(project, sessionId) !== at)) return false
    mkdirSync(join(viewDir, project), { recursive: true })
    if (at === 0) writeFileSync(path, bytes)
    else appendFileSync(path, bytes)
    return true
  }

  /** Every project folder holding this session's transcript. An earlier version could leave two: a
   *  chat moved to another folder on its own PC was written again under the new one. */
  function projectsHolding(sessionId: string): string[] {
    try {
      return readdirSync(projectsDir, { withFileTypes: true })
        .filter(
          (e) => e.isDirectory() && existsSync(join(projectsDir, e.name, `${sessionId}.jsonl`)),
        )
        .map((e) => e.name)
    } catch {
      return []
    }
  }

  async function retire(sessionId: string, bytes: number): Promise<RetireOutcome> {
    if (!isUuid(sessionId)) return { ok: false, reason: 'not a session id', retry: false }
    const held = projectsHolding(sessionId)
    if (held.some((p) => ownSize(p, sessionId) > bytes)) return { ok: true, kept: true }
    for (const dir of roots()) {
      const shown = collectChats([{ dir, label: dir }]).some(
        (c) => !c.staleLogin && !c.archived && c.cliSessionId === sessionId,
      )
      if (!shown) continue
      const r = await archiveChat(dir, sessionId)
      if (!r.ok) return retry(r.reason ?? 'the archive was not confirmed')
    }
    for (const project of held) {
      const from = fileIn(projectsDir, project, sessionId) as string
      const to = viewFile(project, sessionId) as string
      try {
        mkdirSync(join(viewDir, project), { recursive: true })
        copyFileSync(from, to)
        unlinkSync(from)
      } catch (err) {
        return retry(`its transcript could not be moved yet (${(err as Error).message})`)
      }
      projectOf.delete(`${projectsDir}\0${sessionId}`)
      try {
        // The folder an earlier version made for it goes with its last transcript.
        rmdirSync(join(projectsDir, project))
      } catch {
        /* other transcripts still live there */
      }
    }
    return { ok: true, kept: false }
  }

  return { list, read, viewSize, viewWrite, retire }
}
