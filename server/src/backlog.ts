// server/src/backlog.ts — the FULL-MODE backlog scanner (docs/ORCHESTRATOR.md, "Full mode").
//
// WHAT THIS IS FOR. In its normal shape the orchestrator is REACTIVE: it watches chats that
// already exist and proposes things about them (revive this dead one, archive that finished one).
// Nothing in it ever asks the other question — "is there work outstanding that nobody is doing
// right now?" — so a fleet with every chat healthy reads as a fleet with nothing to do, while the
// repos themselves carry unticked TODO boxes, FIXMEs, and gates that have not been run since the
// last commit landed.
//
// Full mode (`/orchestrate full`, settings.workMode === 'full') closes that gap. This module is
// the DISCOVERY half: a cheap, deterministic, READ-ONLY sweep that turns "what is outstanding"
// into a ranked list of work items. The reviewer half decides each one and starts a visible chat
// to do it. Nothing here acts, and nothing here runs a repo's own scripts — see WHY, below.
//
// THREE RULES THIS FILE OBEYS, and each one is load-bearing:
//
// 1. IT NEVER EXECUTES ANYTHING BELONGING TO THE REPO. No `bun run check`, no `cargo clippy`, no
//    `localci`. A daemon that runs arbitrary repo scripts on a timer is a daemon that reinstalls
//    dependencies under a chat that is mid-edit, burns a core forever on a 60-repo fleet, and
//    executes whatever a freshly pulled package.json says. Running the gate is real work with
//    real judgment attached, so it belongs to the seeded chat, which is visible and supervised.
//    All this file does is notice that a gate EXISTS and that HEAD has moved since it was last
//    recorded green.
//
// 2. IT ONLY REPORTS WHAT IS MECHANICALLY DECIDABLE. An unticked `- [ ]` box is a fact. A FIXME
//    that was not there last scan is a fact. "HEAD moved since the last recorded green" is a
//    fact. Whether any of them is worth doing NOW is judgment, and judgment is the reviewer's.
//
// 3. NOTHING OLD IS EVER "NEW". The failure mode that would have killed the marker detector is
//    obvious in hindsight: a mature repo carries hundreds of deliberate `HACK:` comments, and a
//    scanner that reports all of them every 30 minutes is a scanner nobody reads. So markers are
//    BASELINED per repo on first sight and only ever reported when they appear after that, keyed
//    by (file, token, text-hash) rather than by line so that moving code does not fake a new one.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** What kind of outstanding work this is. */
export type BacklogKind = 'todo' | 'marker' | 'gate'

/** How loudly it wants attention. `breaking` is "something may be broken right now" (a gate that
 *  has not passed since the code changed); `warning` is a marker the author flagged as wrong;
 *  `chore` is planned work someone wrote down. Ranked in this order. */
export type BacklogSeverity = 'breaking' | 'warning' | 'chore'

export interface BacklogItem {
  /** Stable across scans — the dedup key for proposals, the fail counter, and the resolve call.
   *  Deliberately derived from CONTENT, never from a line number or a scan ordinal. */
  key: string
  kind: BacklogKind
  severity: BacklogSeverity
  /** Repository root this is about. */
  repo: string
  repoName: string
  /** One line for a human. */
  title: string
  /** The case for doing it, in words. */
  summary: string
  /** Everything the reviewer needs to judge without opening the repo itself. */
  evidence: Record<string, unknown>
  /** ISO. When the newest supporting fact happened, so a rejection can be re-armed by news. */
  evidenceAt: string
}

export interface BacklogScanOptions {
  /** Explicit roots from settings. A root that is not itself a repo is expanded ONE level to its
   *  children that are (so `D:\Projects` covers everything under it without listing each). */
  roots: string[]
  /** Used when `roots` is empty: every cwd the fleet has actually worked in. Folded to repo
   *  roots and deduped, so the default needs no configuration and still covers real ground. */
  fallbackCwds: string[]
  /** Fold a cwd onto its repository root (injected so this module never imports the orchestrator
   *  and so tests can drive it with a plain function). */
  repoRootFor: (cwd: string) => string | null
  /** Report bare `TODO:` markers too. Off by default: in most codebases TODO is a note, not a
   *  defect, and it is by far the noisiest of the four tokens. */
  includeTodoMarkers: boolean
  /** Hard ceiling on repositories touched in one scan, so a badly chosen root cannot turn into
   *  an unbounded disk walk. */
  maxRepos: number
  /** Repos to leave alone entirely this scan (someone is standing in them right now). */
  skipRepos: string[]
  /** A gate item is only raised once HEAD has been still this long — a repo whose last commit
   *  landed a minute ago is very likely still being worked. */
  gateSettleMins: number
  nowMs: number
  /** Per-repo memory (baselines, recorded greens, fail counters). Backed by the orchestrator KV
   *  in production; a plain Map in tests. */
  memory: BacklogMemory
}

