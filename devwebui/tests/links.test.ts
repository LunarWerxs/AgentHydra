// ───────────────────────────────────────────────────────────────────────────────
// Linked servers: a process may declare `links` (sibling localIds, same project)
// and/or `companion: true`. A linked group acts as ONE unit: `startWithLinks(id)`
// (the GUI/MCP start action) starts the anchor immediately, then batch-starts the
// anchor's transitive UNDIRECTED link closure plus every companion in the project;
// `stopWithLinks(id)` (the GUI/MCP stop action) stops the closure but leaves
// companions running. The plain start/stop/restart primitives and autostart never
// pull in or push out linked siblings. See server/src/manager/links.ts and
// server/src/manager/lifecycle.ts for the authoritative semantics, and
// server/src/projects/file-store.ts for how `links` are kept consistent on disk
// (de-duped, self-refs dropped, pruned on removal, rewritten on rename).
// Manager cases use real spawned keep-alive processes, following
// manager.test.ts / wait-for-port-manager.test.ts's idiom. File-store cases hit
// the on-disk .devwebui file directly, no processes spawned.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Manager } from "../server/src/manager";
import {
  addProcessToFile,
  removeProcessFromFile,
  updateProcessInFile,
} from "../server/src/projects/file-store";
import type { LoadedProject, ProcessDef } from "../server/src/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const keepAliveCommand = () =>
  `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 1000)")}`;

function processDef(
  over: Partial<ProcessDef> & { localId: string; projectId?: string },
): ProcessDef {
  const projectId = over.projectId ?? "links-test";
  return {
    id: `${projectId}.${over.localId}`,
    name: over.localId,
    command: keepAliveCommand(),
    cwd: import.meta.dir,
    autostart: true,
    projectId,
    projectName: projectId,
    ...over,
  };
}

function project(id: string, processes: ProcessDef[]): LoadedProject {
  return {
    id,
    name: id,
    path: `${import.meta.dir}\\${id}.devwebui`,
    dir: import.meta.dir,
    processes,
  };
}

function newManager(): Manager {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  return manager;
}

