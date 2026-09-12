// server/tests/instance-pointer-side-run.test.ts — a daemon with a relocated store must not take
// the machine-wide pointer.
//
// The defect this exists for, in full: on 2026-09-12 a session started a daemon from source on port
// 7799 with a scratch database to click through a UI change. It overwrote `~/.agenthydra/
// runtime.json` to name itself and exited without restoring it, and from then on every MCP tool,
// every orchestrator script and every hydralib call on the machine dialled the dead 7799 and
// reported the daemon down — while the real one answered /api/health 200 on 7787 the whole time.
//
// The module under test resolves its decision at IMPORT time from config.ts's CONFIG_DIR/DATA_DIR,
// so this exercises the rule itself (isPathInside) against the real shapes rather than re-importing
// the module per case: a fresh import in bun's module graph would be the same singleton, and
// mutating process.env after the fact cannot move a const that has already been computed.

import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR, DATA_DIR } from '../src/config'
import { isPathInside } from '../src/core/paths'
import { POINTER_DIR } from '../src/instance'

describe('the primary-install rule', () => {
  test('a data dir INSIDE the config dir is the primary install', () => {
    const config = join(homedir(), '.agenthydra')
    expect(isPathInside(config, join(config, 'data'))).toBe(true)
  })

  test('a scratch data dir elsewhere is NOT — this is the shape that hijacked the pointer', () => {
    const config = join(homedir(), '.agenthydra')
    const scratch = join(homedir(), 'AppData', 'Local', 'Temp', 'claude', 'probe-data')
    expect(isPathInside(config, scratch)).toBe(false)
  })

  test('a whole scratch AGENTHYDRA_HOME moves BOTH, so it stays primary and was never the problem', () => {
    // This is the documented way to run a second daemon safely: the config dir moves with the data
    // dir, so the pointer lands in the scratch home and the shared one is untouched by construction.
    const scratchHome = join(homedir(), 'scratch-home')
    expect(isPathInside(scratchHome, join(scratchHome, 'data'))).toBe(true)
  })

  test('the config dir is not "inside itself" — an identical path must not read as relocated', () => {
    // isPathInside returns false for the same path, which would flip a daemon whose DATA_DIR
    // somehow equals CONFIG_DIR into side-run mode. Documented here because that is a plausible
    // portable-install layout, and the answer below is what the running code would do with it.
    const config = join(homedir(), '.agenthydra')
    expect(isPathInside(config, config)).toBe(false)
  })
})

describe('POINTER_DIR, as this process actually resolved it', () => {
  test('is the config dir when the store is canonical, and the data dir when it is not', () => {
    // Under `bun run test` the suite runs with a throwaway AGENTHYDRA_DATA_DIR (see config.ts's
    // NODE_ENV=test branch), so this asserts the rule rather than one fixed answer — and it is the
    // only assertion that proves the exported constant is wired to the same predicate.
    expect(POINTER_DIR).toBe(isPathInside(CONFIG_DIR, DATA_DIR) ? CONFIG_DIR : DATA_DIR)
  })

  test('a side-run never resolves to the shared config dir', () => {
    if (isPathInside(CONFIG_DIR, DATA_DIR)) return // primary: nothing to prove here
    expect(POINTER_DIR).not.toBe(CONFIG_DIR)
  })
})
