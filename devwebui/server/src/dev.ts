// ---------------------------------------------------------------------------
// Dev launcher. Picks the daemon's port ONCE up front (preferring the default,
// stepping past it if busy) and exports DEVWEBUI_PORT before starting both the
// daemon and Vite — so the Vite proxy (which reads DEVWEBUI_PORT) always targets
// wherever the daemon actually landed, even when the default port is taken.
//
// Replaces the previous inline `concurrently` npm script; the watcher + Vite are
// still run via `concurrently` underneath for the same labelled, colored output.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { daemonPort } from "./constants";
import { findFreePort } from "./ports";
import { findLiveInstance } from "./instance";

// One instance at a time: if a DevWebUI is already running (e.g. the tray app, or
// another `bun run dev`), refuse rather than spinning up a second daemon that would
// fight over the runtime pointer. Stop the other one first.
const running = await findLiveInstance();
if (running) {
  console.log(
    `\n[devwebui] already running → ${running.url}\n[devwebui] stop it before running dev (one instance at a time).\n`,
  );
  process.exit(0);
}

const desired = daemonPort();
const port = await findFreePort(desired);
process.env.DEVWEBUI_PORT = String(port);
// Pin it: the daemon binds exactly this (already-free) port instead of probing
// again — a second probe could land somewhere else and desync the Vite proxy,
// which froze its target at startup. See server/src/index.ts.
process.env.DEVWEBUI_PORT_FIXED = "1";
if (port !== desired)
  console.log(`[devwebui] port ${desired} busy → daemon + Vite proxy will use ${port}`);

// Use process.execPath (the real bun binary) rather than "bun", which on Windows may
// be a .cmd shim that CreateProcess can't spawn directly. `bun x concurrently` runs
// the two commands; no shell:true, so each array element stays one argv and
// concurrently receives the commands intact, running each in its own shell (`cd web && …`).
const child = spawn(
  process.execPath,
  [
    "x",
    "concurrently",
    "-k",
    "-n",
    "daemon,web",
    "-c",
    "blue,magenta",
    "bun --watch server/src/index.ts",
    "cd web && bunx vite",
  ],
  { stdio: "inherit", env: process.env },
);
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(`[devwebui] failed to start dev processes: ${err.message}`);
  process.exit(1);
});
