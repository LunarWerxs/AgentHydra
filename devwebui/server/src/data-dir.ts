// ---------------------------------------------------------------------------
// The ONE place that resolves DevWebUI's data directory (~/.devwebui).
// DEVWEBUI_HOME overrides it so tests (and side-by-side instances) never touch
// the real user's state/registry/logs/errors — see tests/setup.ts. Resolved
// lazily on every call so the override can be set after a module is imported.
// ---------------------------------------------------------------------------
import os from "node:os";
import path from "node:path";

export function dataDir(): string {
  return process.env.DEVWEBUI_HOME?.trim() || path.join(os.homedir(), ".devwebui");
}
