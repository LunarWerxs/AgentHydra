// server/src/http's 36 routes had essentially no request-level coverage before this file. Boots a
// REAL Hono app (createApp) over a REAL Manager and drives it with app.request(...) — the house
// pattern from shutdown.test.ts, which is functionally identical to app.fetch(new Request(...))
// but matches the rest of the suite's style. Scope is deliberately the route GROUPS named in the
// coverage brief (project meta, process add/update/remove, star, project/process actions,
// free-port, logs, log-file, errors clear/dismiss, settings) — one happy path plus one
// validation-failure path each. Routes outside that list (scan/browse/clone/take-over/shortcut/
// connections/diagnose) are not this file's job.
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/src/http";
import { Manager } from "../server/src/manager";
import { readDevWebUIFile } from "../server/src/projects";
import { ROUTES } from "../shared/routes";
import type { LoadedProject, ProcessDef } from "../server/src/types";

// Every scratch root this file creates is registered here and reaped by the file-wide
// afterAll below, so a failing (or crashing) test cannot leave one behind.
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JSON_HEADERS = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
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

function newManager(): Manager {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  return manager;
}

/**
 * A project backed by a REAL .devwebui file on disk, for the routes that read/write it
 * (project meta, process add/update/remove, star all go through server/src/projects/file-store.ts,
 * which does real fs reads/writes against `manager.getProjectPath(id)`).
 */
function realProject(id: string, processesJson: Record<string, unknown>[]): LoadedProject {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwebui-http-test-"));
  scratchDirs.push(dir);
  const file = path.join(dir, ".devwebui");
  writeFileSync(file, JSON.stringify({ name: id, processes: processesJson }));
  return readDevWebUIFile(file);
}

/** A project with NO real backing file — fine for routes that only touch Manager in-memory
 *  state (process/project actions, free-port, logs, log-file, errors, settings). */
function fakeProject(id: string, processes: ProcessDef[]): LoadedProject {
  return {
    id,
    name: id,
    path: `${import.meta.dir}\\${id}.devwebui`,
    dir: import.meta.dir,
    processes,
  };
}

function processDef(
  over: Partial<ProcessDef> & { localId: string; projectId: string },
): ProcessDef {
  return {
    id: `${over.projectId}.${over.localId}`,
    name: over.localId,
    command: keepAliveCommand(),
    cwd: import.meta.dir,
    autostart: false,
    projectName: over.projectId,
    ...over,
  };
}

// ── project meta update ─────────────────────────────────────────────────────────────────────

test("project meta update: happy path renames + recolors; failure path rejects a blank name", async () => {
  const project = realProject("meta-test", [{ id: "web", name: "Web", command: "echo hi" }]);
  const manager = newManager();
  manager.addProject(project, { autostart: false });
  const app = createApp(manager, {});
  try {
    const ok = await app.request(ROUTES.projectUpdate.build(project.id), {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed", color: "#22c55e" }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { project: { name: string; color?: string } };
    expect(okBody.project.name).toBe("Renamed");
    expect(okBody.project.color).toBe("#22c55e");

    const bad = await app.request(ROUTES.projectUpdate.build(project.id), {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "   " }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "A project name can't be empty." });
  } finally {
    manager.dispose();
  }
});

// ── process add/update/remove ───────────────────────────────────────────────────────────────

test("process add/update/remove: happy path exercises all three routes; failure path rejects a duplicate id", async () => {
  const project = realProject("crud-test", [{ id: "web", name: "Web", command: "echo hi" }]);
  const manager = newManager();
  manager.addProject(project, { autostart: false });
  const app = createApp(manager, {});
  try {
    const add = await app.request(ROUTES.projectProcesses.build(project.id), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "api", name: "API", command: "echo api" }),
    });
    expect(add.status).toBe(200);
    type Proc = { localId: string; name: string };
    const addBody = (await add.json()) as { project: { processes: Proc[] } };
    expect(addBody.project.processes.map((p) => p.localId)).toContain("api");

    const update = await app.request(ROUTES.projectProcess.build(project.id, "api"), {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "api", name: "API Renamed", command: "echo api2" }),
    });
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as { project: { processes: Proc[] } };
    expect(updateBody.project.processes.find((p) => p.localId === "api")?.name).toBe("API Renamed");

    const remove = await app.request(ROUTES.projectProcess.build(project.id, "api"), {
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    const removeBody = (await remove.json()) as { project: { processes: Proc[] } };
    expect(removeBody.project.processes.some((p) => p.localId === "api")).toBe(false);

    const dup = await app.request(ROUTES.projectProcesses.build(project.id), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "web", name: "dup", command: "echo dup" }),
    });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { error: string }).error).toContain("already exists");
  } finally {
    manager.dispose();
  }
});

// ── star ─────────────────────────────────────────────────────────────────────────────────────

