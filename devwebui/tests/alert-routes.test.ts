// Request-level coverage for the alert-rules REST surface (server/src/http/alert-routes.ts),
// following the house pattern from http-routes.test.ts: boot a REAL Hono app over a REAL
// Manager and drive it with app.request(...). One happy path (create → list → update →
// delete) plus one validation-failure path per rule-mutating route.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import { createApp } from "../server/src/http";
import { Manager } from "../server/src/manager";
import { ROUTES } from "../shared/routes";
import type { AlertRule } from "../shared/dto";
import type { LoadedProject, ProcessDef } from "../server/src/types";

const JSON_HEADERS = { "content-type": "application/json" };

function newManager(): Manager {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  return manager;
}

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
    command: "echo hi",
    cwd: import.meta.dir,
    autostart: false,
    projectName: over.projectId,
    ...over,
  };
}

test("alert rules: happy path create/list/update/delete", async () => {
  const manager = newManager();
  manager.addProject(
    fakeProject("alert-test", [processDef({ localId: "web", projectId: "alert-test" })]),
    { autostart: false },
  );
  const app = createApp(manager, {});
  try {
    const create = await app.request(ROUTES.alertRules, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        processId: "alert-test.web",
        metric: "cpu",
        threshold: 80,
        forMs: 120_000,
      }),
    });
    expect(create.status).toBe(200);
    const rule = (await create.json()) as AlertRule;
    expect(rule.processId).toBe("alert-test.web");
    expect(rule.enabled).toBe(true);

    const list = await app.request(ROUTES.alertRules);
    expect(list.status).toBe(200);
    expect(((await list.json()) as AlertRule[]).map((r) => r.id)).toContain(rule.id);

    const update = await app.request(ROUTES.alertRule.build(rule.id), {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as AlertRule).enabled).toBe(false);

    const del = await app.request(ROUTES.alertRule.build(rule.id), { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const listAfter = (await (await app.request(ROUTES.alertRules)).json()) as AlertRule[];
    expect(listAfter.some((r) => r.id === rule.id)).toBe(false);
  } finally {
    manager.dispose();
  }
});

test("alert rules: create rejects an unknown process and an invalid metric", async () => {
  const manager = newManager();
  const app = createApp(manager, {});
  try {
    const unknownProcess = await app.request(ROUTES.alertRules, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ processId: "no.such.process", metric: "cpu", threshold: 80 }),
    });
    expect(unknownProcess.status).toBe(404);

    manager.addProject(
      fakeProject("bad-metric", [processDef({ localId: "web", projectId: "bad-metric" })]),
      { autostart: false },
    );
    const badMetric = await app.request(ROUTES.alertRules, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ processId: "bad-metric.web", metric: "disk", threshold: 80 }),
    });
    expect(badMetric.status).toBe(400);

    const missingThreshold = await app.request(ROUTES.alertRules, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ processId: "bad-metric.web", metric: "cpu" }),
    });
    expect(missingThreshold.status).toBe(400);
  } finally {
    manager.dispose();
  }
});

test("alert rules: update/delete on an unknown id is a documented 404, not a throw", async () => {
  const manager = newManager();
  const app = createApp(manager, {});
  try {
    const update = await app.request(ROUTES.alertRule.build("nope"), {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(update.status).toBe(404);

    const del = await app.request(ROUTES.alertRule.build("nope"), { method: "DELETE" });
    expect(del.status).toBe(404);
  } finally {
    manager.dispose();
  }
});

test("alert events: list starts empty and clear is a documented no-op when already empty", async () => {
  const manager = newManager();
  const app = createApp(manager, {});
  try {
    const list = await app.request(ROUTES.alertEvents);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);

    const clear = await app.request(ROUTES.alertEventsClear, { method: "POST" });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ ok: true });
  } finally {
    manager.dispose();
  }
});
