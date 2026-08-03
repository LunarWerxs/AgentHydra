// server/tests/lifecycle-cli-unlink.test.ts — regression guard for the ghost-CLI-instance bug in
// removeInstance() (core/lifecycle.ts).
//
// The bug: a CLI instance LINKED to a desktop instance (associatedDesktopDir set) is filtered out
// of the standalone CLI Instances table (CliInstancesSection's unlinkedCliInstances) because it's
// shown on its desktop instance's row instead (InstancesView). If that desktop instance is then
// DELETED without clearing the link, the CLI instance becomes a ghost: still "linked" (so still
// hidden from the CLI table) even though the desktop row it was linked to no longer exists —
// invisible and unmanageable. The fix: removeInstance() now clears the link (associatedDesktopDir
// -> null) on any CLI instance pointing at the dir it just deleted, so the CLI instance falls back
// into the CLI Instances table where it can be relinked, renamed, or deleted normally.
//
// Uses a REAL throwaway directory under instancesRoot() (~/.claude-instances) — removeInstance()'s
// guard 2 requires the target dir to live there, and instancesRoot() is not env-overridable (unlike
// CONFIG_DIR, which IS overridden to a temp scratch dir by tests/setup.ts, so the CLI-instance store
// itself never touches the developer's real ~/.agenthydra state). The desktop dir is created fresh
// and always removed (by removeInstance() on success, or by this test's cleanup on any failure) —
// never a pre-existing instance.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  linkCliInstanceToDesktop,
} from '../src/core/cli-instances'
import { removeInstance } from '../src/core/lifecycle'
import { instancesRoot } from '../src/core/paths'

const cleanupDirs: string[] = []
const cleanupCliIds: string[] = []

afterEach(() => {
  for (const id of cleanupCliIds.splice(0)) {
    try {
      deleteCliInstance(id, getCliInstance(id)?.name ?? '')
    } catch {
      // best-effort
    }
  }
  for (const dir of cleanupDirs.splice(0)) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function makeDesktopDir(label: string): string {
  const dir = join(instancesRoot(), `ccmui-lifecycle-test-${label}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  cleanupDirs.push(dir)
  return dir
}

describe('removeInstance() clears CLI-instance links to the deleted desktop dir (no ghosts)', () => {
  test('a CLI instance linked to the deleted desktop dir is unlinked, not left a ghost', async () => {
    const desktopDir = makeDesktopDir('unlink')
    const created = createCliInstance('ghost-test-cli')
    expect(created.ok).toBe(true)
    const id = created.data?.id as string
    cleanupCliIds.push(id)

    const linked = linkCliInstanceToDesktop(id, desktopDir, 'ghost-test-cli (desktop)')
    expect(linked.ok).toBe(true)
    expect(getCliInstance(id)?.associatedDesktopDir).toBe(desktopDir)

    const result = await removeInstance(desktopDir, { confirmName: basename(desktopDir) })

    expect(result.ok).toBe(true)
    expect(existsSync(desktopDir)).toBe(false)

    // The bug: this CLI instance would otherwise stay associatedDesktopDir === desktopDir forever
    // (a dir that no longer exists) — still "linked" and so still hidden from the CLI table, with
    // no desktop row left to act on it from. The fix clears it back to null.
    const after = getCliInstance(id)
    expect(after).not.toBeNull()
    expect(after?.associatedDesktopDir).toBeNull()
    expect(after?.associatedDesktopLabel).toBeNull()
  })

  test('a CLI instance linked to a DIFFERENT desktop dir is left untouched', async () => {
    const deletedDir = makeDesktopDir('deleted')
    const survivingDir = makeDesktopDir('surviving')
    cleanupDirs.push(survivingDir) // still present after the test; clean it up too

    const created = createCliInstance('unrelated-cli')
    expect(created.ok).toBe(true)
    const id = created.data?.id as string
    cleanupCliIds.push(id)

    linkCliInstanceToDesktop(id, survivingDir, 'unrelated-cli (desktop)')
    expect(getCliInstance(id)?.associatedDesktopDir).toBe(survivingDir)

    const result = await removeInstance(deletedDir, { confirmName: basename(deletedDir) })
    expect(result.ok).toBe(true)

    // Unrelated link must survive — only the CLI instance linked to the DELETED dir gets cleared.
    expect(getCliInstance(id)?.associatedDesktopDir).toBe(survivingDir)
  })

  test('no CLI instance linked to the deleted dir -> delete proceeds exactly as before (no-op loop)', async () => {
    const desktopDir = makeDesktopDir('no-links')
    const result = await removeInstance(desktopDir, { confirmName: basename(desktopDir) })
    expect(result.ok).toBe(true)
    expect(existsSync(desktopDir)).toBe(false)
  })
})
