// POST /dw/folder: a chat's folder in the server manager without an Add step. The project it is already in, else its
// own .devwebui, else one written from what the folder has (Claude Code Desktop's .claude/launch.json, or the dev
// scripts in package.json), the way Claude Code Desktop sets up a folder's preview servers by itself. A project the
// manager has never seen is registered with every server stopped, so nothing runs until a start is asked for. A
// .devwebui written here is kept out of `git status` through the repo's own info/exclude, which is never committed.
// Ported from desk2/server/src/devwebui/folder.ts, calling the manager in-process instead of over HTTP.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { type DevWebFolder, type DevWebProject, projectForCwd } from '@shared/devwebui'
import type { DevServers } from './contract'
import { DevServerError } from './contract'

/** The part of the manager this needs. */
export type FolderApi = Pick<DevServers, 'listProjects' | 'load' | 'scaffold'>

const NOTHING = 'Nothing to run here: no .claude/launch.json, and no dev script in package.json.'

export async function setUpFolder(api: FolderApi, cwd: string): Promise<DevWebFolder> {
  const known = projectForCwd(await api.listProjects(), cwd)
  if (known) return { project: known }

  let project: DevWebProject
  let created: string | undefined
  try {
    const res = await api.load(cwd)
    if ('needsScaffold' in res) {
      const made = await api.scaffold(res.dir, res.fileName, res.proposal)
      excludeFromGit(made.created)
      project = made.project
      created = made.created
    } else project = res.project
  } catch (e) {
    if (!(e instanceof DevServerError)) throw e
    return { nothing: /^No \.devwebui file found/.test(e.message) ? NOTHING : e.message }
  }
  return created ? { project, created } : { project }
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
