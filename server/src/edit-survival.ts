// server/src/edit-survival.ts - how much of the code an agent wrote is still in the file later.
//
// WHY: the analytics tab can say what a session cost and how long it ran, but not whether its work
// was kept. Re-reading the files a session edited some hours after it stopped, and asking how much
// of the text it wrote is still there, is a cheap and language-agnostic quality signal: no model
// judges anything, and nothing but a number is stored.
//
// The idea follows the edit-survival tracker in VS Code's Copilot extension (MIT): score an AI edit
// by the share of its 4-grams (four-character substrings) still present later. This is a fresh
// implementation with one deliberate difference. VS Code composes every later keystroke onto the
// edited RANGE; a transcript has no ranges, only the text the agent wrote and a path. So this asks
// "is what the agent wrote still in the file anywhere", a containment measure, which also survives
// the edit being moved or the file being reformatted around it.
//
// WHAT IT DOES NOT MEASURE. A user who reverts an edit and a later agent that rewrites it both lower
// the score; the session's OWN later rewrites do not (see liveWrites). A file that no longer exists
// is skipped rather than scored 0: agents delete their own scratch files, and a rename is not a
// rejection.

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathKey } from './path-key'

/** One piece of text an edit tool wrote, held only for the length of one scan. */
export interface AgentWrite {
  path: string
  /** What the tool wrote: `new_string` (one per MultiEdit entry), `content` or `new_source`. */
  text: string
  /** What an Edit replaced (`old_string`), so a later edit can be seen consuming an earlier one. */
  replaced: string | null
  /** A whole-file write, which supersedes every earlier write to the same path. */
  whole: boolean
  ts: number | null
}

export interface EditSurvival {
  /** 0..1, the share of the session's written 4-grams still present. Null when nothing was measured. */
  score: number | null
  /** Writes that were actually scored against a file on disk. */
  measured: number
  /** When the session becomes old enough to measure. Null once measured, or when it never will be. */
  dueAt: number | null
}

/**
 * How long after its last write a session is left alone before it is measured.
 *
 * Measured too soon, every session scores 100%: nobody has had time to review, revert or rewrite
 * anything. Two hours is long enough for the same-day review pass, short enough that the number is
 * still about THIS session rather than about everything that happened to the file since.
 */
export const SURVIVAL_MIN_AGE_MS = 2 * 60 * 60_000

/**
 * A session first measured later than this is not measured at all. A file a month on has been
 * rewritten for a dozen unrelated reasons, and a low score then says nothing about the session;
 * leaving it blank keeps the scores that do exist comparable with each other.
 */
export const SURVIVAL_MAX_AGE_MS = 14 * 24 * 60 * 60_000

/** Shorter inserts (a renamed identifier, a flipped flag) carry too few 4-grams to mean anything. */
const MIN_TEXT_CHARS = 24
/** Bounds on what one scan may hold in memory. The scan runs over every transcript in the store. */
export const MAX_WRITES = 200
const MAX_TEXT_CHARS = 32_000
const MAX_FILE_BYTES = 4 * 1024 * 1024
/** A later edit whose `old_string` holds at least this share of an earlier write consumed it. */
const CONSUMED_SHARE = 0.5

const N = 4

/** Line endings are unified first: git's autocrlf can rewrite every line of a file the agent wrote
 *  with `\n`, and that would read as the whole edit being gone. */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** The multiset of `text`'s 4-grams. */
