// ───────────────────────────────────────────────────────────────────────────────
// Time-Travel Log Vault, end-to-end through the real Manager: a crashing process's
// stderr lands in the on-disk rotating log file and survives the crash, readable via
// getLogFileTail() (the GET .../logfile route's backing method). Crash HISTORY is
// deliberately not persisted anywhere else — a crash is reported once, into the
// errors panel, and never replayed on a later start. Real child processes (bun -e),
// following manager.test.ts's idiom, so the daemon's actual spawn/exit/log pipeline
// is exercised.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Manager } from "../server/src/manager";
import { logVaultDir } from "../server/src/log-vault";
import type { LoadedProject, ProcessDef } from "../server/src/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** A process that writes to stderr then exits with the given code. */
function crashingCommand(stderrText: string, exitCode: number): string {
  const script = `process.stderr.write(${JSON.stringify(stderrText)}); process.exitCode = ${exitCode};`;
  return `${quote(process.execPath)} -e ${quote(script)}`;
}

/** A process that exits 0 immediately (a "clean" run). */
function cleanExitCommand(): string {
  return `${quote(process.execPath)} -e ${quote("process.exitCode = 0;")}`;
}

function processDef(id: string, command: string): ProcessDef {
  return {
    id: `logvault-mgr-test.${id}`,
    localId: id,
    name: id,
    command,
    cwd: import.meta.dir,
    autostart: false,
    projectId: "logvault-mgr-test",
    projectName: "LogVaultMgrTest",
  };
}

function project(processes: ProcessDef[]): LoadedProject {
  return {
    id: "logvault-mgr-test",
    name: "LogVaultMgrTest",
    path: `${import.meta.dir}\\.devwebui`,
    dir: import.meta.dir,
    processes,
  };
}

const idsToClean = new Set<string>();

function cleanupVaultFiles(id: string) {
  const dir = logVaultDir();
  for (const suffix of ["", ".1", ".2", ".3"]) {
    const f = path.join(dir, `${id}.log${suffix}`);
    if (existsSync(f)) rmSync(f, { force: true });
  }
}

afterEach(() => {
  for (const id of idsToClean) cleanupVaultFiles(id);
  idsToClean.clear();
});

async function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}

test("a crashed process's stderr survives the crash in the on-disk log file", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const localId = `crash-${Date.now()}`;
  const globalId = `logvault-mgr-test.${localId}`;
  idsToClean.add(globalId);

  try {
    manager.addProject(
      project([processDef(localId, crashingCommand("boom: ECONNREFUSED 127.0.0.1:5432\n", 1))]),
      {
        autostart: false,
      },
    );

    manager.start(globalId);

    await waitFor(() => manager.view(globalId)?.status === "crashed");

    // Give the debounced log-vault append a moment (addLog appends synchronously,
    // but be generous under CI scheduling).
    await sleep(50);

    const tail = manager.getLogFileTail(globalId, 50);
    expect(tail.some((l) => l.includes("ECONNREFUSED"))).toBe(true);
  } finally {
    await manager.stopProject("logvault-mgr-test");
    manager.dispose();
  }
}, 10000);

test("a crash leaves nothing behind to replay on the next start", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const localId = `clean-${Date.now()}`;
  const globalId = `logvault-mgr-test.${localId}`;
  idsToClean.add(globalId);

  try {
    manager.addProject(project([processDef(localId, crashingCommand("first run dies\n", 1))]), {
      autostart: false,
    });
    manager.start(globalId);
    await waitFor(() => manager.view(globalId)?.status === "crashed");

    // No crash sidecar is written — the log vault holds log files only.
    const strays = readdirSync(logVaultDir()).filter(
      (f) => f.startsWith(globalId) && !/\.log(\.\d+)?$/.test(f),
    );
    expect(strays).toEqual([]);

    // Swapping in a clean command and starting again is an ordinary start: the
    // previous crash is not resurfaced in any form.
    manager.reconcileProject(project([processDef(localId, cleanExitCommand())]));
    manager.start(globalId);
    await waitFor(() => manager.view(globalId)?.status === "stopped");
  } finally {
    await manager.stopProject("logvault-mgr-test");
    manager.dispose();
  }
}, 10000);

test("getLogFileTail returns [] for an unknown process id", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  try {
    expect(manager.getLogFileTail("no-such-process", 50)).toEqual([]);
  } finally {
    manager.dispose();
  }
}, 5000);
