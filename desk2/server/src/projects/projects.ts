// The New screen's project grid (GET /api/projects; owner, 2026-10-08: "I click New Chat, and rather than seeing this
// overview and models, I see all my projects"). Rows come from Project Hydra when it is installed (hydra.ts) and,
// always, from the folders this app's chats and Recent list use, rolled up to the checkout that holds them. Each
// row's git state is read here with `git status` (never a fetch: `behind` is as fresh as the checkout's own last
// fetch, which `fetchedAt` gives).
//
// The answer never waits on git (owner, 2026-10-08: "it needs to be fast as fuck"): reading every checkout cold took
// 13 to 24 s for 111 projects on his PC, and the grid showed "Loading your projects…" all that time. It is built from
// Project Hydra's last answer and each checkout's last git state, kept on disk so a restarted server has them too;
// what is stale is read again behind the answer, which says so (`pending`).

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ProjectChoices, ProjectEntry, ProjectGit, ProjectSource, ProjectsResponse } from '@shared/protocol'
import { isRemotePath } from '../engine/reveal'
import { runGit } from '../git/git'
import { checkoutOf, folderKey, isDir, subfolders } from './choices'
import type { HydraLocation, HydraProject, HydraRead } from './hydra'

export interface GitFacts {
  git: ProjectGit
  lastCommitAt: string | null
  /** The commit HEAD was on (git status's branch.oid, '(initial)' before the first commit), so a re-read whose HEAD
   * has not moved keeps lastCommitAt instead of running `git log` again. */
  head?: string | null
}

export interface ProjectDeps {
  /** Where Project Hydra is, or null when it is not installed. */
  findHydra(): HydraLocation | null
  readHydra(at: HydraLocation): Promise<HydraRead>
  /** The Recent list's folders. */
  recent(): string[]
  /** The chats' folders and when each chat was last active (epoch ms). */
  chats(): { cwd: string; updatedAt: number }[]
  /** The folders the user added, the folders of projects and the hidden projects. Default: none. */
  choices?(): ProjectChoices
  /** A checkout's git state, or null when it is not one; `prev` is the last one read. Default: readGit. */
  git?(path: string, prev: GitFacts | null): Promise<GitFacts | null>
  now?(): number
  /** The scratch folder whose chats are left out. Default: the OS temp folder. */
  tempDir?: string
  /** Where Project Hydra's answer and the git states are kept for the next start. Default: nowhere. */
  cacheFile?: string
}

/** How long Project Hydra's answer and where it is installed are trusted before it is read again. */
const HYDRA_TTL_MS = 60_000
/** How long one checkout's git state is trusted while its index, HEAD and FETCH_HEAD stay as they were. A re-read is
 * a git process per checkout, about a hundred for the owner, so not on every visit to New. */
const GIT_TTL_MS = 60_000
/** Checkouts read at once. */
const GIT_PARALLEL = 8

/** The repo's git folder: `.git`, or where a worktree's `.git` file points. */
function gitDirOf(path: string): string | null {
  const dotGit = join(path, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    return m ? resolve(path, m[1]!.trim()) : null
  } catch {
    return null
  }
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** `git status --porcelain=v2 --branch` read into branch, upstream, ahead, behind and the changed-file count. */
export function parseStatus(out: string): Omit<ProjectGit, 'fetchedAt'> {
  const git: Omit<ProjectGit, 'fetchedAt'> = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 }
  for (const line of out.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      git.branch = head === '(detached)' ? null : head
    } else if (line.startsWith('# branch.upstream ')) git.upstream = line.slice('# branch.upstream '.length).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        git.ahead = Number(m[1])
        git.behind = Number(m[2])
      }
    } else if (!line.startsWith('#')) git.dirty++
  }
  return git
}

/** A checkout's git state, or null when `path` is not one (or git cannot read it). `prev`, the last one read, gives
 * the commit time while HEAD has not moved. */
export async function readGit(path: string, prev: GitFacts | null = null): Promise<GitFacts | null> {
  const gitDir = gitDirOf(path)
  if (!gitDir) return null
  const status = await runGit(path, ['status', '--porcelain=v2', '--branch']).catch(() => null)
  if (!status || status.code !== 0) return null
  const out = status.stdout.toString('utf8')
  const head = /^# branch\.oid (\S+)/m.exec(out)?.[1] ?? null
  let lastCommitAt: string | null = null
  if (head && head === prev?.head) lastCommitAt = prev.lastCommitAt
  else if (head && head !== '(initial)') {
    const log = await runGit(path, ['log', '-1', '--format=%cI']).catch(() => null)
    lastCommitAt = log?.code === 0 ? log.stdout.toString('utf8').trim() || null : null
  }
  const fetched = mtime(join(gitDir, 'FETCH_HEAD'))
  return { git: { ...parseStatus(out), fetchedAt: fetched ? new Date(fetched).toISOString() : null }, lastCommitAt, head }
}

