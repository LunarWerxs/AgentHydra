// devservers/edit.ts: editing a .devwebui in place keeps what the edit does not own (unknown keys, compose, the other
// servers and their order), and a refused edit leaves the file exactly as it was.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DevWebProcessSpec } from '@shared/devwebui'
import { DevServerError } from '../../src/devservers/contract'
import { addSpec, removeSpec, replaceSpec } from '../../src/devservers/edit'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function projectFile(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'devs-edit-'))
  dirs.push(d)
  const file = path.join(d, '.devwebui')
  writeFileSync(
    file,
    JSON.stringify({
      name: 'Example',
      future: { kept: true },
      processes: [
        { id: 'web', name: 'Web', command: 'bun dev', compose: { file: 'compose.yaml' }, extra: 1 },
        { id: 'api', name: 'API', command: 'bun api', answers: [{ expect: 'Continue?', send: 'y' }] },
        { id: 'worker', name: 'Worker', command: 'bun worker', waitForPort: 'api', links: ['api', 'web'] },
      ],
    })
  )
  return file
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { future: unknown; processes: Record<string, unknown>[] }

test("updating a server keeps the file's other keys, the server's compose and unknown keys, and the order", () => {
  const file = projectFile()
  expect(replaceSpec(file, 'web', { id: 'web', name: 'Web 2', command: 'bun dev --host', port: 4173 })).toBe('web')
  const j = read(file)
  expect(j.future).toEqual({ kept: true })
  expect(j.processes.map((p) => p.id)).toEqual(['web', 'api', 'worker'])
  expect(j.processes[0]).toEqual({ id: 'web', name: 'Web 2', command: 'bun dev --host', port: 4173, compose: { file: 'compose.yaml' }, extra: 1 })
  expect(j.processes[1]).toEqual({ id: 'api', name: 'API', command: 'bun api', answers: [{ expect: 'Continue?', send: 'y' }] })
})

test('a refused edit leaves the file byte-identical', () => {
  const ok: DevWebProcessSpec = { id: 'web', name: 'Web', command: 'bun dev' }
  const cases: [string, (file: string) => unknown][] = [
    ["renaming to a sibling's id", (f) => replaceSpec(f, 'web', { ...ok, id: 'api' })],
    ['an update with port 0', (f) => replaceSpec(f, 'web', { ...ok, port: 0 })],
    ['adding with port 0', (f) => addSpec(f, { ...ok, id: 'docs', port: 0 })],
    ['adding a taken id', (f) => addSpec(f, { ...ok, id: 'worker' })],
  ]
  const outcomes = cases.map(([what, edit]) => {
    const file = projectFile()
    const before = readFileSync(file)
    let err: unknown = null
    try {
      edit(file)
    } catch (e) {
      err = e
    }
    return [what, err instanceof DevServerError ? err.status : String(err), readFileSync(file).equals(before)]
  })
  expect(outcomes).toEqual(cases.map(([what]) => [what, 400, true]))
})

test('removing a server leaves the others, and their links and wait no longer name it', () => {
  const file = projectFile()
  removeSpec(file, 'api')
  const j = read(file)
  expect(j.future).toEqual({ kept: true })
  expect(j.processes.map((p) => p.id)).toEqual(['web', 'worker'])
  expect(j.processes[1]).toEqual({ id: 'worker', name: 'Worker', command: 'bun worker', links: ['web'] })
})
