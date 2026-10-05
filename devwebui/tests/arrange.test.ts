// ───────────────────────────────────────────────────────────────────────────────
// arrangeProcesses is the single filter+sort the card grid and the table both run,
// so its ordering rules (status precedence, name tie-break, direction, filtering)
// must be exact and stable. Pure function → straightforward to pin.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import { arrangeProcesses, statusBucket } from "../web/src/lib/arrange";
import type { ProcessView, StatusBucket } from "../web/src/types";

const ALL: StatusBucket[] = ["running", "busy", "crashed", "stopped"];

function mk(over: Partial<ProcessView> & { name: string }): ProcessView {
  return {
    id: over.name,
    localId: over.name,
    name: over.name,
    command: "cmd",
    cwd: ".",
    enabled: true,
    projectId: "proj",
    projectName: "Proj",
    status: "stopped",
    pid: null,
    startedAt: null,
    restarts: 0,
    exitCode: null,
    cpu: null,
    memory: null,
    conflict: false,
    ...over,
  };
}

test("statusBucket collapses the five statuses into four buckets", () => {
  expect(statusBucket("running")).toBe("running");
  expect(statusBucket("crashed")).toBe("crashed");
  expect(statusBucket("starting")).toBe("busy");
  expect(statusBucket("stopping")).toBe("busy");
  expect(statusBucket("stopped")).toBe("stopped");
});

test("arrangeProcesses filters out buckets not in the status filter", () => {
  const list = [mk({ name: "a", status: "running" }), mk({ name: "b", status: "stopped" })];
  const out = arrangeProcesses(list, {
    sortKey: "name",
    sortDir: "asc",
    statusFilter: ["running"],
    now: 0,
  });
  expect(out.map((p) => p.name)).toEqual(["a"]);
});

test("arrangeProcesses sorts by name case-insensitively, both directions", () => {
  const list = [mk({ name: "Charlie" }), mk({ name: "alpha" }), mk({ name: "Bravo" })];
  const asc = arrangeProcesses(list, {
    sortKey: "name",
    sortDir: "asc",
    statusFilter: ALL,
    now: 0,
  });
  expect(asc.map((p) => p.name)).toEqual(["alpha", "Bravo", "Charlie"]);
  const desc = arrangeProcesses(list, {
    sortKey: "name",
    sortDir: "desc",
    statusFilter: ALL,
    now: 0,
  });
  expect(desc.map((p) => p.name)).toEqual(["Charlie", "Bravo", "alpha"]);
});

test("arrangeProcesses status sort puts running first, then tie-breaks by name", () => {
  const list = [
    mk({ name: "z", status: "running" }),
    mk({ name: "a", status: "stopped" }),
    mk({ name: "m", status: "running" }),
  ];
  const out = arrangeProcesses(list, {
    sortKey: "status",
    sortDir: "asc",
    statusFilter: ALL,
    now: 0,
  });
  expect(out.map((p) => p.name)).toEqual(["m", "z", "a"]); // both running (m<z) before stopped
});

test("arrangeProcesses does not mutate the input array", () => {
  const list = [mk({ name: "b" }), mk({ name: "a" })];
  const before = list.map((p) => p.name);
  arrangeProcesses(list, { sortKey: "name", sortDir: "asc", statusFilter: ALL, now: 0 });
  expect(list.map((p) => p.name)).toEqual(before);
});

// ── toolbar search ─────────────────────────────────────────────────────────────
// The search box narrows by PROCESS NAME only (not command/port): the panel header
// handles project-name matching, and matching on `command` would surface a process
// whose visible label has nothing to do with what was typed.
test("arrangeProcesses filters by the search text, case-insensitively", () => {
  const list = [mk({ name: "Mock DB" }), mk({ name: "Mock Cache" }), mk({ name: "Web" })];
  const opts = { sortKey: "name" as const, sortDir: "asc" as const, statusFilter: ALL, now: 0 };

  expect(arrangeProcesses(list, { ...opts, search: "mock db" }).map((p) => p.name)).toEqual([
    "Mock DB",
  ]);
  expect(arrangeProcesses(list, { ...opts, search: "MOCK" }).map((p) => p.name)).toEqual([
    "Mock Cache",
    "Mock DB",
  ]);
  expect(arrangeProcesses(list, { ...opts, search: "zzzznomatch" })).toEqual([]);
});

test("a blank or whitespace-only search matches everything (never hides the fleet)", () => {
  const list = [mk({ name: "a" }), mk({ name: "b" })];
  const opts = { sortKey: "name" as const, sortDir: "asc" as const, statusFilter: ALL, now: 0 };
  expect(arrangeProcesses(list, { ...opts, search: "" })).toHaveLength(2);
  expect(arrangeProcesses(list, { ...opts, search: "   " })).toHaveLength(2);
  expect(arrangeProcesses(list, opts)).toHaveLength(2); // omitted entirely
});

test("search composes with the status filter rather than overriding it", () => {
  const list = [
    mk({ name: "Mock DB", status: "running" }),
    mk({ name: "Mock Cache", status: "stopped" }),
  ];
  const out = arrangeProcesses(list, {
    sortKey: "name",
    sortDir: "asc",
    statusFilter: ["running"],
    now: 0,
    search: "mock",
  });
  expect(out.map((p) => p.name)).toEqual(["Mock DB"]);
});
