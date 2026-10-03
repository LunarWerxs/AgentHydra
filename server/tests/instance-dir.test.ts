// The `:dir` of every `/api/instances/:dir/...` route names a LISTED instance or gets a 404
// (server/src/core/instance-dir.ts + server/src/instance-dir-param.ts).
//
// Why: on 2026-09-03 `POST /api/instances/thomas/open` - a bare name - was taken as a path,
// resolved relative to the daemon's working directory and launched claude.exe with a
// --user-data-dir under System32's driver store. The rule under test: a full listed dir in any
// spelling is accepted, a bare folder name is accepted only when it names exactly one instance,
// and everything else (unknown names, ambiguous names, paths outside the list) is refused before
// any action runs. Three layers: the pure matcher, the real routes/instances.ts routes driven
// through Hono against the scratch instances root, and live discovery. That every per-instance
// route on BOTH daemons goes through the gate is scripts/checks/instance-dir-route-gate.mjs's job.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { matchInstanceDir, resolveInstanceDir } from '../src/core/instance-dir'
import { readInstanceMetaMap } from '../src/core/instance-meta'
import { instancesRoot } from '../src/core/paths'
import type { CMInstance } from '../src/core/shared'
import { app } from '../src/http-app'
import { UNKNOWN_INSTANCE } from '../src/instance-dir-param'
import { samePathKey } from '../src/path-key'
import '../src/routes/instances'

const win = process.platform === 'win32'
const ROOT = win ? 'C:\\Users\\me\\.claude-instances' : '/home/me/.claude-instances'
// The exact dir the bare name resolved to on 2026-09-03.
const STRAY = win
  ? 'C:\\Windows\\System32\\DriverStore\\FileRepository\\ntprint.inf_amd64_58e7118cdecb935e\\amd64\\thomas'
  : '/usr/lib/systemd/thomas'

function row(dir: string, name: string, isExternal = false): CMInstance {
  return {
    num: 0,
    name,
    dir,
    isRunning: false,
    pid: null,
    startTime: null,
    lastLaunchedAt: null,
    lastRunningAt: null,
    sizeBytes: null,
    memoryBytes: null,
    account: null,
    loginUuid: null,
    isExternal,
    isDefault: false,
    label: null,
    icon: null,
    color: null,
  }
}

const thomas = join(ROOT, 'thomas')
// `twin` exists twice: a root folder, and an external instance running from a dir of the same
// basename. The bare name must refuse rather than pick one.
const fleet: CMInstance[] = [
  row(thomas, 'thomas'),
  row(join(ROOT, 'arama'), 'arama'),
  row(join(ROOT, 'twin'), 'twin'),
  row(win ? 'D:\\elsewhere\\twin' : '/srv/elsewhere/twin', 'twin', true),
]

describe('matchInstanceDir', () => {
  test('accepts a listed dir, in any spelling', () => {
    expect(matchInstanceDir(thomas, fleet)?.dir).toBe(thomas)
    expect(matchInstanceDir(`${thomas.replace(/\\/g, '/')}/`, fleet)?.dir).toBe(thomas)
    if (win) expect(matchInstanceDir(thomas.toUpperCase(), fleet)?.dir).toBe(thomas)
  })

  test('accepts a bare folder name that names exactly one instance', () => {
    expect(matchInstanceDir('thomas', fleet)?.dir).toBe(thomas)
    expect(matchInstanceDir('arama', fleet)?.name).toBe('arama')
  })

  test('refuses a bare name two instances share', () => {
    expect(matchInstanceDir('twin', fleet)).toBeNull()
  })

  test('refuses an unknown name, a path outside the list, and an empty ref', () => {
    expect(matchInstanceDir('nobody', fleet)).toBeNull()
    expect(matchInstanceDir(STRAY, fleet)).toBeNull()
    expect(matchInstanceDir(join(ROOT, 'thomas2'), fleet)).toBeNull()
    expect(matchInstanceDir('', fleet)).toBeNull()
    expect(matchInstanceDir('   ', fleet)).toBeNull()
  })
})

describe('the real per-instance routes (routes/instances.ts) against the scratch root', () => {
  // http-app.ts is ONE object for the whole test process; request through a copy (see
  // queue-patch-guard.test.ts) so it stays open for later files.
  const http = new Hono().route('/', app)
  const root = instancesRoot()
  const name = `dir-route-${process.pid}`
  const listed = join(root, name)
  const outside = mkdtempSync(join(tmpdir(), 'ah-outside-'))
  mkdirSync(listed, { recursive: true })
  afterAll(() => {
    rmSync(listed, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const at = (ref: string, tail: string) => `/api/instances/${encodeURIComponent(ref)}${tail}`

  // Two routes whose actions are safe to run in a test: a read, and a write into the scratch
  // config dir. The same gate fronts open/quit/reveal/shortcut/delete, which must not run here.
  test('a folder outside the list is 404 before the action runs, though it exists', async () => {
    const read = await http.request(at(outside, '/login-history'))
    expect(read.status).toBe(404)
    expect(await read.json()).toEqual(UNKNOWN_INSTANCE)

    const write = await http.request(at(outside, '/meta'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'crafted' }),
    })
    expect(write.status).toBe(404)
    expect(await write.json()).toEqual(UNKNOWN_INSTANCE)
    expect(Object.keys(readInstanceMetaMap()).some((k) => samePathKey(k, outside))).toBe(false)
  }, 30_000) // The gate runs the real per-OS process scan (PowerShell Get-CimInstance on Windows).

  test('an unknown bare name is 404, never a path relative to the daemon', async () => {
    const res = await http.request(at('no-such-instance-anywhere', '/login-history'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(UNKNOWN_INSTANCE)
  }, 30_000)

  test('a listed instance is reached by its dir and by its bare name', async () => {
    expect((await http.request(at(listed, '/login-history'))).status).toBe(200)
    const meta = await http.request(at(name, '/meta'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: null }),
    })
    expect(meta.status).toBe(200)
    // The action sees the LISTED dir, not the name the caller typed.
    expect(samePathKey(((await meta.json()) as { dir: string }).dir, listed)).toBe(true)
  }, 30_000)
})

describe('resolveInstanceDir against live discovery', () => {
  // The preload points instancesRoot() at a throwaway dir; refuse to run against the real store.
  const root = instancesRoot()
  test('the suite is looking at its scratch root, not ~/.claude-instances', () => {
    expect(process.env.AGENTHYDRA_INSTANCES_ROOT).toBeTruthy()
    expect(samePathKey(root, process.env.AGENTHYDRA_INSTANCES_ROOT)).toBe(true)
  })

  test('a folder under the root resolves by dir and by name; a dir outside it does not', async () => {
    const name = `dir-test-${process.pid}`
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), 'ah-outside-'))
    try {
      const byDir = await resolveInstanceDir(dir)
      expect(byDir?.name).toBe(name)
      expect(samePathKey(byDir?.dir, dir)).toBe(true)
      const byName = await resolveInstanceDir(name)
      expect(samePathKey(byName?.dir, dir)).toBe(true)
      expect(await resolveInstanceDir(outside)).toBeNull()
      expect(await resolveInstanceDir('no-such-instance-anywhere')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  }, 30_000) // Discovery runs the real per-OS process scan (PowerShell Get-CimInstance on Windows).
})
