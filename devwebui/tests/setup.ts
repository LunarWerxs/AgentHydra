// Bun test preload (wired in bunfig.toml). Guarantees the suite's data dir is a throwaway temp
// dir so tests never read or write the REAL ~/.devwebui — state.json, the registry, logs,
// errors.ndjson, runtime.json, settings.json, connections.json all resolve through
// server/src/data-dir.ts's dataDir(), which honors the DEVWEBUI_HOME override set below.
//
// The override itself lives in ./isolate so a test can import the SAME guarantee directly:
// the bunfig preload is ONLY picked up when `bun test` runs from a dir where bunfig.toml is
// discoverable, so isolate.ts is imported first by every data-touching test as a CWD-proof
// backstop. This preload additionally cleans up the temp dir once the whole suite finishes.
import { rmSync } from "node:fs";
import { afterAll } from "bun:test";
import { createdHome } from "./isolate";

// Remove this run's throwaway data dir once every test has finished, so the `devwebui-test-*`
// dirs don't pile up in %TEMP% across runs. A global afterAll registered from the preload is
// the test-runner-native hook (Bun's `bun test` does NOT reliably emit Node's `process.exit`
// event, so an exit handler wouldn't fire). `createdHome` is null when DEVWEBUI_HOME was set
// by something else — in that case it isn't ours to delete.
afterAll(() => {
  if (!createdHome) return;
  try {
    rmSync(createdHome, { recursive: true, force: true });
  } catch {
    /* best-effort — the OS temp cleaner reclaims anything left behind */
  }
});