/** The small amount of state a scan must remember between runs. */
export interface BacklogMemory {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface BacklogScan {
  scannedAt: string
  /** The repository roots actually swept. */
  repos: string[]
  items: BacklogItem[]
  /** Roots that were asked for and could not be used, with the reason — a silently dropped root
   *  is indistinguishable from a clean one, which is the failure this field exists to prevent. */
  skipped: Array<{ path: string; why: string }>
  /** Wall-clock cost, so a scan that becomes expensive is visible rather than merely felt. */
  tookMs: number
}

// --- keys in the orchestrator KV --------------------------------------------

const BASELINE_PREFIX = 'backlogMarkers:'
const GREEN_PREFIX = 'backlogGreen:'
const FAILS_PREFIX = 'backlogFails:'
const DONE_PREFIX = 'backlogDone:'
const LAST_SCAN_KEY = 'backlogLastScan'

/** Markers remembered per repo. Generous but finite: a repo with more than this many flagged
 *  lines is telling you something the backlog scanner is not the right tool for. */
const MAX_BASELINE = 2000

/** Give up on an item after this many reported failures and hand it to the owner instead of
 *  re-proposing it every scan. A gate nothing can fix (a flaky test, a missing local secret) is
 *  otherwise an infinite loop that looks like diligence. */
export const MAX_ITEM_FAILURES = 3

export function backlogLastScanAt(memory: BacklogMemory): number | null {
  const raw = memory.get(LAST_SCAN_KEY)
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

export function recordBacklogScan(memory: BacklogMemory, nowMs: number): void {
  memory.set(LAST_SCAN_KEY, String(nowMs))
}

/** How many times this item has been reported failed. */
export function backlogFailures(memory: BacklogMemory, key: string): number {
  const n = Number(memory.get(FAILS_PREFIX + key) ?? '0')
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function noteBacklogFailure(memory: BacklogMemory, key: string): number {
  const next = backlogFailures(memory, key) + 1
  memory.set(FAILS_PREFIX + key, String(next))
  return next
}

/**
 * Record an item as dealt with. Two different mechanisms, because the two key shapes re-arm for
 * two different reasons, and using one mechanism for both would break the other.
 *
 * A `gate` key is `gate:<repoHash>` and is CONSTANT for the life of the repository, so it cannot
 * carry its own resolution: the recorded green SHA is what makes it quiet, and it re-arms the
 * moment HEAD moves off that commit. That is the whole point of a gate item.
 *
 * A `todo` or `marker` key is content-derived, so a resolution can simply be pinned to the key
 * itself: the same key means the same unticked boxes, word for word, and re-offering work the
 * reviewer already dealt with would be the loop this whole design is trying to avoid. Change a
 * box and the key changes with it, which raises it again exactly as it should. (Found in live
 * testing: without this, a resolved todo item came back on the very next sweep.)
 */
export function resolveBacklogItem(memory: BacklogMemory, key: string, sha?: string | null): void {
  memory.set(FAILS_PREFIX + key, '0')
  if (key.startsWith('gate:')) {
    const repo = repoOfKey(key)
    if (repo && sha?.trim()) memory.set(GREEN_PREFIX + repo, sha.trim())
    return
  }
  memory.set(DONE_PREFIX + key, '1')
}

/** Has this exact item already been dealt with? Always false for a gate key, whose quiet comes
 *  from the recorded green sha instead — see resolveBacklogItem, and backlogGateIsGreen below. */
export function backlogResolved(memory: BacklogMemory, key: string): boolean {
  return !key.startsWith('gate:') && memory.get(DONE_PREFIX + key) === '1'
}

/**
 * Is this gate item's commit ALREADY recorded green, as of right now?
 *
 * The scan asks the same question, but it asks it minutes earlier - a sweep over sixty
 * repositories reads repo #3's green sha long before it finishes repo #60 - and in that window the
 * reviewer can report the very gate the scan is carrying as fixed. Re-asking at the moment work is
 * about to be offered is what stops a resolved gate being handed straight back.
 */
export function backlogGateIsGreen(
  memory: BacklogMemory,
  item: { key: string; evidence: Record<string, unknown> },
): boolean {
  if (!item.key.startsWith('gate:')) return false
  const repo = repoOfKey(item.key)
  const head = item.evidence.head
  return !!repo && typeof head === 'string' && memory.get(GREEN_PREFIX + repo) === head
}

/** The repo hash a key was built from ('gate:<repoHash>' / 'todo:<repoHash>:<n>'). */
function repoOfKey(key: string): string | null {
  return key.split(':')[1] ?? null
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function repoKey(repo: string): string {
  return hash(repo.toLowerCase().replace(/[\\/]+$/, ''))
}

// --- secret hygiene ----------------------------------------------------------

/**
 * Files a secret plausibly lives in. The standing rail is that no secret value is ever read into
 * an agent's context, and the feed this scanner writes into is read by one.
 *
 * TWO GATES, and they do not cover the same ground, which is worth stating rather than implying.
 * `MARKER_EXCLUDES` below keeps most of these away from `git grep` entirely, so their bytes are
 * never read at all — that is the real protection. This regex is the SECOND gate, applied to
 * whatever git hands back, and it exists because a git pathspec glob cannot express "a file
 * literally named token.ts" without also excluding `tokenizer.ts`. Neither gate is load-bearing
 * alone: the pathspec is the cheap one, this is the exact one.
 */
const SECRET_PATH =
  /(^|[\\/])(\.env($|\.)|.*(secret|credential|password|token)s?\.|.*\.(pem|key|p12|pfx)$)/i

/**
 * Blank out anything that looks like a live value while keeping the sentence readable. A `FIXME`
 * comment is source the repo already publishes, so the text is worth carrying — but a line that
 * happens to read `token = "sk-abc..."` must not travel into a feed, and one that reads
 * "FIXME: rotate the API key" must, because that IS the work.
 *
 * `is`/`was` are in the verb list, not decoration: the first version matched only `=` and `:`, and
 * a review found that "FIXME: default password is admin123" therefore travelled verbatim. Prose is
 * how a human writes a note to themselves, which is exactly what a FIXME is.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // `key = value`, `key: value`, `key is value` — the label plus a value is the tell, not the
      // word on its own, so "rotate the signing key before release" is left intact.
      .replace(
        /\b(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth|bearer)\b(\s*[=:]\s*|\s+(?:is|was)\s+)\S+/gi,
        (_m, label: string) => `${label}=<redacted>`,
      )
      // Bare long opaque strings (keys pasted inline with no assignment around them).
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
  )
}

// --- resolving which repositories to sweep -----------------------------------

/**
 * Turn the configured roots (or, with none, the fleet's own cwds) into the list of repository
 * roots to sweep.
 *
 * An explicit root that IS a repo is taken as-is. An explicit root that is not gets expanded one
 * level to its children that are, which is what makes `D:\Projects` a usable answer; it stops at
 * one level on purpose, because a recursive walk over a projects directory full of node_modules
 * is exactly the unbounded scan this whole module is trying not to be.
 */
export function resolveBacklogRepos(opts: {
  roots: string[]
  fallbackCwds: string[]
  repoRootFor: (cwd: string) => string | null
  maxRepos: number
}): { repos: string[]; skipped: Array<{ path: string; why: string }> } {
  const out: string[] = []
  const seen = new Set<string>()
  const skipped: Array<{ path: string; why: string }> = []
  const add = (dir: string): boolean => {
    const k = dir.toLowerCase()
    if (seen.has(k)) return true
    if (out.length >= opts.maxRepos) return false
    seen.add(k)
    out.push(dir)
    return true
  }

  const explicit = opts.roots.map((r) => r.trim()).filter(Boolean)
  if (explicit.length > 0) {
    for (const root of explicit) {
      if (!existsSync(root)) {
        skipped.push({ path: root, why: 'does not exist' })
        continue
      }
      if (existsSync(join(root, '.git'))) {
        if (!add(root)) skipped.push({ path: root, why: 'over the repo cap' })
        continue
      }
      let children: string[] = []
      try {
        children = readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => join(root, e.name))
      } catch {
        skipped.push({ path: root, why: 'unreadable' })
        continue
      }
      const repos = children.filter((c) => existsSync(join(c, '.git')))
      if (repos.length === 0) {
        skipped.push({ path: root, why: 'not a repo, and no repos directly inside it' })
        continue
      }
      for (const r of repos) {
        if (!add(r)) {
          skipped.push({ path: r, why: 'over the repo cap' })
          break
        }
      }
    }
    return { repos: out, skipped }
  }

  // No roots configured: the repos the fleet actually works in. Scratch and temp directories are
  // dropped — a chat's scratchpad is not a codebase with a backlog.
  for (const cwd of opts.fallbackCwds) {
    if (!cwd?.trim()) continue
    if (/[\\/](temp|tmp|scratchpad|scratch)([\\/]|$)/i.test(cwd)) continue
    const root = opts.repoRootFor(cwd)
    if (!root) continue
    if (!add(root)) break
  }
  return { repos: out, skipped }
}

// --- detector: unticked checkboxes -------------------------------------------

/** Where a repo writes down work it has decided to do. Read directly (a handful of files), never
 *  grepped repo-wide: a `- [ ]` inside a README's example block is not a task. */
const TODO_FILES = [
  'TODO.md',
  'TODOS.md',
  'PROGRESS.md',
  'ROADMAP.md',
  'BACKLOG.md',
  'PLAN.md',
  'NEXT.md',
]
const TODO_DIRS = ['docs/todo', '.claude/todo']
const TODO_GLOB_PREFIX = ['BURNDOWN', 'TODO']

/** Any file over this is not a task list, it is a document that happens to contain checkboxes. */
const MAX_TODO_BYTES = 512 * 1024

export interface TodoBox {
  file: string
  line: number
  text: string
}

/** Every unticked `- [ ]` box in a repo's task-list files, with the file it came from. */
export function findTodoBoxes(repo: string): TodoBox[] {
  const out: TodoBox[] = []
  const files: string[] = []
  for (const f of TODO_FILES) if (existsSync(join(repo, f))) files.push(f)
  for (const d of TODO_DIRS) {
    const dir = join(repo, d)
    if (!existsSync(dir)) continue
    try {
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isFile() && e.name.toLowerCase().endsWith('.md')) files.push(join(d, e.name))
    } catch {
      /* unreadable directory is simply no task list */
    }
  }
  try {
    for (const e of readdirSync(repo, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
      if (!TODO_GLOB_PREFIX.some((p) => e.name.toUpperCase().startsWith(p))) continue
      if (!files.includes(e.name)) files.push(e.name)
    }
  } catch {
    /* an unreadable repo root yields no boxes, which is the honest answer */
  }

  for (const rel of files) {
    if (SECRET_PATH.test(rel)) continue
    const abs = join(repo, rel)
    try {
      if (statSync(abs).size > MAX_TODO_BYTES) continue
      const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i]?.match(/^\s*(?:[-*+]|\d+\.)\s+\[ \]\s+(.+)$/)
        if (!m?.[1]) continue
        const text = redactSecrets(m[1].trim()).slice(0, 200)
        if (text) out.push({ file: rel.replace(/\\/g, '/'), line: i + 1, text })
      }
    } catch {
      /* a file that vanished between the listing and the read is not an error worth raising */
    }
  }
  return out
}

// --- detector: author-flagged markers ----------------------------------------

export interface CodeMarker {
  file: string
  line: number
  token: string
  text: string
  /** Line-independent identity: the same comment moved down a file is the same marker. */
  id: string
}

const MARKER_TOKENS = ['FIXME', 'HACK', 'XXX', 'BUG']

/** Pathspecs excluded from the marker grep — vendored code, lockfiles, and anything that reads
 *  like a secret. Passed to git so the exclusion happens before a single byte is read. */
const MARKER_EXCLUDES = [
  ':(exclude)**/node_modules/**',
  ':(exclude)**/vendor/**',
  ':(exclude)**/dist/**',
  ':(exclude)**/build/**',
  ':(exclude)**/target/**',
  ':(exclude)**/*.lock',
  ':(exclude)**/*.min.*',
  ':(exclude)**/*.map',
  ':(exclude)**/CHANGELOG.md',
  // Secret-shaped files, kept away from git so their bytes are never read at all. Everything a
  // glob can state safely is here; `SECRET_PATH` is the second gate for the rest (see its note).
  // `*token*` is deliberately NOT in this list: it would exclude `tokenizer.ts` and every other
  // ordinary file with the word in its name, and SECRET_PATH catches the real shape exactly.
  ':(exclude)**/.env*',
  ':(exclude)**/*secret*',
  ':(exclude)**/*credential*',
  ':(exclude)**/*password*',
  ':(exclude)**/*.pem',
  ':(exclude)**/*.key',
  ':(exclude)**/*.p12',
  ':(exclude)**/*.pfx',
]

/** Parse `git grep -n` output into markers. Pure, so the parsing is testable without a repo. */
export function parseMarkerGrep(stdout: string, includeTodo: boolean): CodeMarker[] {
  const tokens = includeTodo ? [...MARKER_TOKENS, 'TODO'] : MARKER_TOKENS
  const out: CodeMarker[] = []
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue
    // `path:line:text` — a Windows drive letter cannot appear here (git prints repo-relative
    // paths), so splitting on the first two colons is unambiguous.
    const first = raw.indexOf(':')
    if (first < 0) continue
    const second = raw.indexOf(':', first + 1)
    if (second < 0) continue
    const file = raw.slice(0, first)
    const line = Number(raw.slice(first + 1, second))
    if (!Number.isFinite(line)) continue
    const text = raw.slice(second + 1)
    if (SECRET_PATH.test(file)) continue
    const token = tokens.find((t) => new RegExp(`\\b${t}\\b`).test(text))
    if (!token) continue
    const clean = redactSecrets(text.trim()).slice(0, 160)
    out.push({
      file: file.replace(/\\/g, '/'),
      line,
      token,
      text: clean,
      id: hash(`${file.toLowerCase()}|${token}|${clean}`),
    })
  }
  return out
}

