// server/src/fleet-git.ts - PIECE 3 of the orchestrator rebuild (owner-picked, 2026-08-29):
// git hygiene for the repos the live sessions are working in, observed deterministically.
//
// Same doctrine as fleet.ts / fleet-usage.ts: 100% programmatic, read-only, zero AI. Every fact
// is git's own answer to a stated question - never an inference:
//   - repo root:  `git rev-parse --show-toplevel`  (also the dedupe key: many sessions, one repo)
//   - branch:     `git rev-parse --abbrev-ref HEAD` ('HEAD' = detached)
//   - dirty:      `git status --porcelain` line count
//   - ahead:      `git rev-list --count @{upstream}..HEAD` (null when no upstream exists)
// offMain flags a branch that is not main/master, or a detached HEAD - the standing owner rule
// is that work happens on main, so being elsewhere is a fact worth surfacing. What to DO about
// a dirty or off-main repo is a later piece's business.
//
// Failure honesty: a git call that errors or times out yields nulls plus an `error` string on
// that repo's row - never a silent zero, because "0 dirty files" and "could not ask" must not
// look alike. Each command carries its own timeout so one hung git (e.g. a lock contest with a
// concurrent session) cannot wedge the endpoint.

export interface FleetRepoState {
  root: string
  /** Live-session cwds working inside this repo (why it is being watched at all). */
  cwds: string[]
  branch: string | null
  detached: boolean
  /** Not on main/master, or detached. Work happens on main (standing owner rule). */
  offMain: boolean
  dirtyCount: number | null
  /** Commits ahead of upstream; null when there is no upstream to compare against. */
  aheadCount: number | null
  /** The first git failure hit for this repo, verbatim and truncated - or null. */
  error: string | null
}

export interface FleetGit {
  repos: FleetRepoState[]
  /** Live-session cwds that are not inside any git repository. A fact, not a problem. */
  notRepo: string[]
}

const GIT_TIMEOUT_MS = 3000
const MAIN_BRANCHES = new Set(['main', 'master'])

export interface FleetGitDeps {
  /** Seam for tests; the default shells out to real git with a timeout. */
  runGit?: (args: string[]) => Promise<{ ok: boolean; out: string; err: string }>
}

async function realRunGit(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const killer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }, GIT_TIMEOUT_MS)
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(killer)
    return { ok: code === 0, out: out.trim(), err: err.trim() }
  } catch (e) {
    return { ok: false, out: '', err: e instanceof Error ? e.message : String(e) }
  }
}

function normKey(p: string): string {
  return p
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Git hygiene for every repo the given cwds live in, deduped by repo root, dirtiest first.
 * Read-only: nothing here writes, locks, or fetches.
 */
export async function fleetGit(cwds: string[], deps: FleetGitDeps = {}): Promise<FleetGit> {
  const runGit = deps.runGit ?? realRunGit
  const notRepo: string[] = []
  // cwd -> root, deduped by normalized cwd first so one repo is asked about once per distinct dir.
  const seenCwd = new Set<string>()
  const rootCwds = new Map<string, { root: string; cwds: string[] }>()
  for (const cwd of cwds) {
    const key = normKey(cwd)
    if (seenCwd.has(key)) continue
    seenCwd.add(key)
    const top = await runGit(['-C', cwd, 'rev-parse', '--show-toplevel'])
    if (!top.ok || !top.out) {
      notRepo.push(cwd)
      continue
    }
    const rootKey = normKey(top.out)
    const entry = rootCwds.get(rootKey)
    if (entry) entry.cwds.push(cwd)
    else rootCwds.set(rootKey, { root: top.out, cwds: [cwd] })
  }

  const repos: FleetRepoState[] = []
  for (const { root, cwds: members } of rootCwds.values()) {
    let error: string | null = null
    const fail = (r: { err: string }) => {
      if (error === null) error = (r.err || 'git failed').slice(0, 200)
    }
    const branchRes = await runGit(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = branchRes.ok && branchRes.out ? branchRes.out : null
    if (!branchRes.ok) fail(branchRes)
    const detached = branch === 'HEAD'
    const statusRes = await runGit(['-C', root, 'status', '--porcelain'])
    const dirtyCount = statusRes.ok
      ? statusRes.out.split('\n').filter((l) => l.trim()).length
      : null
    if (!statusRes.ok) fail(statusRes)
    // No upstream is an ordinary condition (fresh branch, local-only repo): null, not an error.
    const aheadRes = await runGit(['-C', root, 'rev-list', '--count', '@{upstream}..HEAD'])
    const aheadCount = aheadRes.ok && /^\d+$/.test(aheadRes.out) ? Number(aheadRes.out) : null
    repos.push({
      root,
      cwds: members.sort(),
      branch,
      detached,
      offMain: detached || (branch !== null && !MAIN_BRANCHES.has(branch)),
      dirtyCount,
      aheadCount,
      error,
    })
  }
  // Dirtiest first (null = could-not-ask sorts above clean, below genuinely dirty), then root.
  repos.sort(
    (a, b) => (b.dirtyCount ?? 0.5) - (a.dirtyCount ?? 0.5) || a.root.localeCompare(b.root),
  )
  return { repos, notRepo: notRepo.sort() }
}
