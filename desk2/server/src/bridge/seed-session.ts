// A Claude Code session is a file: <config dir>/projects/<encoded cwd>/<session id>.jsonl. Resuming it
// under a login means that login's config folder holds the file, and a session Claude Desktop or a
// terminal ran lives in whichever folder that tool wrote to, usually the default ~/.claude. Resuming
// from a different folder fails with "No conversation found". So before a chat resumes a session its
// account's folder does not have, the transcript is copied there (a fork: the original is untouched,
// each side continues on its own). The copy is asynchronous: a session file of hundreds of MB must not
// hold up the server while it copies.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { copyFile, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { encodeProjectDir, findSessionJsonl, readTail, TAIL_BYTES } from './session-jsonl'

export type SeedResult =
  | { status: 'present' } // the account's folder already has the session
  | { status: 'copied'; from: string; to: string }
  | { status: 'refreshed'; from: string; to: string } // its older copy there was brought up to date
  | { status: 'missing' } // no folder on this machine has it: the resume will say so

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** The projects folder of a login's config folder (null = the default ~/.claude). */
export function projectsRoot(configDir: string | null, home = homedir()): string {
  return join(configDir ?? join(home, '.claude'), 'projects')
}

/**
 * Makes `sessionId`'s transcript available under `configDir` (null = the default ~/.claude), copying it
 * from `prefer` (the projects folder the chat last ran in, which holds its latest turns) when that has
 * it, else from the newest copy in `roots`. The copy keeps the source's project folder name, so it sits
 * where the same cwd would put it. A copy already there is replaced only when it is an older version of
 * the same transcript (the source is newer and starts with its bytes): a chat that moved A -> B -> A
 * then resumes with the turns it ran on B. A copy that went its own way is never overwritten. The
 * session's sidecar folder goes along, its missing files also into a copy already there (copySidecar).
 */
export async function seedSession(sessionId: string, cwd: string | null, configDir: string | null, roots: string[], home = homedir(), prefer: string | null = null): Promise<SeedResult> {
  const target = projectsRoot(configDir, home)
  const preferred = prefer && !same(prefer, target) ? findSessionJsonl(sessionId, [prefer], cwd) : null
  const source =
    preferred ??
    findSessionJsonl(
      sessionId,
      roots.filter((r) => !same(r, target)),
      cwd,
    )
  const have = findSessionJsonl(sessionId, [target], cwd)
  // The sidecar goes first and the transcript last, so a transcript in the target marks a copy that
  // finished. A sidecar left short (a copy that failed partway, or one made before sidecars went along)
  // is finished on a later call: copySidecar never overwrites, so running it again is safe.
  if (have) {
    if (!source) return { status: 'present' }
    await copySidecar(source, have, sessionId)
    if (!(await olderVersionOf(have, source))) return { status: 'present' }
    await copyThrough(source, have)
    return { status: 'refreshed', from: source, to: have }
  }
  if (!source) return { status: 'missing' }
  const dir = join(target, basename(dirname(source)))
  const to = join(dir, `${sessionId}.jsonl`)
  await copySidecar(source, to, sessionId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  await copyThrough(source, to)
  return { status: 'copied', from: source, to }
}

/**
 * Claude Code resumes a session from the project folder of the cwd it starts in. A chat that moved to
 * another folder (the model cd'd out of the old one) still has its transcript under the old folder's name,
 * so before it resumes in the new one the transcript is copied under the new folder's name, in the same
 * config folder. The original stays; an older copy already there (the chat went back) is brought up to
 * date, one that went its own way is left alone. 'present' when `cwd`'s folder already has it.
 */
export async function placeInCwd(sessionId: string, cwd: string, configDir: string | null, home = homedir()): Promise<SeedResult> {
  const root = projectsRoot(configDir, home)
  const dir = join(root, encodeProjectDir(cwd))
  const to = join(dir, `${sessionId}.jsonl`)
  const elsewhere = findSessionJsonl(sessionId, [root], null)
  const have = existsSync(to) ? to : null
  const source = elsewhere && !same(elsewhere, to) ? elsewhere : null
  if (have) {
    if (!source || !(await olderVersionOf(have, source))) return { status: 'present' }
    await copySidecar(source, have, sessionId)
    await copyThrough(source, have)
    return { status: 'refreshed', from: source, to }
  }
  if (!source) return { status: 'missing' }
  await copySidecar(source, to, sessionId)
  mkdirSync(dir, { recursive: true })
  await copyThrough(source, to)
  return { status: 'copied', from: source, to }
}

let copies = 0

/** Copies through a temp name of its own, so a crash mid-copy never leaves half a file that later looks done. */
async function copyThrough(from: string, to: string): Promise<void> {
  const tmp = `${to}.${process.pid}.${++copies}.tmp`
  try {
    await copyFile(from, tmp)
    await rename(tmp, to)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/**
 * The folder beside a transcript named like the session (subagents/, tool-results/, workflows/,
 * custom-title.json) holds what the transcript alone lacks: the sub-agents' own transcripts above all.
 * Its files the target lacks are copied, none overwritten; a session without one is fine. The transcript
 * names tool-result and workflow files by absolute path into the source folder and is left as written.
 */
async function copySidecar(fromJsonl: string, toJsonl: string, sessionId: string): Promise<void> {
  const from = join(dirname(fromJsonl), sessionId)
  if (existsSync(from)) await copyMissing(from, join(dirname(toJsonl), sessionId))
}

async function copyMissing(from: string, to: string): Promise<void> {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) await copyMissing(src, dst)
    else if (entry.isFile() && !existsSync(dst)) {
      mkdirSync(to, { recursive: true })
      await copyThrough(src, dst)
    }
  }
}

/** True when `newer` was written after `older`, is longer, and starts with every byte of it. */
async function olderVersionOf(older: string, newer: string): Promise<boolean> {
  const a = statSync(older)
  const b = statSync(newer)
  if (!(b.mtimeMs > a.mtimeMs) || b.size <= a.size) return false
  const fa = await open(older, 'r')
  try {
    const fb = await open(newer, 'r')
    try {
      const bufA = Buffer.alloc(1024 * 1024)
      const bufB = Buffer.alloc(bufA.length)
      for (let pos = 0; pos < a.size; ) {
        const want = Math.min(bufA.length, a.size - pos)
        const { bytesRead: na } = await fa.read(bufA, 0, want, pos)
        const { bytesRead: nb } = await fb.read(bufB, 0, want, pos)
        if (na <= 0 || na !== nb || !bufA.subarray(0, na).equals(bufB.subarray(0, nb))) return false
        pos += na
      }
      return true
    } finally {
      await fb.close()
    }
  } finally {
    await fa.close()
  }
}

/**
 * Where a fork of `sessionId` cuts it: the uuid of the last chain entry in its newest transcript in
 * `roots`, or null (no file, or no entry yet). The SDK reads the source at the fork's first send, so
 * without the cut a fork would take in the turns the source ran after it was forked. Reads the file's
 * end only: a short tail first, the long one only when the last entries are bigger than that.
 */
export function forkPoint(sessionId: string, cwd: string | null, roots: string[]): string | null {
  const file = findSessionJsonl(sessionId, roots, cwd)
  if (!file) return null
  const size = statSync(file).size
  for (const max of [64 * 1024, TAIL_BYTES]) {
    const lines = readTail(file, max).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line) as { uuid?: unknown; parentUuid?: unknown; isSidechain?: unknown }
        // A chain entry has a parentUuid (null on the first); summaries and snapshots have none.
        if (typeof rec.uuid === 'string' && 'parentUuid' in rec && rec.isSidechain !== true) return rec.uuid
      } catch {
        // the tail's first line may be cut
      }
    }
    if (size <= max) break
  }
  return null
}

