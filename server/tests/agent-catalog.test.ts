// server/tests/agent-catalog.test.ts — the agent catalog (server/src/agent-catalog.ts).
//
// Most of this file is data, and data is tested by the properties that must hold across every row:
// no duplicate ids, no format claim without a reader, no OpenCode-shaped tool without a database
// filename. The behaviour worth pinning separately is the safety story — that a speculative entry
// pointing at a directory nobody has cannot cost anything or leak into the three stores that were
// here first.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_TOOLS,
  agentTool,
  BUILT_IN_TOOL_IDS,
  detectAgentTools,
  extraRootsWithFormat,
  rootsFor,
  rootsWithFormat,
} from '../src/agent-catalog'

const home = mkdtempSync(join(tmpdir(), 'agenthydra-catalog-'))

describe('the catalog as data', () => {
  test('ids are unique — they key the API, settings and i18n', () => {
    const ids = AGENT_TOOLS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every tool has a name and a vendor: the UI shows both', () => {
    for (const t of AGENT_TOOLS) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.vendor.length).toBeGreaterThan(0)
    }
  })

  test('a format claim is only ever one we have a reader for', () => {
    for (const t of AGENT_TOOLS) {
      if (t.format === null) continue
      expect(['claude', 'codex', 'opencode']).toContain(t.format)
    }
  })

  test('every opencode-format tool names its database file', () => {
    // Without it the root is a directory, and the indexer would have nothing to open.
    for (const t of AGENT_TOOLS.filter((t) => t.format === 'opencode')) {
      expect(t.dbName).toBeTruthy()
    }
  })

  test('archived dirs are drawn from the tool’s own dirs', () => {
    for (const t of AGENT_TOOLS) {
      for (const d of t.archivedDirs ?? []) expect(t.dirs).toContain(d)
    }
  })

  test('paths are home-relative, never absolute', () => {
    // An absolute default would be a path on the author's machine, not a store location.
    for (const t of AGENT_TOOLS) {
      for (const d of t.dirs) {
        expect(d.startsWith('/')).toBe(false)
        expect(/^[A-Za-z]:/.test(d)).toBe(false)
      }
    }
  })

  test('the three stores that predate this file are all present and readable', () => {
    for (const id of BUILT_IN_TOOL_IDS) {
      expect(agentTool(id)?.format).not.toBeNull()
    }
  })
})

describe('resolving roots on a real machine', () => {
  test('a store that is not installed yields nothing at all', () => {
    // The entire safety story for a speculative row: a wrong path costs one stat and produces no
    // sessions, so it cannot mislead and cannot break anything.
    const tool = agentTool('qwen')
    expect(tool).toBeDefined()
    if (tool) expect(rootsFor(tool, home)).toEqual([])
  })

  test('an existing directory is found, and its archive flag comes from the tool', () => {
    mkdirSync(join(home, '.trae', 'cli', 'archived_sessions'), { recursive: true })
    const roots = rootsFor(agentTool('traex') as (typeof AGENT_TOOLS)[number], home)
    expect(roots).toHaveLength(1)
    expect(roots[0]?.archived).toBe(true)
  })

  test('an opencode-format root without its database is not a store', () => {
    // The directory exists because the tool is installed; with no .db there is no conversation to
    // read, and reporting it as a store would produce an empty provider on every chart.
    mkdirSync(join(home, '.local', 'share', 'kilo'), { recursive: true })
    expect(rootsFor(agentTool('kilo') as (typeof AGENT_TOOLS)[number], home)).toEqual([])
    writeFileSync(join(home, '.local', 'share', 'kilo', 'kilo.db'), '')
    expect(rootsFor(agentTool('kilo') as (typeof AGENT_TOOLS)[number], home)).toHaveLength(1)
  })

  test('the extra-roots view excludes the three the indexer already handles by constant', () => {
    // Those keep their own config constants — including env overrides that predate this file — so
    // the catalog must not hand the indexer a second, differently-resolved copy of them.
    const ids = new Set(
      (['claude', 'codex', 'opencode'] as const).flatMap((f) =>
        extraRootsWithFormat(f, home).map((r) => r.tool.id),
      ),
    )
    for (const built of BUILT_IN_TOOL_IDS) expect(ids.has(built)).toBe(false)
  })

  test('the unfiltered view DOES include them', () => {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    expect(rootsWithFormat('claude', home).map((r) => r.tool.id)).toContain('claude-code')
  })
})

describe('detection', () => {
  test('reports only what is installed, with a file count and a date', () => {
    mkdirSync(join(home, '.grok', 'sessions'), { recursive: true })
    writeFileSync(join(home, '.grok', 'sessions', 'a.jsonl'), '{}\n')
    writeFileSync(join(home, '.grok', 'sessions', 'b.jsonl'), '{}\n')

    const found = detectAgentTools(home)
    const grok = found.find((t) => t.id === 'grok')
    expect(grok?.files).toBe(2)
    expect(grok?.lastActivityAt).toBeGreaterThan(0)
    // Detected, not readable — and the UI must be able to say which.
    expect(grok?.format).toBeNull()

    // Nothing that is not on disk gets a row.
    expect(found.find((t) => t.id === 'qwen')).toBeUndefined()
  })

  test('a readable tool reports the reader that handles it', () => {
    expect(detectAgentTools(home).find((t) => t.id === 'claude-code')?.format).toBe('claude')
  })
})
