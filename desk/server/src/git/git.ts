// Git for the bar above the composer and the diff pane (SPEC.md REST rows /api/git, /api/git/diff).
// Every git call is spawned without a shell, with a 5 second timeout, and never opens a window.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { GitFileChange, GitStatus } from '@shared/protocol'

export const GIT_TIMEOUT_MS = 5000
export const MAX_FILES = 500
export const MAX_DIFF_BYTES = 200 * 1024
/** Untracked files bigger than this are not read to count their lines. */
const MAX_COUNT_BYTES = 8 * 1024 * 1024
/** Bytes looked at to decide whether an untracked file is binary (git's own rule: a NUL byte). */
const BINARY_SNIFF_BYTES = 8000
/** status and numstat output is read up to this much; beyond it the repo is not one to list anyway. */
const MAX_LIST_BYTES = 32 * 1024 * 1024

/**
 * GitStatus plus what the cap left out. The contract's GitStatus has no field for it, so these ride
 * along as extra JSON fields: `truncated` is true when files lists only the first MAX_FILES of
 * `totalFiles` changed paths.
 */
export interface GitStatusResult extends GitStatus {
  truncated: boolean
  totalFiles: number
}

/** A git call that failed in a way the caller should answer as a 4xx (bad cwd, bad path, timeout). */
export class GitError extends Error {}

interface RunResult {
  code: number
  stdout: Buffer
  stderr: string
  /** stdout went past maxBytes and the process was stopped there. */
  capped: boolean
}

interface RunOptions {
  maxBytes?: number
  stdin?: string
}

const GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0', // status must not take index.lock while Jacob's own git works in the repo
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1', // a file named '*.ts' or ':x' is that file, not a pattern
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number, onCap: () => void) {
  const chunks: Uint8Array[] = []
  let size = 0
  let capped = false
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (capped) continue
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size))
      size = maxBytes
      capped = true
      onCap()
      continue
    }
    chunks.push(value)
    size += value.length
  }
  return { buf: Buffer.concat(chunks), capped }
}