/** What makes a cached git state stale before its time is up: a commit, a checkout, a stage or a fetch. */
function gitSignature(path: string): string {
  const dir = gitDirOf(path)
  if (!dir) return ''
  return ['index', 'HEAD', 'FETCH_HEAD'].map((f) => mtime(join(dir, f))).join(':')
}

interface Row {
  path: string
  name: string
  group: string | null
  icon: string | null
  hydraKey: string | null
  sources: Set<ProjectSource>
  lastChatAt: number | null
}

interface HydraState {
  at: number
  location: HydraLocation | null
  read: HydraRead | null
}

interface GitEntry {
  at: number
  sig: string
  facts: GitFacts | null
}

/** What `cacheFile` holds: Project Hydra's last answer and the listed checkouts' git states, by folder key. */
interface Snapshot {
  hydra: HydraState | null
  git: [string, GitEntry][]
}

export class ProjectList {
  private hydraAt: HydraState | null = null
  private hydraLoading: Promise<void> | null = null
  private readonly gitCache = new Map<string, GitEntry>()
  /** The git reads running or waiting for a slot, by folder key. */
  private readonly gitReads = new Map<string, Promise<void>>()
  private gitRunning = 0
  private readonly gitQueue: (() => void)[] = []
  /** The folder keys of the last list, the git states worth keeping on disk. */
  private listed = new Set<string>()
  private readonly now: () => number

  constructor(private readonly deps: ProjectDeps) {
    this.now = deps.now ?? Date.now
    this.load()
  }

  private load(): void {
    if (!this.deps.cacheFile) return
    try {
      const kept = JSON.parse(readFileSync(this.deps.cacheFile, 'utf8')) as Partial<Snapshot> | null
      if (typeof kept?.hydra?.at === 'number') this.hydraAt = kept.hydra
      for (const [key, entry] of Array.isArray(kept?.git) ? kept.git : []) if (typeof key === 'string' && typeof entry?.at === 'number') this.gitCache.set(key, entry)
    } catch {
      // floor-ok: no snapshot (the first start, or a damaged file) means the first answer waits for Project Hydra
    }
  }