test("startWithLinks: starting A with links:['b'] also starts B", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
      ]),
      { autostart: false },
    );

    const res = manager.startWithLinks("links-test.a");
    expect(res.coStarted).toEqual(["links-test.b"]);
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.b")?.status === "running");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("startWithLinks: links are symmetric — link declared only on A, starting B still starts A", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.b");
    await waitFor(() => manager.view("links-test.b")?.status === "running");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    // The link is declared on A only; starting B must still have brought A up.
    expect(manager.view("links-test.a")?.status).toBe("running");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("startWithLinks: transitivity across mixed directions — A links B, C links B; starting A starts B and C", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
        processDef({ localId: "c", links: ["b"] }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.b")?.status === "running");
    await waitFor(() => manager.view("links-test.c")?.status === "running");
    // A reaches C only through B, and C declares its link with the opposite direction.
    expect(manager.view("links-test.b")?.status).toBe("running");
    expect(manager.view("links-test.c")?.status).toBe("running");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("startWithLinks: a mutual link cycle (A<->B) starts both, no hang, no error", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b", links: ["a"] }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.b")?.status === "running");

    const errors = manager.listErrors().filter((e) => e.processId.startsWith("links-test."));
    expect(errors.length).toBe(0);
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("startWithLinks: a companion rides along, scoped to its own project only", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a" }),
        processDef({ localId: "c", companion: true }),
      ]),
      { autostart: false },
    );
    manager.addProject(
      project("other-test", [
        processDef({ localId: "x", projectId: "other-test" }),
        processDef({ localId: "y", projectId: "other-test", companion: true }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.c")?.status === "running");

    // The other project's companion must NOT have been swept in.
    await sleep(150);
    expect(manager.view("other-test.x")?.status).toBe("stopped");
    expect(manager.view("other-test.y")?.status).toBe("stopped");
  } finally {
    await manager.stopProject("links-test");
    await manager.stopProject("other-test");
    manager.dispose();
  }
}, 10000);

test("restart(A) after stopping linked B leaves B stopped", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.b")?.status === "running");

    await manager.stop("links-test.b");
    await waitFor(() => manager.view("links-test.b")?.status === "stopped");

    await manager.restart("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");

    await sleep(150);
    expect(manager.view("links-test.b")?.status).toBe("stopped");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("plain stop(A) does NOT propagate — a running linked B stays running", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.b")?.status === "running");

    await manager.stop("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "stopped");

    await sleep(150);
    expect(manager.view("links-test.b")?.status).toBe("running");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("stopWithLinks: stopping either side of a link brings the whole group down", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        // Link declared only on a; stopping b must still stop a (symmetric).
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.b")?.status === "running");

    const coStopped = await manager.stopWithLinks("links-test.b");
    expect(coStopped).toEqual(["links-test.a"]);
    await waitFor(() => manager.view("links-test.b")?.status === "stopped");
    await waitFor(() => manager.view("links-test.a")?.status === "stopped");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("ripple reporting: coStarted excludes already-running members; coStopped excludes stopped ones", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
      ]),
      { autostart: false },
    );

    // b already running -> starting a reports no ripple.
    manager.start("links-test.b");
    await waitFor(() => manager.view("links-test.b")?.status === "running");
    const res = manager.startWithLinks("links-test.a");
    expect(res.coStarted).toEqual([]);
    await waitFor(() => manager.view("links-test.a")?.status === "running");

    // Both running -> stopping a reports b as brought down with it.
    const coStopped = await manager.stopWithLinks("links-test.a");
    expect(coStopped).toEqual(["links-test.b"]);

    // Everything stopped -> stopping again reports no ripple.
    const again = await manager.stopWithLinks("links-test.a");
    expect(again).toEqual([]);
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("stopWithLinks: companions keep running — they join starts only", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
        processDef({ localId: "db", companion: true }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.b")?.status === "running");
    await waitFor(() => manager.view("links-test.db")?.status === "running");

    await manager.stopWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "stopped");
    await waitFor(() => manager.view("links-test.b")?.status === "stopped");

    await sleep(150);
    expect(manager.view("links-test.db")?.status).toBe("running");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("stopWithLinks: unknown id resolves without throwing and stops nothing", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");

    await manager.stopWithLinks("links-test.nope");
    await sleep(100);
    expect(manager.view("links-test.a")?.status).toBe("running");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("startWithLinks: an unknown link target is ignored — the anchor still starts, no throw", async () => {
  const manager = newManager();
  try {
    manager.addProject(project("links-test", [processDef({ localId: "a", links: ["nope"] })]), {
      autostart: false,
    });

    expect(() => manager.startWithLinks("links-test.a")).not.toThrow();
    await waitFor(() => manager.view("links-test.a")?.status === "running");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("startWithLinks: an unknown id reports nothing and starts nothing", async () => {
  const manager = newManager();
  try {
    manager.addProject(project("links-test", [processDef({ localId: "a" })]), {
      autostart: false,
    });

    const result = manager.startWithLinks("links-test.unknown");
    expect(result.coStarted).toEqual([]);

    await sleep(150);
    expect(manager.view("links-test.a")?.status).toBe("stopped");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
});

test("plain start(A) does NOT propagate to linked B", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
      ]),
      { autostart: false },
    );

    manager.start("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");

    await sleep(150);
    expect(manager.view("links-test.b")?.status).toBe("stopped");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

test("startWithLinks: a waitForPort cycle between companions doesn't block the anchor's linked group", async () => {
  const manager = newManager();
  try {
    manager.addProject(
      project("links-test", [
        processDef({ localId: "a", links: ["b"] }),
        processDef({ localId: "b" }),
        // Unrelated companion pair whose waitForPort declarations form a cycle —
        // they must be stripped from the co-start batch, not sink it wholesale.
        processDef({ localId: "comp1", companion: true, waitForPort: "comp2", port: 34851 }),
        processDef({ localId: "comp2", companion: true, waitForPort: "comp1", port: 34852 }),
      ]),
      { autostart: false },
    );

    manager.startWithLinks("links-test.a");
    await waitFor(() => manager.view("links-test.a")?.status === "running");
    await waitFor(() => manager.view("links-test.b")?.status === "running");
    // The cycle members are logged and skipped, never started.
    expect(manager.view("links-test.comp1")?.status).toBe("stopped");
    expect(manager.view("links-test.comp2")?.status).toBe("stopped");
  } finally {
    await manager.stopProject("links-test");
    manager.dispose();
  }
}, 10000);

// ── file store: links are kept consistent on disk, no processes spawned ──────

// Every scratch root this file creates is registered here and reaped by the file-wide
// afterAll below, so a failing (or crashing) test cannot leave one behind.
const scratchDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDevWebUIFile(): string {
  const dir = tempDir("devwebui-links-test-");
  const file = path.join(dir, ".devwebui");
  writeFileSync(
    file,
    JSON.stringify({
      name: "FileStoreLinksTest",
      processes: [{ id: "a", name: "a", command: "echo a" }],
    }),
  );
  return file;
}

function readProcesses(file: string): Array<{ id: string; links?: string[] }> {
  return JSON.parse(readFileSync(file, "utf8")).processes;
}

test("clean(): duplicate + self links are de-duped and self-refs dropped", () => {
  const file = makeTempDevWebUIFile();

  addProcessToFile(file, {
    id: "b",
    name: "b",
    command: "echo b",
    links: ["a", "a", "b", "a"],
  });

  const processes = readProcesses(file);
  const b = processes.find((p) => p.id === "b");
  expect(b?.links).toEqual(["a"]);
});

test("removeProcessFromFile prunes the removed id from sibling links and drops emptied keys", () => {
  const file = makeTempDevWebUIFile();

  addProcessToFile(file, { id: "b", name: "b", command: "echo b", links: ["a"] });
  addProcessToFile(file, { id: "c", name: "c", command: "echo c", links: ["a", "b"] });

  removeProcessFromFile(file, "a");

  const processes = readProcesses(file);
  const b = processes.find((p) => p.id === "b");
  const c = processes.find((p) => p.id === "c");
  expect(b?.links).toBeUndefined();
  expect(c?.links).toEqual(["b"]);
});

test("updateProcessInFile renaming a process id rewrites sibling links to the new id", () => {
  const file = makeTempDevWebUIFile();

  addProcessToFile(file, { id: "b", name: "b", command: "echo b", links: ["a"] });

  updateProcessInFile(file, "a", { id: "a-renamed", name: "a", command: "echo a" });

  const processes = readProcesses(file);
  const b = processes.find((p) => p.id === "b");
  expect(b?.links).toEqual(["a-renamed"]);
  expect(processes.some((p) => p.id === "a-renamed")).toBe(true);
});
