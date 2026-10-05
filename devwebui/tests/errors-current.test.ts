// ───────────────────────────────────────────────────────────────────────────────
// "Only CURRENT errors" contract. The error log is persisted to disk (errors.ndjson)
// so it survives a daemon restart for post-mortem diagnosis — but a record from a
// PREVIOUS session (or a process's PREVIOUS run) must NEVER resurface as a live alert
// on launch. Regression for: opening DevWebUI and being greeted by a days-old error.
//   - unit: the pure isErrorActive() predicate, all four quadrants.
//   - integration: a stale record seeded on disk is hidden after the daemon boots and
//     loads it, while a freshly-recorded error from THIS session still surfaces.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { dataDir } from "../server/src/data-dir";
import { isErrorActive, type ErrorEvent } from "../server/src/errors";
import { Manager } from "../server/src/manager";
import type { LoadedProject, ProcessDef } from "../server/src/types";

// ---- unit: isErrorActive ---------------------------------------------------
const BOOT = 1_000_000;
function evt(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    fingerprint: "fp",
    processId: "p.web",
    localId: "web",
    processName: "Web",
    projectId: "p",
    projectName: "P",
    source: "stderr",
    sample: "boom",
    count: 1,
    firstSeen: 0,
    lastSeen: BOOT,
    ...over,
  };
}

test.each([
  ["a record from a previous session (lastSeen < bootedAt) is not current", BOOT - 1, null, false],
  // process stopped/crashed now (runStartedAt null) → a crash it just logged still counts.
  ["a this-session record is current when no run post-dates it", BOOT + 5, null, true],
  [
    "an error predating the process's current run is stale (restart clears it)",
    BOOT + 5,
    BOOT + 10,
    false,
  ],
  ["an error from within the current run is current", BOOT + 15, BOOT + 10, true],
])("isErrorActive: %s", (_name, lastSeen, runStartedAt, active) => {
  expect(isErrorActive(evt({ lastSeen }), BOOT, runStartedAt)).toBe(active);
});

// ---- integration: real Manager load path -----------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}
function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
const keepAlive = () => `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 1000)")}`;
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}
function project(processes: ProcessDef[]): LoadedProject {
  return {
    id: "cur-test",
    name: "CurTest",
    path: `${import.meta.dir}\\.devwebui`,
    dir: import.meta.dir,
    processes,
  };
}

test("a stale persisted error is hidden on boot, but a fresh error this session surfaces", async () => {
  // Seed errors.ndjson with a record from days ago, BEFORE the daemon (Manager) boots —
  // exactly the on-disk state that used to greet the user with a phantom error on launch.
  mkdirSync(dataDir(), { recursive: true });
  const stale: ErrorEvent = evt({
    fingerprint: "stale.proc|stderr|old boom",
    processId: "stale.proc",
    localId: "proc",
    processName: "Old",
    projectId: "stale",
    projectName: "Stale",
    firstSeen: Date.now() - 3 * 24 * 3600 * 1000,
    lastSeen: Date.now() - 3 * 24 * 3600 * 1000, // ~3 days ago → previous session
  });
  writeFileSync(path.join(dataDir(), "errors.ndjson"), `${JSON.stringify(stale)}\n`);

  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  manager.waitForPortTimeoutMs = 200;
  manager.waitForPortPollMs = 40;

  try {
    // The recorder loaded the stale record, but nothing current has happened yet.
    expect(manager.listErrors()).toHaveLength(0);

    // Now produce a genuinely-current error: a process that gives up waiting for a port
    // it will never see, logging to stderr → recorded THIS session.
    const port = await freePort();
    manager.addProject(
      project([
        {
          id: "cur-test.web",
          localId: "web",
          name: "web",
          command: keepAlive(),
          cwd: import.meta.dir,
          autostart: true,
          projectId: "cur-test",
          projectName: "CurTest",
          waitForPort: port,
        },
      ]),
      { autostart: false },
    );
    manager.start("cur-test.web");
    await waitFor(() => manager.view("cur-test.web")?.status === "stopped", 3000);

    const surfaced = manager.listErrors();
    // The fresh give-up error is shown; the 3-day-old seeded record is NOT.
    expect(surfaced.some((e) => e.processId === "cur-test.web")).toBe(true);
    expect(surfaced.some((e) => e.processId === "stale.proc")).toBe(false);
  } finally {
    await manager.stopProject("cur-test");
    manager.dispose();
  }
}, 10000);
