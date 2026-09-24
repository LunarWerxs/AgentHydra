import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private state dir per test run: the signing key, config.json and tray.json land here,
// never in the repo's real state/. A discard-port daemon URL makes any accidental fleet call fail fast.
const orchestratorStateDir = mkdtempSync(join(tmpdir(), 'orch-remote-test-'))
process.env.ORCHESTRATOR_STATE_DIR = orchestratorStateDir
process.env.AGENTHYDRA_URL = 'http://127.0.0.1:9'
process.env.ORCH_NO_TUNNEL = '1'

// Outcome-independent reap: setup.ts is a preload that runs once per whole `bun test` process, not
// a per-file fixture, so process exit is the only hook that always fires.
process.on('exit', () => {
  rmSync(orchestratorStateDir, { recursive: true, force: true })
})
