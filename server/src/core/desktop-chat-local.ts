// server/src/core/desktop-chat-local.ts — this PC's side of desktop chat sync (the ChatLocal in
// desktop-chat-types.ts): which desktop chats render here, their transcripts, and landing a chat
// another PC shared. Never opens or launches a desktop app, and never touches a chat through the
// UI or a menu: archive and rename go through the production entry points the routes use.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type CarriedSettings, pickCarriedSettings } from '../chat-settings-carry'
import { collectChats } from './chat-store-scan'
import type { ChatLocal, IncomingChat, LandOutcome, LocalChat } from './desktop-chat-types'
import { readLoginUuid } from './login-state'
import { defaultClaudeUserDataDir, instancesRoot } from './paths'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A plain folder name: letters, digits, `.`, `_`, `-`, space. No separator, drive colon or `..`. */
const PLAIN_NAME = /^[\p{L}\p{N}._ -]+$/u

const isUuid = (s: string | null | undefined): s is string => !!s && UUID.test(s)
const isPlainName = (s: string): boolean => PLAIN_NAME.test(s) && !/^\.+$/.test(s)

/** How long "no folder holds this transcript" is believed before folders are checked again. */
const MISS_MS = 5 * 60_000

export interface ImportArgs {
  sessionId: string
  instanceDir: string
  title: string
  carried: CarriedSettings
  isInstanceRunning: (dir: string) => Promise<boolean>
}

export interface ChatLocalOpts {
  /** Desktop profile directories (default: the default install and every `~/.claude-instances/*`). */
  profileRoots?: () => string[]
  /** The folder holding `<project>/<sessionId>.jsonl` (default `~/.claude/projects`). */
  projectsDir?: string
  /** The production import (session-launch importSessionToDesktop). */
  importChat?: (args: ImportArgs) => Promise<{ ok: boolean; reason?: string }>
  /** The production archive of a chat already in `profile`. */
  archiveChat?: (profile: string, sessionId: string) => Promise<{ ok: boolean; reason?: string }>
  /** The production rename (the chat_rename route's renameChatDiscoveringRenderedTitle). */
  renameChat?: (
    profile: string,
    currentTitle: string,
    newTitle: string,
  ) => Promise<{ ok: boolean; detail?: string }>
  /** Is this profile's desktop app running? */
  isRunning?: (profile: string) => Promise<boolean>
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

async function defaultImport(args: ImportArgs): Promise<{ ok: boolean; reason?: string }> {
  const { importSessionToDesktop } = await import('../session-launch')
  // The import itself refuses (`instance-not-running`) rather than boot a closed profile; the
  // seam below says the same thing the caller already checked.
  return importSessionToDesktop(args)
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

async function defaultRename(
  profile: string,
  currentTitle: string,
  newTitle: string,
): Promise<{ ok: boolean; detail?: string }> {
  const { renameChatDiscoveringRenderedTitle } = await import('../ui-archive')
  return renameChatDiscoveringRenderedTitle(profile, currentTitle, newTitle, false)
}

const retry = (reason: string): LandOutcome => ({ ok: false, reason, retry: true })

export function createChatLocal(opts: ChatLocalOpts = {}): ChatLocal {
  const roots = opts.profileRoots ?? defaultProfileRoots
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects')
  const importChat = opts.importChat ?? defaultImport
  const archiveChat = opts.archiveChat ?? defaultArchive
  const renameChat = opts.renameChat ?? defaultRename
  const isRunning = opts.isRunning ?? defaultIsRunning

  const projectOf = new Map<string, { project: string | null; at: number }>()
  let folders: string[] | null = null
  let foldersAt = 0

  const transcript = (project: string, sessionId: string): string | null =>
    isPlainName(project) && isUuid(sessionId)
      ? join(projectsDir, project, `${sessionId}.jsonl`)
      : null

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
      const parts = c.metaPath.split(/[\\/]/)
      const org = parts[parts.length - 2]
      const account = parts[parts.length - 3]
      if (!account || !org) continue
      let record: Record<string, unknown>
      if (c.archived) {
        const last = c.lastActivityAt ? Date.parse(c.lastActivityAt) : Number.NaN
        record = {
          ...(c.title ? { title: c.title } : {}),
          isArchived: true,
          ...(Number.isFinite(last) ? { lastActivityAt: last } : {}),
          ...(c.cwd ? { cwd: c.cwd } : {}),
        }
      } else {
        try {
          record = JSON.parse(readFileSync(c.metaPath, 'utf8')) as Record<string, unknown>
        } catch {
          continue
        }
      }
      const project = findProject(c.cliSessionId, c.cwd)
      out.push({
        id,
        sessionId: c.cliSessionId,
        project,
        account,
        org,
        record,
        archived: c.archived,
        size: project ? size(project, c.cliSessionId) : 0,
      })
    }
    return out
  }

  function size(project: string, sessionId: string): number {
    const path = transcript(project, sessionId)
    try {
      return path ? statSync(path).size : 0
    } catch {
      return 0
    }
  }

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

  function append(
    project: string,
    sessionId: string,
    expected: number,
    bytes: Uint8Array,
  ): boolean {
    const path = transcript(project, sessionId)
    if (!path || size(project, sessionId) !== expected) return false
    mkdirSync(join(projectsDir, project), { recursive: true })
    appendFileSync(path, bytes)
    return true
  }

  /** The profile signed into `account`, or null. */
  function profileFor(account: string): string | null {
    const want = account.toLowerCase()
    return roots().find((dir) => readLoginUuid(dir)?.toLowerCase() === want) ?? null
  }

  async function land(chat: IncomingChat): Promise<LandOutcome> {
    if (!isUuid(chat.sessionId)) return { ok: false, reason: 'not a session id', retry: false }
    const profile = profileFor(chat.account)
    if (!profile) return retry('no desktop profile on this PC is signed into that account')
    const title = typeof chat.record.title === 'string' ? chat.record.title.trim() : ''
    const there = collectChats([{ dir: profile, label: profile }]).find(
      (c) => !c.staleLogin && c.cliSessionId === chat.sessionId,
    )
    if (there) {
      if (chat.archived) {
        // Unarchive has no production path, so a copy already archived here stays as it is.
        if (there.archived) return { ok: true }
        const r = await archiveChat(profile, chat.sessionId)
        return r.ok ? { ok: true } : retry(r.reason ?? 'the archive was not confirmed')
      }
      // The incoming chat is live but this copy is archived: unarchive has no production path,
      // so the archived copy stays as it is (ok, not an error).
      if (title && there.title !== title && !there.archived) {
        if (!(await isRunning(profile)))
          return retry('its desktop app is closed here; it lands when that app runs')
        const r = await renameChat(profile, there.title ?? title, title)
        if (!r.ok) return retry(r.detail ?? 'the rename was not confirmed')
      }
      return { ok: true }
    }
    if (chat.archived) return { ok: true }
    if (!(await isRunning(profile)))
      return retry('its desktop app is closed here; it lands when that app runs')
    const r = await importChat({
      sessionId: chat.sessionId,
      instanceDir: profile,
      title,
      carried: pickCarriedSettings(chat.record),
      isInstanceRunning: isRunning,
    })
    return r.ok ? { ok: true } : retry(r.reason ?? 'the import was refused')
  }

  return { list, read, size, append, land }
}
