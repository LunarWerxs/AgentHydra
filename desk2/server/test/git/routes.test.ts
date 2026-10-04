import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitStatus } from '@shared/protocol'
import { createServer, type DeskServer } from '../../src/index'
import { cleanTemps, commitAll, initRepo, tempDir } from './helpers'

const servers: DeskServer[] = []

// Every case spawns several git processes; on a busy Windows box that takes seconds.
setDefaultTimeout(30_000)

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  cleanTemps()
})

/** A server that loads only this piece's plugin. */
async function boot(): Promise<DeskServer> {
  const plugins = tempDir('desk-plugins-')
  writeFileSync(
    join(plugins, '30-git.ts'),
    `export { default } from ${JSON.stringify(join(import.meta.dir, '../../src/plugins/30-git.ts'))}\n`,
  )
  const desk = await createServer({ port: 0, home: tempDir('desk-home-'), pluginsDir: plugins })
  servers.push(desk)
  return desk
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

describe('git and folders routes', () => {
  test('GET /api/git and /api/git/diff', async () => {
    const desk = await boot()
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    commitAll(dir)
    writeFileSync(join(dir, 'a.txt'), 'b\n')

    const res = await fetch(`${desk.url}/api/git?${q({ cwd: dir })}`)
    expect(res.status).toBe(200)
    const s = (await res.json()) as GitStatus
    expect(s).toMatchObject({ isRepo: true, branch: 'main', added: 1, removed: 1 })
    expect(s.files).toEqual([{ path: 'a.txt', status: 'M', added: 1, removed: 1 }])

    const d = await fetch(`${desk.url}/api/git/diff?${q({ cwd: dir, path: 'a.txt' })}`)
    expect(d.status).toBe(200)
    expect(((await d.json()) as { diff: string }).diff).toContain('+b')

    const bad = await fetch(`${desk.url}/api/git/diff?${q({ cwd: dir, path: '../x' })}`)
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toMatch(/outside the repository/)

    const rel = await fetch(`${desk.url}/api/git?${q({ cwd: 'not/absolute' })}`)
    expect(rel.status).toBe(400)
    expect(((await rel.json()) as { error: string }).error).toMatch(/absolute/)
  })

  test('GET /api/folders/browse', async () => {
    const desk = await boot()
    const root = tempDir()
    copyFileSync(import.meta.path, join(root, 'not-a-dir.ts'))
    const ok = await fetch(`${desk.url}/api/folders/browse?${q({ path: root })}`)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ path: root, dirs: [] })

    const bad = await fetch(`${desk.url}/api/folders/browse?${q({ path: 'relative' })}`)
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toMatch(/must be absolute/)

    const file = await fetch(`${desk.url}/api/folders/browse?${q({ path: join(root, 'not-a-dir.ts') })}`)
    expect(file.status).toBe(400)
    expect(((await file.json()) as { error: string }).error).toMatch(/not a folder/)
  })
})
