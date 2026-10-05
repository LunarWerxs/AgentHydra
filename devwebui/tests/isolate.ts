// Import-time data-dir isolation — the CWD-proof half of the test isolation story.
//
// tests/setup.ts wires this in as a bunfig `preload`, which covers the common case:
// `bun test` launched from the repo root (where bunfig.toml is discovered). But bun
// resolves bunfig.toml RELATIVE TO THE CWD, so `bun test tests/foo.test.ts` launched
// from a PARENT or unrelated directory never loads the preload — and then any test that
// spins up a real Manager (or calls writeSettings/appendLog/…) persists logs, error
// records and settings into the LIVE ~/.devwebui. That leak flipped the real machine's
// settings and put a phantom "N errors" count in the GUI (see the fixture logs that piled
// up under ~/.devwebui/logs across days of runs before this existed).
//
// Importing this module FIRST in such a test guarantees DEVWEBUI_HOME points at a
// throwaway dir no matter how the runner was invoked: dataDir() reads the env lazily at
// write time (long after imports run), so setting it during this module's evaluation is
// always early enough. Idempotent + module-cached: it fires once per process, and defers
// to a DEVWEBUI_HOME the caller (or the preload) already set.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME_PREFIX = "devwebui-test-";

// Age past which a throwaway home cannot belong to a LIVE run: a full suite finishes in
// seconds and every test case times out in ≤10s, so an hour is ~120× the worst case. Sweeping
// by age (below) reclaims leftovers WITHOUT ever deleting a concurrent run's active dir —
// preserving the "never delete a sibling's dir" safety the preload's cleanup relies on. That
// matters here: this machine runs many test sessions at once.
const STALE_MS = 60 * 60 * 1000;

// Best-effort GC of homes left behind by earlier `bun test <path>` runs that skipped the bunfig
// preload — those have no afterAll (Bun fires neither a global afterAll from an imported module
// nor process 'exit'/'beforeExit' under the test runner, both verified), so nothing cleans up
// this run's own dir. Sweeping stale ones on the NEXT run keeps them from piling up. Never throws.
function sweepStaleHomes(): void {
  const tmp = os.tmpdir();
  const cutoff = Date.now() - STALE_MS;
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(HOME_PREFIX)) continue;
    const full = path.join(tmp, name);
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
    } catch {
      /* raced with another sweeper, or still in use — leave it for next time / the OS cleaner */
    }
  }
}

function ensureIsolatedHome(): string | null {
  if (process.env.DEVWEBUI_HOME?.trim()) return null; // already isolated (preload, or a prior import)
  const dir = mkdtempSync(path.join(os.tmpdir(), HOME_PREFIX));
  process.env.DEVWEBUI_HOME = dir;
  // Outcome-independent reap, keyed to PROCESS end rather than to a test file's end. The dir must
  // OUTLIVE every test file in the run, so a file-scoped afterAll here is unusable: imported by a
  // test file it fires BETWEEN files and deletes the dir the later ones still write into
  // (writeFileAtomic creates no parent dirs). An `exit` handler is tied to process end instead, and
  // is the reaper whenever this module is loaded as a plain module — `bun run <script>`, Node, or a
  // `bun test` launched from a dir where bunfig.toml (hence tests/setup.ts's reaping preload
  // afterAll) is never discovered. That preload reaps the same path via `createdHome`; hard kills
  // are still reclaimed by sweepStaleHomes() above.
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort — the OS temp cleaner reclaims anything left behind */
    }
  });
  return dir;
}

// The repo's one "is this a test run?" signal, alongside DEVWEBUI_HOME above — `bun test` doesn't
// set NODE_ENV itself, so this is the earliest point every data-touching test agrees it's isolated.
// server/src/github-updater.ts's install ping reads it to skip itself in exactly this situation:
// a test run is never a real install worth counting. `??=` so an explicit NODE_ENV (e.g. a caller
// deliberately testing production behavior) is never clobbered.
process.env.NODE_ENV ??= "test";

sweepStaleHomes();

/** The throwaway dir this module created, or null if DEVWEBUI_HOME was already set. setup.ts cleans it up. */
export const createdHome: string | null = ensureIsolatedHome();
