// The .devwebui format DevWebUI wrote and people committed: what is accepted, the ids that must stay identical to
// DevWebUI's (state.json overrides and the pane's remembered ids ride on them), and what is refused with which words.

import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseProjectSpec, ProjectFileError, projectIdFromPath, readProjectFile } from '../../src/devservers/project-file'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'devs-pf-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** DevWebUI's formula, restated: 'p' + sha1 of the absolute path, slashes forward, lowercased off Linux. */
function expectedId(file: string): string {
  const abs = path.resolve(file).replace(/\\/g, '/')
  const norm = process.platform === 'linux' ? abs : abs.toLowerCase()
  return `p${createHash('sha1').update(norm).digest('hex').slice(0, 8)}`
}

const message = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProjectFileError)
    return (e as Error).message
  }
  throw new Error('did not throw')
}

describe('ids', () => {
  test('a project id is p + 8 hex of the normalized path, whichever way the path is written', () => {
    const d = tmp()
    const file = path.join(d, '.devwebui')
    expect(projectIdFromPath(file)).toBe(expectedId(file))
    expect(projectIdFromPath(file)).toMatch(/^p[0-9a-f]{8}$/)
    expect(projectIdFromPath(file.replace(/\\/g, '/'))).toBe(projectIdFromPath(file))
    if (process.platform !== 'linux') expect(projectIdFromPath(file.toUpperCase())).toBe(projectIdFromPath(file))
  })

  test('a server id is <project id>.<local id>, its cwd is resolved against the file, and unknown keys are accepted', () => {
    const d = tmp()
    const file = path.join(d, '.devwebui')
    writeFileSync(
      file,
      `﻿${JSON.stringify({
        name: 'Example',
        extra: { kept: true },
        processes: [
          { id: 'web', name: 'Web', command: 'bun run dev', cwd: 'apps/web', port: 4173, autostart: true, starred: true, color: '#fff', waitForPort: 'api', links: ['api'], companion: false, future: 1 },
          { id: 'api', name: 'API', command: 'bun run api', env: { A: '1' }, url: '/health', runtime: 'bun' },
        ],
      })}`
    )
    const lp = readProjectFile(file)
    const id = expectedId(file)
    expect(lp.id).toBe(id)
    expect(lp.processes.map((p) => p.id)).toEqual([`${id}.web`, `${id}.api`])
    expect(lp.processes[0]).toMatchObject({ localId: 'web', cwd: path.resolve(d, 'apps/web'), port: 4173, autostart: true, starred: true, waitForPort: 'api', links: ['api'], projectId: id, projectName: 'Example' })
    expect(lp.processes[1]).toMatchObject({ cwd: path.resolve(d), env: { A: '1' }, url: '/health' })
  })

  test('compose and answers are accepted but flagged: they are not run here', () => {
    const d = tmp()
    const file = path.join(d, '.devwebui')
    writeFileSync(file, JSON.stringify({ name: 'E', processes: [{ id: 'db', name: 'DB', command: 'x', compose: { file: 'compose.yaml' }, answers: [{ send: 'y' }] }, { id: 'web', name: 'W', command: 'y' }] }))
    const [db, web] = readProjectFile(file).processes
    expect(db!.unsupported).toBe('compose/answers')
    expect(web!.unsupported).toBeUndefined()
  })
})

describe('what is refused, and how it is said', () => {
  const ok = { id: 'web', name: 'Web', command: 'x' }

  test('names the server and the field', () => {
    expect(message(() => parseProjectSpec({ name: 'E', processes: [ok, { ...ok, id: 'api', port: 0 }] }))).toBe('processes[1] ("api"): port must be a positive whole number')
    expect(message(() => parseProjectSpec({ name: 'E', processes: [{ ...ok, id: 'a b' }] }))).toContain('id may only contain letters, numbers, . _ -')
    expect(message(() => parseProjectSpec({ name: 'E', processes: [{ ...ok, command: '' }] }))).toContain('command must be a non-empty text')
    expect(message(() => parseProjectSpec({ name: 'E', processes: [{ ...ok, runtime: 'deno' }] }))).toContain('runtime must be "node" or "bun"')
    expect(message(() => parseProjectSpec({ name: 'E', processes: [{ ...ok, links: ['ok', 'no good'] }] }))).toContain('links must be a list of server ids')
  })

  test('a script or file url is never stored; http(s) addresses and paths are', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(message(() => parseProjectSpec({ name: 'E', processes: [{ ...ok, url }] }))).toContain('url must be an http(s):// address or a path')
    }
    for (const url of ['http://localhost:3000/a', 'https://example.test', '/health', 'health']) {
      expect(parseProjectSpec({ name: 'E', processes: [{ ...ok, url }] }).processes[0]!.url).toBe(url)
    }
  })

  test('a project needs a name and at least one server, and ids are unique', () => {
    expect(message(() => parseProjectSpec({ processes: [ok] }))).toContain('name must be a non-empty text')
    expect(message(() => parseProjectSpec({ name: 'E', processes: [] }))).toContain('at least one server')
    expect(message(() => parseProjectSpec({ name: 'E', processes: [ok, ok] }))).toContain('duplicate id "web"')
    expect(message(() => parseProjectSpec('nope'))).toContain('must be an object')
  })

  test('reading a file that is not JSON, or not a project, names the file', () => {
    const d = tmp()
    const bad = path.join(d, 'bad.devwebui')
    writeFileSync(bad, '{ not json')
    expect(message(() => readProjectFile(bad))).toContain(`Could not read ${bad}`)
    const empty = path.join(d, 'empty.devwebui')
    writeFileSync(empty, JSON.stringify({ name: 'E', processes: [] }))
    expect(message(() => readProjectFile(empty))).toContain(`${empty} is not a valid .devwebui file`)
  })
})
