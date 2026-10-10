// Desk's server talking to RepoYeti's REST API for one folder: the work-tree root, RepoYeti's id for it (registered
// when missing), and short readable errors. No credential is sent: in loopback local mode RepoYeti answers /api/* to
// Desk's server without one; a refusal says so in words and never carries a token.

import { resolve } from 'node:path'

const CALL_MS = 20_000
/** Pushing and pulling go over the network. */
const NET_MS = 90_000

export class RepoYetiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export const sameFolder = (a: string, b: string): boolean => {
  const norm = (p: string): string => resolve(p).replace(/[\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/** Runs git read-only in `cwd` (rev-parse, symbolic-ref, remote get-url); null on any failure. */
export async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const out = (await new Response(proc.stdout).text()).trim()
    return (await proc.exited) === 0 && out ? out : null
  } catch {
    return null
  }
}

/**
 * RepoYeti refuses to push a branch that has no upstream ("set one at your desk"), and a branch Create PR just made has
 * none: this records origin/<branch> as its upstream in git config (no network, no history change), so the push is
 * still RepoYeti's own. Nothing is set when the branch already has one or the repo has no origin.
 */
export async function ensureUpstream(root: string, branch: string): Promise<void> {
  if (!branch || (await gitOut(root, ['config', '--get', `branch.${branch}.merge`]))) return
  if (!(await gitOut(root, ['config', '--get', 'remote.origin.url']))) return
  for (const [key, value] of [[`branch.${branch}.remote`, 'origin'], [`branch.${branch}.merge`, `refs/heads/${branch}`]]) {
    await Bun.spawn(['git', '-C', root, 'config', key, value], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).exited
  }
}

/** The root of the git work tree `cwd` is in, or null when it is not in one. */
export async function workTreeRoot(cwd: string): Promise<string | null> {
  const out = await gitOut(cwd, ['rev-parse', '--show-toplevel'])
  return out ? resolve(out) : null
}

const short = (s: unknown, fallback: string): string => String(s ?? fallback).replace(/\s+/g, ' ').slice(0, 200)

export class RepoYetiClient {
  constructor(readonly url: string) {}

  /** One call; `ok:false` answers and non-2xx statuses become a RepoYetiError with RepoYeti's own message. */
  async call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, ms = CALL_MS): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(ms)
      })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new RepoYetiError(timedOut ? 'RepoYeti took too long to answer' : 'RepoYeti did not answer', 502)
    }
    if (res.status === 401 || res.status === 403) throw new RepoYetiError('RepoYeti asks you to sign in: open it and continue', 409)
    const json = (await res.json().catch(() => null)) as (Record<string, unknown> & { ok?: boolean; message?: unknown }) | null
    if (!res.ok || !json || json.ok === false) throw new RepoYetiError(short(json?.message, `RepoYeti answered ${res.status}`), res.ok ? 422 : 502)
    return json as T
  }

  /** Network calls (push, pull) wait longer. */
  net<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.call<T>('POST', path, undefined, NET_MS)
  }

  /** RepoYeti's id for the work tree at `root`: listed already, or registered now. */
  async repoId(root: string): Promise<string> {
    const listed = await this.call<{ repos?: { id?: string; absPath?: string }[] }>('GET', '/api/repos')
    const have = (listed.repos ?? []).find((r) => typeof r.absPath === 'string' && sameFolder(r.absPath, root))
    if (have?.id) return have.id
    const made = await this.call<{ repo?: { id?: string } }>('POST', '/api/repos/register', { path: root })
    if (!made.repo?.id) throw new RepoYetiError('RepoYeti did not give the folder an id', 502)
    return made.repo.id
  }
}
