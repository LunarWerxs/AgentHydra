// Bun test preload (wired in bunfig.toml). Points AGENTHYDRA_DB at a throwaway sqlite file and
// AGENTHYDRA_HOME at a temp dir so the suite never reads or writes the REAL server/data db or
// ~/.agenthydra runtime pointer. Without this, the auto-update tests' clamp calls persist their
// synthetic values (e.g. intervalSecs 900) into the developer's live settings table.
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Child-process tests should run the exact Bun binary that is running the suite. On Windows an npm
// install can put a quote-lossy `bun.cmd` shim earlier on PATH than bun.exe; the updater's real
// `bun -e <script>` fixtures then fail inside cmd before the code under test even runs.
process.env.PATH = [path.dirname(process.execPath), process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter)

const scratch = mkdtempSync(path.join(os.tmpdir(), 'agenthydra-test-'))
process.env.AGENTHYDRA_HOME = scratch
process.env.AGENTHYDRA_DB = path.join(scratch, 'agenthydra-test.db')
// Isolate per-run dispatch logs (+ the detached runner's spec/status sidecars) too, so the
// dispatch tests never write into the real server/data/run-logs.
process.env.AGENTHYDRA_RUN_LOG_DIR = path.join(scratch, 'run-logs')
mkdirSync(process.env.AGENTHYDRA_RUN_LOG_DIR, { recursive: true })
// And the rest of the data dir. In a source checkout DATA_DIR is the developer's REAL server/data,
// so anything the suite writes through usage-cache.ts / usage-history.ts would land in the state
// their running app reads — a synthetic account's usage row showing up in their own UI.
process.env.AGENTHYDRA_DATA_DIR = path.join(scratch, 'data')
mkdirSync(process.env.AGENTHYDRA_DATA_DIR, { recursive: true })
