import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HydraRead } from '../../src/projects/hydra'
import { ProjectList, parseStatus, type GitFacts } from '../../src/projects/projects'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'projects-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('parseStatus', () => {
  test('reads the branch, upstream, ahead and behind counts and the changed files', () => {
    const out = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +1 -2', '1 .M N... 100644 100644 100644 a b f.ts', '? new.txt', ''].join('\n')
    expect(parseStatus(out)).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, dirty: 2 })
  })

  test('a detached HEAD has no branch name', () => {
    expect(parseStatus('# branch.oid abc\n# branch.head (detached)\n').branch).toBeNull()
  })
})

describe('ProjectList', () => {
  test('a chat in a Hydra project counts for that project, the nested one takes its own, a scratch chat is left out, and other folders roll up to their checkout', async () => {
    const app = resolve(base, 'app')
    const pkg = resolve(app, 'pkg')
    const tool = resolve(base, 'tool')
    const scratch = resolve(base, 'scratch')
    for (const dir of [join(app, 'docs'), join(pkg, 'src'), join(tool, 'src'), join(tool, '.git')]) mkdirSync(dir, { recursive: true })

    const read: HydraRead = {
      problem: null,
      projects: [
        { key: 'app', path: app, name: 'App', group: 'Work', iconFile: null },
        { key: 'pkg', path: pkg, name: 'Pkg', group: null, iconFile: null },
      ],
    }
    const gitByPath = new Map<string, GitFacts>([[app, { git: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 1, dirty: 0, fetchedAt: null }, lastCommitAt: null }]])
    const list = new ProjectList({
      findHydra: () => ({ python: 'python', ph: join(base, 'ph.py'), root: base }),
      readHydra: async () => read,
      recent: () => [tool],
      chats: () => [
        { cwd: join(app, 'docs'), updatedAt: 1_000 },
        { cwd: join(pkg, 'src'), updatedAt: 2_000 },
        { cwd: join(tool, 'src'), updatedAt: 3_000 },
        { cwd: join(scratch, 'run'), updatedAt: 4_000 },
      ],
      git: async (path) => gitByPath.get(path) ?? null,
      tempDir: scratch,
    })

    const res = await list.list()
    const byPath = new Map(res.projects.map((p) => [p.path, p]))
    expect(res.projects.length).toBe(3)
    expect(byPath.get(app)?.sources).toEqual(['projecthydra', 'chats'])
    expect(byPath.get(app)?.git?.behind).toBe(1)
    expect(byPath.get(app)?.lastChatAt).toBe(new Date(1_000).toISOString())
    expect(byPath.get(pkg)?.sources).toEqual(['projecthydra', 'chats'])
    expect(byPath.get(pkg)?.lastChatAt).toBe(new Date(2_000).toISOString())
    expect(byPath.get(tool)?.sources).toEqual(['chats', 'recent'])
    expect(byPath.get(tool)?.git).toBeNull()
    expect(res.hydra).toEqual({ found: true, root: base, placed: 2, problem: null })
  })
})
