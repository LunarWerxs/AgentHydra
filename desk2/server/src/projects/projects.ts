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
//
// Chats count for the project they work in (owner, 2026-10-08: "ones with active chats would also show up on the top
// with a little badge ... how many unarchived chats exist for each"): this app's and the ones run elsewhere on this PC
// (Claude Desktop, the CLI). One started in a folder that holds projects (D:\NEWProjects) is placed by what it did
// (attribute.ts) and filed once into that project's sidebar group; a group the user picks is never changed.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ExternalSession, ProjectChoices, ProjectEntry, ProjectGit, ProjectSource, ProjectsResponse } from '@shared/protocol'
import { lastCwd, readTail } from '../bridge/session-jsonl'
import { isRemotePath } from '../engine/reveal'
import { runGit } from '../git/git'
import { type PlacedBy, SpotIndex } from './attribute'
import { checkoutOf, folderKey, isDir, subfolders } from './choices'
import type { HydraLocation, HydraProject, HydraRead } from './hydra'
import { writeFlushed } from '../write-flushed'

export interface GitFacts {
  git: ProjectGit
  lastCommitAt: string | null
  /** The commit HEAD was on (git status's branch.oid, '(initial)' before the first commit), so a re-read whose HEAD
   * has not moved keeps lastCommitAt instead of running `git log` again. */
  head?: string | null
}

/** One of this app's chats. Its folder and last activity (epoch ms) count it; the rest places and files it. */
export interface DeskChat {
  cwd: string
  updatedAt: number
  id?: string
  sessionId?: string | null
  title?: string
  archived?: boolean
  group?: string | null
}

/** A session run elsewhere, as the bridge lists it. */
export type OutsideChat = Pick<ExternalSession, 'id' | 'cwd' | 'title' | 'source' | 'lastActivityAt' | 'archived' | 'group' | 'fromPc'>

/** A chat to file: one of this app's by its id, one run elsewhere by its session id. */
export interface ChatRef {
  kind: 'desk' | 'outside'
  id: string
}

