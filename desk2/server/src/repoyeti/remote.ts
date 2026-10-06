// What the bar's Create PR needs from a git remote URL: GitHub's owner and repo, the compare page of a branch and a name
// for the branch that work on the default branch moves to. Pure, so it is tested without git.

import type { RepoYetiRemote } from '@shared/connectors'

/** The GitHub owner/repo of a remote URL (https, ssh:// or scp-like git@github.com:owner/repo.git), or null for any other host. */
export function parseGithubRemote(url: string): RepoYetiRemote | null {
  const u = url.trim()
  const m =
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u) ??
    /^(?:ssh:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u)
  return m ? { owner: m[1]!, repo: m[2]! } : null
}

/** https://github.com/<owner>/<repo>/compare/<branch>?expand=1; each part of the branch is encoded, its slashes stay. */
export function compareUrl(remote: RepoYetiRemote, branch: string): string {
  const path = branch.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${remote.owner}/${remote.repo}/compare/${path}?expand=1`
}

/** A fresh branch name for work found on the default branch: desk/YYYYMMDD-HHMM (UTC), so two PRs on a day differ. */
export function prBranchName(now: Date, taken: readonly string[]): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const base = `desk/${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`
  return name
}
