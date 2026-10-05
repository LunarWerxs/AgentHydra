// ───────────────────────────────────────────────────────────────────────────────
// The toolbar search runs fzf's FuzzyMatchV2 port (web/src/lib/fuzzy.ts): it must find
// acronym-style subsequences a substring test misses, pick the alignment fzf would, and
// rank the better match first in both the process list and the project panel order.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import { fuzzyMatch, fuzzySearch } from "../web/src/lib/fuzzy";
import { arrangeProcesses, rankProjectsBySearch } from "../web/src/lib/arrange";
import type { ProcessView, ProjectView, StatusBucket } from "../web/src/types";

const ALL: StatusBucket[] = ["running", "busy", "crashed", "stopped"];

function mk(name: string): ProcessView {
  return {
    id: name,
    localId: name,
    name,
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
  };
}

function proj(name: string, processes: string[] = []): ProjectView {
  return { id: name, name, path: `/x/${name}`, enabled: true, processes: processes.map(mk) };
}

test("fuzzyMatch finds an in-order subsequence a substring test misses, and nothing else", () => {
  expect(fuzzyMatch("API Server", "asv")?.positions).toEqual([0, 4, 7]);
  expect(fuzzyMatch("web", "wx")).toBeNull();
  expect(fuzzyMatch("web", "ew")).toBeNull();
});

test("fuzzyMatch prefers a consecutive boundary run over a split match", () => {
  // "f..B" both sit on word starts, but the adjacent "fb" run at the end scores higher.
  expect(fuzzyMatch("Fix Bar fb", "fb")?.positions).toEqual([8, 9]);
});

test("a match at a word start outscores the same letters mid-word", () => {
  const start = fuzzyMatch("API Server", "api");
  const mid = fuzzyMatch("Grapi Loader", "api");
  expect(start && mid && start.score > mid.score).toBe(true);
});

test("fuzzySearch ANDs whitespace-separated terms", () => {
  expect(fuzzySearch("Mock DB", "mock db")).not.toBeNull();
  expect(fuzzySearch("Mock Cache", "mock db")).toBeNull();
});

test("while searching, arrangeProcesses ranks relevance ahead of the chosen sort", () => {
  const list = [mk("API Server"), mk("Grapi Loader")];
  const opts = { sortKey: "name" as const, sortDir: "desc" as const, statusFilter: ALL, now: 0 };
  expect(arrangeProcesses(list, { ...opts, search: "api" }).map((p) => p.name)).toEqual([
    "API Server",
    "Grapi Loader",
  ]);
  expect(arrangeProcesses(list, { ...opts, search: "asv" }).map((p) => p.name)).toEqual([
    "API Server",
  ]);
});

test("rankProjectsBySearch orders panels by best match, non-matches last in list order", () => {
  const list = [proj("zzz"), proj("web-tools", ["Grapi Loader"]), proj("yyy"), proj("api")];
  expect(rankProjectsBySearch(list, "api").map((p) => p.name)).toEqual([
    "api",
    "web-tools",
    "zzz",
    "yyy",
  ]);
  expect(rankProjectsBySearch(list, "  ")).toBe(list);
});
