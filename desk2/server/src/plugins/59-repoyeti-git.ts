// The git actions of the bar above the message box, run in RepoYeti for the chat's folder: GET /api/repoyeti/git/state,
// POST .../draft and POST .../<action> (commit, push, pull, checkout, branch, undo, redo, create-pr). Desk's server calls
// RepoYeti's REST API itself (its loopback guard refuses a browser's cross-site request); there is no pull-request route
// in RepoYeti, so Create PR is branch + commit + push there and GitHub's compare page opened by the window.
// Own page only, and only while the repoyeti connector runs. Contract: shared/connectors.ts.

import { isAbsolute } from 'node:path'
import type { Context, Hono } from 'hono'
import {
  REPOYETI_GIT,
  REPOYETI_GIT_ACTIONS,
  type RepoYetiDraft,
  type RepoYetiGitAction,
  type RepoYetiGitRequest,
  type RepoYetiGitResult,
  type RepoYetiGitState
} from '@shared/connectors'
import type { ServerContext } from '../context'
import { connectorStatus } from '../connectors/registry'
import { notOwnPage } from '../own-page'
import { ensureUpstream, gitOut, RepoYetiClient, RepoYetiError, workTreeRoot } from '../repoyeti/api'
import { compareUrl, parseGithubRemote, prBranchName } from '../repoyeti/remote'

const WHAT = "RepoYeti's git actions"

interface Target {
  client: RepoYetiClient
  root: string
  id: string
}

interface Step {
  ok?: boolean
  message?: string
  step?: { to?: string; subject?: string }
}

/** Refuses what is not Desk 2's own page or RepoYeti not running, and resolves the folder to RepoYeti's repo. */
async function target(c: Context, cwd: unknown): Promise<Target> {
  const why = notOwnPage(c.req.raw.headers, WHAT)
  if (why) throw new RepoYetiError(why, 403)
  const dir = typeof cwd === 'string' ? cwd.trim() : ''
  if (!dir || !isAbsolute(dir)) throw new RepoYetiError('cwd must be an absolute folder', 400)
  const status = connectorStatus('repoyeti')
  if (!status || status.state !== 'running' || !status.url) throw new RepoYetiError('RepoYeti is not running', 409)
  const root = await workTreeRoot(dir)
  if (!root) throw new RepoYetiError('that folder is not a git work tree', 400)
  const client = new RepoYetiClient(status.url)
  return { client, root, id: await client.repoId(root) }
}

async function readBranches(t: Target): Promise<{ current: string | null; names: string[] }> {
  const b = await t.client.call<{ current?: string | null; branches?: { name?: string }[] }>('GET', `/api/repos/${t.id}/branches`)
  const names = (b.branches ?? []).map((x) => x.name).filter((n): n is string => typeof n === 'string')
  const current = typeof b.current === 'string' ? b.current : null
  return { current, names: current ? [current, ...names.filter((n) => n !== current)] : names }
}

async function defaultBranch(root: string, names: string[]): Promise<string | null> {
  const head = await gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head?.startsWith('origin/')) return head.slice('origin/'.length)
  return ['main', 'master'].find((n) => names.includes(n)) ?? null
}

async function state(t: Target): Promise<RepoYetiGitState> {
  const { current, names } = await readBranches(t)
  const preview = await t.client.call<{ undo?: Step; redo?: Step }>('GET', `/api/repos/${t.id}/undo`).catch((): { undo?: Step; redo?: Step } => ({}))
  // The URL as configured: get-url applies insteadOf rewrites, which can turn a GitHub URL into something else.
  const url = (await gitOut(t.root, ['config', '--get', 'remote.origin.url'])) ?? (await gitOut(t.root, ['remote', 'get-url', 'origin']))
  const words = (s?: Step): string | null => (s?.ok ? (s.step?.subject ?? s.message ?? 'the last git action') : null)
  return {
    repoId: t.id,
    branch: current,
    defaultBranch: await defaultBranch(t.root, names),
    branches: names,
    remote: url ? parseGithubRemote(url) : null,
    undo: words(preview.undo),
    ...(preview.undo && !preview.undo.ok && preview.undo.message ? { undoWhy: preview.undo.message } : {}),
    redo: words(preview.redo)
  }
}

/** RepoYeti's AI-drafted message for what changed; null when it has no AI provider or says nothing. */
async function draft(t: Target): Promise<string | null> {
  try {
    const r = await t.client.call<{ message?: unknown; draft?: unknown; text?: unknown; commitMessage?: unknown }>('POST', `/api/repos/${t.id}/commit-message`, {}, 60_000)
    const m = [r.draft, r.commitMessage, r.text, r.message].find((x): x is string => typeof x === 'string' && x.trim() !== '')
    return m ? m.trim() : null
  } catch {
    return null
  }
}