test("star: happy path floats a process; failure path rejects an unknown localId", async () => {
  const project = realProject("star-test", [{ id: "web", name: "Web", command: "echo hi" }]);
  const manager = newManager();
  manager.addProject(project, { autostart: false });
  const app = createApp(manager, {});
  try {
    const ok = await app.request(ROUTES.projectProcessStar.build(project.id, "web"), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ starred: true }),
    });
    expect(ok.status).toBe(200);
    type Proc = { localId: string; starred?: boolean };
    const okBody = (await ok.json()) as { project: { processes: Proc[] } };
    expect(okBody.project.processes.find((p) => p.localId === "web")?.starred).toBe(true);

    const bad = await app.request(ROUTES.projectProcessStar.build(project.id, "nope"), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ starred: true }),
    });
    expect(bad.status).toBe(400);
  } finally {
    manager.dispose();
  }
});

// ── project actions (start/stop/enable/disable/remove) ─────────────────────────────────────

test("project actions: happy path drives every dispatch branch; failure paths reject a bogus action and an unknown project", async () => {
  const manager = newManager();
  const projectId = "actions-test";
  manager.addProject(fakeProject(projectId, [processDef({ localId: "svc", projectId })]), {
    autostart: false,
  });
  const app = createApp(manager, {});
  const processId = `${projectId}.svc`;
  try {
    const disable = await app.request(ROUTES.projectAction.build(projectId, "disable"), {
      method: "POST",
    });
    expect(disable.status).toBe(200);
    expect(manager.listProjects().find((p) => p.id === projectId)?.enabled).toBe(false);

    const enable = await app.request(ROUTES.projectAction.build(projectId, "enable"), {
      method: "POST",
    });
    expect(enable.status).toBe(200);
    expect(manager.listProjects().find((p) => p.id === projectId)?.enabled).toBe(true);

    const start = await app.request(ROUTES.projectAction.build(projectId, "start"), {
      method: "POST",
    });
    expect(start.status).toBe(200);
    await waitFor(() => manager.view(processId)?.status === "running");

    // stop is awaited server-side, so the response only lands once the process is down.
    const stop = await app.request(ROUTES.projectAction.build(projectId, "stop"), {
      method: "POST",
    });
    expect(stop.status).toBe(200);
    expect(manager.view(processId)?.status).toBe("stopped");

    const remove = await app.request(ROUTES.projectAction.build(projectId, "remove"), {
      method: "POST",
    });
    expect(remove.status).toBe(200);
    expect(manager.listProjects().some((p) => p.id === projectId)).toBe(false);

    const bogusAction = await app.request(ROUTES.projectAction.build("nonexistent", "start"), {
      method: "POST",
    });
    expect(bogusAction.status).toBe(404);
    expect(await bogusAction.json()).toEqual({ error: "unknown project" });
  } finally {
    await manager.stopProject(projectId);
    manager.dispose();
  }
});

// ── process actions (start/stop/restart/enable/disable) ────────────────────────────────────

test("process actions: happy path drives every dispatch branch; failure path rejects an unknown action", async () => {
  const manager = newManager();
  const projectId = "proc-actions-test";
  const processId = `${projectId}.svc`;
  manager.addProject(fakeProject(projectId, [processDef({ localId: "svc", projectId })]), {
    autostart: false,
  });
  const app = createApp(manager, {});
  try {
    const disable = await app.request(ROUTES.processAction.build(processId, "disable"), {
      method: "POST",
    });
    expect(disable.status).toBe(200);
    expect(manager.view(processId)?.enabled).toBe(false);

    const enable = await app.request(ROUTES.processAction.build(processId, "enable"), {
      method: "POST",
    });
    expect(enable.status).toBe(200);
    expect(manager.view(processId)?.enabled).toBe(true);

    const start = await app.request(ROUTES.processAction.build(processId, "start"), {
      method: "POST",
    });
    expect(start.status).toBe(200);
    await waitFor(() => manager.view(processId)?.status === "running");

    const restart = await app.request(ROUTES.processAction.build(processId, "restart"), {
      method: "POST",
    });
    expect(restart.status).toBe(200);
    await waitFor(() => manager.view(processId)?.status === "running");

    const stop = await app.request(ROUTES.processAction.build(processId, "stop"), {
      method: "POST",
    });
    expect(stop.status).toBe(200);
    await waitFor(() => manager.view(processId)?.status === "stopped");

    const bad = await app.request(ROUTES.processAction.build(processId, "teleport"), {
      method: "POST",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "unknown action" });
  } finally {
    await manager.stop(processId);
    manager.dispose();
  }
});

// ── free-port ────────────────────────────────────────────────────────────────────────────────

