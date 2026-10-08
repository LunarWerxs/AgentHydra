// The New screen's project grid (GET /api/projects; owner, 2026-10-08: "I click New Chat, and rather than seeing this
// overview and models, I see all my projects"). Rows come from Project Hydra when it is installed (hydra.ts) and,
// always, from the folders this app's chats and Recent list use, rolled up to the checkout that holds them. Each
// row's git state is read here with `git status` (never a fetch: `behind` is as fresh as the checkout's own last
// fetch, which `fetchedAt` gives).

import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { ProjectChoices, ProjectEntry, ProjectGit, ProjectSource, ProjectsResponse } from '@shared/protocol'
import { isRemotePath } from '../engine/reveal'
import { runGit } from '../git/git'
import { checkoutOf, folderKey, isDir, subfolders } from './choices'
import type { HydraLocation, HydraProject, HydraRead } from './hydra'

export interface GitFacts {
  git: ProjectGit
  lastCommitAt: string | null
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
  /** A checkout's git state, or null when it is not one. Default: readGit. */
  git?(path: string): Promise<GitFacts | null>
  now?(): number
  /** The scratch folder whose chats are left out. Default: the OS temp folder. */
  tempDir?: string
}

/** How long Project Hydra's answer and where it is installed are reused. */
const HYDRA_TTL_MS = 60_000
/** How long one checkout's git state is reused while its index, HEAD and FETCH_HEAD stay as they were. */
const GIT_TTL_MS = 20_000
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

/** A checkout's git state, or null when `path` is not one (or git cannot read it). */
export async function readGit(path: string): Promise<GitFacts | null> {
  const gitDir = gitDirOf(path)
  if (!gitDir) return null
  const status = await runGit(path, ['status', '--porcelain=v2', '--branch']).catch(() => null)
  if (!status || status.code !== 0) return null
  const log = await runGit(path, ['log', '-1', '--format=%cI']).catch(() => null)
  const fetched = mtime(join(gitDir, 'FETCH_HEAD'))
  return {
    git: { ...parseStatus(status.stdout.toString('utf8')), fetchedAt: fetched ? new Date(fetched).toISOString() : null },
    lastCommitAt: log?.code === 0 ? log.stdout.toString('utf8').trim() || null : null,
  }
}

/** What makes a cached git state stale before its time is up: a commit, a checkout, a stage or a fetch. */
function gitSignature(path: string): string {
  const dir = gitDirOf(path)
  if (!dir) return ''
  return ['index', 'HEAD', 'FETCH_HEAD'].map((f) => mtime(join(dir, f))).join(':')
}

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) await run(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane))
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

export class ProjectList {
  private hydraAt: { at: number; location: HydraLocation | null; read: HydraRead | null } | null = null
  private hydraLoading: Promise<void> | null = null
  private readonly gitCache = new Map<string, { at: number; sig: string; facts: GitFacts | null }>()
  private readonly now: () => number

  constructor(private readonly deps: ProjectDeps) {
    this.now = deps.now ?? Date.now
  }

  private async hydra(): Promise<{ location: HydraLocation | null; read: HydraRead | null }> {
    if (!this.hydraAt || this.now() - this.hydraAt.at > HYDRA_TTL_MS) {
      this.hydraLoading ??= (async () => {
        const location = this.deps.findHydra()
        const read = location ? await this.deps.readHydra(location) : null
        // A failed read keeps the projects of the last good one; the problem is still said.
        const kept = read?.problem && !read.projects.length && this.hydraAt?.read?.projects.length ? { ...read, projects: this.hydraAt.read.projects } : read
        this.hydraAt = { at: this.now(), location, read: kept }
      })().finally(() => (this.hydraLoading = null))
      await this.hydraLoading
    }
    return { location: this.hydraAt!.location, read: this.hydraAt!.read }
  }

  /** The logo file of a Project Hydra project, from the last answer; null when it has none. */
  iconFile(key: string): string | null {
    return this.hydraAt?.read?.projects.find((p) => p.key === key)?.iconFile ?? null
  }

  private async gitOf(path: string): Promise<GitFacts | null> {
    const key = folderKey(path)
    const sig = gitSignature(path)
    const hit = this.gitCache.get(key)
    if (hit && hit.sig === sig && this.now() - hit.at < GIT_TTL_MS) return hit.facts
    const facts = await (this.deps.git ?? readGit)(path)
    this.gitCache.set(key, { at: this.now(), sig, facts })
    return facts
  }

  async list(): Promise<ProjectsResponse> {
    const { location, read } = await this.hydra()
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
    const facts = new Map<Row, GitFacts | null>()
    await inBatches(list, GIT_PARALLEL, async (row) => void facts.set(row, await this.gitOf(row.path).catch(() => null)))

    const projects: ProjectEntry[] = list.map((row) => {
      const f = facts.get(row) ?? null
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