async function dirty(t: Target): Promise<boolean> {
  const r = await t.client.call<{ total?: number; files?: unknown[] }>('GET', `/api/repos/${t.id}/changes`)
  return (r.total ?? r.files?.length ?? 0) > 0
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

async function run(action: RepoYetiGitAction, t: Target, req: RepoYetiGitRequest): Promise<RepoYetiGitResult> {
  const at = `/api/repos/${t.id}`
  switch (action) {
    case 'commit': {
      const message = text(req.message)
      if (!message) throw new RepoYetiError('write a commit message first', 400)
      await t.client.call('POST', `${at}/commit`, { message, ...(req.amend ? { amend: true } : {}) })
      return { ok: true, message: req.amend ? 'Amended the last commit' : 'Committed' }
    }
    case 'push':
      await ensureUpstream(t.root, (await readBranches(t)).current ?? '')
      await t.client.net(`${at}/push`)
      return { ok: true, message: 'Pushed' }
    case 'pull':
      await t.client.net(`${at}/pull`)
      return { ok: true, message: 'Pulled (fast-forward)' }
    case 'checkout': {
      const branch = text(req.branch)
      if (!branch) throw new RepoYetiError('pick a branch', 400)
      await t.client.call('POST', `${at}/checkout`, { branch })
      return { ok: true, message: `Switched to ${branch}` }
    }
    case 'branch': {
      const name = text(req.branch)
      if (!name) throw new RepoYetiError('name the new branch', 400)
      await t.client.call('POST', `${at}/branch`, { name, switch: true })
      return { ok: true, message: `Created and switched to ${name}` }
    }
    case 'undo':
    case 'redo': {
      const preview = await t.client.call<{ undo?: Step; redo?: Step }>('GET', `${at}/undo`)
      const side = action === 'undo' ? preview.undo : preview.redo
      if (!side?.ok || !side.step?.to) throw new RepoYetiError(side?.message ?? `nothing to ${action}`, 422)
      await t.client.call('POST', `${at}/${action}`, { expect: { to: side.step.to, subject: side.step.subject ?? '' } })
      return { ok: true, message: action === 'undo' ? 'Undid the last git action' : 'Redid the git action' }
    }
    case 'create-pr': {
      const s = await state(t)
      if (!s.remote) throw new RepoYetiError('origin is not on GitHub, so there is no pull request page to open', 422)
      if (!s.branch) throw new RepoYetiError('switch to a branch first (HEAD is detached)', 422)
      let branch = s.branch
      if (branch === s.defaultBranch) {
        branch = prBranchName(new Date(), s.branches)
        await t.client.call('POST', `${at}/branch`, { name: branch, switch: true })
      }
      if (await dirty(t)) {
        const message = text(req.message) || (await draft(t)) || 'Update'
        await t.client.call('POST', `${at}/commit`, { message })
      }
      await ensureUpstream(t.root, branch)
      await t.client.net(`${at}/push`)
      return { ok: true, message: `Pushed ${branch}`, compareUrl: compareUrl(s.remote, branch) }
    }
  }
}

export default async function plugin(app: Hono, _ctx: ServerContext): Promise<void> {
  const fail = (c: Context, err: unknown) => {
    if (err instanceof RepoYetiError) return c.json({ error: err.message }, err.status as 400 | 403 | 409 | 422 | 502)
    return c.json({ error: `RepoYeti did not answer: ${err instanceof Error ? err.name : 'error'}` }, 502)
  }

  app.get(`${REPOYETI_GIT}/state`, async (c) => {
    try {
      return c.json(await state(await target(c, c.req.query('cwd'))))
    } catch (err) {
      return fail(c, err)
    }
  })

  app.post(`${REPOYETI_GIT}/draft`, async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as Partial<RepoYetiGitRequest> | null
      const out: RepoYetiDraft = { message: await draft(await target(c, body?.cwd)) }
      return c.json(out)
    } catch (err) {
      return fail(c, err)
    }
  })

  app.post(`${REPOYETI_GIT}/:action`, async (c) => {
    try {
      const action = c.req.param('action') as RepoYetiGitAction
      if (!REPOYETI_GIT_ACTIONS.includes(action)) return c.json({ error: 'unknown git action' }, 404)
      const body = (await c.req.json().catch(() => null)) as Partial<RepoYetiGitRequest> | null
      return c.json(await run(action, await target(c, body?.cwd), { cwd: body?.cwd ?? '', message: body?.message, amend: body?.amend === true, branch: body?.branch }))
    } catch (err) {
      return fail(c, err)
    }
  })
}
