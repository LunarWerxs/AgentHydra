import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
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

    const res = await list.list({ wait: true })
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

  test('a Hydra project reached through a junction is one row, and the chat that ran in its target joins it', async () => {
    const target = resolve(base, 'Connections')
    const link = resolve(base, 'shared', 'Connections')
    mkdirSync(target)
    mkdirSync(resolve(base, 'shared'))
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

    const list = new ProjectList({
      findHydra: () => ({ python: 'python', ph: join(base, 'ph.py'), root: base }),
      readHydra: async () => ({ problem: null, projects: [{ key: 'connections', path: link, name: 'Connections', group: null, iconFile: null }] }),
      recent: () => [],
      chats: () => [{ cwd: target, updatedAt: 1_000 }],
      git: async () => null,
      tempDir: resolve(base, 'scratch'),
    })

    const res = await list.list({ wait: true })
    expect(res.projects.length).toBe(1)
    expect(res.projects[0]!.path).toBe(link)
    expect(res.projects[0]!.sources).toEqual(['projecthydra', 'chats'])
  })

  const facts = (behind: number): GitFacts => ({ git: { branch: 'main', upstream: 'origin/main', ahead: 0, behind, dirty: 0, fetchedAt: null }, lastCommitAt: null })

  test('the grid answers before git does, says so, and wait answers with the fresh git state', async () => {
    const app = resolve(base, 'app')
    mkdirSync(app)
    let release!: () => void
    const gitDone = new Promise<void>((r) => (release = r))
    const list = new ProjectList({
      findHydra: () => ({ python: 'python', ph: join(base, 'ph.py'), root: base }),
      readHydra: async () => ({ problem: null, projects: [{ key: 'app', path: app, name: 'App', group: null, iconFile: null }] }),
      recent: () => [],
      chats: () => [],
      git: async () => {
        await gitDone
        return facts(3)
      },
    })

    const first = await list.list()
    expect(first.projects.map((p) => p.name)).toEqual(['App'])
    expect(first.projects[0]!.git).toBeNull()
    expect(first.pending).toBe(true)

    const waited = list.list({ wait: true })
    release()
    const fresh = await waited
    expect(fresh.projects[0]!.git?.behind).toBe(3)
    expect(fresh.pending).toBe(false)
  })

  test('a restarted server answers from the kept snapshot without waiting for Project Hydra or git', async () => {
    const app = resolve(base, 'app')
    mkdirSync(app)
    const cacheFile = join(base, 'home', 'projects.json')
    const deps = {
      findHydra: () => ({ python: 'python', ph: join(base, 'ph.py'), root: base }),
      recent: () => [],
      chats: () => [],
      cacheFile,
    }
    const before = new ProjectList({
      ...deps,
      readHydra: async () => ({ problem: null, projects: [{ key: 'app', path: app, name: 'App', group: 'Work', iconFile: null }] }),
      git: async () => facts(2),
    })
    await before.list({ wait: true })

    // Started ten minutes later: everything kept is stale, so both are read again, behind the answer.
    const never = new Promise<never>(() => {})
    const after = new ProjectList({ ...deps, readHydra: () => never, git: () => never, now: () => Date.now() + 600_000 })
    const res = await after.list()
    expect(res.projects.map((p) => [p.name, p.group, p.git?.behind])).toEqual([['App', 'Work', 2]])
    expect(res.hydra.found).toBe(true)
    expect(res.pending).toBe(true)
  })
})
