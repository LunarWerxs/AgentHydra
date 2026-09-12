// server/tests/misc-assets.test.ts — a compiled build MUST be able to deliver (2026-09-12).
//
// ⛔ THE DEFECT, proved live. A chat was migrated between accounts and the resume prompt that tells
// it to carry on could not be delivered, by any route, because the daemon looked for
// `<dist>\misc\Deliver-DesktopChat.ps1` and the build had never put misc\ beside the exe. The
// composer route IS that script; the peer route is refused by the same endpoint before it picks a
// channel. So on a compiled install NO chat could be delivered to at all, and `move_chats --resume`
// silently stopped meaning anything - a migrated chat just landed dormant.
//
// This is the tray defect with a different file (fixed 2026-09-11, same cause: the exe embeds Vite
// assets and nothing from misc\), so these tests pin the same three things the tray's do: where the
// file lands, that misc\ still wins when it is there, and that the BUILD is still wired to embed it.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DELIVERY_ACTUATOR_FILE,
  EMBEDDED_MISC_GLOBAL,
  type MiscAssetDeps,
  RUNTIME_MISC_FILES,
  resolveMiscAsset,
} from '../src/misc-assets'

const APP_ROOT = join('D:', 'Downloads')
const STATE = join('C:', 'Users', 'me', '.agenthydra', 'data')
const EMBEDDED = { [DELIVERY_ACTUATOR_FILE]: '/$bunfs/deliver.ps1' }

function run(over: Partial<MiscAssetDeps> = {}, name = DELIVERY_ACTUATOR_FILE) {
  const present = new Set<string>(over.exists ? [] : [])
  const copied: Array<[string, string]> = []
  const made: string[] = []
  const deps: MiscAssetDeps = {
    appRoot: APP_ROOT,
    stateDir: STATE,
    version: '1.2.3',
    compiled: true,
    embedded: EMBEDDED,
    exists: (p) => present.has(p),
    mkdir: (p) => void made.push(p),
    copy: async (from, to) => void copied.push([from, to]),
    ...over,
  }
  return { promise: resolveMiscAsset(name, deps), copied, made }
}

describe('resolving a misc file a compiled build needs', () => {
  test('a real misc\\ on disk always wins, so a checkout uses its own working copy', async () => {
    const onDisk = join(APP_ROOT, 'misc', DELIVERY_ACTUATOR_FILE)
    const got = await resolveMiscAsset(DELIVERY_ACTUATOR_FILE, {
      appRoot: APP_ROOT,
      compiled: true,
      embedded: EMBEDDED,
      exists: (p) => p === onDisk,
    })
    expect(got.reason).toBe('on-disk')
    expect(got.path).toBe(onDisk)
  })

  test('with no misc\\ it writes the embedded copy out, version-scoped', async () => {
    const { promise, copied, made } = run()
    const got = await promise
    expect(got.reason).toBe('materialized')
    expect(got.path).toBe(join(STATE, 'misc', '1.2.3', DELIVERY_ACTUATOR_FILE))
    expect(made).toEqual([join(STATE, 'misc', '1.2.3')])
    expect(copied).toEqual([
      ['/$bunfs/deliver.ps1', join(STATE, 'misc', '1.2.3', DELIVERY_ACTUATOR_FILE)],
    ])
  })

  test("an upgraded binary does not reuse the previous version's copy", async () => {
    const oldCopy = join(STATE, 'misc', '1.2.2', DELIVERY_ACTUATOR_FILE)
    const { promise, copied } = run({ exists: (p) => p === oldCopy })
    const got = await promise
    expect(got.path).toBe(join(STATE, 'misc', '1.2.3', DELIVERY_ACTUATOR_FILE))
    expect(copied).toHaveLength(1)
  })

  test('a copy already written by an earlier run is reused, not rewritten', async () => {
    const already = join(STATE, 'misc', '1.2.3', DELIVERY_ACTUATOR_FILE)
    const { promise, copied } = run({ exists: (p) => p === already })
    const got = await promise
    expect(got.reason).toBe('already-materialized')
    expect(copied).toHaveLength(0)
  })

  test('two daemons racing the first delivery: a failed write over a present file is survivable', async () => {
    let written = false
    const target = join(STATE, 'misc', '1.2.3', DELIVERY_ACTUATOR_FILE)
    const got = await resolveMiscAsset(DELIVERY_ACTUATOR_FILE, {
      appRoot: APP_ROOT,
      stateDir: STATE,
      version: '1.2.3',
      compiled: true,
      embedded: EMBEDDED,
      exists: (p) => (p === target ? written : false),
      mkdir: () => {},
      copy: async () => {
        written = true // the other daemon won the race
        throw new Error('EPERM')
      },
    })
    expect(got.reason).toBe('already-materialized')
    expect(got.path).toBe(target)
  })

  test('a build that embedded nothing says so as a BUILD defect, and never throws', async () => {
    const got = await run({ embedded: null }).promise
    expect(got.reason).toBe('not-embedded')
    expect(got.path).toBeNull()
    expect(got.error).toContain('BUILD defect')
  })

  test('a checkout missing the file is a different answer from a build missing it', async () => {
    const got = await run({ compiled: false, embedded: null }).promise
    expect(got.reason).toBe('missing')
    expect(got.path).toBeNull()
  })
})

describe('the build is still wired to embed it', () => {
  // The runtime half is useless if the build stops embedding, and that is a one-line edit away.
  const build = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'build.ts'), 'utf8')

  test('build.ts embeds the shared file list under the global the runtime reads', () => {
    expect(build).toContain('RUNTIME_MISC_FILES')
    expect(build).toContain(EMBEDDED_MISC_GLOBAL)
  })

  test('build.ts fails the build when a runtime misc file is missing', () => {
    // Shipping without it is a daemon that can never deliver - a warning would be read past.
    expect(build).toContain('cannot build:')
    expect(build).toContain('never')
  })

  test('every file it promises to embed is actually in misc\\ and non-empty', () => {
    for (const name of RUNTIME_MISC_FILES) {
      const path = join(import.meta.dir, '..', '..', 'misc', name)
      expect(readFileSync(path).byteLength).toBeGreaterThan(0)
    }
  })
})
