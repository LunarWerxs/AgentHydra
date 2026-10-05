// ───────────────────────────────────────────────────────────────────────────────
// Build dependency-ordered startup (S): unit tests for the pure resolver/sorter in
// wait-for-port.ts — resolving a `waitForPort` declaration (literal port, or a
// sibling process id) to a concrete port number, and topologically ordering a
// start batch so dependencies are queued before their dependents. Manager-level
// integration (the actual polling/spawning) is covered in wait-for-port-manager.test.ts.
// ───────────────────────────────────────────────────────────────────────────────
import { expect, test } from "bun:test";
import type { ProcessDef } from "../server/src/types";
import {
  DependencyCycleError,
  orderByDependency,
  resolveWaitPort,
} from "../server/src/manager/wait-for-port";

function def(over: Partial<ProcessDef> & { localId: string }): ProcessDef {
  const projectId = over.projectId ?? "proj";
  return {
    name: over.localId,
    command: "noop",
    cwd: ".",
    projectName: "Proj",
    ...over,
    projectId,
    id: `${projectId}.${over.localId}`,
  };
}

function byId(defs: ProcessDef[]): Map<string, ProcessDef> {
  return new Map(defs.map((d) => [d.id, d]));
}

test("resolveWaitPort: a numeric waitForPort resolves to itself", () => {
  const d = def({ localId: "web", waitForPort: 5432 });
  expect(resolveWaitPort(d, byId([d]))).toBe(5432);
});

test("resolveWaitPort: a string waitForPort resolves to the sibling's declared port", () => {
  const backend = def({ localId: "backend", port: 8080 });
  const web = def({ localId: "web", waitForPort: "backend" });
  expect(resolveWaitPort(web, byId([backend, web]))).toBe(8080);
});

test("resolveWaitPort: a string reference is scoped to the SAME project", () => {
  const otherProjectBackend = def({ localId: "backend", projectId: "other", port: 9999 });
  const web = def({ localId: "web", waitForPort: "backend" }); // project "proj", not "other"
  expect(resolveWaitPort(web, byId([otherProjectBackend, web]))).toBeNull();
});

test("resolveWaitPort: an unresolvable sibling (no port, or unknown id) returns null", () => {
  const backendNoPort = def({ localId: "backend" }); // no port declared
  const web = def({ localId: "web", waitForPort: "backend" });
  expect(resolveWaitPort(web, byId([backendNoPort, web]))).toBeNull();

  const web2 = def({ localId: "web2", waitForPort: "ghost" });
  expect(resolveWaitPort(web2, byId([web2]))).toBeNull();
});

test("resolveWaitPort: no waitForPort declared returns null", () => {
  const d = def({ localId: "web" });
  expect(resolveWaitPort(d, byId([d]))).toBeNull();
});

test("orderByDependency: a dependent is ordered after its in-batch dependency", () => {
  const backend = def({ localId: "backend", port: 8080 });
  const web = def({ localId: "web", waitForPort: "backend" });
  // Deliberately fed in "wrong" order — the dependent listed first.
  const ordered = orderByDependency([web.id, backend.id], byId([backend, web]));
  expect(ordered).toEqual([backend.id, web.id]);
});

test("orderByDependency: independent processes keep their input order", () => {
  const a = def({ localId: "a" });
  const b = def({ localId: "b" });
  const c = def({ localId: "c" });
  const ordered = orderByDependency([c.id, a.id, b.id], byId([a, b, c]));
  expect(ordered).toEqual([c.id, a.id, b.id]);
});

test("orderByDependency: a chain of three resolves in dependency order", () => {
  const db = def({ localId: "db", port: 5432 });
  const backend = def({ localId: "backend", port: 8080, waitForPort: "db" });
  const web = def({ localId: "web", waitForPort: "backend" });
  const ordered = orderByDependency([web.id, backend.id, db.id], byId([db, backend, web]));
  expect(ordered).toEqual([db.id, backend.id, web.id]);
});

test("orderByDependency: a dependency pointing OUTSIDE the batch doesn't force reordering", () => {
  // "backend" isn't in this start batch (e.g. already running) — "web" just keeps
  // its position rather than erroring or waiting on something not being started.
  const web = def({ localId: "web", waitForPort: "backend" });
  const other = def({ localId: "other" });
  const ordered = orderByDependency([web.id, other.id], byId([web, other]));
  expect(ordered).toEqual([web.id, other.id]);
});

test("orderByDependency: a two-process cycle throws DependencyCycleError naming both ids", () => {
  const a = def({ localId: "a", port: 1, waitForPort: "b" });
  const b = def({ localId: "b", port: 2, waitForPort: "a" });
  expect(() => orderByDependency([a.id, b.id], byId([a, b]))).toThrow(DependencyCycleError);
  try {
    orderByDependency([a.id, b.id], byId([a, b]));
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(DependencyCycleError);
    const cycle = (err as InstanceType<typeof DependencyCycleError>).cycle;
    expect(cycle).toContain(a.id);
    expect(cycle).toContain(b.id);
  }
});

test("orderByDependency: a self-referencing waitForPort throws a (single-id) cycle", () => {
  const a = def({ localId: "a", port: 1, waitForPort: "a" });
  expect(() => orderByDependency([a.id], byId([a]))).toThrow(DependencyCycleError);
});
