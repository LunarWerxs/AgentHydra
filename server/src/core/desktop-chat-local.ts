// server/src/core/desktop-chat-local.ts — this PC's side of desktop chat sync (the ChatLocal in
// desktop-chat-types.ts): which desktop chats render here, their transcripts, the viewer's copies of
// other PCs' chats (REMOTE_CHATS_DIR), and taking back out of this PC's chat list a chat an earlier
// version landed there. Never opens or launches a desktop app, and never touches a chat through the
// UI or a menu: the archive goes through the production entry point the routes use.

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
import { join } from 'node:path'
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

export interface ChatLocalOpts {
  /** Desktop profile directories (default: the default install and every `~/.claude-instances/*`). */
  profileRoots?: () => string[]
  /** The folder holding `<project>/<sessionId>.jsonl` (default `~/.claude/projects`). */
  projectsDir?: string
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

export function createChatLocal(opts: ChatLocalOpts = {}): ChatLocal {
  const roots = opts.profileRoots ?? defaultProfileRoots
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects')
  const viewDir = opts.viewDir ?? REMOTE_CHATS_DIR
  const archiveChat = opts.archiveChat ?? defaultArchive

  const projectOf = new Map<string, { project: string | null; at: number }>()
  let folders: string[] | null = null
  let foldersAt = 0

  const fileIn = (dir: string, project: string, sessionId: string): string | null =>
    isPlainName(project) && isUuid(sessionId) ? join(dir, project, `${sessionId}.jsonl`) : null
  const transcript = (project: string, sessionId: string) => fileIn(projectsDir, project, sessionId)
  const viewFile = (project: string, sessionId: string) => fileIn(viewDir, project, sessionId)
  const sizeOf = (path: string | null): number => {
    try {
      return path ? statSync(path).size : 0
    } catch {
      return 0
    }
  }

  function findProject(sessionId: string, cwd: string | null): string | null {
    const seen = projectOf.get(sessionId)
    if (seen?.project && existsSync(join(projectsDir, seen.project, `${sessionId}.jsonl`)))
      return seen.project
    if (seen && !seen.project && Date.now() - seen.at < MISS_MS) return null
    const found = (() => {
      // The folder is the chat's cwd with every non-alphanumeric turned to `-`: try it first.
      const guess = cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : null
      if (guess && existsSync(join(projectsDir, guess, `${sessionId}.jsonl`))) return guess
      if (!folders || Date.now() - foldersAt > MISS_MS) {
        try {
          folders = readdirSync(projectsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        } catch {
          folders = []
        }
        foldersAt = Date.now()
      }
      return folders.find((f) => existsSync(join(projectsDir, f, `${sessionId}.jsonl`))) ?? null
    })()
    projectOf.set(sessionId, { project: found, at: Date.now() })
    return found
  }

  function list(): LocalChat[] {
    const dirs = roots()
    const out: LocalChat[] = []
    for (const c of collectChats(dirs.map((dir) => ({ dir, label: dir })))) {
      if (c.staleLogin || !isUuid(c.cliSessionId)) continue
      const id = c.chatId?.startsWith('local_') ? c.chatId.slice('local_'.length) : null
      if (!isUuid(id)) continue
      const where = accountOrgOf(c.metaPath)
      if (!where) continue
      const record = recordOf(c)
      if (!record) continue
      const project = findProject(c.cliSessionId, c.cwd)
      out.push({
        id,
        sessionId: c.cliSessionId,
        project,
        account: where.account,
        org: where.org,
        record,
        archived: c.archived,
        size: project ? size(project, c.cliSessionId) : 0,
      })
    }
    return out
  }

  const size = (project: string, sessionId: string): number =>
    sizeOf(transcript(project, sessionId))

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

  async function retire(sessionId: string, bytes: number): Promise<RetireOutcome> {
    if (!isUuid(sessionId)) return { ok: false, reason: 'not a session id', retry: false }
    const project = findProject(sessionId, null)
    if (project && size(project, sessionId) > bytes) return { ok: true, kept: true }
    for (const dir of roots()) {
      const shown = collectChats([{ dir, label: dir }]).some(
        (c) => !c.staleLogin && !c.archived && c.cliSessionId === sessionId,
      )
      if (!shown) continue
      const r = await archiveChat(dir, sessionId)
      if (!r.ok) return retry(r.reason ?? 'the archive was not confirmed')
    }
    if (!project) return { ok: true, kept: false }
    const from = transcript(project, sessionId) as string
    const to = viewFile(project, sessionId) as string
    try {
      mkdirSync(join(viewDir, project), { recursive: true })
      copyFileSync(from, to)
      unlinkSync(from)
    } catch (err) {
      return retry(`its transcript could not be moved yet (${(err as Error).message})`)
    }
    projectOf.delete(sessionId)
    try {
      // The folder an earlier version made for it goes with its last transcript.
      rmdirSync(join(projectsDir, project))
    } catch {
      /* other transcripts still live there */
    }
    return { ok: true, kept: false }
  }

  return { list, read, viewSize, viewWrite, retire }
}
