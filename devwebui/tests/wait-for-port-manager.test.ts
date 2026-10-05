// ───────────────────────────────────────────────────────────────────────────────
// Build dependency-ordered startup (S), through the real Manager: a process that
// declares `waitForPort` (a literal port, or a sibling's id) sits in "waiting"
// until that port is listening, THEN spawns. `startMany`/`startProject` resolve
// ordering up front so a dependency is queued before its dependent. A cycle among
// `waitForPort` declarations is detected and logged instead of deadlocking. Uses
// real spawned processes (bun -e), following manager.test.ts's idiom.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { expect, test } from "bun:test";
import net from "node:net";
import { Manager } from "../server/src/manager";
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

/** A process that opens a TCP listener on `port` after `delayMs`, then idles. */
function listenAfterDelayCommand(port: number, delayMs: number): string {
  const script =
    `setTimeout(() => { require("net").createServer().listen(${port}); }, ${delayMs}); ` +
    `setInterval(() => {}, 1000);`;
  return `${quote(process.execPath)} -e ${quote(script)}`;
}

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, () => resolve(srv));
  });
}
function close(srv: net.Server): Promise<void> {
  return new Promise((r) => srv.close(() => r()));
}
function freePort(): Promise<number> {
  return listenOn(0).then(async (srv) => {
    const port = (srv.address() as net.AddressInfo).port;
    await close(srv);
    return port;
  });
}

function processDef(over: Partial<ProcessDef> & { localId: string; command: string }): ProcessDef {
  return {
    id: `waitfor-test.${over.localId}`,
    name: over.localId,
    cwd: import.meta.dir,
    autostart: true,
    projectId: "waitfor-test",
    projectName: "WaitForTest",
    ...over,
  };
}

function project(processes: ProcessDef[]): LoadedProject {
  return {
    id: "waitfor-test",
    name: "WaitForTest",
    path: `${import.meta.dir}\\.devwebui`,
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

test("a process with waitForPort sits in 'waiting' then spawns once the port opens", async () => {
  const manager = newManager();
  manager.waitForPortTimeoutMs = 5000;
  manager.waitForPortPollMs = 50;
  const port = await freePort();

  try {
    manager.addProject(
      project([processDef({ localId: "web", command: keepAliveCommand(), waitForPort: port })]),
      { autostart: false },
    );

    manager.start("waitfor-test.web");
    await waitFor(() => manager.view("waitfor-test.web")?.status === "waiting");
    expect(manager.view("waitfor-test.web")?.waitingOnPort).toBe(port);

    // Nothing is listening yet — still waiting a bit later.
    await sleep(150);
    expect(manager.view("waitfor-test.web")?.status).toBe("waiting");

    const dep = await listenOn(port);
    try {
      await waitFor(() => manager.view("waitfor-test.web")?.status === "running", 5000);
      expect(manager.view("waitfor-test.web")?.waitingOnPort).toBeUndefined();
    } finally {
      await close(dep);
    }
  } finally {
    await manager.stopProject("waitfor-test");
    manager.dispose();
  }
}, 10000);

test("waitForPort as a sibling id resolves to that sibling's declared port", async () => {
  const manager = newManager();
  manager.waitForPortTimeoutMs = 5000;
  manager.waitForPortPollMs = 50;
  const port = await freePort();

  try {
    manager.addProject(
      project([
        processDef({ localId: "backend", command: listenAfterDelayCommand(port, 300), port }),
        processDef({ localId: "web", command: keepAliveCommand(), waitForPort: "backend" }),
      ]),
      { autostart: false },
    );

    manager.start("waitfor-test.backend");
    manager.start("waitfor-test.web");
    await waitFor(() => manager.view("waitfor-test.web")?.status === "waiting");
    expect(manager.view("waitfor-test.web")?.waitingOnPort).toBe(port);

    await waitFor(() => manager.view("waitfor-test.web")?.status === "running", 5000);
    await waitFor(() => manager.view("waitfor-test.backend")?.status === "running", 5000);
  } finally {
    await manager.stopProject("waitfor-test");
    manager.dispose();
  }
}, 10000);

test("waitForPort gives up after the timeout and logs an error instead of spawning", async () => {
  const manager = newManager();
  manager.waitForPortTimeoutMs = 200;
  manager.waitForPortPollMs = 40;
  const port = await freePort(); // guaranteed nothing is listening on it

  try {
    manager.addProject(
      project([processDef({ localId: "web", command: keepAliveCommand(), waitForPort: port })]),
      { autostart: false },
    );

    manager.start("waitfor-test.web");
    await waitFor(() => manager.view("waitfor-test.web")?.status === "waiting");
    await waitFor(() => manager.view("waitfor-test.web")?.status === "stopped", 3000);

    expect(manager.view("waitfor-test.web")?.pid).toBeNull();
    const errors = manager.listErrors().filter((e) => e.processId === "waitfor-test.web");
    expect(errors.some((e) => /gave up waiting for port/.test(e.sample))).toBe(true);
  } finally {
    await manager.stopProject("waitfor-test");
    manager.dispose();
  }
}, 10000);

test("startProject resolves dependency order: a waitForPort target starts before its dependent", async () => {
  const manager = newManager();
  const port = await freePort();

  try {
    // Deliberately registered dependent-first — order resolution must fix it up.
    manager.addProject(
      project([
        processDef({ localId: "web", command: keepAliveCommand(), waitForPort: "backend" }),
        processDef({ localId: "backend", command: keepAliveCommand(), port }),
      ]),
      { autostart: false },
    );

    manager.startProject("waitfor-test");
    // "backend" (no dependency) should be running (or at least started) well before
    // "web" is still stuck waiting on backend's (never-opened) port — proving
    // "backend" was queued FIRST rather than after "web" in raw input order.
    await waitFor(() => manager.view("waitfor-test.backend")?.status === "running", 3000);
    expect(manager.view("waitfor-test.web")?.status).not.toBe("running");
  } finally {
    await manager.stopProject("waitfor-test");
    manager.dispose();
  }
}, 10000);

test("a waitForPort cycle is detected and logged; nothing in the cycle is started", async () => {
  const manager = newManager();

  try {
    manager.addProject(
      project([
        processDef({ localId: "a", command: keepAliveCommand(), port: 1, waitForPort: "b" }),
        processDef({ localId: "b", command: keepAliveCommand(), port: 2, waitForPort: "a" }),
      ]),
      { autostart: false },
    );

    manager.startProject("waitfor-test");
    await sleep(200);
    expect(manager.view("waitfor-test.a")?.status).toBe("stopped");
    expect(manager.view("waitfor-test.b")?.status).toBe("stopped");

    const errors = manager.listErrors().filter((e) => e.processId.startsWith("waitfor-test."));
    expect(errors.some((e) => /[Dd]ependency cycle/.test(e.sample))).toBe(true);
  } finally {
    await manager.stopProject("waitfor-test");
    manager.dispose();
  }
}, 10000);
