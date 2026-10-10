// server/src/box-doctor-hydra.ts - which of Project Hydra's facts become incidents, which stay
// notes, and that a fact Project Hydra could not take never resolves anything. No real Project
// Hydra is asked: the family folder is a scratch fixture.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hydraFindings, readHydraFacts } from '../src/box-doctor-hydra'

const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-box-hydra-test-${crypto.randomUUID()}`
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// A fixed instant well away from the clock; every AGO offset is relative to it, so the test never drifts.
const NOW = Date.parse('2025-06-01T07:00:00Z')
const AGO = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
const levelKeys = (findings: Array<{ level: string; key: string }>) =>
  findings.map((f) => `${f.level}:${f.key}`).sort()

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

  test.each([
    [{ registry_dir: 'R', registry_dir_exists: false }, "Project Hydra's registry is missing at R"],
    [
      { registry_dir: 'R', registry_dir_exists: true, project_files: null },
      "Project Hydra's registry projects folder could not be listed under R",
    ],
    [
      { registry_dir: 'R', registry_dir_exists: true, project_files: 0 },
      "Project Hydra's registry holds no project files under R",
    ],
  ])('an unreadable or empty registry is a problem, never a clean pass: %j', (paths, why) => {
    const { findings, checked } = hydraFindings({ paths }, NOW)
    expect(findings).toEqual([
      {
        key: 'hydra:registry',
        level: 'problem',
        message: `${why} - every registry check below measured an empty fleet, not a clean one.`,
      },
    ])
    expect(checked).toEqual(['hydra:registry'])
  })

  test.each([
    [{ host_file_exists: false, roots: [] }, 'This PC has no Project Hydra host file'],
    [
      { host_file_exists: true, roots: [] },
      "This PC's Project Hydra host file names no search roots",
    ],
    [
      { host_file_exists: true, roots: [{ path: 'D:/none', role: 'code', exists: false }] },
      "None of this PC's Project Hydra search roots exist",
    ],
  ])('a PC without a usable search root is a problem: %j', (roots, why) => {
    const { findings, checked } = hydraFindings({ search_roots: roots }, NOW)
    expect(findings).toEqual([
      {
        key: 'hydra:search-roots',
        level: 'problem',
        message: `${why}, so every discovery sweep finds nothing because there is nothing to search, not because the fleet is clean.`,
      },
    ])
    expect(checked).toEqual(['hydra:search-roots'])
  })

  test('locate statuses, site paths, the walk, elsewhere, archives, unregistered and nested checkouts each raise their own key', () => {
    const facts = {
      walk: { complete: true, unreadable: ['D:/locked'] },
      known_elsewhere: { found_here: ['zed'] },
      locate: {
        findings: [
          {
            key: 'a',
            status: 'AMBIGUOUS',
            registered: 'D:/a',
            found: ['D:/a1', 'D:/a2'],
            detail: 'two copies',
          },
          { key: 'b', status: 'MISSING', registered: 'D:/b', found: [] },
          { key: 'c', status: 'NOT_GIT', registered: 'D:/c', found: [] },
          { key: 'd', status: 'WRONG', registered: 'D:/d', found: [] },
        ],
        site_missing: [{ key: 's', site_path: 'S:/s' }],
      },
      archived_to: [
        { key: 'old', state: 'missing', archive: 'E:/old.7z' },
        { key: 'far', state: 'unreachable', root: 'F:/' },
      ],
      unregistered: { paths: ['D:/new'] },
      nested: { nested: [{ path: 'D:/app/inner', owner: 'app' }], unreadable: ['D:/x'] },
    }
    const { findings, checked } = hydraFindings(facts, NOW)
    expect(levelKeys(findings)).toEqual(
      [
        'problem:hydra:elsewhere:zed',
        'problem:hydra:locate:a',
        'problem:hydra:locate:b',
        'problem:hydra:locate:c',
        'problem:hydra:locate:d',
        'problem:hydra:site:s',
        'note:hydra:walk',
        'problem:hydra:archive:old',
        'note:hydra:archive-away',
        'problem:hydra:unregistered',
        'problem:hydra:nested',
      ].sort(),
    )
    const byKey = (key: string) => findings.find((f) => f.key === key)
    expect(byKey('hydra:locate:a')?.message).toBe(
      "Project Hydra's a matches more than one checkout on this machine: D:/a.",
    )
    expect(byKey('hydra:locate:a')?.detail).toBe('two copies; D:/a1; D:/a2')
    expect(byKey('hydra:locate:b')?.detail).toBeUndefined()
    expect(byKey('hydra:site:s')?.message).toBe("s's site_path S:/s is not on this machine.")
    expect(byKey('hydra:walk')?.detail).toBe('D:/locked')
    expect(byKey('hydra:archive-away')?.detail).toBe('far (F:/)')
    expect(byKey('hydra:unregistered')?.detail).toBe('D:/new')
    expect(byKey('hydra:nested')?.detail).toBe('D:/app/inner (inside app)')
    // A walk with unreadable folders and an unreadable nested listing claims neither locate nor the rest.
    expect(checked).toEqual(['hydra:elsewhere:', 'hydra:archive:'])
  })

  test('a rewritten or lagging record, index bad lines, never-read instruments and a stale sweep run each raise their own finding', () => {
    const facts = {
      sweep_evidence: {
        sarif: [],
        sarif_without: [],
        sarif_unreadable: [],
        runs: [{ command: 'maintain', at: AGO(20) }],
        runs_dropped: [],
      },
      record: {
        files: [
          { rel: 'a.jsonl', size: 5, error: 'EACCES' },
          { rel: 'b.jsonl', size: 100, bad_lines: 2 },
          { rel: 'c.jsonl', size: 3 },
        ],
        index: {
          exists: true,
          error: null,
          absorbed: { 'a.jsonl': 0, 'b.jsonl': 100, 'c.jsonl': 40 },
          bad_lines_total: 5,
        },
      },
      instruments: {
        error: null,
        index_exists: true,
        items: [{ name: 'ghost', deep: false, newest: null }],
      },
    }
    const { findings, checked } = hydraFindings(facts, NOW)
    expect(levelKeys(findings)).toEqual(
      [
        'problem:hydra:sweep-runs',
        'problem:hydra:record-unreadable:a.jsonl',
        'problem:hydra:record-bad-lines',
        'problem:hydra:record-rewritten:c.jsonl',
        'note:hydra:index-behind',
        'problem:hydra:index-bad-lines',
        'note:hydra:instruments-unread',
      ].sort(),
    )
    const byKey = (key: string) => findings.find((f) => f.key === key)
    expect(byKey('hydra:sweep-runs')?.detail).toBe(`maintain at ${AGO(20)}`)
    expect(byKey('hydra:record-unreadable:a.jsonl')?.detail).toBe('EACCES')
    expect(byKey('hydra:record-bad-lines')?.detail).toBe('b.jsonl (2)')
    expect(byKey('hydra:record-rewritten:c.jsonl')?.detail).toBe('3 bytes, 40 absorbed')
    expect(byKey('hydra:index-behind')?.detail).toBe('a.jsonl')
    expect(byKey('hydra:index-bad-lines')?.detail).toBe('3 line(s)')
    expect(byKey('hydra:instruments-unread')?.detail).toBe('ghost')
    expect(checked).toEqual([
      'hydra:sweep-sarif',
      'hydra:sweep-runs',
      'hydra:record-unreadable:',
      'hydra:record-bad-lines',
      'hydra:record-rewritten:',
      'hydra:index-bad-lines',
      'hydra:instrument:',
    ])
  })

  test('loki, cadence, prerequisites and collectors raise their own findings', () => {
    const cadence = (state: string, command: string) =>
      hydraFindings({ cadence: { task: 'Hydra-maintain', state, detail: 'exit 2', command } }, NOW)
    const failing = cadence('failing', 'python -m other')
    expect(levelKeys(failing.findings)).toEqual([
      'note:hydra:cadence-command',
      'problem:hydra:cadence',
    ])
    expect(failing.findings.find((f) => f.key === 'hydra:cadence')?.detail).toBe('exit 2')
    expect(failing.findings.find((f) => f.key === 'hydra:cadence-command')?.detail).toBe(
      'python -m other',
    )
    const paused = cadence('paused', 'python -m projecthydra.tools.maintain')
    expect(levelKeys(paused.findings)).toEqual(['note:hydra:cadence-paused'])
    expect(paused.checked).toEqual(['hydra:cadence'])

    const stale = hydraFindings({ loki: { run_at: AGO(5), folder_newest: null } }, NOW)
    expect(levelKeys(stale.findings)).toEqual(['problem:hydra:loki'])
    expect(stale.findings[0]?.detail).toBe(AGO(5))
    const fresh = hydraFindings({ loki: { run_at: AGO(1), folder_newest: null } }, NOW)
    expect(fresh.findings).toEqual([])
    expect(fresh.checked).toEqual(['hydra:loki'])

    const missing = hydraFindings(
      { prerequisites: { pyyaml: false, pytest: true, git: true, hook_state: 'missing' } },
      NOW,
    )
    expect(levelKeys(missing.findings)).toEqual(['problem:hydra:hook', 'problem:hydra:prereq'])
    expect(missing.findings.find((f) => f.key === 'hydra:prereq')?.detail).toBe(
      'PyYAML (every registry read needs it)',
    )
    expect(missing.checked).toEqual(['hydra:prereq', 'hydra:hook'])
    const installed = hydraFindings(
      { prerequisites: { pyyaml: true, pytest: true, git: true, hook_state: 'installed' } },
      NOW,
    )
    expect(installed.findings).toEqual([])
    expect(installed.checked).toEqual(['hydra:prereq', 'hydra:hook'])

    // arkitect.mjs is not in this PC's tools at all, so it is not reported; a null git is a problem and a null 7z a note.
    const tools = hydraFindings({ tools: { git: null, bun: 'C:/bun.exe', '7z': null } }, NOW)
    expect(levelKeys(tools.findings)).toEqual([
      'note:hydra:collector-optional:7z',
      'problem:hydra:collector:git',
    ])
    expect(tools.checked).toEqual(['hydra:collector:'])
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
