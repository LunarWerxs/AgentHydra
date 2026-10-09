// Which project a chat works in when it was started outside every project (owner, 2026-10-08: "right now I'm lazy and
// I just open everything in NEWProjects, so I don't have to pick the subfolder, but I wouldn't mind if Agent Hydra
// automatically applies the right folders"). A chat whose folder is a project, or inside one, belongs to it. One
// started in a folder that holds projects (D:\NEWProjects) or anywhere else is placed by what it did, strongest first:
//   1. paths: the project its transcript's file paths name (its reads, edits and commands): the deepest one holding at
//      least 60% of them, a nested project's paths counting for the one holding it too;
//   2. moved: when its transcript names too few project paths to say, the folder Claude Code says it is in now (the
//      newest `cwd`, which follows `cd`);
//   3. title: one project's name in its title ("Inventory: fix the CSV export").
// No model is asked. Measured on the owner's 14 open chats started outside a project (2026-10-08): moved first put
// research chats in the project they last ran a command in, and split one app's chat across its parts; paths first
// placed 12, and the one whose work was spread over several projects and the one that touched none stayed in their own
// folder.

import { basename } from 'node:path'

export interface Spot {
  path: string
  name: string
}

export type PlacedBy = 'moved' | 'paths' | 'title'

/** A project's name shorter than this is not looked for in titles ('app', 'site', 'bench' name too much). */
const MIN_NAME = 6
/** The paths tier needs this many paths in projects, and the project's share of them. */
const MIN_PATH_HITS = 3
const PATH_SHARE = 0.6

/** Absolute paths as a transcript holds them: D:\\x\\y (JSON-escaped), D:/x/y, and POSIX or Git Bash /d/x/y. */
const PATHS = /[A-Za-z]:(?:\\\\|\\|\/)[^\s"'<>|*?`,;(){}[\]]*|(?<![\w.:~/-])\/[\w.~-][^\s"'<>|*?`,;(){}[\]]*/g

const WIN = process.platform === 'win32'

/** One spelling of a path: forward slashes, none doubled or trailing; on Windows, Git Bash's /d/x is d:/x and case is dropped. */
export function spelling(path: string): string {
  let p = path.replace(/[\\/]+/g, '/')
  if (WIN) {
    const bash = /^\/([a-zA-Z])(?:\/|$)/.exec(p)
    if (bash) p = `${bash[1]}:/${p.slice(3)}`
    p = p.toLowerCase()
  }
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

const word = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The projects a chat can be placed in; S is the caller's own row, handed back as it was given. */
export class SpotIndex<S extends Spot = Spot> {
  private readonly byPath = new Map<string, S>()
  private readonly names: { token: string; spot: S }[] = []

  /** `aliases` gives every spelling a project's folder is reached by (a junction and its target). */
  constructor(spots: readonly S[], aliases: (path: string) => string[] = (p) => [p]) {
    for (const s of spots) for (const a of aliases(s.path)) if (!this.byPath.has(spelling(a))) this.byPath.set(spelling(a), s)
    const owners = new Map<string, Set<S>>()
    for (const s of spots) {
      for (const token of new Set([word(s.name), word(basename(s.path))])) {
        if (token.length < MIN_NAME) continue
        const set = owners.get(token) ?? new Set<S>()
        set.add(s)
        owners.set(token, set)
      }
    }
    // A name two projects share places nothing.
    for (const [token, set] of owners) if (set.size === 1) this.names.push({ token, spot: [...set][0]! })
  }

  /** Every project whose folder is `path` or holds it, the nearest first. */
  private holders(path: string): S[] {
    const out: S[] = []
    let p = spelling(path)
    for (;;) {
      const hit = this.byPath.get(p)
      if (hit && !out.includes(hit)) out.push(hit)
      const cut = p.lastIndexOf('/')
      if (cut <= 0) return out
      p = p.slice(0, cut)
    }
  }

  /** The project whose folder is `path` or holds it, the nearest one up. */
  holding(path: string): S | null {
    return this.holders(path)[0] ?? null
  }

  /** The project a transcript's paths name, and whether they were `enough` to say (MIN_PATH_HITS in projects). */
  fromPaths(text: string): { spot: S | null; enough: boolean } {
    const hits = new Map<S, number>()
    /** How many projects hold it, itself included: the deepest qualifying one wins. */
    const depth = new Map<S, number>()
    let total = 0
    for (const m of text.matchAll(PATHS)) {
      const holders = this.holders(m[0])
      if (!holders.length) continue
      total++
      holders.forEach((s, i) => {
        hits.set(s, (hits.get(s) ?? 0) + 1)
        depth.set(s, holders.length - i)
      })
    }
    if (total < MIN_PATH_HITS) return { spot: null, enough: false }
    let best: S | null = null
    for (const [spot, n] of hits) if (n >= total * PATH_SHARE && (!best || depth.get(spot)! > depth.get(best)!)) best = spot
    return { spot: best, enough: true }
  }

  /** The one project whose name the title holds (spaces and case aside); none or two is null. */
  fromTitle(title: string): S | null {
    const t = word(title)
    const found = new Set(this.names.filter((n) => t.includes(n.token)).map((n) => n.spot))
    return found.size === 1 ? [...found][0]! : null
  }
}