  private save(): void {
    const file = this.deps.cacheFile
    if (!file) return
    const git = [...this.gitCache].filter(([key]) => !this.listed.size || this.listed.has(key))
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ hydra: this.hydraAt, git } satisfies Snapshot))
      renameSync(tmp, file)
    } catch {
      // floor-ok: without the snapshot the next start waits for Project Hydra once, as it did before
    }
  }

  /** Project Hydra's last answer at once. A stale one is read again behind it, awaited only with `wait` or when
   * there is none yet. */
  private async hydra(wait: boolean): Promise<HydraState> {
    if (!this.hydraAt || this.now() - this.hydraAt.at > HYDRA_TTL_MS) {
      this.hydraLoading ??= (async () => {
        const location = this.deps.findHydra()
        const read = location ? await this.deps.readHydra(location) : null
        // A failed read keeps the projects of the last good one; the problem is still said.
        const kept = read?.problem && !read.projects.length && this.hydraAt?.read?.projects.length ? { ...read, projects: this.hydraAt.read.projects } : read
        this.hydraAt = { at: this.now(), location, read: kept }
        this.save()
      })()
        .catch(() => {})
        .finally(() => (this.hydraLoading = null))
      if (wait || !this.hydraAt) await this.hydraLoading
    }
    return this.hydraAt ?? { at: 0, location: null, read: null }
  }

  /** The logo file of a Project Hydra project, from the last answer; null when it has none. */
  iconFile(key: string): string | null {
    return this.hydraAt?.read?.projects.find((p) => p.key === key)?.iconFile ?? null
  }

  /** The checkout's last known git state, and the read that refreshes it when it is missing or stale. */
  private gitOf(path: string): { facts: GitFacts | null; reading: Promise<void> | null } {
    const key = folderKey(path)
    const hit = this.gitCache.get(key)
    const fresh = hit && hit.sig === gitSignature(path) && this.now() - hit.at < GIT_TTL_MS
    return { facts: hit?.facts ?? null, reading: fresh ? null : this.readGitOnce(key, path) }
  }

  private readGitOnce(key: string, path: string): Promise<void> {
    let reading = this.gitReads.get(key)
    if (!reading) {
      reading = this.inGitSlot(async () => {
        const sig = gitSignature(path)
        const prev = this.gitCache.get(key)?.facts ?? null
        const facts = await (this.deps.git ?? readGit)(path, prev).catch(() => null)
        this.gitCache.set(key, { at: this.now(), sig, facts })
      }).finally(() => {
        this.gitReads.delete(key)
        if (!this.gitReads.size) this.save()
      })
      this.gitReads.set(key, reading)
    }
    return reading
  }

  /** Runs `read` once fewer than GIT_PARALLEL git reads are running. */
  private async inGitSlot(read: () => Promise<void>): Promise<void> {
    if (this.gitRunning < GIT_PARALLEL) this.gitRunning++
    else await new Promise<void>((go) => this.gitQueue.push(go)) // a finished read hands over its slot
    try {
      await read()
    } finally {
      const next = this.gitQueue.shift()
      if (next) next()
      else this.gitRunning--
    }
  }

  /** The grid from what is known now; `wait` answers once Project Hydra and the stale git states are read again. */
  async list(opts: { wait?: boolean } = {}): Promise<ProjectsResponse> {
    const wait = opts.wait ?? false
    const { location, read } = await this.hydra(wait)
    const rows = new Map<string, Row>()
    const hydraRows: { key: string; prefix: string; row: Row }[] = []
    for (const p of read?.projects ?? []) {
      if (isRemotePath(p.path) || !isDir(p.path)) continue
      const row = hydraRow(p)
      const key = folderKey(p.path)
      if (rows.has(key)) continue
      rows.set(key, row)
      hydraRows.push({ key, prefix: key + sep, row })
    }
    // The longest folder first, so a project nested in another one (a package in a monorepo) takes its own chats.
    hydraRows.sort((a, b) => b.key.length - a.key.length)

    const choices = this.deps.choices?.() ?? { folders: [], roots: [], hidden: [] }
    const addFolder = (path: string, source: ProjectSource) => {
      if (isRemotePath(path) || !isDir(path)) return
      const key = folderKey(path)
      let row = rows.get(key)
      if (!row) {
        row = { path: resolve(path), name: basename(path) || path, group: null, icon: null, hydraKey: null, sources: new Set(), lastChatAt: null }
        rows.set(key, row)
      }
      row.sources.add(source)
    }
    for (const folder of choices.folders) addFolder(folder, 'added')
    for (const root of choices.roots) for (const folder of subfolders(root)) addFolder(folder, 'folder')

    // A chat or Recent folder inside a Hydra project counts for that project; any other is its own row, as the
    // checkout that holds it.
    const temp = folderKey(this.deps.tempDir ?? tmpdir()) + sep
    const own = (dir: string): Row | null => {
      if (!dir || !isAbsolute(dir) || isRemotePath(dir)) return null
      const key = folderKey(dir)
      if (key.startsWith(temp)) return null
      const hydra = hydraRows.find((h) => key === h.key || key.startsWith(h.prefix))
      if (hydra) return hydra.row
      if (!isDir(dir)) return null
      const top = checkoutOf(dir)
      const topKey = folderKey(top)
      const inHydra = hydraRows.find((h) => topKey === h.key || topKey.startsWith(h.prefix))
      if (inHydra) return inHydra.row
      let row = rows.get(topKey)
      if (!row) {
        row = { path: top, name: basename(top) || top, group: null, icon: null, hydraKey: null, sources: new Set(), lastChatAt: null }
        rows.set(topKey, row)
      }
      return row
    }
    for (const chat of this.deps.chats()) {
      const row = own(chat.cwd)
      if (!row) continue
      row.sources.add('chats')
      row.lastChatAt = Math.max(row.lastChatAt ?? 0, chat.updatedAt)
    }
    for (const dir of this.deps.recent()) own(dir)?.sources.add('recent')

    const hidden = new Set(choices.hidden.map(folderKey))
    const list = [...rows.values()].filter((row) => !hidden.has(folderKey(row.path)))
    const keys = list.map((row) => folderKey(row.path))
    this.listed = new Set(keys)
    const known = list.map((row) => this.gitOf(row.path))
    if (wait) await Promise.all(known.map((k) => k.reading))
    const factsAt = (i: number) => (wait ? (this.gitCache.get(keys[i]!)?.facts ?? null) : known[i]!.facts)

    const projects: ProjectEntry[] = list.map((row, i) => {
      const f = factsAt(i)
      return {
        path: row.path,
        name: row.name,
        group: row.group,
        icon: row.icon,
        sources: [...row.sources],
        git: f?.git ?? null,
        lastCommitAt: f?.lastCommitAt ?? null,
        lastChatAt: row.lastChatAt ? new Date(row.lastChatAt).toISOString() : null,
      }
    })
    const newest = (p: ProjectEntry) => Math.max(p.lastChatAt ? Date.parse(p.lastChatAt) : 0, p.lastCommitAt ? Date.parse(p.lastCommitAt) : 0)
    projects.sort((a, b) => newest(b) - newest(a) || a.name.localeCompare(b.name))
    return {
      projects,
      choices: { folders: choices.folders, roots: choices.roots, hidden: choices.hidden },
      hydra: { found: !!location, root: location?.root ?? null, placed: hydraRows.length, problem: read?.problem ?? null },
      pending: !!this.hydraLoading || keys.some((key) => this.gitReads.has(key)),
    }
  }
}

function hydraRow(p: HydraProject): Row {
  return {
    path: p.path,
    name: p.name,
    group: p.group,
    icon: p.iconFile ? `/api/projects/icon?key=${encodeURIComponent(p.key)}` : null,
    hydraKey: p.key,
    sources: new Set(['projecthydra']),
    lastChatAt: null,
  }
}