export interface ProjectDeps {
  /** Where Project Hydra is, or null when it is not installed. */
  findHydra(): HydraLocation | null
  readHydra(at: HydraLocation): Promise<HydraRead>
  /** The Recent list's folders. */
  recent(): string[]
  /** This app's chats, the archived ones too. */
  chats(): DeskChat[]
  /** The sessions run elsewhere (Claude Desktop, the CLI), read behind the answer as Project Hydra is. Default: none. */
  outside?(): Promise<OutsideChat[]>
  /** A session's transcript (.jsonl), or null when there is none yet. Default: none, so chats are placed by title only. */
  transcript?(sessionId: string, cwd: string): string | null
  /** Puts a chat in a sidebar group. Default: chats are placed on the grid, never filed. */
  file?(chat: ChatRef, group: string): unknown
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
/** How long the list of sessions run elsewhere is trusted. */
const OUTSIDE_TTL_MS = 20_000
/** How much of a transcript's end the paths tier reads. */
const PATH_BYTES = 2 * 1024 * 1024
/** How long a chat whose transcript was not found waits before it is looked for again. */
const PLACE_RETRY_MS = 60_000
/** Filed chats remembered, the newest kept. */
const FILED_KEPT = 5_000
/** A sidebar group's longest name (ChatPatch.group). */
const GROUP_MAX = 60

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
  openChats: number
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

interface OutsideState {
  at: number
  list: OutsideChat[]
}

/** Where a chat's transcript placed it, by session id: the file and its size when read (a grown one is read again),
 * and the project's folder (null: no tier placed it). */
interface Placement {
  at: number
  path: string | null
  size: number
  spot: string | null
  by: PlacedBy | null
}

/** What `cacheFile` holds: Project Hydra's last answer, the listed checkouts' git states by folder key, the last list
 * of sessions run elsewhere, the chats placed from their transcripts and the ones already filed. */
interface Snapshot {
  hydra: HydraState | null
  git: [string, GitEntry][]
  outside?: OutsideState | null
  placed?: [string, Placement][]
  filed?: string[]
}

/** A chat as the grid counts it. */
interface Chat {
  ref: ChatRef
  /** `<kind>:<id>`, as the filed list keeps it. */
  key: string
  sessionId: string | null
  cwd: string
  title: string
  at: number
  open: boolean
  group: string | null
}

interface Grid {
  rows: Map<string, Row>
  choices: ProjectChoices
  hydraPlaced: number
  /** Transcript reads this build started or found running. */
  placing: Promise<void>[]
  /** Chats placed away from the folder they started in, with nothing left to read before they are filed. */
  placedAway: { chat: Chat; row: Row }[]
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
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
  private outsideAt: OutsideState | null = null
  private outsideLoading: Promise<void> | null = null
  private readonly placed = new Map<string, Placement>()
  /** The transcript reads running or waiting, by session id. They run one at a time, on `placeChain`. */
  private readonly placing = new Map<string, Promise<void>>()
  private placeChain: Promise<void> = Promise.resolve()
  /** The session ids of the last build, the placements worth keeping on disk. */
  private seen = new Set<string>()
  private readonly filed = new Set<string>()
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
      if (typeof kept?.outside?.at === 'number' && Array.isArray(kept.outside.list)) this.outsideAt = kept.outside
      for (const [id, p] of Array.isArray(kept?.placed) ? kept.placed : []) if (typeof id === 'string' && typeof p?.size === 'number') this.placed.set(id, p)
      for (const key of Array.isArray(kept?.filed) ? kept.filed : []) if (typeof key === 'string') this.filed.add(key)
    } catch {
      // floor-ok: no snapshot (the first start, or a damaged file) means the first answer waits for Project Hydra
    }
  }

  private save(): void {
    const file = this.deps.cacheFile
    if (!file) return
    const git = [...this.gitCache].filter(([key]) => !this.listed.size || this.listed.has(key))
    const placed = [...this.placed].filter(([id]) => !this.seen.size || this.seen.has(id))
    const snapshot: Snapshot = { hydra: this.hydraAt, git, outside: this.outsideAt, placed, filed: [...this.filed].slice(-FILED_KEPT) }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFlushed(tmp, JSON.stringify(snapshot))
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

  /** The sessions run elsewhere, from the last read. A stale list is read again behind it, awaited only with `wait`:
   * without one yet the grid counts this app's chats alone and says it is pending. */
  private async outside(wait: boolean): Promise<OutsideChat[]> {
    if (!this.deps.outside) return []
    if (!this.outsideAt || this.now() - this.outsideAt.at > OUTSIDE_TTL_MS) {
      this.outsideLoading ??= Promise.resolve()
        .then(() => this.deps.outside!())
        .then((list) => {
          this.outsideAt = { at: this.now(), list }
          this.save()
        })
        .catch(() => {}) // floor-ok: a failed read keeps the last list; the next visit reads it again
        .finally(() => (this.outsideLoading = null))
      if (wait) await this.outsideLoading
    }
    return this.outsideAt?.list ?? []
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

  /** This app's chats and the sessions run elsewhere on this PC, as the grid counts them. The other PC's chats work
   * in its folders, and CliMayte's workers are not chats. */
  private chatsOf(outside: OutsideChat[]): Chat[] {
    const desk = this.deps.chats().map(
      (c): Chat => ({
        ref: { kind: 'desk', id: c.id ?? '' },
        key: `desk:${c.id ?? ''}`,
        sessionId: c.sessionId ?? null,
        cwd: c.cwd,
        title: c.title ?? '',
        at: c.updatedAt,
        open: !c.archived,
        group: c.group ?? null,
      }),
    )
    const elsewhere = outside
      .filter((s) => s.cwd && !s.fromPc && s.source !== 'climayte')
      .map(
        (s): Chat => ({
          ref: { kind: 'outside', id: s.id },
          key: `outside:${s.id}`,
          sessionId: s.id,
          cwd: s.cwd!,
          title: s.title,
          at: s.lastActivityAt ?? 0,
          open: !s.archived,
          group: s.group,
        }),
      )
    return [...desk, ...elsewhere]
  }

  /** The project a chat works in, from its transcript when one was read (the reading started when it is missing or
   * has grown), else from its title. `settled`: a transcript read has had its say, so the chat can be filed. */
  private place(chat: Chat, rows: Map<string, Row>, index: SpotIndex<Row>): { row: Row | null; reading: Promise<void> | null; settled: boolean } {
    if (chat.sessionId && this.deps.transcript) {
      const kept = this.placed.get(chat.sessionId)
      const stale = !kept || (kept.path ? sizeOf(kept.path) !== kept.size : this.now() - kept.at > PLACE_RETRY_MS)
      const reading = stale ? this.readPlacementOnce(chat.sessionId, chat.cwd, index) : null
      const row = kept?.spot ? rows.get(folderKey(kept.spot)) : undefined
      if (row) return { row, reading, settled: true }
      return { row: chat.title ? index.fromTitle(chat.title) : null, reading, settled: !!kept }
    }
    return { row: chat.title ? index.fromTitle(chat.title) : null, reading: null, settled: true }
  }

  private readPlacementOnce(sessionId: string, cwd: string, index: SpotIndex<Row>): Promise<void> {
    let reading = this.placing.get(sessionId)
    if (!reading) {
      // One transcript at a time, each after the event loop has had a turn: the reads are synchronous.
      reading = this.placeChain = this.placeChain
        .then(async () => {
          await new Promise((go) => setImmediate(go))
          this.placed.set(sessionId, this.readPlacement(sessionId, cwd, index))
        })
        .catch(() => {})
        .finally(() => {
          this.placing.delete(sessionId)
          if (!this.placing.size) this.save()
        })
      this.placing.set(sessionId, reading)
    }
    return reading
  }

  /** The paths tier, then the moved tier (attribute.ts); a project that is the chat's own folder places nothing. */
  private readPlacement(sessionId: string, cwd: string, index: SpotIndex<Row>): Placement {
    const at = this.now()
    const none: Placement = { at, path: null, size: -1, spot: null, by: null }
    try {
      const path = this.deps.transcript!(sessionId, cwd)
      if (!path) return none
      const size = statSync(path).size
      const start = folderKey(cwd)
      const away = (row: Row | null) => (row && folderKey(row.path) !== start ? row : null)
      const paths = index.fromPaths(readTail(path, PATH_BYTES))
      let row = away(paths.spot)
      let by: PlacedBy | null = row ? 'paths' : null
      if (!row && !paths.enough) {
        const moved = lastCwd(path)
        row = away(moved ? index.holding(moved) : null)
        if (row) by = 'moved'
      }
      return { at, path, size, spot: row?.path ?? null, by }
    } catch {
      return none
    }
  }

  /** The grid's rows from Project Hydra's answer, the chosen folders, the chats and the Recent list, as known now. */
  private build(read: HydraRead | null, outside: OutsideChat[]): Grid {
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
    const newRow = (path: string): Row => ({ path, name: basename(path) || path, group: null, icon: null, hydraKey: null, sources: new Set(), lastChatAt: null, openChats: 0 })
    const addFolder = (path: string, source: ProjectSource) => {
      if (isRemotePath(path) || !isDir(path)) return
      const key = folderKey(path)
      let row = rows.get(key)
      if (!row) {
        row = newRow(resolve(path))
        rows.set(key, row)
      }
      row.sources.add(source)
    }
    for (const folder of choices.folders) addFolder(folder, 'added')
    for (const root of choices.roots) for (const folder of subfolders(root)) addFolder(folder, 'folder')
    const spots = [...rows.keys()].map((key) => ({ key, prefix: key + sep }))

    // A chat or Recent folder inside a Hydra project counts for that project; any other is its own row, as the
    // checkout that holds it.
    const temp = folderKey(this.deps.tempDir ?? tmpdir()) + sep
    const usable = (dir: string) => !!dir && isAbsolute(dir) && !isRemotePath(dir) && !folderKey(dir).startsWith(temp)
    const own = (dir: string): Row | null => {
      if (!usable(dir)) return null
      const key = folderKey(dir)
      const hydra = hydraRows.find((h) => key === h.key || key.startsWith(h.prefix))
      if (hydra) return hydra.row
      if (!isDir(dir)) return null
      const top = checkoutOf(dir)
      const topKey = folderKey(top)
      const inHydra = hydraRows.find((h) => topKey === h.key || topKey.startsWith(h.prefix))
      if (inHydra) return inHydra.row
      let row = rows.get(topKey)
      if (!row) {
        row = newRow(top)
        rows.set(topKey, row)
      }
      return row
    }
    // A chat is placed by what it did when it started in a folder that holds projects, or in one that is in no
    // project and no checkout; every other chat is its folder's.
    const placeable = (dir: string): boolean => {
      if (!usable(dir)) return false
      const key = folderKey(dir)
      if (spots.some((s) => s.key.startsWith(key + sep))) return true
      if (spots.some((s) => key === s.key || key.startsWith(s.prefix))) return false
      return isDir(dir) && !existsSync(join(checkoutOf(dir), '.git'))
    }
    const count = (row: Row | null, chat: Chat) => {
      if (!row) return
      row.sources.add('chats')
      row.lastChatAt = Math.max(row.lastChatAt ?? 0, chat.at)
      if (chat.open) row.openChats++
    }

    const chats = this.chatsOf(outside)
    this.seen = new Set(chats.flatMap((c) => (c.sessionId ? [c.sessionId] : [])))
    const toPlace: Chat[] = []
    for (const chat of chats) {
      if (placeable(chat.cwd)) toPlace.push(chat)
      else count(own(chat.cwd), chat)
    }
    const placing: Promise<void>[] = []
    const placedAway: Grid['placedAway'] = []
    if (toPlace.length) {
      const index = new SpotIndex<Row>([...rows.values()], (p) => [p, folderKey(p)])
      for (const chat of toPlace) {
        const p = this.place(chat, rows, index)
        if (p.reading) placing.push(p.reading)
        const away = p.row && folderKey(p.row.path) !== folderKey(chat.cwd) ? p.row : null
        count(away ?? own(chat.cwd), chat)
        if (away && p.settled) placedAway.push({ chat, row: away })
      }
    }
    for (const dir of this.deps.recent()) own(dir)?.sources.add('recent')
    return { rows, choices, hydraPlaced: hydraRows.length, placing, placedAway }
  }

  /** Files each chat placed away from its folder, open and in no group yet, into its project's sidebar group, once:
   * a chat moved back, or out of a group, by hand stays where it was put. */
  private fileChats(grid: Grid): void {
    if (!this.deps.file) return
    // The project's name as its tile has it, less a note in brackets ("Packing Buddy (working name)"): a folder's name
    // can be a part's ('bench') or one many projects share ('app').
    const label = (row: Row) => (row.name.replace(/\s*\([^)]*\)\s*$/, '').trim() || row.name).slice(0, GROUP_MAX)
    let filed = false
    for (const { chat, row } of grid.placedAway) {
      if (!chat.open || chat.group || !chat.ref.id || this.filed.has(chat.key)) continue
      this.filed.add(chat.key)
      filed = true
      Promise.resolve()
        .then(() => this.deps.file!(chat.ref, label(row)))
        .catch(() => this.filed.delete(chat.key)) // floor-ok: not filed, so the next list tries again
    }
    if (filed) this.save()
  }

  /** The grid from what is known now; `wait` answers once Project Hydra, the sessions run elsewhere, the chats'
   * transcripts and the stale git states are read again. `git: false` leaves git as it is (the sweep). */
  async list(opts: { wait?: boolean; git?: boolean } = {}): Promise<ProjectsResponse> {
    const wait = opts.wait ?? false
    const [{ location, read }, outside] = await Promise.all([this.hydra(wait), this.outside(wait)])
    let grid = this.build(read, outside)
    if (wait && grid.placing.length) {
      await Promise.all(grid.placing)
      grid = this.build(read, outside)
    }
    this.fileChats(grid)

    const { choices } = grid
    const hidden = new Set(choices.hidden.map(folderKey))
    const list = [...grid.rows.values()].filter((row) => !hidden.has(folderKey(row.path)))
    const keys = list.map((row) => folderKey(row.path))
    this.listed = new Set(keys)
    const known = list.map((row, i) => (opts.git === false ? { facts: this.gitCache.get(keys[i]!)?.facts ?? null, reading: null } : this.gitOf(row.path)))
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
        openChats: row.openChats,
      }
    })
    const newest = (p: ProjectEntry) => Math.max(p.lastChatAt ? Date.parse(p.lastChatAt) : 0, p.lastCommitAt ? Date.parse(p.lastCommitAt) : 0)
    projects.sort((a, b) => Number(b.openChats > 0) - Number(a.openChats > 0) || newest(b) - newest(a) || a.name.localeCompare(b.name))
    return {
      projects,
      choices: { folders: choices.folders, roots: choices.roots, hidden: choices.hidden },
      hydra: { found: !!location, root: location?.root ?? null, placed: grid.hydraPlaced, problem: read?.problem ?? null },
      pending: !!this.hydraLoading || !!this.outsideLoading || this.placing.size > 0 || keys.some((key) => this.gitReads.has(key)),
    }
  }

  /** Places and files the chats with New closed (a timer runs it), leaving git alone. */
  async sweep(): Promise<void> {
    await this.list({ wait: true, git: false })
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
    openChats: 0,
  }
}
