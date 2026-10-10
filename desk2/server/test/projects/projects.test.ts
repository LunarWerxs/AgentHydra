import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HydraRead } from '../../src/projects/hydra'
import { type ChatRef, type GitFacts, type OutsideChat, ProjectList, parseStatus } from '../../src/projects/projects'

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

  test('a hidden project is left out unless the list asks for hidden ones, and is then marked hidden', async () => {
    const app = resolve(base, 'app')
    const other = resolve(base, 'other')
    mkdirSync(app)
    mkdirSync(other)
    const list = new ProjectList({
      findHydra: () => ({ python: 'python', ph: join(base, 'ph.py'), root: base }),
      readHydra: async () => ({
        problem: null,
        projects: [
          { key: 'app', path: app, name: 'App', group: null, iconFile: null },
          { key: 'other', path: other, name: 'Other', group: null, iconFile: null },
        ],
      }),
      recent: () => [],
      chats: () => [],
      git: async () => null,
      choices: () => ({ folders: [], roots: [], hidden: [app] }),
      tempDir: resolve(base, 'scratch'),
    })

    const shown = await list.list({ wait: true })
    expect(shown.projects.map((p) => p.name)).toEqual(['Other'])
    expect(shown.projects[0]!.hidden).toBe(false)

    const all = await list.list({ wait: true, hidden: true })
    const byName = new Map(all.projects.map((p) => [p.name, p]))
    expect(byName.get('App')?.hidden).toBe(true)
    expect(byName.get('Other')?.hidden).toBe(false)
    expect(all.choices.hidden).toEqual([app])
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
    before.flushSync()

    // Started ten minutes later: everything kept is stale, so both are read again, behind the answer.
    const never = new Promise<never>(() => {})
    const after = new ProjectList({ ...deps, readHydra: () => never, git: () => never, now: () => Date.now() + 600_000 })
    const res = await after.list()
    expect(res.projects.map((p) => [p.name, p.group, p.git?.behind])).toEqual([['App', 'Work', 2]])
    expect(res.hydra.found).toBe(true)
    expect(res.pending).toBe(true)
  })

  test('a chat started in a folder of projects counts for the one it worked in, those with open chats come first, and each is filed into that group once', async () => {
    const projects = resolve(base, 'projects')
    const alpha = resolve(projects, 'alphaville')
    const beta = resolve(projects, 'betamax')
    for (const dir of [alpha, beta, resolve(base, 't')]) mkdirSync(dir, { recursive: true })
    // s1 started in the folder of projects and worked in betamax; its transcript says so.
    const s1 = resolve(base, 't', 's1.jsonl')
    const touched = [...[0, 1, 2, 3].map((i) => join(beta, 'src', `f${i}.ts`)), join(alpha, 'README.md')]
    writeFileSync(s1, touched.map((p) => JSON.stringify({ cwd: projects, message: { content: [{ type: 'tool_use', input: { file_path: p } }] } })).join('\n'))
    const outside = (id: string, title: string, at: number, over: Partial<OutsideChat> = {}): OutsideChat => ({ id, cwd: projects, title, source: 'desktop', lastActivityAt: at, archived: false, group: null, fromPc: null, ...over })
    const filed: [ChatRef, string][] = []
    const list = new ProjectList({
      findHydra: () => ({ python: 'python', ph: join(base, 'ph.py'), root: base }),
      readHydra: async () => ({
        problem: null,
        projects: [
          { key: 'a', path: alpha, name: 'Alphaville', group: null, iconFile: null },
          { key: 'b', path: beta, name: 'Betamax Studio', group: null, iconFile: null },
        ],
      }),
      recent: () => [],
      chats: () => [{ id: 'd1', sessionId: null, cwd: alpha, title: 'Old work', updatedAt: 5_000, archived: true, group: null }],
      outside: async () => [
        outside('s1', 'Untitled', 9_000),
        // Placed by its title (no transcript), but already in a group the user chose: counted, never filed.
        outside('s3', 'Fix the Alphaville login', 8_000, { group: 'Mine' }),
        // Nothing places it: it stays its folder's.
        outside('s2', 'Archived notes', 7_000, { archived: true }),
      ],
      transcript: (sessionId) => (sessionId === 's1' ? s1 : null),
      file: (chat, group) => filed.push([chat, group]),
      git: async () => null,
      tempDir: resolve(base, 'scratch'),
    })

    const res = await list.list({ wait: true })
    expect(res.projects.map((p) => [p.name, p.openChats])).toEqual([
      ['Betamax Studio', 1],
      ['Alphaville', 1],
      ['projects', 0],
    ])
    expect(filed).toEqual([[{ kind: 'outside', id: 's1' }, 'Betamax Studio']])

    // Taken out of the group by hand (its group is null again): it is not filed a second time.
    await list.list({ wait: true })
    expect(filed.length).toBe(1)
  })
})
