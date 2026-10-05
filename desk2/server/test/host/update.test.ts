// plugins/60-update.ts: the window hears when the server's code changed after it started, and Restart to update
// starts launcher/restart.ps1 only for a server the launcher started.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { codeStamp, startedByLauncher, type CodeStamp, type UpdateDeps } from '../../src/plugins/60-update'
import { createServer, type DeskServer } from '../../src/index'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '60-update.ts')
const temps: string[] = []
const stops: (() => unknown)[] = []

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(over: Partial<UpdateDeps> & { stamp?: () => CodeStamp } = {}) {
  const home = temp('desk-update-home-')
  const plugins = temp('desk-update-plugins-')
  writeFileSync(join(plugins, '60-update.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  const started: string[][] = []
  const deps: UpdateDeps = { bootedAt: 1000, stamp: () => ({ newest: 900, count: 3 }), platform: 'win32', pid: 4242, start: (argv) => started.push(argv), ...over }
  const desk: DeskServer = await createServer({ port: 0, home, pluginsDir: plugins, deps: { update: deps } })
  stops.push(() => desk.stop())
  return { desk, home, started }
}

/** server.pid as start.ps1 writes it: Set-Content -Encoding UTF8 on Windows PowerShell puts a BOM first. */
const pidFile = (home: string, serverPid: number) => writeFileSync(join(home, 'server.pid'), `﻿${JSON.stringify({ serverPid, wrapperPid: 1, port: 7798 })}`)

test('stale once a file of the server is newer than its start, or one was added or removed', async () => {
  let stamp: CodeStamp = { newest: 900, count: 3 }
  const { desk } = await boot({ stamp: () => stamp })
  const read = async () => (await fetch(`${desk.url}/api/server/update`)).json()
  expect(await read()).toEqual({ stale: false, restartable: false })
  stamp = { newest: 1500, count: 3 }
  expect((await read()).stale).toBe(true)
  stamp = { newest: 900, count: 2 }
  expect((await read()).stale).toBe(true)
})

test('restart starts launcher/restart.ps1, logging to the data home, only for the server the launcher started', async () => {
  const { desk, home, started } = await boot()
  const restart = () => fetch(`${desk.url}/api/server/restart`, { method: 'POST' })
  // No pid file: started some other way (bun run dev), so nothing would bring it back.
  const refused = await restart()
  expect(refused.status).toBe(409)
  expect((await refused.json()).error).toContain('restart.ps1')
  pidFile(home, 1)
  expect((await restart()).status).toBe(409)
  expect(started).toEqual([])

  pidFile(home, 4242)
  expect((await (await fetch(`${desk.url}/api/server/update`)).json()).restartable).toBe(true)
  const ok = await restart()
  expect(ok.status).toBe(202)
  expect(started).toHaveLength(1)
  const command = started[0]!.at(-1)!
  expect(command).toContain(join('launcher', 'restart.ps1'))
  expect(command).toContain(`*>> '${join(home, 'logs', 'restart.log')}'`)
})

test('not restartable off Windows: the launcher scripts are PowerShell', async () => {
  const { desk, home } = await boot({ platform: 'linux' })
  pidFile(home, 4242)
  expect((await fetch(`${desk.url}/api/server/restart`, { method: 'POST' })).status).toBe(409)
})

test('codeStamp counts .ts files and finds the newest; startedByLauncher reads a BOM pid file', () => {
  const dir = temp('desk-update-code-')
  mkdirSync(join(dir, 'a'))
  writeFileSync(join(dir, 'a', 'x.ts'), '')
  writeFileSync(join(dir, 'y.ts'), '')
  writeFileSync(join(dir, 'notes.md'), '')
  utimesSync(join(dir, 'a', 'x.ts'), 2000, 2000)
  utimesSync(join(dir, 'y.ts'), 1000, 1000)
  expect(codeStamp([dir, join(dir, 'missing')])).toEqual({ count: 2, newest: 2_000_000 })
  pidFile(dir, 77)
  expect(startedByLauncher(dir, 77)).toBe(true)
  expect(startedByLauncher(dir, 78)).toBe(false)
  expect(startedByLauncher(join(dir, 'missing'), 77)).toBe(false)
})