/** Where a fork that leaves out one of the owner's messages may cut a transcript (cutsBefore). */
export interface Cuts {
  /** The entry before the one whose uuid is the message's id: null when that one opened the session, undefined when no entry has it. */
  byId: string | null | undefined
  /** The entry before each of the owner's prompts whose text is the message's, oldest first. */
  exact: (string | null)[]
  /** The same for prompts that hold its text among more (a merged or annotated prompt). */
  loose: (string | null)[]
}

const squashText = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Reads a whole transcript for the entry before the owner's message `id` (a fork at it resumes there,
 * resumeSessionAt, and so leaves the message out). Hydra Desk names a message by its entry's uuid
 * (`<uuid>:<n>` for a part of a split one); an older one, or a queued message merged into the turn, only
 * by its text, so those prompts are listed too and the caller picks among them.
 */
export function cutsBefore(file: string, id: string, text: string): Cuts {
  const uuid = id.split(':')[0]!
  const want = squashText(text)
  const cuts: Cuts = { byId: undefined, exact: [], loose: [] }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!(uuid && line.includes(uuid)) && !(want && line.includes('"type":"user"'))) continue
    let rec: { type?: unknown; uuid?: unknown; parentUuid?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { content?: unknown } }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.isSidechain === true) continue
    const parent = typeof rec.parentUuid === 'string' ? rec.parentUuid : null
    if (uuid && rec.uuid === uuid) return { byId: parent, exact: [], loose: [] }
    if (rec.type !== 'user' || rec.isMeta === true || !want) continue
    const said = promptText(rec.message?.content)
    if (said === null) continue
    if (said === want) cuts.exact.push(parent)
    else if (said.includes(want)) cuts.loose.push(parent)
  }
  return cuts
}

/** A user entry's text when the owner wrote it (a string, or text and picture blocks), squashed; null for a tool result. */
function promptText(content: unknown): string | null {
  if (typeof content === 'string') return squashText(content)
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block?.type === 'tool_result') return null
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return squashText(parts.join('\n'))
}
