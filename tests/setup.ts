// Bun test preload (wired in bunfig.toml). Points AGENTHYDRA_DB at a throwaway sqlite file and
// AGENTHYDRA_HOME at a temp dir so the suite never reads or writes the REAL ~/.agenthydra/data db
// or runtime pointer. Without this, the auto-update tests' clamp calls persist their
// synthetic values (e.g. intervalSecs 900) into the developer's live settings table.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Child-process tests should run the exact Bun binary that is running the suite. On Windows an npm
// install can put a quote-lossy `bun.cmd` shim earlier on PATH than bun.exe; the updater's real
// `bun -e <script>` fixtures then fail inside cmd before the code under test even runs.
process.env.PATH = [path.dirname(process.execPath), process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter)

const realTmp = os.tmpdir()
const scratch = mkdtempSync(path.join(realTmp, 'agenthydra-test-'))

// Sweep the scratches earlier runs left behind. Nothing can delete a scratch at its own exit —
// the sqlite handle is still open when 'exit' fires, and Windows refuses to remove an open db
// file — so each run instead removes PREVIOUS runs' dirs. The 24h age floor keeps any
// concurrently-running suite's scratch (or a laptop suspended mid-run) safe; a busy day's worth
// of ~300KB dirs is the bounded steady state, and anything a crashed run leaks is gone within a
// day. Every failure here is swallowed: housekeeping must never fail the suite.
for (const entry of readdirSync(realTmp)) {
  if (!entry.startsWith('agenthydra-test-')) continue
  const p = path.join(realTmp, entry)
  if (p === scratch) continue
  try {
    if (Date.now() - statSync(p).mtimeMs > 24 * 60 * 60 * 1000)
      rmSync(p, { recursive: true, force: true })
  } catch {
    // In use, already gone, or undeletable — the next run's sweep gets another chance.
  }
}

// Point the OS temp dir INSIDE the scratch, so the ~15 per-test mkdtemp prefixes the suite
// scatters (ah-*, agh-*, cmui-*, ccmui-*, lunarwerx-*, lw-*, …) all nest under the one swept
// dir instead of accumulating in the real %TEMP% whenever a test skips or crashes before its
// rmSync. os.tmpdir() reads TMPDIR/TEMP/TMP per call, and spawned children inherit the env, so
// this covers child-process fixtures too. The sweep above deliberately ran against realTmp.
const scratchTmp = path.join(scratch, 'tmp')
mkdirSync(scratchTmp, { recursive: true })
process.env.TMPDIR = scratchTmp
process.env.TEMP = scratchTmp
process.env.TMP = scratchTmp

process.env.AGENTHYDRA_HOME = scratch
process.env.AGENTHYDRA_DB = path.join(scratch, 'agenthydra-test.db')
// Isolate per-run dispatch logs (+ the detached runner's spec/status sidecars) too, so the
// dispatch tests never write into the real ~/.agenthydra/data/run-logs.
process.env.AGENTHYDRA_RUN_LOG_DIR = path.join(scratch, 'run-logs')
mkdirSync(process.env.AGENTHYDRA_RUN_LOG_DIR, { recursive: true })
// And the rest of the data dir. DATA_DIR is the developer's REAL ~/.agenthydra/data in every mode
// now, so anything the suite writes through usage-cache.ts / usage-history.ts would land in the
// state their running app reads — a synthetic account's usage row showing up in their own UI.
process.env.AGENTHYDRA_DATA_DIR = path.join(scratch, 'data')
mkdirSync(process.env.AGENTHYDRA_DATA_DIR, { recursive: true })
