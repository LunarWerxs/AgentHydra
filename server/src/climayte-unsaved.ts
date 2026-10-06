// server/src/climayte-unsaved.ts — the files a worker changed and never committed, read when its check
// passes (climayte.ts judgeCheck). A check's exit code says the work runs; it says nothing about
// whether the work was saved. On 2026-10-05 a worker's check passed with 15 of its files uncommitted,
// and the task sat 'done' for 2h26m while the two tasks after it waited on work that was never in git.

import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tailText, transcriptCandidates, transcriptFile } from './climayte-core'
import type { CliMayteAccount, CliMayteWorker } from './climayte-lib'

/** The tools whose input names a file the session changed. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** How much of each transcript's end is read, and of all of a task's together, newest session first:
 *  a session of 555 MB exists, and the daemon's tick waits on this. */
const TRANSCRIPT_TAIL = 64 * 1024 * 1024
const TASK_READ_BUDGET = 128 * 1024 * 1024
/** A file changed later than this after the session's last write to it was changed by someone else
 *  (a peer worker in the same checkout, a formatter): it is not counted as this worker's. */
const PEER_SLACK_MS = 30_000
/** The most paths named in one `git status`, well under Windows' command-line limit. */
const PATHSPEC_CHUNK = 200

/** A task that says its changes stay uncommitted (the orchestrator commits them, or only a draft is
 *  wanted) is not held to a commit. */
const NO_COMMIT =
  /\b(?:do not|don't|never|without) (?:commit|committing)\b|\bleave [^.\n]{0,40}\buncommitted\b/i

/** Each file the transcript's Edit, Write, MultiEdit and NotebookEdit calls changed, absolute, with
 *  the time of the newest such call (ms; Infinity when its line has no timestamp). */
export function editedPaths(jsonl: string, cwd: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of jsonl.split('\n')) {
    if (!raw.includes('"tool_use"')) continue
    let rec: { timestamp?: unknown; message?: { content?: unknown } }
    try {
      rec = JSON.parse(raw)
    } catch {
      continue // the first line of a cut read, or a half-written last one
    }
    const content = rec.message?.content
    if (!Array.isArray(content)) continue
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN
    for (const c of content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
      if (c?.type !== 'tool_use' || !EDIT_TOOLS.has(String(c.name))) continue
      const input = (c.input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
      const p = input.file_path ?? input.notebook_path
      if (typeof p !== 'string' || !p) continue
      const abs = isAbsolute(p) ? p : resolve(cwd, p)
      const time = Number.isNaN(at) ? Number.POSITIVE_INFINITY : at
      out.set(abs, Math.max(out.get(abs) ?? 0, time))
    }
  }
  return out
}

/** A repo-relative path as compared: Windows paths differ only in case when they are the same file. */
const keyOf = (rel: string): string => (process.platform === 'win32' ? rel.toLowerCase() : rel)

/** A path as the filesystem names it, the form `git rev-parse --show-toplevel` prints: Windows' 8.3
 *  short names resolve (a GitHub runner's TEMP is C:\Users\RUNNER~1\..., while git says runneradmin,
 *  so every edit read as outside the repository and nothing was ever uncommitted: CI, 2026-10-06), as
 *  do macOS' /var -> /private/var and any junction or symlink. A path that is gone is kept as given;
 *  a file the session wrote that no longer exists is never counted anyway. */
function canonical(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  return r.status === 0 ? (r.stdout ?? '') : null
}

/** Of `edits` (from editedPaths), the ones inside `cwd`'s repository that git still shows changed or
 *  untracked and that nobody changed after the session's last write to them: repo-relative, sorted.
 *  Ignored files never show. [] outside a repository. */
export function uncommittedOf(cwd: string, edits: Map<string, number>): string[] {
  if (!edits.size) return []
  const shown = git(cwd, ['rev-parse', '--show-toplevel'])?.trim()
  if (!shown) return []
  const top = canonical(shown)
  const lastWrite = new Map<string, number>()
  const rels: string[] = []
  for (const [abs, at] of edits) {
    const rel = relative(top, canonical(abs)).replaceAll('\\', '/')
    if (!rel || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) continue
    lastWrite.set(keyOf(rel), at)
    rels.push(rel)
  }
  const dirty = new Set<string>()
  for (let i = 0; i < rels.length; i += PATHSPEC_CHUNK) {
    const out = git(top, [
      '--literal-pathspecs',
      'status',
      '--porcelain',
      '-z',
      '-uall',
      '--',
      ...rels.slice(i, i + PATHSPEC_CHUNK),
    ])
    if (out === null) return [] // git could not answer: no claim either way
    const parts = out.split('\0')
    for (let j = 0; j < parts.length; j++) {
      const e = parts[j] as string
      if (e.length < 4) continue
      dirty.add(e.slice(3))
      if (e[0] === 'R' || e[0] === 'C') j++ // a rename's source path follows it
    }
  }
  const left: string[] = []
  for (const rel of dirty) {
    const at = lastWrite.get(keyOf(rel))
    if (at === undefined) continue
    try {
      if (statSync(join(top, rel)).mtimeMs > at + PEER_SLACK_MS) continue
    } catch {
      continue // gone since: whoever removed it owns that
    }
    left.push(rel)
  }
  return left.sort()
}

/** The files the worker's sessions changed and never committed, in its folder's repository; [] for a
 *  task that says not to commit. */
export function unsavedEdits(w: CliMayteWorker, accounts: CliMayteAccount[]): string[] {
  if (NO_COMMIT.test(w.prompt)) return []
  const dirs = transcriptCandidates(w, accounts).map((c) => c.configDir)
  const edits = new Map<string, number>()
  let budget = TASK_READ_BUDGET
  for (const id of [...new Set([...(w.sessions ?? []), w.sessionId])].reverse()) {
    if (!id || budget <= 0) continue
    for (const dir of dirs) {
      const file = transcriptFile(dir, id)
      if (!file) continue
      const text = tailText(file, Math.min(TRANSCRIPT_TAIL, budget))
      budget -= Buffer.byteLength(text)
      for (const [p, at] of editedPaths(text, w.cwd)) edits.set(p, Math.max(edits.get(p) ?? 0, at))
      break
    }
  }
  return uncommittedOf(w.cwd, edits)
}