/** The git pathspec + pattern the marker grep runs with (exported so the docs and the tests can
 *  agree with the implementation rather than describing it twice). */
export function markerGrepArgs(includeTodo: boolean): string[] {
  const tokens = includeTodo ? [...MARKER_TOKENS, 'TODO'] : MARKER_TOKENS
  return [
    'grep',
    '-n',
    '-I',
    '--no-color',
    '-E',
    `(^|[^A-Za-z0-9_])(${tokens.join('|')})[: ]`,
    '--',
    ...MARKER_EXCLUDES,
  ]
}

// --- detector: the repo's own gate -------------------------------------------

export interface GateInfo {
  /** Does this repo have a quality gate at all? */
  present: boolean
  /** The commands a work chat should run, most authoritative first. Never run here. */
  commands: string[]
  /** What told us the gate exists. */
  sources: string[]
}

/**
 * What this repo checks itself with. Read from what the repo DECLARES — package.json scripts, a
 * workflow directory, a Cargo/Python manifest — never by running anything. The point is to hand a
 * work chat a correct first command, not to know the answer ourselves.
 */
export function describeGate(repo: string): GateInfo {
  const commands: string[] = []
  const sources: string[] = []
  const pkgPath = join(repo, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>
      }
      const scripts = pkg.scripts ?? {}
      const runner =
        existsSync(join(repo, 'bun.lock')) || existsSync(join(repo, 'bun.lockb'))
          ? 'bun run'
          : 'npm run'
      for (const name of ['check', 'typecheck', 'lint', 'test']) {
        if (typeof scripts[name] === 'string') commands.push(`${runner} ${name}`)
      }
      if (commands.length > 0) sources.push('package.json scripts')
    } catch {
      /* an unparseable package.json tells us nothing, which is not a failure */
    }
  }
  if (existsSync(join(repo, '.arkitect'))) {
    // The owner's own architecture gate. Its counts are the "breaking fixes or warnings" this
    // mode was asked for, and the repo that has one always wants it read first.
    commands.unshift('bun run arkitect:counts')
    sources.push('.arkitect')
  }
  if (existsSync(join(repo, 'Cargo.toml'))) {
    commands.push('cargo fmt --all --check', 'cargo clippy --all-targets -- -D warnings')
    sources.push('Cargo.toml')
  }
  if (existsSync(join(repo, '.github', 'workflows'))) {
    // Every step CI would run, on this machine, before a push wastes a runner.
    commands.push('python ~/.claude/tools/localci.py --docker')
    sources.push('.github/workflows')
  }
  return { present: commands.length > 0, commands, sources }
}