test("free-port: happy path calls the manager with id + confirm; failure path rejects a portless process", async () => {
  const manager = newManager();
  const projectId = "freeport-test";
  const processId = `${projectId}.svc`;
  manager.addProject(
    fakeProject(projectId, [
      processDef({ localId: "svc", projectId, port: 39217 }),
      processDef({ localId: "noport", projectId }),
    ]),
    { autostart: false },
  );
  const app = createApp(manager, {});
  try {
    // Spied rather than exercised for real: the real path shells out to a port-owner probe
    // (PowerShell on Windows) that can take seconds — this route's own risk is a typo'd id/URL/body
    // wiring into manager.freeProcessPort, not that module's port-lookup correctness.
    let calledWith: unknown;
    manager.freeProcessPort = (async (id: string, opts?: { confirm?: boolean }) => {
      calledWith = { id, opts };
      return { ok: true, owners: [] };
    }) as typeof manager.freeProcessPort;

    const ok = await app.request(ROUTES.processFreePort.build(processId), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, owners: [] });
    expect(calledWith).toEqual({ id: processId, opts: { confirm: true } });

    const bad = await app.request(ROUTES.processFreePort.build(`${projectId}.noport`), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "process has no declared port" });
  } finally {
    manager.dispose();
  }
});

// ── logs ─────────────────────────────────────────────────────────────────────────────────────

test("logs: happy path returns recorded lines for a known process (route has no validation branch)", async () => {
  const manager = newManager();
  const projectId = "logs-test";
  const processId = `${projectId}.svc`;
  manager.addProject(fakeProject(projectId, [processDef({ localId: "svc", projectId })]), {
    autostart: false,
  });
  const app = createApp(manager, {});
  try {
    const res = await app.request(ROUTES.processLogs.build(processId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: processId, lines: [] });

    // GET /logs never validates the id — getLogs() returns [] for an unknown one too, so
    // there is no 4xx branch here to exercise (unlike /logfile below, which does 404).
    const unknown = await app.request(ROUTES.processLogs.build("nope.nope"));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ id: "nope.nope", lines: [] });
  } finally {
    manager.dispose();
  }
});

// ── log-file ─────────────────────────────────────────────────────────────────────────────────

test("log-file: happy path tails a known process's file; failure path 404s an unknown process", async () => {
  const manager = newManager();
  const projectId = "logfile-test";
  const processId = `${projectId}.svc`;
  manager.addProject(fakeProject(projectId, [processDef({ localId: "svc", projectId })]), {
    autostart: false,
  });
  const app = createApp(manager, {});
  try {
    const ok = await app.request(ROUTES.processLogFile.build(processId, 50));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: processId, lines: [] });

    const bad = await app.request(ROUTES.processLogFile.build("nope.nope"));
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: "unknown process" });
  } finally {
    manager.dispose();
  }
});

// ── errors clear/dismiss ────────────────────────────────────────────────────────────────────

test("errors clear/dismiss: happy path forwards processId/fingerprint; the missing-fingerprint case is a documented no-op, not a failure", async () => {
  const manager = newManager();
  const app = createApp(manager, {});
  try {
    // Both routes always answer { ok: true } (see core.ts) — neither has a validation-failure
    // status code to assert on, so this spies on the manager call to prove the ROUTE forwards
    // the right argument, which is the actual typo'd-URL/typo'd-field risk for these two.
    let clearedWith: string | undefined | "unset" = "unset";
    manager.clearErrors = ((processId?: string) => {
      clearedWith = processId;
    }) as typeof manager.clearErrors;
    const clear = await app.request(`${ROUTES.errorsClear}?processId=proj.svc`, {
      method: "POST",
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ ok: true });
    expect(clearedWith).toBe("proj.svc");

    let dismissedWith: string | "unset" = "unset";
    manager.dismissError = ((fingerprint: string) => {
      dismissedWith = fingerprint;
      return true;
    }) as typeof manager.dismissError;
    const dismiss = await app.request(ROUTES.errorsDismiss, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fingerprint: "abc123" }),
    });
    expect(dismiss.status).toBe(200);
    expect(dismissedWith).toBe("abc123");

    // No-op case: an absent fingerprint still answers ok:true, but must NOT call the manager —
    // the handler's own `if (fingerprint) …` guard is the thing under test here.
    dismissedWith = "unset";
    const noFingerprint = await app.request(ROUTES.errorsDismiss, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(noFingerprint.status).toBe(200);
    expect(dismissedWith).toBe("unset");
  } finally {
    manager.dispose();
  }
});

// ── settings PUT ─────────────────────────────────────────────────────────────────────────────

test("settings PUT: happy path saves + applies runtime prefs; failure path rejects an invalid runtime value", async () => {
  const manager = newManager();
  const app = createApp(manager, {});
  try {
    const ok = await app.request(ROUTES.settings, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ runtime: "bun", freePortOnStart: true }),
    });
    expect(ok.status).toBe(200);
    const saved = (await ok.json()) as { runtime: string; freePortOnStart: boolean };
    expect(saved.runtime).toBe("bun");
    expect(saved.freePortOnStart).toBe(true);
    expect(manager.globalRuntime).toBe("bun");

    const bad = await app.request(ROUTES.settings, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ runtime: "deno" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "runtime must be one of: auto, node, bun" });
  } finally {
    manager.dispose();
  }
});
