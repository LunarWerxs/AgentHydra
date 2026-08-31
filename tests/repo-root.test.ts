// THE ROOT-BINDING GUARD. Proves the repo root is found by RECOGNITION, not by hop count.
//
// The bug this locks out is silent by nature: a hop-counted root that goes stale does not throw,
// it just points somewhere wrong, and a suite that walks files from there finds none and passes.
// So the tests that matter most here are the two a hop count would fail - resolving from a
// DEEPER directory, and refusing to answer at all when there is no repo above.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findRepoRoot, REPO_ROOT } from './repo-root'

describe('repo root binding', () => {
  test('resolves to a directory that proves it is this repo', () => {
    expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true)
    for (const landmark of ['misc', 'server', 'web', 'scripts']) {
      expect(existsSync(join(REPO_ROOT, landmark))).toBe(true)
    }
  })

  // THE REGRESSION. `resolve(import.meta.dir, '..')` is only right while the caller sits exactly
  // one level down; from two levels down it lands on `server/`, and every path built from it
  // silently stops existing. Recognition returns the same answer from any depth.
  test('is depth-independent: a deeper start finds the same root', () => {
    const deep = join(REPO_ROOT, 'server', 'src')
    const deeper = join(REPO_ROOT, 'scripts', 'checks')
    expect(existsSync(deep)).toBe(true)
    expect(findRepoRoot(deep)).toBe(REPO_ROOT)
    expect(findRepoRoot(deeper)).toBe(REPO_ROOT)
    // What the old pattern would have produced from that same spot - the wrong directory.
    expect(resolve(deep, '..')).not.toBe(REPO_ROOT)
  })

  test('does not stop at a workspace package on the way up', () => {
    // server/ has its own package.json; only the root one is named 'agenthydra' with workspaces.
    expect(existsSync(join(REPO_ROOT, 'server', 'package.json'))).toBe(true)
    expect(findRepoRoot(join(REPO_ROOT, 'server'))).toBe(REPO_ROOT)
  })

  test('finds the root when already standing on it', () => {
    expect(findRepoRoot(REPO_ROOT)).toBe(REPO_ROOT)
  })

  // The load-bearing half: no repo above means THROW, never a best guess. A guess here is exactly
  // what lets a relocated suite scan nothing and report success.
  test('throws rather than guessing when there is no repo above', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agenthydra-rootguard-'))
    expect(() => findRepoRoot(outside)).toThrow(/no AgentHydra repo root/)
  })

  // The swap that adopted this helper must not have moved any path. Identical value today is what
  // makes it a safe replacement; being immune to a future move is what makes it worth doing.
  test('matches what the hop count resolved to while the hop count was still correct', () => {
    expect(REPO_ROOT).toBe(resolve(import.meta.dir, '..'))
  })
})
