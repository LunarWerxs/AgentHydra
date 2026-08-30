// server/src/ui-archive.ts - the SERVER-SIDE invocation of the app's own Archive click
// (misc/Manage-DesktopChat.ps1). Owner ruling 2026-08-30 ("I will defer to your recommendation
// and say yes"): when auto-archive writes a flag under a RUNNING app, the server itself retires
// the row through the app's UI - immediate and durable, because the app makes the write - so
// the chat leaves the sidebar now, not at some future restart.
//
// SAFETY RAILS, each one bought by a measured failure:
//   - The tool acts on RENDERED titles, and a rendered title is an IN-MEMORY name that can
//     differ from the disk title (the piece-9 drill: disk said the real name, the sidebar said
//     'General coding session'). So the click fires only when the chat's DISK title is a real
//     name that the sidebar actually renders - and the hazard that matters is a DIFFERENT chat
//     sharing the title, which DISK answers: if more than one metadata file in the store
//     carries this title, refuse. The same chat rendered in two sidebar sections (measured
//     live: one import rendered twice) is safe - every matching row is the one chat.
//   - After a click that the tool reports as done, the archive is verified BY ID on disk (the
//     app's own archive re-saves the metadata), because verified-by-title is the mistake the
//     drill-cleanup lesson exists to prevent. A chat already archived on disk with no rendered
//     row is reported as settled, not as a failure.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isGenericChatTitle } from './chat-title'
import { findChatMetaPath } from './session-launch'

const PS1 = join(import.meta.dir, '..', '..', 'misc', 'Manage-DesktopChat.ps1')
const SPAWN_TIMEOUT_MS = 90_000

async function runPs1(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(
    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
    // A console spawn: windowsHide required (repo guardrail - only GUI spawns stay visible).
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', windowsHide: true },
  )
  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS)
  try {
    // Stderr rides along: the PS1 runs under ErrorActionPreference=Stop, so a UIA call that
    // throws (window closed mid-click) puts the only real diagnostic on stderr - dropping it
    // reported bare 'exited 1' with nothing to act on (review-confirmed).
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, out: err.trim() ? `${out}\n${err}` : out }
  } finally {
    clearTimeout(timer)
  }
}

/** Parse the PS1 -List output into rendered titles VERBATIM: exactly the two-space indent is
 *  stripped, nothing else - a title's own leading/trailing whitespace is part of the app's
 *  accessible name and trimming it made the later exact-name click miss (review-confirmed).
 *  Exported pure for tests. */
export function parseListOutput(out: string): string[] {
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('  '))
    .map((l) => l.slice(2))
    .filter((l) => l.trim().length > 0)
}

/** The titles the instance's sidebar currently RENDERS (in-memory names, not disk names). */
async function listRenderedTitles(profileDir: string): Promise<string[]> {
  const { code, out } = await runPs1(['-List', '-Instance', profileDir])
  if (code !== 0) return []
  return parseListOutput(out)
}

function diskTitleOf(profileDir: string, sessionId: string): string | null {
  const p = findChatMetaPath(profileDir, sessionId)
  if (!p) return null
  try {
    const meta = JSON.parse(readFileSync(p, 'utf8'))
    // VERBATIM, not trimmed: the app renders the stored string exactly, and the exact-name
    // UIA lookup needs the same bytes. Only an effectively-empty title is a null.
    return typeof meta.title === 'string' && meta.title.trim() ? meta.title : null
  } catch {
    return null
  }
}

function diskArchivedOf(profileDir: string, sessionId: string): boolean | null {
  const p = findChatMetaPath(profileDir, sessionId)
  if (!p) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')).isArchived === true
  } catch {
    return null
  }
}

/** How many chats in this profile's store carry `title` on disk, ANY archive state. More than
 *  one means a rendered row with that title is ambiguous and must not be clicked. */
