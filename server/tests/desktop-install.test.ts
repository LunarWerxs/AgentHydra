// server/tests/desktop-install.test.ts — core/desktop-install.ts detection matrix.
//
// The win32 detection paths are exercised with injected fake %LOCALAPPDATA% trees (throwaway
// temp dirs), gated to Windows since non-win32 platforms take the early "always manageable"
// return. One golden test asserts this machine's real classic (Squirrel) install resolves.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { appxOutputHasPfn, detectDesktopInstall } from '../src/core/desktop-install'
import { openInstance } from '../src/core/instances'
import { resolveLaunchBinary } from '../src/core/paths'

const isWin = process.platform === 'win32'

/** Fake %LOCALAPPDATA% builder — returns the root; callers add Packages/WindowsApps bits. */
function fakeLocalAppData(): string {
  return mkdtempSync(join(os.tmpdir(), 'ccmui-desktop-install-'))
}

/** No live Claude process found — the deterministic default for every test below that resolves
 *  `directPath` to null. Without this, detectDesktopInstall()'s live-process check falls back to
 *  the REAL listClaudeProcesses(), which would make these tests depend on whether this machine
 *  happens to have an actual Claude Desktop instance running. */
const noRunningProcesses = async () => []

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort temp cleanup.
    }
  }
  delete process.env.AGENTHYDRA_FAKE_DESKTOP_INSTALL
})

