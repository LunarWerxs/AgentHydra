// POST /dw/folder: a chat's folder in the server manager without an Add step. The project it is already in, else
// its own .devwebui, else one written from what DevWebUI finds there (Claude Code Desktop's .claude/launch.json, or
// the dev scripts in package.json), the way Claude Code Desktop sets up a folder's preview servers by itself.
// DevWebUI registers a project it has never seen with every server stopped, so nothing runs until Start is clicked.
// A .devwebui written here is kept out of `git status` through the repo's own info/exclude, which is never committed.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { type DevWebFolder, type DevWebProject, projectForCwd } from '@shared/devwebui'
import { daemonAuth } from './daemon'

interface Answer {
  ok: boolean
  body: Record<string, unknown>
}

async function ask(base: string, path: string, body?: unknown): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = daemonAuth(base)
  if (auth) headers.authorization = auth
  const res = await fetch(`${base}/api${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
  const parsed = (await res.json().catch(() => null)) as unknown
  return { ok: res.ok, body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} }
}

const NOTHING = 'Nothing to run here: no .claude/launch.json, and no dev script in package.json.'

export async function setUpFolder(base: string, cwd: string): Promise<DevWebFolder> {
  const list = await ask(base, '/projects')
  const known = projectForCwd(Array.isArray(list.body) ? (list.body as DevWebProject[]) : [], cwd)
  if (known) return { project: known }

  let res = await ask(base, '/projects/load', { path: cwd })
  if (res.ok && res.body.needsScaffold) {
    res = await ask(base, '/projects/scaffold', { dir: res.body.dir, fileName: res.body.fileName, project: res.body.proposal })
    if (res.ok && typeof res.body.created === 'string') excludeFromGit(res.body.created)
  }
  const project = res.body.project as DevWebProject | undefined
  if (res.ok && project) return typeof res.body.created === 'string' ? { project, created: res.body.created } : { project }
  return { nothing: typeof res.body.error === 'string' && !/^No \.devwebui file found/.test(res.body.error) ? res.body.error : NOTHING }
}

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })

/** Adds `file` to its repo's info/exclude unless git already ignores it or it is outside a work tree. True when added. */
export function excludeFromGit(file: string): boolean {
  const dir = dirname(file)
  const name = basename(file)
  const inside = git(dir, 'rev-parse', '--is-inside-work-tree')
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return false
  if (git(dir, 'check-ignore', '-q', name).status === 0) return false
  const prefix = git(dir, 'rev-parse', '--show-prefix').stdout.trim()
  const where = git(dir, 'rev-parse', '--git-path', 'info/exclude').stdout.trim()
  if (!where) return false
  const exclude = resolve(dir, where)
  mkdirSync(dirname(exclude), { recursive: true })
  const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  appendFileSync(exclude, `${before === '' || before.endsWith('\n') ? '' : '\n'}/${prefix}${name}\n`)
  return true
}