/** Runs `git <args>` in cwd: no shell, no window, killed after GIT_TIMEOUT_MS. */
export async function runGit(cwd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args]
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['git', ...fullArgs], {
      cwd,
      env: GIT_ENV,
      stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
  } catch (err) {
    throw new GitError(`could not start git in ${cwd}: ${(err as Error).message}`)
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, GIT_TIMEOUT_MS)
  try {
    const [out, err, code] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array>, opts.maxBytes ?? MAX_LIST_BYTES, () => proc.kill()),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    if (timedOut) throw new GitError(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s in ${cwd}`)
    return { code, stdout: out.buf, stderr: err.trim(), capped: out.capped }
  } finally {
    clearTimeout(timer)
  }
}

function assertDir(cwd: string): string {
  if (!cwd) throw new GitError('cwd is required')
  if (!isAbsolute(cwd)) throw new GitError(`cwd must be an absolute path: ${cwd}`)
  const abs = resolve(cwd)
  let isDir = false
  try {
    isDir = statSync(abs).isDirectory()
  } catch (err) {
    throw new GitError(`no such folder: ${abs} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`)
  }
  if (!isDir) throw new GitError(`not a folder: ${abs}`)
  return abs
}

/** The repo's top folder, or null when cwd is not inside a work tree. */
async function repoRoot(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (r.code !== 0) return null
  const top = r.stdout.toString('utf8').trim()
  return top ? resolve(top) : null
}

/** How long a folder's answer from repoRoot is reused. The composer asks every 5 seconds per open
 *  chat, and a folder rarely becomes or stops being a repo. */
const ROOT_TTL_MS = 60_000
const roots = new Map<string, { root: string | null; at: number }>()

async function cachedRepoRoot(dir: string): Promise<string | null> {
  const hit = roots.get(dir)
  if (hit && Date.now() - hit.at < ROOT_TTL_MS && (hit.root === null || existsSync(join(hit.root, '.git'))))
    return hit.root
  const root = await repoRoot(dir)
  roots.set(dir, { root, at: Date.now() })
  return root
}

async function headSha(root: string): Promise<string | null> {
  const r = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.code === 0 ? r.stdout.toString('utf8').trim() : null
}

/** The empty tree's id in this repo's hash (sha1 or sha256), to diff against when there is no commit yet. */
async function emptyTree(root: string): Promise<string> {
  const r = await runGit(root, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '' })
  if (r.code !== 0) throw new GitError(`git hash-object failed: ${r.stderr}`)
  return r.stdout.toString('utf8').trim()
}

interface PorcelainEntry {
  path: string
  status: string
}

/** What one `git status --porcelain=v2 --branch -z` tells: the branch headers and the entries. */
export interface PorcelainV2 {
  /** The commit HEAD is at; null before the first commit. */
  head: string | null
  /** The branch name; null when HEAD is detached. */
  branch: string | null
  ahead: number
  behind: number
  entries: PorcelainEntry[]
}

/** Fields before the path in each v2 record kind: `1 XY sub mH mI mW hH hI path`, `2 ... Xscore path`
 *  (then the old path as the next part), `u XY sub m1 m2 m3 mW h1 h2 h3 path`. */
const V2_FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10 }

/** Parses `git status --porcelain=v2 --branch -z`. One call answers what used to take rev-parse,
 *  symbolic-ref and rev-list as well. */
export function parsePorcelainV2Z(out: string): PorcelainV2 {
  const parsed: PorcelainV2 = { head: null, branch: null, ahead: 0, behind: 0, entries: [] }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (rec.startsWith('# ')) {
      const space = rec.indexOf(' ', 2)
      const key = rec.slice(2, space)
      const value = rec.slice(space + 1)
      if (key === 'branch.oid') parsed.head = value === '(initial)' ? null : value
      else if (key === 'branch.head') parsed.branch = value === '(detached)' ? null : value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          parsed.ahead = Number(m[1])
          parsed.behind = Number(m[2])
        }
      }
      continue
    }
    if (rec.startsWith('? ')) {
      parsed.entries.push({ path: rec.slice(2), status: '??' })
      continue
    }
    const fields = V2_FIELDS[rec[0]]
    if (!fields) continue // `! path` (ignored) or the empty tail
    let at = 0
    for (let n = 0; n < fields; n++) at = rec.indexOf(' ', at) + 1
    if (rec[0] === '2') i++ // the next part is the old path
    const x = rec[2]
    const y = rec[3]
    parsed.entries.push({ path: rec.slice(at), status: rec[0] === 'u' ? 'U' : x !== '.' ? x : y })
  }
  return parsed
}

/** Parses `git diff --numstat -z`: `a\tr\tpath\0`, renames `a\tr\t\0from\0to\0`, binary `-\t-\t...`. */
export function parseNumstatZ(out: string): Map<string, { added: number; removed: number }> {
  const parts = out.split('\0')
  const map = new Map<string, { added: number; removed: number }>()
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec)
    if (!m) continue
    let path = m[3]
    if (path === '') {
      // rename or copy: old path, then new path
      path = parts[i + 2] ?? ''
      i += 2
    }
    map.set(path, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) })
  }
  return map
}

/** Lines in a text file the way git counts them; 0 for a binary, unreadable or huge file. */
export function countTextLines(file: string): number {
  let fd: number
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size === 0 || st.size > MAX_COUNT_BYTES) return 0
    fd = openSync(file, 'r')
  } catch {
    return 0
  }
  try {
    const buf = Buffer.alloc(64 * 1024)
    let lines = 0
    let last = -1
    let offset = 0
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      const view = buf.subarray(0, n)
      if (offset < BINARY_SNIFF_BYTES && view.subarray(0, BINARY_SNIFF_BYTES - offset).includes(0)) return 0
      for (let i = 0; i < n; i++) if (view[i] === 10) lines++
      last = view[n - 1]
      offset += n
    }
    if (offset > 0 && last !== 10) lines++
    return lines
  } catch {
    return 0
  } finally {
    closeSync(fd)
  }
}

function notRepo(): GitStatusResult {
  return { isRepo: false, branch: null, ahead: 0, behind: 0, added: 0, removed: 0, files: [], truncated: false, totalFiles: 0 }
}

/**
 * The working tree against HEAD. isRepo false for a folder outside any repo. files is capped at
 * MAX_FILES (truncated/totalFiles say so); added/removed total every tracked change plus the lines
 * of the untracked text files that made the list.
 */
export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  const dir = assertDir(cwd)
  const root = await cachedRepoRoot(dir)
  if (!root) return notRepo()
  // Every open composer polls; two asking about one repo at once share one run.
  let run = running.get(root)
  if (!run) {
    run = readStatus(root).finally(() => running.delete(root))
    running.set(root, run)
  }
  return run
}

const running = new Map<string, Promise<GitStatusResult>>()

/** Above this many changed paths the numstat is not memoized: stat-ing them all costs more than it saves. */
const MAX_MEMO_ENTRIES = 2000

/**
 * The last numstat and untracked line counts per repo, keyed by what decides them. `git diff
 * --numstat <HEAD> --` compares HEAD with the working tree, and every tracked path that differs is
 * in status; so while HEAD, those paths' statuses and their files' size and mtime are unchanged,
 * the numstat is too, and the poll costs one git process instead of two.
 */
const memos = new Map<
  string,
  { key: string; counts: Map<string, { added: number; removed: number }>; lines: Map<string, { stamp: string; lines: number }> }
>()

function stampOf(file: string): string {
  try {
    const st = statSync(file)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return '-'
  }
}

async function readStatus(root: string): Promise<GitStatusResult> {
  const status = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  if (status.code !== 0) throw new GitError(`git status failed: ${status.stderr}`)
  const { head, branch: name, ahead, behind, entries } = parsePorcelainV2Z(status.stdout.toString('utf8'))
  let branch = name
  if (branch === null && head) {
    const short = await runGit(root, ['rev-parse', '--short', 'HEAD'])
    branch = (short.code === 0 && short.stdout.toString('utf8').trim()) || head.slice(0, 7)
  }

  const memo = memos.get(root)
  const stamps = new Map<string, string>()
  const tracked = entries.filter((e) => e.status !== '??')
  let key: string | null = null
  if (entries.length <= MAX_MEMO_ENTRIES) {
    for (const e of entries) stamps.set(e.path, stampOf(join(root, e.path)))
    key = `${head}\0${tracked.map((e) => `${e.status}\t${e.path}\t${stamps.get(e.path)}`).join('\0')}`
  }
  let counts: Map<string, { added: number; removed: number }>
  if (tracked.length === 0) counts = new Map()
  else if (key !== null && memo?.key === key) counts = memo.counts
  else {
    const base = head ?? (await emptyTree(root))
    const numstat = await runGit(root, ['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', base, '--'])
    if (numstat.code !== 0) throw new GitError(`git diff --numstat failed: ${numstat.stderr}`)
    counts = parseNumstatZ(numstat.stdout.toString('utf8'))
  }
  const listed = entries.slice(0, MAX_FILES)

  let added = 0
  let removed = 0
  for (const c of counts.values()) {
    added += c.added
    removed += c.removed
  }
  const lines = new Map<string, { stamp: string; lines: number }>()
  const files: GitFileChange[] = listed.map((e) => {
    if (e.status === '??') {
      const stamp = stamps.get(e.path)
      const known = stamp ? memo?.lines.get(e.path) : undefined
      const n = known && known.stamp === stamp ? known.lines : countTextLines(join(root, e.path))
      if (stamp) lines.set(e.path, { stamp, lines: n })
      added += n
      return { path: e.path, status: '??', added: n, removed: 0 }
    }
    const c = counts.get(e.path)
    return { path: e.path, status: e.status, added: c?.added ?? 0, removed: c?.removed ?? 0 }
  })
  if (key !== null) memos.set(root, { key, counts, lines })
  else memos.delete(root)

  return {
    isRepo: true,
    branch,
    ahead,
    behind,
    added,
    removed,
    files,
    truncated: entries.length > listed.length || status.capped,
    totalFiles: entries.length,
  }
}

const BINARY_LINE = /^Binary files .* differ$/m

function finishDiff(path: string, r: RunResult): string {
  const text = r.stdout.toString('utf8')
  if (BINARY_LINE.test(text) && !text.includes('\n@@')) return `Binary file ${path} changed (no text diff)\n`
  if (r.capped) return `${text}\n... diff truncated at ${MAX_DIFF_BYTES / 1024} KB\n`
  return text
}

/**
 * The unified diff of one file (a path relative to the repo's top, as gitStatus lists it) against
 * HEAD. An untracked file shows as all added, a binary file as a one-line note; capped at 200 KB.
 */
export async function gitDiff(cwd: string, path: string): Promise<string> {
  const dir = assertDir(cwd)
  if (!path) throw new GitError('path is required')
  const root = await cachedRepoRoot(dir)
  if (!root) throw new GitError(`not a git repository: ${dir}`)
  const abs = resolve(root, path)
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new GitError(`path is outside the repository: ${path}`)
  const gitPath = rel.split('\\').join('/')

  const head = await headSha(root)
  const base = head ?? (await emptyTree(root))
  const common = ['--no-color', '--no-ext-diff', '--no-textconv']
  const tracked = await runGit(root, ['diff', ...common, base, '--', gitPath], { maxBytes: MAX_DIFF_BYTES })
  if (tracked.code !== 0 && !tracked.capped) throw new GitError(`git diff failed: ${tracked.stderr}`)
  if (tracked.stdout.length > 0) return finishDiff(gitPath, tracked)

  // Nothing against HEAD: an untracked file shows as all added; anything else has no change.
  const known = await runGit(root, ['ls-files', '--error-unmatch', '--', gitPath])
  if (known.code === 0) return ''
  let isFile = false
  try {
    isFile = statSync(abs).isFile()
  } catch {
    throw new GitError(`no such file: ${gitPath}`)
  }
  if (!isFile) throw new GitError(`not a file: ${gitPath}`)
  // --no-index exits 1 when the files differ, which is the normal answer here.
  const r = await runGit(root, ['diff', ...common, '--no-index', '--', '/dev/null', gitPath], { maxBytes: MAX_DIFF_BYTES })
  if (r.code > 1 && !r.capped) throw new GitError(`git diff --no-index failed: ${r.stderr}`)
  return finishDiff(gitPath, r)
}