// --- running git -------------------------------------------------------------

interface GitRun {
  ok: boolean
  stdout: string
}

async function git(repo: string, args: string[], timeoutMs: number): Promise<GitRun> {
  try {
    const proc = Bun.spawn(['git', '-C', repo, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
      windowsHide: true,
    })
    const killer = setTimeout(() => proc.kill(), timeoutMs)
    const [stdout, code] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited])
    clearTimeout(killer)
    // `git grep` exits 1 for "no matches", which is a successful empty answer, not a failure.
    return { ok: code === 0 || code === 1, stdout }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/** Bound how many repos are being shelled out to at once. A 60-repo fleet is two git processes
 *  per repo; unbounded, that is 120 at once on a machine whose whole job is running other work. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      const item = items[i]
      if (item === undefined) return
      out[i] = await fn(item)
    }
  })
  await Promise.all(workers)
  return out
}

const GIT_TIMEOUT_MS = 20_000

// --- the scan ----------------------------------------------------------------

const SEVERITY_RANK: Record<BacklogSeverity, number> = { breaking: 0, warning: 1, chore: 2 }

/**
 * One full sweep. Read-only, bounded, and safe to call at any time — the only state it writes is
 * the marker baseline (so a marker is never "new" twice) and the scan timestamp.
 */
