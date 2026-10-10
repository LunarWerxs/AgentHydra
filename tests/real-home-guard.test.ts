// tests/real-home-guard.test.ts — the preload refuses writes into the developer's real agent homes.
//
// Contract: a write whose target resolves inside a real ~/.claude, ~/.claude-instances, ~/.codex,
// ~/.hswarm or ~/.hydra-desk-2 (or the CLAUDE_CONFIG_DIR / CODEX_HOME the shell started with) throws,
// naming the path. A write into the scratch dir works, and a read of a real-home path is never refused.
// A remove of the working folder throws too.
// Regression: setup.ts redirected every state root except the agent homes, so a test that wrote into
// the real ~/.claude changed a live account with no error.
// Gap: a child process started without this preload is not covered. A named ESM import is checked
// below, so a Bun that binds named exports before the patch makes this suite fail, which is the signal.
// Seam: the probe is a random name under the real ~/.claude, so a broken guard writes a file nobody reads.

import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { unguardedRmSync } from './real-home-guard'

const probe = join(homedir(), '.claude', `agenthydra-guard-probe-${randomUUID()}`)
const GUARD = /real agent home/

afterAll(() => {
  // Only exists when the guard is broken; remove it with the unpatched rmSync so the cleanup is not refused.
  if (existsSync(probe)) unguardedRmSync(probe, { recursive: true, force: true })
})

describe('the real-agent-home write guard', () => {
  test('a named-import write into the real ~/.claude throws, names the path, and creates nothing', () => {
    expect(() => writeFileSync(probe, 'probe')).toThrow(GUARD)
    expect(() => writeFileSync(probe, 'probe')).toThrow(/agenthydra-guard-probe-/)
    expect(existsSync(probe)).toBe(false)
  })

  test('the same kind of write into the scratch dir works', () => {
    const dir = join(process.env.AGENTHYDRA_HOME!, 'guard-ok')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'probe.txt')
    writeFileSync(file, 'ok')
    expect(readFileSync(file, 'utf8')).toBe('ok')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a read of a real-home path is not refused', () => {
    expect(existsSync(probe)).toBe(false)
    // A read of a missing file fails with ENOENT, never with the guard's message.
    expect(() => readFileSync(probe)).toThrow(/ENOENT/)
  })

  // Bun on Windows empties the working folder for rmSync(''): desk2/ lost every file that way on 2026-10-10. Run from a
  // throwaway folder, so a broken guard empties only that.
  test("a remove of the working folder ('' or '.') throws and deletes nothing", () => {
    const dir = join(process.env.AGENTHYDRA_HOME!, 'guard-cwd')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'keep.txt'), 'keep')
    const back = process.cwd()
    process.chdir(dir)
    try {
      expect(() => rmSync('', { recursive: true, force: true })).toThrow(/folder the tests run in/)
      expect(() => rmSync('.', { recursive: true, force: true })).toThrow(/folder the tests run in/)
      expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep')
    } finally {
      process.chdir(back)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('the fs/promises twin rejects with the same refusal', async () => {
    await expect(fsp.writeFile(probe, 'probe')).rejects.toThrow(GUARD)
    expect(existsSync(probe)).toBe(false)
  })
})
