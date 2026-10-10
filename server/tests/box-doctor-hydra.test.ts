// server/src/box-doctor-hydra.ts - which of Project Hydra's facts become incidents, which stay
// notes, and that a fact Project Hydra could not take never resolves anything. No real Project
// Hydra is asked: the family folder is a scratch fixture.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hydraFindings, readHydraFacts } from '../src/box-doctor-hydra'

const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-box-hydra-test-${crypto.randomUUID()}`
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const NOW = Date.parse('2026-10-10T07:00:00Z')
const AGO = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

describe('hydraFindings', () => {
  test('raw facts become problems and notes by the old doctor rules; an errored section checks nothing', () => {
    const facts = {
      schema: 'projecthydra.facts/1',
      paths: { registry_dir: 'R', registry_dir_exists: true, project_files: 12 },
      walk: { complete: false, unreadable: [], checkouts: 40 },
      locate: {
        findings: [
          {
            key: 'app',
            status: 'MOVED',
            registered: 'D:/old/app',
            found: ['D:/new/app'],
            detail: 'same remote',
          },
          { key: 'site', status: 'OK', registered: 'D:/site', found: [] },
          { key: 'theirs', status: 'UNBOUND', registered: '{PLEX}/x', found: [] },
        ],
        retired_gone: [],
        site_missing: [],
      },
      nested: {
        nested: [],
        declared: 1,
        scratch_roots: [
          { path: 'D:/app/.testtmp', newest_mtime: AGO(0.1), count: 290 },
          { path: 'D:/old/tmp', newest_mtime: AGO(9), count: 4 },
        ],
        unreadable: [],
      },
      // Caught mid-sweep: a rescan's staging folder and a tool's in-flight marker are not litter.
      scans: { owned: 2, orphans: ['.app.check-lock', 'tmp'], prev: ['app.prev'] },
      sweep_evidence: {
        owned_scan_dirs: 2,
        sarif: [{ key: 'app', at: AGO(20) }],
        sarif_without: ['zonotify'],
        sarif_unreadable: [],
        runs: [{ command: 'scan', at: AGO(1), host: 'H' }],
        runs_dropped: [],
      },
      instruments: {
        error: null,
        index_exists: true,
        items: [
          { name: 'census', deep: false, newest: AGO(30) },
          { name: 'deepdive', deep: true, newest: AGO(30) },
          { name: 'fresh', deep: false, newest: AGO(1) },
        ],
      },
      cadence: {
        task: 'Orchestrator-todo-sweep',
        state: 'absent',
        detail: 'no task',
        command: null,
      },
      record: { error: 'OSError: the record folder could not be listed' },
      tools: { git: 'C:/git.exe', bun: null, '7z': 'C:/7z.exe' },
    }
    const { findings, checked } = hydraFindings(facts, NOW)
    expect(findings.map((f) => `${f.level}:${f.key}`).sort()).toEqual(
      [
        'problem:hydra:locate:app',
        'note:hydra:unbound',
        'note:hydra:walk',
        'problem:hydra:scratch', // only the root untouched for 9 days; the live test run is not litter
        'problem:hydra:sweep-sarif',
        'note:hydra:sweep-sarif-missing',
        'note:hydra:scan-prev',
        'problem:hydra:scan-orphans',
        'problem:hydra:instrument:census',
        'note:hydra:instrument-deep:deepdive',
        'problem:hydra:cadence',
        'note:hydra:collector-optional:bun',
      ].sort(),
    )
    // The walk ran out of time: what it found is reported, nothing resting on it resolves.
    expect(checked).not.toContain('hydra:locate:')
    // The record section raised inside Project Hydra: none of its incidents may resolve.
    expect(checked.some((c) => c.startsWith('hydra:record'))).toBe(false)
    expect(checked).toEqual(
      expect.arrayContaining(['hydra:registry', 'hydra:sweep-sarif', 'hydra:cadence']),
    )
    expect(findings.find((f) => f.key === 'hydra:scan-orphans')?.detail).toBe('tmp')
    // Counts and ages live in detail, so a growing pile does not mint a new incident each pass.
    const stale = findings.find((f) => f.key === 'hydra:sweep-sarif')
    expect(stale?.detail).toContain(AGO(20))
    expect(stale?.message).not.toContain(AGO(20))
  })
})

describe('readHydraFacts', () => {
  test('not installed is its own answer; a cached read never runs Project Hydra before a pass has', async () => {
    const family = join(scratch, 'family')
    mkdirSync(family, { recursive: true })
    const before = process.env.HYDRA_FAMILY_DIR
    process.env.HYDRA_FAMILY_DIR = family
    try {
      expect(await readHydraFacts('cached')).toEqual({ installed: false })
      // A manifest whose command line would fail loudly if it were ever started.
      writeFileSync(
        join(family, 'projecthydra.json'),
        JSON.stringify({
          schema: 'hydra-family/1',
          name: 'projecthydra',
          cli: [join(scratch, 'no-such-ph.exe')],
        }),
      )
      const cached = await readHydraFacts('cached')
      expect(cached).toMatchObject({ installed: true, facts: null })
      expect((cached as { reason: string }).reason).toContain('not read yet')
      expect(await readHydraFacts('fresh')).toMatchObject({ installed: true, facts: null })
    } finally {
      if (before === undefined) delete process.env.HYDRA_FAMILY_DIR
      else process.env.HYDRA_FAMILY_DIR = before
    }
  })
})