export function fourGrams(text: string): Map<string, number> {
  const t = normalize(text)
  const grams = new Map<string, number>()
  for (let i = 0; i + N <= t.length; i++) {
    const g = t.slice(i, i + N)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  return grams
}

/**
 * Of `written`'s 4-grams, how many are still in `now` (counted with multiplicity), and how many
 * there were. A text shorter than one 4-gram has nothing to count.
 */
export function fourGramOverlap(
  written: string,
  now: Map<string, number>,
): { kept: number; total: number } {
  let kept = 0
  let total = 0
  for (const [g, count] of fourGrams(written)) {
    total += count
    kept += Math.min(count, now.get(g) ?? 0)
  }
  return { kept, total }
}

/** `fourGramOverlap` as a share, 1 for an empty text (nothing was lost). */
export function fourGramContainment(written: string, now: Map<string, number>): number {
  const { kept, total } = fourGramOverlap(written, now)
  return total === 0 ? 1 : kept / total
}

/**
 * The writes the session did not itself overwrite later.
 *
 * An agent that writes a function and then edits it twice has not had its first version rejected;
 * scoring that first version against the file would call the session's own iteration a failure.
 * So a write is dropped when a later write to the same path replaced the whole file, or when a
 * later edit's `old_string` is mostly made of it.
 */
export function liveWrites(writes: AgentWrite[]): AgentWrite[] {
  const live: AgentWrite[] = []
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i]
    if (!w) continue
    const key = pathKey(w.path)
    let superseded = false
    for (let j = i + 1; j < writes.length && !superseded; j++) {
      const later = writes[j]
      if (!later || pathKey(later.path) !== key) continue
      if (later.whole) superseded = true
      else if (later.replaced)
        superseded = fourGramContainment(w.text, fourGrams(later.replaced)) >= CONSUMED_SHARE
    }
    if (!superseded) live.push(w)
  }
  return live
}

/**
 * Record what one edit tool call wrote, if it wrote enough to be worth scoring.
 * `input` is the tool call's own input object; nothing else is read.
 */
export function captureWrite(
  writes: AgentWrite[],
  path: string,
  input: unknown,
  ts: number | null,
): void {
  if (writes.length >= MAX_WRITES || !input || typeof input !== 'object') return
  const rec = input as Record<string, unknown>
  // MultiEdit carries its replacements in `edits[]`, each shaped like one Edit call.
  if (Array.isArray(rec.edits)) {
    for (const e of rec.edits) captureWrite(writes, path, e, ts)
    return
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const content = str(rec.content)
  const text = str(rec.new_string) || content || str(rec.new_source)
  if (text.trim().length < MIN_TEXT_CHARS) return
  const replaced = str(rec.old_string)
  writes.push({
    path,
    text: text.slice(0, MAX_TEXT_CHARS),
    replaced: replaced ? replaced.slice(0, MAX_TEXT_CHARS) : null,
    whole: content.length > 0 && !replaced,
    ts,
  })
}

async function readGrams(path: string): Promise<Map<string, number> | null> {
  try {
    const s = await stat(path)
    if (!s.isFile() || s.size > MAX_FILE_BYTES) return null
    return fourGrams(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Score a session's writes against the files as they are on disk now.
 *
 * Weighted by 4-gram count, so a 300-line module that survived is not outvoted by a one-line tweak
 * that did not. Relative paths are skipped: the transcript does not say what they were relative to.
 */
export async function measureEditSurvival(
  writes: AgentWrite[],
  now = Date.now(),
): Promise<EditSurvival> {
  if (writes.length === 0) return { score: null, measured: 0, dueAt: null }
  let last: number | null = null
  for (const w of writes) if (w.ts !== null && (last === null || w.ts > last)) last = w.ts
  if (last !== null && now - last < SURVIVAL_MIN_AGE_MS)
    return { score: null, measured: 0, dueAt: last + SURVIVAL_MIN_AGE_MS }
  if (last !== null && now - last > SURVIVAL_MAX_AGE_MS)
    return { score: null, measured: 0, dueAt: null }

  const files = new Map<string, Map<string, number> | null>()
  let kept = 0
  let total = 0
  let measured = 0
  for (const w of liveWrites(writes)) {
    if (!isAbsolute(w.path)) continue
    const key = pathKey(w.path)
    if (!files.has(key)) files.set(key, await readGrams(w.path))
    const grams = files.get(key)
    if (!grams) continue
    const o = fourGramOverlap(w.text, grams)
    if (o.total === 0) continue
    kept += o.kept
    total += o.total
    measured++
  }
  return { score: total > 0 ? kept / total : null, measured, dueAt: null }
}
