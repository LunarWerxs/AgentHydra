// ---------------------------------------------------------------------------
// Running-instance pointer — thin per-app adapter over the shared kit factory
// (`createInstancePointer`, synced in as `./instance-pointer.mjs`). The only local
// code is DevWebUI's ~/.devwebui config-dir resolution and its host. The daemon
// records the port it ACTUALLY bound in runtime.json so launchers and the
// /api/health probe can find it and enforce single-instance. Best-effort throughout.
// ---------------------------------------------------------------------------
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./data-dir";
import { createInstancePointer, type InstanceInfo } from "./instance-pointer.mjs";

export type { InstanceInfo };

const pointer = createInstancePointer({
  // dataDir() honors DEVWEBUI_HOME so tests (and side-by-side instances) don't touch the
  // real ~/.devwebui runtime pointer; see tests/setup.ts.
  configDir: dataDir(),
  // Makes findLiveInstance require `service: "devwebui"` on the health body, so a stale pointer
  // aimed at a port since recycled by a foreign server (a Vite dev server answers /api/health with
  // its SPA fallback) reads as "not running" instead of "already running".
  serviceName: "devwebui",
  host: "localhost",
});

export const instanceFilePath = pointer.instanceFilePath;
export const writeInstanceInfo = pointer.writeInstanceInfo;
export const updateInstanceInfo = pointer.updateInstanceInfo;
export const readInstanceInfo = pointer.readInstanceInfo;
export const clearInstanceInfo = pointer.clearInstanceInfo;
export const findLiveInstance = pointer.findLiveInstance;

// ---------------------------------------------------------------------------
// "Full shutdown requested" sentinel — a marker file the PowerShell tray host polls
// so a user "Shut Down" from the web menu (or `devwebui stop`) tears down the WHOLE
// app, notification-area icon included, not just the daemon. It lives beside
// runtime.json in the data dir. Written by the shutdown route ONLY for a UI-source
// request that lacks the tray's session token (i.e. NOT the tray's own Restart/Quit,
// which carry it). Cleared on daemon boot and by the tray at startup, so a stale one
// left by a hard-killed run never causes a spurious quit. Resolved lazily like
// dataDir(); best-effort throughout (a tray that misses it still has its own Quit).
// ---------------------------------------------------------------------------
export function shutdownRequestPath(): string {
  return path.join(dataDir(), "shutdown.request");
}
export function writeShutdownRequest(): void {
  try {
    writeFileSync(shutdownRequestPath(), JSON.stringify({ ts: Date.now() }), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}
export function clearShutdownRequest(): void {
  try {
    rmSync(shutdownRequestPath(), { force: true });
  } catch {
    /* best-effort */
  }
}