describe('detectDesktopInstall — win32 detection matrix (injected dirs)', () => {
  test.if(isWin)('classic-only install: manageable, no MSIX', async () => {
    const lad = fakeLocalAppData()
    cleanups.push(lad)
    const result = await detectDesktopInstall({
      localAppData: lad,
      resolveDirect: async () => 'C:\\fake\\AnthropicClaude\\app-1.0.0\\Claude.exe',
      appxProbe: null,
    })
    expect(result.platform).toBe('win32')
    expect(result.manageable).toBe(true)
    expect(result.msixDetected).toBe(false)
    expect(result.msixSignals).toEqual([])
  })

  test.if(isWin)('MSIX-only via Packages dir: not manageable, packages-dir signal', async () => {
    const lad = fakeLocalAppData()
    cleanups.push(lad)
    mkdirSync(join(lad, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
    const result = await detectDesktopInstall({
      localAppData: lad,
      resolveDirect: async () => null,
      appxProbe: null,
      listRunningProcesses: noRunningProcesses,
    })
    expect(result.manageable).toBe(false)
    expect(result.directPath).toBeNull()
    expect(result.msixDetected).toBe(true)
    expect(result.msixSignals).toEqual(['packages-dir'])
  })

  test.if(isWin)('MSIX via app-execution alias: exec-alias signal', async () => {
    const lad = fakeLocalAppData()
    cleanups.push(lad)
    mkdirSync(join(lad, 'Microsoft', 'WindowsApps'), { recursive: true })
    writeFileSync(join(lad, 'Microsoft', 'WindowsApps', 'claude.exe'), '')
    const result = await detectDesktopInstall({
      localAppData: lad,
      resolveDirect: async () => null,
      appxProbe: null,
      listRunningProcesses: noRunningProcesses,
    })
    expect(result.msixDetected).toBe(true)
    expect(result.msixSignals).toEqual(['exec-alias'])
    expect(result.manageable).toBe(false)
  })

  test.if(isWin)('both installed side by side: manageable AND msixDetected', async () => {
    const lad = fakeLocalAppData()
    cleanups.push(lad)
    mkdirSync(join(lad, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
    const result = await detectDesktopInstall({
      localAppData: lad,
      resolveDirect: async () => 'C:\\fake\\AnthropicClaude\\app-1.0.0\\Claude.exe',
      appxProbe: null,
    })
    expect(result.manageable).toBe(true)
    expect(result.msixDetected).toBe(true)
  })

  test.if(isWin)('nothing installed: not manageable, no MSIX', async () => {
    const lad = fakeLocalAppData()
    cleanups.push(lad)
    const result = await detectDesktopInstall({
      localAppData: lad,
      resolveDirect: async () => null,
      appxProbe: null,
      listRunningProcesses: noRunningProcesses,
    })
    expect(result.manageable).toBe(false)
    expect(result.msixDetected).toBe(false)
    expect(result.msixSignals).toEqual([])
  })

  test.if(isWin)(
    'MSIX fs signal present BUT a live classic process is running: manageable',
    async () => {
      const lad = fakeLocalAppData()
      cleanups.push(lad)
      mkdirSync(join(lad, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
      let probeRan = false
      const result = await detectDesktopInstall({
        localAppData: lad,
        resolveDirect: async () => null,
        // Mirrors process.ts's CMProcessInfo shape narrowed to `dir` — a running main process
        // always carries a resolved (non-null) --user-data-dir by construction.
        listRunningProcesses: async () => [{ dir: 'C:\\claude-instances\\work' }],
        appxProbe: async () => {
          probeRan = true
          return false
        },
      })
      expect(result.directPath).toBeNull()
      expect(result.manageable).toBe(true)
      // The classic evidence (a running process) already answers "manageable" — the fs-only
      // MSIX signal is still reported for debuggability, and the probe is skipped because classic
      // evidence is already positive (see the probe-skip-semantics tests below).
      expect(result.msixDetected).toBe(true)
      expect(result.msixSignals).toEqual(['packages-dir'])
      expect(probeRan).toBe(false)
    },
  )

  test.if(isWin)(
    'no directPath, no MSIX signals, live classic process running: manageable',
    async () => {
      const lad = fakeLocalAppData()
      cleanups.push(lad)
      const result = await detectDesktopInstall({
        localAppData: lad,
        resolveDirect: async () => null,
        listRunningProcesses: async () => [{ dir: 'C:\\claude-instances\\work' }],
        appxProbe: null,
      })
      expect(result.directPath).toBeNull()
      expect(result.manageable).toBe(true)
      expect(result.msixDetected).toBe(false)
      expect(result.msixSignals).toEqual([])
    },
  )

  test.if(isWin)(
    'a running-process list with no --user-data-dir entries does not count as running classic',
    async () => {
      const lad = fakeLocalAppData()
      cleanups.push(lad)
      const result = await detectDesktopInstall({
        localAppData: lad,
        resolveDirect: async () => null,
        // Defends the `.some((p) => p.dir != null)` filter: a malformed/childless record must
        // not be mistaken for proof of a launchable classic install.
        listRunningProcesses: async () => [{ dir: null }, {}],
        appxProbe: null,
      })
      expect(result.manageable).toBe(false)
    },
  )

  test.if(isWin)('Get-AppxPackage probe runs only as fallback and adds appx signal', async () => {
    const lad = fakeLocalAppData()
    cleanups.push(lad)
    const result = await detectDesktopInstall({
      localAppData: lad,
      resolveDirect: async () => null,
      listRunningProcesses: noRunningProcesses,
      appxProbe: async () => true,
    })
    expect(result.msixDetected).toBe(true)
    expect(result.msixSignals).toEqual(['appx'])
  })

  describe('probe-skip semantics (classic evidence gates the probe, not the fs signal)', () => {
    test.if(isWin)('probe is SKIPPED when directPath resolves, even with a fs signal', async () => {
      const lad = fakeLocalAppData()
      cleanups.push(lad)
      mkdirSync(join(lad, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
      let probeRan = false
      const result = await detectDesktopInstall({
        localAppData: lad,
        resolveDirect: async () => 'C:\\fake\\AnthropicClaude\\app-1.0.0\\Claude.exe',
        appxProbe: async () => {
          probeRan = true
          return true
        },
      })
      expect(probeRan).toBe(false)
      expect(result.manageable).toBe(true)
      expect(result.msixSignals).toEqual(['packages-dir'])
    })

    test.if(isWin)(
      'probe RUNS when a fs signal fired but classic evidence is negative, and OVERRIDES a stale leftover',
      async () => {
        const lad = fakeLocalAppData()
        cleanups.push(lad)
        // A leftover packages-dir from an MSIX that has since been uninstalled — the exact
        // "leftovers-prone" false-positive scenario the fix addresses.
        mkdirSync(join(lad, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
        let probeRan = false
        const result = await detectDesktopInstall({
          localAppData: lad,
          resolveDirect: async () => null,
          listRunningProcesses: noRunningProcesses,
          appxProbe: async () => {
            probeRan = true
            return false // authoritative: the MSIX is not actually installed
          },
        })
        expect(probeRan).toBe(true)
        // msixSignals still records the fs signal that fired (debuggability)...
        expect(result.msixSignals).toEqual(['packages-dir'])
        // ...but msixDetected is corrected by the authoritative probe, not pinned true forever.
        expect(result.msixDetected).toBe(false)
        expect(result.manageable).toBe(false)
      },
    )
  })

  test.if(isWin)('package-family-name shape is strict: no false positives', async () => {
    const lad = fakeLocalAppData()
    cleanups.push(lad)
    // Wrong name prefix, wrong hash length, unrelated Claude-ish third-party package.
    mkdirSync(join(lad, 'Packages', 'ClaudeFake_pzs8sxrjxfjjc'), { recursive: true })
    mkdirSync(join(lad, 'Packages', 'Claude_short'), { recursive: true })
    mkdirSync(join(lad, 'Packages', 'SomeVendor.ClaudeChat_abcdefghjkmnp'), { recursive: true })
    const result = await detectDesktopInstall({
      localAppData: lad,
      resolveDirect: async () => null,
      appxProbe: null,
      listRunningProcesses: noRunningProcesses,
    })
    expect(result.msixDetected).toBe(false)
  })
})

describe('resolveLaunchBinary — win32 stable-stub-first ordering', () => {
  test.if(isWin)(
    'the stable AnthropicClaude\\claude.exe stub wins over a versioned app-<ver> dir',
    async () => {
      const savedLad = process.env.LOCALAPPDATA
      const lad = fakeLocalAppData()
      cleanups.push(lad)
      const anthropicDir = join(lad, 'AnthropicClaude')
      mkdirSync(anthropicDir, { recursive: true })
      writeFileSync(join(anthropicDir, 'claude.exe'), '')
      mkdirSync(join(anthropicDir, 'app-9.9.9'), { recursive: true })
      writeFileSync(join(anthropicDir, 'app-9.9.9', 'Claude.exe'), '')

      process.env.LOCALAPPDATA = lad
      try {
        const resolved = await resolveLaunchBinary()
        expect(resolved).toBe(join(anthropicDir, 'claude.exe'))
      } finally {
        // Restore with the delete-idiom: a bare assignment of `undefined` stores the STRING
        // "undefined" (Node semantics, and Bun's from 1.4), poisoning the var for later tests.
        if (savedLad === undefined) delete process.env.LOCALAPPDATA
        else process.env.LOCALAPPDATA = savedLad
      }
    },
  )

  test.if(isWin)(
    'falls back to the newest versioned app-<ver> dir when the stub is absent',
    async () => {
      const savedLad = process.env.LOCALAPPDATA
      const lad = fakeLocalAppData()
      cleanups.push(lad)
      const anthropicDir = join(lad, 'AnthropicClaude')
      mkdirSync(join(anthropicDir, 'app-1.2.3'), { recursive: true })
      writeFileSync(join(anthropicDir, 'app-1.2.3', 'Claude.exe'), '')

      process.env.LOCALAPPDATA = lad
      try {
        const resolved = await resolveLaunchBinary()
        expect(resolved).toBe(join(anthropicDir, 'app-1.2.3', 'Claude.exe'))
      } finally {
        // Restore with the delete-idiom: a bare assignment of `undefined` stores the STRING
        // "undefined" (Node semantics, and Bun's from 1.4), poisoning the var for later tests.
        if (savedLad === undefined) delete process.env.LOCALAPPDATA
        else process.env.LOCALAPPDATA = savedLad
      }
    },
  )
})

describe('detectDesktopInstall — cross-platform behavior', () => {
  test.if(!isWin)('non-Windows is always manageable (MSIX split does not exist)', async () => {
    const result = await detectDesktopInstall({ fresh: true, appxProbe: null })
    expect(result.platform).not.toBe('win32')
    expect(result.manageable).toBe(true)
    expect(result.msixDetected).toBe(false)
  })

  test('AGENTHYDRA_FAKE_DESKTOP_INSTALL=msix-only forces the warning shape', async () => {
    process.env.AGENTHYDRA_FAKE_DESKTOP_INSTALL = 'msix-only'
    const result = await detectDesktopInstall({ fresh: true })
    expect(result.manageable).toBe(false)
    expect(result.msixDetected).toBe(true)
    expect(result.msixSignals).toEqual(['fake'])
    // Fake modes must report win32 even on mac/linux dev machines — the Instances-tab banner
    // is gated on platform === 'win32', so a passed-through real platform would no-op there.
    expect(result.platform).toBe('win32')
  })

  test('AGENTHYDRA_FAKE_DESKTOP_INSTALL=ok forces the manageable shape', async () => {
    process.env.AGENTHYDRA_FAKE_DESKTOP_INSTALL = 'ok'
    const result = await detectDesktopInstall({ fresh: true })
    expect(result.manageable).toBe(true)
    expect(result.msixDetected).toBe(false)
    expect(result.platform).toBe('win32')
  })

  test('unknown fake mode falls through to real detection', async () => {
    process.env.AGENTHYDRA_FAKE_DESKTOP_INSTALL = 'bogus'
    const result = await detectDesktopInstall({ fresh: true, appxProbe: null })
    expect(result.msixSignals).not.toEqual(['fake'])
  })
})

describe('appxOutputHasPfn — Get-AppxPackage stdout parsing', () => {
  test('matches the bare PFN and newline-joined multi-package output', () => {
    expect(appxOutputHasPfn('Claude_pzs8sxrjxfjjc\r\n')).toBe(true)
    expect(appxOutputHasPfn('Other_abcdefghjkmnp\r\nClaude_pzs8sxrjxfjjc\r\n')).toBe(true)
  })

  test('rejects PFN-shaped substrings inside longer lines and empty output', () => {
    expect(appxOutputHasPfn('')).toBe(false)
    expect(appxOutputHasPfn('WARNING: something Claude_pzs8sxrjxfjjc mentioned')).toBe(false)
    expect(appxOutputHasPfn('SomeVendor.ClaudeChat_abcdefghjkmnp')).toBe(false)
  })
})

// openInstance's no-binary failure path: point LOCALAPPDATA at an empty temp dir so no real
// Claude binary resolves (nothing can actually launch), and force the MSIX-only fake so the
// failure message carries the actionable explanation. Skipped if a machine-wide install at
// C:\Program Files\Claude exists (paths.ts falls back to it and would resolve a real binary).
describe('openInstance — no-binary failure message', () => {
  test.if(isWin && !existsSync('C:\\Program Files\\Claude\\Claude.exe'))(
    'explains the MSIX-only case instead of the generic message',
    async () => {
      const savedLad = process.env.LOCALAPPDATA
      const lad = fakeLocalAppData()
      cleanups.push(lad)
      process.env.LOCALAPPDATA = lad
      process.env.AGENTHYDRA_FAKE_DESKTOP_INSTALL = 'msix-only'
      try {
        const result = await openInstance('C:\\nonexistent\\ccmui-msix-message-test')
        expect(result.ok).toBe(false)
        expect(result.message ?? '').toContain('MSIX')
      } finally {
        // Restore with the delete-idiom: a bare assignment of `undefined` stores the STRING
        // "undefined" (Node semantics, and Bun's from 1.4), poisoning the var for later tests.
        if (savedLad === undefined) delete process.env.LOCALAPPDATA
        else process.env.LOCALAPPDATA = savedLad
      }
    },
  )
})

// Golden (this machine): the real classic install at %LOCALAPPDATA%\AnthropicClaude resolves.
const goldenClassicDir = isWin ? join(process.env.LOCALAPPDATA ?? '', 'AnthropicClaude') : ''
describe('detectDesktopInstall — golden (real machine state)', () => {
  test.if(isWin && existsSync(goldenClassicDir))(
    'this machine reports a manageable classic install',
    async () => {
      const result = await detectDesktopInstall({ fresh: true, appxProbe: null })
      expect(result.manageable).toBe(true)
      expect(result.directPath ?? '').toContain('AnthropicClaude')
    },
  )
})
