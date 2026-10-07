// devservers/scan.ts over a temp tree (never the real disk): it finds .devwebui files and package.json dev projects,
// and never goes into node_modules, an excluded folder (by name or by path) or below the preset's depth.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { scanProjects } from '../../src/devservers/scan'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const put = (root: string, rel: string, body: unknown): void => {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(body))
}
const project = (name: string) => ({ name, processes: [{ id: 'web', name: 'Web', command: 'bun dev' }] })

test('a quick scan finds files and dev packages, skipping node_modules, excludes and what is too deep', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devs-scan-'))
  dirs.push(root)
  put(root, 'site/.devwebui', project('Site'))
  put(root, 'app/package.json', { name: 'example-app', scripts: { dev: 'vite', build: 'vite build' } })
  put(root, 'a/b/c/.devwebui', project('Depth three'))
  put(root, 'a/b/c/d/.devwebui', project('Depth four'))
  put(root, 'node_modules/pkg/.devwebui', project('In node_modules'))
  put(root, 'node_modules/pkg/package.json', { name: 'pkg', scripts: { dev: 'vite' } })
  put(root, 'skipme/.devwebui', project('Excluded by name'))
  put(root, 'by-path/.devwebui', project('Excluded by path'))

  const res = await scanProjects({ roots: [root], exclude: ['skipme', path.join(root, 'by-path')], preset: 'quick' })
  expect(res.files.map((f) => f.name).sort()).toEqual(['Depth three', 'Site'])
  expect(res.detected.map((d) => [path.relative(root, d.path), d.framework])).toEqual([['app', 'Vite']])
  expect(res.truncated).toBe(false)
  expect(res.timedOut).toBe(false)
})
