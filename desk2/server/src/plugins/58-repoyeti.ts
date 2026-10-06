// POST /api/repoyeti/register { cwd }: the RepoYeti pane asks Desk to add the chat's folder to RepoYeti's list. Desk
// makes the call itself (no Origin, loopback Host) because RepoYeti's loopback guard refuses a browser's cross-site
// request. RepoYeti answers 201 for a folder it already has too, so "added" comes from its list read first.
// Only for Desk 2's own page, and only while the repoyeti connector is running.

import { isAbsolute, resolve } from 'node:path'
import type { Hono } from 'hono'
import { REPOYETI_REGISTER, type RepoYetiRegisterRequest, type RepoYetiRegisterResult } from '@shared/connectors'
import type { ServerContext } from '../context'
import { connectorStatus } from '../connectors/registry'
import { notOwnPage } from '../own-page'

const WHAT = "RepoYeti's registration API"
const CALL_MS = 15_000

const sameFolder = (a: string, b: string): boolean => {
  const norm = (p: string): string => resolve(p).replace(/[\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/** The root of the git work tree `cwd` is in, or null when it is not in one. */
async function workTreeRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const out = (await new Response(proc.stdout).text()).trim()
    return (await proc.exited) === 0 && out ? resolve(out) : null
  } catch {
    return null
  }
}

export default async function plugin(app: Hono, _ctx: ServerContext): Promise<void> {
  app.post(REPOYETI_REGISTER, async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const body = (await c.req.json().catch(() => null)) as Partial<RepoYetiRegisterRequest> | null
    const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
    if (!cwd || !isAbsolute(cwd)) return c.json({ error: 'cwd must be an absolute folder' }, 400)
    const status = connectorStatus('repoyeti')
    if (!status || status.state !== 'running' || !status.url) return c.json({ error: 'RepoYeti is not running' }, 409)
    const root = await workTreeRoot(cwd)
    if (!root) return c.json({ error: 'that folder is not a git work tree' }, 400)
    try {
      const listed = await fetch(`${status.url}/api/repos`, { signal: AbortSignal.timeout(CALL_MS) })
      if (!listed.ok) return c.json({ error: `RepoYeti's list answered ${listed.status}` }, 502)
      const repos = ((await listed.json()) as { repos?: { id?: string; absPath?: string }[] }).repos ?? []
      const have = repos.find((r) => typeof r.absPath === 'string' && sameFolder(r.absPath, root))
      if (have) {
        const done: RepoYetiRegisterResult = { ok: true, added: false, repoId: have.id }
        return c.json(done)
      }
      const res = await fetch(`${status.url}/api/repos/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: root }),
        signal: AbortSignal.timeout(CALL_MS)
      })
      const answer = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; repo?: { id?: string } }
      if (!res.ok || answer.ok === false) return c.json({ error: String(answer.message ?? `RepoYeti answered ${res.status}`).slice(0, 200) }, 422)
      const done: RepoYetiRegisterResult = { ok: true, added: true, repoId: answer.repo?.id }
      return c.json(done)
    } catch (err) {
      return c.json({ error: `RepoYeti did not answer: ${err instanceof Error ? err.name : 'error'}` }, 502)
    }
  })
}
