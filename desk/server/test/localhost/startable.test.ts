// What a folder can start: package.json dev/start/preview with its lockfile's package manager, and .devwebui.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectStartable } from '../../src/localhost/startable'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'desk-startable-'))
  temps.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

describe('detectStartable', () => {
  test('dev/start/preview scripts only, run with the lockfile package manager, port read from the script', () => {
    const dir = folder({
      'package.json': JSON.stringify({ scripts: { dev: 'vite --port 5174', build: 'vite build', preview: 'vite preview', test: 'bun test' } }),
      'pnpm-lock.yaml': '',
    })
    expect(detectStartable(dir).map((s) => [s.id, s.command, s.port])).toEqual([
      ['script:dev', 'pnpm run dev', 5174],
      ['script:preview', 'pnpm run preview', null],
    ])
  })

  test('bun.lock wins, yarn has no "run", no lockfile is npm', () => {
    const scripts = JSON.stringify({ scripts: { start: 'node server.js' } })
    expect(detectStartable(folder({ 'package.json': scripts, 'bun.lock': '', 'yarn.lock': '' }))[0]!.command).toBe('bun run start')
    expect(detectStartable(folder({ 'package.json': scripts, 'yarn.lock': '' }))[0]!.command).toBe('yarn start')
    expect(detectStartable(folder({ 'package.json': scripts }))[0]!.command).toBe('npm run start')
  })

  test('.devwebui processes come first, with their cwd resolved against the folder', () => {
    const dir = folder({
      '.devwebui': JSON.stringify({
        name: 'Site',
        processes: [
          { id: 'web', name: 'Web', command: 'bun run dev:web', cwd: 'apps/web', port: 4020 },
          { id: 'bad id!', command: 'x' },
        ],
      }),
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    })
    const found = detectStartable(dir)
    expect(found.map((s) => s.id)).toEqual(['devwebui-file:web', 'script:dev'])
    expect(found[0]).toMatchObject({ name: 'Web', command: 'bun run dev:web', cwd: join(dir, 'apps/web'), source: '.devwebui', port: 4020 })
  })

  test('a folder with neither, or broken JSON, offers nothing', () => {
    expect(detectStartable(folder({ 'README.md': '# hi' }))).toEqual([])
    expect(detectStartable(folder({ 'package.json': '{ not json', '.devwebui': '[' }))).toEqual([])
  })
})
