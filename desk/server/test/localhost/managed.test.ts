// The stop guard: Desk ends only a process tree it started, checked by pid AND start time.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedServers } from '../../src/localhost/managed'
import type { ProcInfo } from '../../src/localhost/ports'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(table: ProcInfo[]) {
  const home = mkdtempSync(join(tmpdir(), 'desk-managed-'))
  temps.push(home)
  const procs = new Map(table.map((p) => [p.pid, p]))
  const killed: number[] = []
  const m = new ManagedServers(home, {
    procs: async () => procs,
    kill: (pid) => void killed.push(pid),
    launch: async () => ({ pid: 500, created: 1_000_000 }),
  })
  return { m, procs, killed }
}

const proc = (pid: number, ppid: number, created: number, name = 'node'): ProcInfo => ({ pid, ppid, name, command: name, created })

describe('ManagedServers.stop', () => {
  test('refuses a pid Desk did not start, and kills nothing', async () => {
    const { m, killed } = setup([proc(500, 1, 1_000_000, 'cmd'), proc(777, 1, 900_000)])
    await m.start('C:/proj', 'script:dev', 'dev', 'bun run dev', 'C:/proj')
    await expect(m.stop({ pid: 777 })).rejects.toThrow('not started by Desk')
    await expect(m.stop({ folder: 'C:/other', id: 'script:dev' })).rejects.toThrow('not started by Desk')
    expect(killed).toEqual([])
  })

  test('refuses when the recorded pid now belongs to another process (start time differs), and forgets it', async () => {
    const { m, procs, killed } = setup([proc(500, 1, 1_000_000, 'cmd')])
    await m.start('C:/proj', 'script:dev', 'dev', 'bun run dev', 'C:/proj')
    procs.set(500, proc(500, 1, 5_000_000, 'chrome')) // the server ended and Windows gave its pid to another process
    await expect(m.stop({ folder: 'C:/proj', id: 'script:dev' })).rejects.toThrow(/no longer the process Desk started/)
    expect(killed).toEqual([])
    expect(m.list()).toEqual([])
  })

  test('stops the tree Desk started, found by a descendant listener pid', async () => {
    const { m, killed } = setup([proc(500, 1, 1_000_000, 'cmd'), proc(501, 500, 1_000_400, 'node')])
    await m.start('C:/proj', 'script:dev', 'dev', 'bun run dev', 'C:/proj')
    await m.stop({ pid: 501 })
    expect(killed).toEqual([500])
    expect(m.list()).toEqual([])
  })
})