export async function scanBacklog(opts: BacklogScanOptions): Promise<BacklogScan> {
  const startedAt = Date.now()
  const nowIso = new Date(opts.nowMs).toISOString()
  const skip = new Set(opts.skipRepos.map((r) => r.toLowerCase()))
  const { repos: allRepos, skipped } = resolveBacklogRepos(opts)
  const repos = allRepos.filter((r) => {
    if (!skip.has(r.toLowerCase())) return true
    skipped.push({ path: r, why: 'a chat is working in it right now' })
    return false
  })

  const perRepo = await mapLimited(repos, 4, async (repo): Promise<BacklogItem[]> => {
    const items: BacklogItem[] = []
    const rk = repoKey(repo)
    const name = basename(repo)

    // --- gate -----------------------------------------------------------------
    const gate = describeGate(repo)
    if (gate.present) {
      const head = (await git(repo, ['rev-parse', 'HEAD'], GIT_TIMEOUT_MS)).stdout.trim()
      const green = opts.memory.get(GREEN_PREFIX + rk)
      if (head && head !== green) {
        // How long HEAD has been still. A commit from a minute ago belongs to whoever is still
        // typing; the gate item waits for the dust to settle.
        const ts = Number(
          (await git(repo, ['log', '-1', '--format=%ct'], GIT_TIMEOUT_MS)).stdout.trim(),
        )
        const ageMins = Number.isFinite(ts)
          ? (opts.nowMs - ts * 1000) / 60_000
          : Number.POSITIVE_INFINITY
        if (ageMins >= opts.gateSettleMins) {
          items.push({
            key: `gate:${rk}`,
            kind: 'gate',
            severity: 'breaking',
            repo,
            repoName: name,
            title: `${name}: run its own gate and fix what it reports`,
            summary:
              `${name} has a quality gate (${gate.sources.join(', ')}) and HEAD is at ${head.slice(0, 8)}, ` +
              `which has never been recorded green. ${green ? `Last recorded green was ${green.slice(0, 8)}.` : 'No green has ever been recorded.'}`,
            evidence: {
              head,
              lastGreenSha: green,
              headAgeMins: Number.isFinite(ageMins) ? Math.round(ageMins) : null,
              commands: gate.commands,
              sources: gate.sources,
              // The reviewer reports the green back with this, and nothing is raised again
              // until the code moves.
              resolveWith: { key: `gate:${rk}`, sha: head },
            },
            evidenceAt: nowIso,
          })
        }
      }
    }

    // --- markers --------------------------------------------------------------
    if (existsSync(join(repo, '.git'))) {
      const grep = await git(repo, markerGrepArgs(opts.includeTodoMarkers), GIT_TIMEOUT_MS)
      if (grep.ok) {
        const markers = parseMarkerGrep(grep.stdout, opts.includeTodoMarkers)
        const raw = opts.memory.get(BASELINE_PREFIX + rk)
        let baseline: Set<string> | null = null
        if (raw) {
          try {
            baseline = new Set(JSON.parse(raw) as string[])
          } catch {
            baseline = null
          }
        }
        const ids = markers.map((m) => m.id)
        if (ids.length > MAX_BASELINE) {
          // TOO MANY TO TRACK HONESTLY, so track none of them and SAY so.
          //
          // The baseline is what makes this detector usable, and it only works while every marker
          // in the tree fits in it. The first version truncated instead, which is the version a
          // review caught: it evicted the OLDEST baselined ids, which are precisely the untouched
          // ones, so past the cap a repo would re-report decade-old HACK comments as new for
          // ever - the exact failure the baseline exists to prevent, arriving quietly at scale.
          // A skip that names itself is worth more than a detector that lies above 2000 markers.
          opts.memory.set(BASELINE_PREFIX + rk, JSON.stringify([]))
          skipped.push({
            path: repo,
            why: `${ids.length} code markers, over the ${MAX_BASELINE} the sweep can baseline - markers not reported for this repo`,
          })
        } else if (baseline === null) {
          // FIRST SIGHT OF THIS REPO. Everything here predates the scanner, so none of it is
          // news — record it and report nothing. Reporting a decade of accumulated HACKs as
          // "found" would be true and useless.
          opts.memory.set(BASELINE_PREFIX + rk, JSON.stringify(ids))
        } else {
          const fresh = markers.filter((m) => !baseline?.has(m.id))
          if (fresh.length > 0) {
            const worst = fresh.some((m) => m.token === 'BUG' || m.token === 'FIXME')
            items.push({
              key: `marker:${rk}:${hash(fresh.map((m) => m.id).join(','))}`,
              kind: 'marker',
              severity: worst ? 'warning' : 'chore',
              repo,
              repoName: name,
              title: `${name}: ${fresh.length} new ${fresh.length === 1 ? 'marker' : 'markers'} in the code`,
              summary:
                `${fresh.length} ${MARKER_TOKENS.join('/')} marker(s) appeared in ${name} since the last sweep: ` +
                fresh
                  .slice(0, 3)
                  .map((m) => `${m.file}:${m.line} ${m.token}`)
                  .join(', ') +
                (fresh.length > 3 ? `, and ${fresh.length - 3} more` : ''),
              evidence: {
                markers: fresh.slice(0, 25),
                total: fresh.length,
                note: 'Only markers that were not present at the previous sweep. Text is redacted of anything value-shaped.',
              },
              evidenceAt: nowIso,
            })
          }
          // The new baseline is EXACTLY what is in the tree now, not the union with what used to
          // be. A union grows without bound and then has to be truncated, and any truncation rule
          // eventually evicts a marker that is still sitting in the code, which re-reports it as
          // new. Ids of markers that have been deleted are worth nothing anyway: if that comment
          // is ever written again, it genuinely is new work.
          opts.memory.set(BASELINE_PREFIX + rk, JSON.stringify(ids))
        }
      }
    }

    // --- todo boxes -----------------------------------------------------------
    const boxes = findTodoBoxes(repo)
    if (boxes.length > 0) {
      // ONE item per repo, never one per box. A task list is a single piece of work to pick up,
      // and a repo with forty unticked boxes must not become forty proposals.
      const files = [...new Set(boxes.map((b) => b.file))]
      items.push({
        key: `todo:${rk}:${hash(boxes.map((b) => `${b.file}|${b.text}`).join('\n'))}`,
        kind: 'todo',
        severity: 'chore',
        repo,
        repoName: name,
        title: `${name}: ${boxes.length} unticked task${boxes.length === 1 ? '' : 's'} written down`,
        summary:
          `${name} has ${boxes.length} unticked "- [ ]" item(s) across ${files.join(', ')}. ` +
          `First: ${boxes[0]?.text ?? ''}`,
        evidence: { files, total: boxes.length, boxes: boxes.slice(0, 25) },
        evidenceAt: nowIso,
      })
    }

    return items
  })

  const items = perRepo
    .flat()
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.repoName.localeCompare(b.repoName),
    )

  recordBacklogScan(opts.memory, opts.nowMs)
  return {
    scannedAt: nowIso,
    repos,
    items,
    skipped,
    tookMs: Date.now() - startedAt,
  }
}
