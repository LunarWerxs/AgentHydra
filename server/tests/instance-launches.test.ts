// server/tests/instance-launches.test.ts — "Last launched on this PC" (server/src/core/instance-launches.ts).
//
// What is pinned is what makes the column honest:
//  * the LATER of two sightings always wins, so a process scan reporting an older start time can
//    never walk a fresh Open backwards, and a launch from outside AgentHydra still moves it forward;
//  * the file is rewritten only when something moved, because the list that feeds it runs on a
//    refresh timer and must not turn every poll into a disk write;
//  * entries belong to ONE machine: a data dir shared with another PC never shows that PC's
//    launches as local ones;
//  * a corrupt or hand-edited file reads as "never launched" instead of throwing into the list.
//
// CONFIG_DIR is redirected to a temp dir by tests/setup.ts (AGENTHYDRA_HOME), so nothing here
// touches the developer's real ~/.agenthydra.

import { afterEach, expect, test } from 'bun:test'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import {
  deleteInstanceLaunch,
  readInstanceLaunches,
  recordInstanceLaunches,
} from '../src/core/instance-launches'
import { instanceLaunchesFile, normalizeInstancePath } from '../src/core/paths'

const A = normalizeInstancePath('C:/fixture/instances/alpha')
const B = normalizeInstancePath('C:/fixture/instances/beta')
const host = os.hostname().trim().toLowerCase()

afterEach(() => {
  rmSync(instanceLaunchesFile(), { force: true })
})

test('nothing recorded reads as never launched', () => {
  expect(readInstanceLaunches()).toEqual({})
})

test('a recorded launch reads back under its normalized dir', () => {
  recordInstanceLaunches([{ dir: 'C:/fixture/instances/alpha/', at: 1_000 }])
  expect(readInstanceLaunches()).toEqual({ [A]: 1_000 })
})

test('the later sighting wins and an older one never walks it back', () => {
  recordInstanceLaunches([{ dir: A, at: 5_000 }])
  recordInstanceLaunches([{ dir: A, at: 3_000 }])
  expect(readInstanceLaunches()[A]).toBe(5_000)
  recordInstanceLaunches([{ dir: A, at: 9_000 }])
  expect(readInstanceLaunches()[A]).toBe(9_000)
})

test('an unchanged sighting does not rewrite the file', () => {
  recordInstanceLaunches([{ dir: A, at: 5_000 }])
  const before = statSync(instanceLaunchesFile()).mtimeMs
  const content = readFileSync(instanceLaunchesFile(), 'utf8')
  // Write a sentinel so a rewrite would be detectable even within the filesystem's mtime resolution.
  writeFileSync(instanceLaunchesFile(), content)
  const sentinel = statSync(instanceLaunchesFile()).mtimeMs
  recordInstanceLaunches([
    { dir: A, at: 5_000 },
    { dir: A, at: 4_000 },
  ])
  expect(statSync(instanceLaunchesFile()).mtimeMs).toBe(sentinel)
  expect(sentinel).toBeGreaterThanOrEqual(before)
})

test('invalid times are ignored rather than recorded', () => {
  recordInstanceLaunches([
    { dir: A, at: Number.NaN },
    { dir: A, at: 0 },
    { dir: A, at: -5 },
    { dir: '', at: 5_000 },
  ])
  expect(readInstanceLaunches()).toEqual({})
})

test('another machine’s launches are kept but never shown here', () => {
  writeFileSync(
    instanceLaunchesFile(),
    JSON.stringify({ 'some-other-pc': { [A]: 7_000 }, [host]: { [B]: 2_000 } }),
  )
  expect(readInstanceLaunches()).toEqual({ [B]: 2_000 })
  recordInstanceLaunches([{ dir: B, at: 3_000 }])
  const stored = JSON.parse(readFileSync(instanceLaunchesFile(), 'utf8'))
  expect(stored['some-other-pc']).toEqual({ [A]: 7_000 })
  expect(stored[host]).toEqual({ [B]: 3_000 })
})

test('a corrupt or oddly shaped file reads as never launched', () => {
  writeFileSync(instanceLaunchesFile(), '{ not json')
  expect(readInstanceLaunches()).toEqual({})
  writeFileSync(
    instanceLaunchesFile(),
    JSON.stringify({ [host]: { [A]: 'yesterday', [B]: 4_000 } }),
  )
  expect(readInstanceLaunches()).toEqual({ [B]: 4_000 })
  writeFileSync(instanceLaunchesFile(), JSON.stringify([1, 2, 3]))
  expect(readInstanceLaunches()).toEqual({})
})

test('a deleted profile forgets its history on this machine only', () => {
  writeFileSync(
    instanceLaunchesFile(),
    JSON.stringify({ 'some-other-pc': { [A]: 7_000 }, [host]: { [A]: 1_000, [B]: 2_000 } }),
  )
  deleteInstanceLaunch(A)
  expect(readInstanceLaunches()).toEqual({ [B]: 2_000 })
  const stored = JSON.parse(readFileSync(instanceLaunchesFile(), 'utf8'))
  expect(stored['some-other-pc']).toEqual({ [A]: 7_000 })
})