function diskTitleCountOf(profileDir: string, title: string): number {
  let n = 0
  try {
    const storeDir = join(profileDir, 'claude-code-sessions')
    for (const org of readdirSync(storeDir, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const user of readdirSync(join(storeDir, org.name), { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        const dir = join(storeDir, org.name, user.name)
        for (const f of readdirSync(dir)) {
          if (!f.startsWith('local_') || !f.endsWith('.json')) continue
          try {
            const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'))
            if (meta.title === title) n++
          } catch {
            // one unreadable file says nothing about the others
          }
        }
      }
    }
  } catch {
    // no readable store: 0 forces the caller's not-rendered/ambiguity handling
  }
  return n
}

export interface UiArchiveOutcome {
  /** The app's own Archive action fired and the tool saw the row leave the sidebar. */
  clicked: boolean
  /** The chat is settled: archived BY ID on disk with no rendered row left (a confirmed
   *  click, or found already retired). This is the bit the caller's durability reads. */
  verified: boolean
  reason?: string
}

export interface UiArchiveDeps {
  list?: (profileDir: string) => Promise<string[]>
  invoke?: (profileDir: string, title: string) => Promise<{ code: number; out: string }>
  readTitle?: (profileDir: string, sessionId: string) => string | null
  readArchived?: (profileDir: string, sessionId: string) => boolean | null
  /** How many chats in the profile's store carry this title on disk, any archive state. */
  readTitleCount?: (profileDir: string, title: string) => number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export async function uiArchiveChat(
  profileDir: string,
  sessionId: string,
  deps: UiArchiveDeps = {},
): Promise<UiArchiveOutcome> {
  const list = deps.list ?? listRenderedTitles
  const invoke =
    deps.invoke ??
    ((dir: string, title: string) =>
      runPs1(['-Title', title, '-Instance', dir, '-Action', 'Archive']))
  const readTitle = deps.readTitle ?? diskTitleOf
  const readArchived = deps.readArchived ?? diskArchivedOf
  const readTitleCount = deps.readTitleCount ?? diskTitleCountOf
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now

  const title = readTitle(profileDir, sessionId)
  if (title === null || isGenericChatTitle(title))
    return {
      clicked: false,
      verified: false,
      reason:
        'the chat has no real disk title to match a rendered row by - clicking a generic row ' +
        'could hit the wrong chat',
    }
  const rendered = await list(profileDir)
  const matches = rendered.filter((t) => t === title)
  if (matches.length === 0) {
    // No row to click. If the disk flag is already set, the chat is settled - already retired
    // (this is also what an idempotent re-act sees after a successful click).
    if (readArchived(profileDir, sessionId) === true)
      return {
        clicked: false,
        verified: true,
        reason: 'already archived on disk and no rendered row remains - settled',
      }
    return {
      clicked: false,
      verified: false,
      reason: `the sidebar does not render '${title}' (in-memory name differs, or the row is scrolled out) - the flag sticks at that instance's next restart`,
    }
  }
  // The hazard is a DIFFERENT chat sharing this title; disk answers that. The same chat
  // rendered in two sidebar sections (measured live) is safe - every matching row is it.
  const holders = readTitleCount(profileDir, title)
  if (holders > 1)
    return {
      clicked: false,
      verified: false,
      reason: `${holders} chats in this profile's store carry the title '${title}' - clicking by title could archive the wrong one`,
    }
  const { code, out } = await invoke(profileDir, title)
  // Exit 0 = row left the sidebar; exit 2 = Archive was INVOKED but the row still rendered at
  // the script's fixed check - which can simply be the app removing it a beat late, so the
  // disk poll below settles both rather than calling 2 a hard failure (review-confirmed).
  if (code !== 0 && code !== 2)
    return {
      clicked: false,
      verified: false,
      reason: `the UI archive tool exited ${code}: ${out.trim().split('\n').pop() ?? ''}`,
    }
  // Confirm by ID that the app's re-save carries the flag. Brief poll: the app writes its
  // store asynchronously after the click.
  const deadline = now() + 5000
  for (;;) {
    if (readArchived(profileDir, sessionId) === true) return { clicked: true, verified: true }
    if (now() >= deadline) break
    await sleep(500)
  }
  return {
    clicked: true,
    verified: false,
    reason:
      code === 2
        ? 'Archive was invoked but the row was still rendered and the disk flag did not ' +
          'confirm within 5s - re-check via the dossier, do not blind-retry'
        : 'the app archived the row (it left the sidebar) but the disk flag did not confirm ' +
          'within 5s - re-check via the dossier',
  }
}
