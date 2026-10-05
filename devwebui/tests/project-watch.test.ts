// ───────────────────────────────────────────────────────────────────────────────
// Live `.devwebui` reloading. The daemon reads a project's file once (boot, or a
// GUI/MCP load) and then outlives every edit, so without a watcher an edit stays
// invisible until restart — the bug these pin (2026-07-16: five servers added to a
// repo's .devwebui never appeared in the GUI; reloading the browser cannot help,
// because the staleness is in the daemon, not the frontend).
//
// The cases that matter are the ones a naive watch(file) gets wrong: an ATOMIC save
// (write temp + rename — what editors actually do) must still be seen, and a file
// caught MID-WRITE must never drop the project. Most cases use inert commands and
// spawn nothing; the two "running" cases at the bottom spawn a REAL keep-alive child,
// because "the reload didn't bounce my server" is only worth asserting against a real
// pid — that safety property is what makes auto-reload safe to have at all.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Manager } from "../server/src/manager";
import { readDevWebUIFile } from "../server/src/projects/file-store";
import { ProjectWatcher } from "../server/src/project-watch";

// Comfortably past the watcher's 200ms debounce, without making the suite crawl.
const SETTLE_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(SETTLE_MS);

async function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}

/**
 * Wait until the watcher has actually reached the state under test, then let the
 * caller's own `expect` produce the diff.
 *
 * A fixed `settle()` is the RIGHT tool for asserting a NON-event ("nothing was
 * torn down", "no emission") - you cannot wait for something that must not
 * happen. It is the wrong tool for asserting a CHANGE, because it races the OS
 * rather than the debounce: macOS coalesces directory events under
 * /var/folders and a loaded runner delivers one well past 700 ms. That is
 * exactly how "a plain in-place edit reloads" went red on macos-latest and
 * nowhere else, three runs running, on 2026-09-20 - and it read as a product
 * regression every time.
 *
 * Waiting for the condition is bounded at 5 s but normally returns in tens of
 * milliseconds, so this is FASTER than the sleep it replaces as well as being
 * deterministic. The timeout is swallowed on purpose: the caller's `expect` is
 * what should report, with its readable diff, not "waitFor timed out".
 */
async function reloaded(predicate: () => boolean): Promise<void> {
  try {
    await waitFor(predicate);
  } catch {
    /* fall through to the caller's expect */
  }
}

/** `h.processIds()` equals `expected`, in order - the predicate most cases want. */
const idsAre = (h: { processIds: () => string[] }, expected: string[]) => (): boolean => {
  const got = h.processIds();
  return got.length === expected.length && got.every((id, i) => id === expected[i]);
};

const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;
/** A process that stays up until we stop it — so "still running" is a real observation. */
const keepAliveCommand = () =>
  `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 1000)")}`;

// ONE mkdtempSync call site for the whole file: every scratch root goes through tempDir,
// is registered here, and is reaped by the file-wide afterAll below — outcome-independent,
// unlike a trailing rmSync in a passing body.
const scratchDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectJson(processIds: string[], name = "Fixture", command = "node -e 0"): string {
  return JSON.stringify({
    name,
    processes: processIds.map((id) => ({ id, name: id, command })),
  });
}

/** A temp .devwebui + a Manager with it loaded + a started watcher. */
function harness(initial: string[] = ["web"]) {
  const dir = tempDir("devwebui-watch-");
  const file = path.join(dir, ".devwebui");
  writeFileSync(file, projectJson(initial));

  const manager = new Manager();
  manager.addProject(readDevWebUIFile(file), { autostart: false });
  const watcher = new ProjectWatcher(manager);
  watcher.start();

  // `localId` is the id as written in the file; `id` is namespaced with the project
  // hash (`p<sha1>.web`), which is an internal detail these cases don't care about.
  const processIds = () => manager.listProjects().flatMap((p) => p.processes.map((x) => x.localId));
  const dispose = () => {
    watcher.stop();
    manager.dispose();
  };
  return { dir, file, manager, watcher, processIds, dispose };
}

test("a plain in-place edit reloads: added processes appear without a restart", async () => {
  const h = harness(["web"]);
  try {
    expect(h.processIds()).toEqual(["web"]);
    writeFileSync(h.file, projectJson(["web", "api", "worker"]));
    await reloaded(idsAre(h, ["web", "api", "worker"]));
    expect(h.processIds()).toEqual(["web", "api", "worker"]);
  } finally {
    h.dispose();
  }
});

test("an ATOMIC save (write temp + rename) reloads — the case a file-level watch goes deaf to", async () => {
  // Editors replace the inode rather than appending. watch(file) is bound to the OLD
  // inode and stops reporting after the first such save; the directory watch survives.
  const h = harness(["web"]);
  try {
    const tmp = path.join(h.dir, ".devwebui.tmp");
    writeFileSync(tmp, projectJson(["web", "api"]));
    renameSync(tmp, h.file); // atomic replace
    await reloaded(idsAre(h, ["web", "api"]));
    expect(h.processIds()).toEqual(["web", "api"]);
  } finally {
    h.dispose();
  }
});

test("two atomic saves in a row both land (the watcher does not go deaf after the first)", async () => {
  const h = harness(["web"]);
  try {
    for (const ids of [
      ["web", "api"],
      ["web", "api", "worker"],
    ]) {
      const tmp = path.join(h.dir, ".devwebui.tmp");
      writeFileSync(tmp, projectJson(ids));
      renameSync(tmp, h.file);
      await reloaded(idsAre(h, ids));
    }
    expect(h.processIds()).toEqual(["web", "api", "worker"]);
  } finally {
    h.dispose();
  }
});

test("removing a process from the file removes it from the project", async () => {
  const h = harness(["web", "api"]);
  try {
    writeFileSync(h.file, projectJson(["web"]));
    await reloaded(idsAre(h, ["web"]));
    expect(h.processIds()).toEqual(["web"]);
  } finally {
    h.dispose();
  }
});

test("a project-level rename reloads", async () => {
  const h = harness(["web"]);
  try {
    writeFileSync(h.file, projectJson(["web"], "Renamed"));
    await reloaded(() => h.manager.listProjects()[0]?.name === "Renamed");
    expect(h.manager.listProjects()[0]?.name).toBe("Renamed");
  } finally {
    h.dispose();
  }
});

test("invalid JSON (a half-written save) is skipped — the last good state stays loaded", async () => {
  const h = harness(["web", "api"]);
  try {
    writeFileSync(h.file, '{ "name": "Fixture", "processes": [ { "id": "we');
    await settle();
    // The project must NOT be torn down because the file was read mid-write.
    expect(h.processIds()).toEqual(["web", "api"]);
  } finally {
    h.dispose();
  }
});

test("a good write AFTER a bad one still reloads (the retry is not wedged)", async () => {
  const h = harness(["web"]);
  try {
    writeFileSync(h.file, "{ not json");
    await settle();
    expect(h.processIds()).toEqual(["web"]); // unchanged, as above
    writeFileSync(h.file, projectJson(["web", "api"]));
    await reloaded(idsAre(h, ["web", "api"]));
    expect(h.processIds()).toEqual(["web", "api"]);
  } finally {
    h.dispose();
  }
});

test("a transiently MISSING file does not drop the project (the atomic-rename window)", async () => {
  const h = harness(["web", "api"]);
  try {
    unlinkSync(h.file);
    await settle();
    expect(h.processIds()).toEqual(["web", "api"]);
    // …and when it comes back, the edit lands.
    writeFileSync(h.file, projectJson(["web", "api", "worker"]));
    await reloaded(idsAre(h, ["web", "api", "worker"]));
    expect(h.processIds()).toEqual(["web", "api", "worker"]);
  } finally {
    h.dispose();
  }
});

test("a byte-identical rewrite is a no-op (no churn from touches or the daemon's own writes)", async () => {
  const h = harness(["web"]);
  try {
    let emissions = 0;
    h.manager.on("projects", () => emissions++);
    writeFileSync(h.file, projectJson(["web"])); // same bytes
    await settle();
    expect(emissions).toBe(0);
  } finally {
    h.dispose();
  }
});

// ── The safety property: auto-reload must not disturb what's already running ──
// This is what makes watching the file safe at all. Editing `.devwebui` to ADD a
// server while others are up is the normal case; if a reload bounced every process,
// auto-reload would be a footgun rather than a convenience. Reconciliation restarts
// only a process whose exec shape actually moved — these two pin both halves with a
// REAL child process, not a mock.
test("adding a process to the file leaves a RUNNING sibling untouched (same pid)", async () => {
  const dir = tempDir("devwebui-watch-live-");
  const file = path.join(dir, ".devwebui");
  writeFileSync(file, projectJson(["web"], "Live", keepAliveCommand()));
  const manager = new Manager();
  manager.addProject(readDevWebUIFile(file), { autostart: false });
  const watcher = new ProjectWatcher(manager);
  watcher.start();
  const viewOf = (localId: string) =>
    manager.listProjects()[0]?.processes.find((x) => x.localId === localId);
  try {
    manager.start(viewOf("web")!.id);
    await waitFor(() => viewOf("web")?.status === "running");
    const pidBefore = viewOf("web")?.pid;
    expect(pidBefore).toBeGreaterThan(0);

    // Add a sibling — exactly the ".devwebui gained new servers" edit.
    writeFileSync(file, projectJson(["web", "api"], "Live", keepAliveCommand()));
    await reloaded(() => !!viewOf("api"));

    expect(viewOf("api")).toBeDefined();
    expect(viewOf("web")?.status).toBe("running");
    expect(viewOf("web")?.pid).toBe(pidBefore); // same process — never bounced
  } finally {
    await manager.stopAll();
    watcher.stop();
    manager.dispose();
  }
});

test("changing a running process's COMMAND is HELD, not applied — restart applies it", async () => {
  // A .devwebui landing on disk (a git pull, a branch switch, a teammate's commit) must
  // never be able to relaunch a running server on a new command by itself. The watch
  // registers the change and flags it; only an explicit restart re-execs.
  const dir = tempDir("devwebui-watch-restart-");
  const file = path.join(dir, ".devwebui");
  writeFileSync(file, projectJson(["web"], "Live", keepAliveCommand()));
  const manager = new Manager();
  manager.addProject(readDevWebUIFile(file), { autostart: false });
  const watcher = new ProjectWatcher(manager);
  watcher.start();
  const viewOf = (localId: string) =>
    manager.listProjects()[0]?.processes.find((x) => x.localId === localId);
  try {
    manager.start(viewOf("web")!.id);
    await waitFor(() => viewOf("web")?.status === "running");
    const pidBefore = viewOf("web")?.pid;

    // A different keep-alive command: same shape, different exec.
    const changed = `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 999)")}`;
    writeFileSync(file, projectJson(["web"], "Live", changed));
    await waitFor(() => viewOf("web")?.configChanged === true);

    // Still the ORIGINAL process, on the original command.
    expect(viewOf("web")?.status).toBe("running");
    expect(viewOf("web")?.pid).toBe(pidBefore);
    expect(viewOf("web")?.command).toBe(changed); // the new def IS registered…
    expect(viewOf("web")?.configChanged).toBe(true); // …but flagged as not yet applied

    // An explicit restart is what re-execs, and it clears the flag.
    await manager.restart(viewOf("web")!.id);
    await waitFor(() => viewOf("web")?.status === "running" && viewOf("web")?.pid !== pidBefore);
    expect(viewOf("web")?.pid).not.toBe(pidBefore);
    expect(viewOf("web")?.configChanged).toBeUndefined();
  } finally {
    await manager.stopAll();
    watcher.stop();
    manager.dispose();
  }
});

test("a process ADDED to the file by a watch reload does not auto-start, even with autostart:true", async () => {
  const dir = tempDir("devwebui-watch-newproc-");
  const file = path.join(dir, ".devwebui");
  writeFileSync(file, projectJson(["web"], "Live", keepAliveCommand()));
  const manager = new Manager();
  manager.addProject(readDevWebUIFile(file), { autostart: false });
  const watcher = new ProjectWatcher(manager);
  watcher.start();
  const viewOf = (localId: string) =>
    manager.listProjects()[0]?.processes.find((x) => x.localId === localId);
  try {
    // `api` arrives with autostart:true. It must appear, and stay stopped.
    const withAutostart = JSON.stringify(
      {
        name: "Live",
        processes: [
          { id: "web", name: "web", command: keepAliveCommand() },
          { id: "api", name: "api", command: keepAliveCommand(), autostart: true },
        ],
      },
      null,
      2,
    );
    writeFileSync(file, withAutostart);
    await waitFor(() => !!viewOf("api"));
    await settle();
    expect(viewOf("api")?.status).toBe("stopped");
    expect(viewOf("api")?.pid).toBeNull();
  } finally {
    await manager.stopAll();
    watcher.stop();
    manager.dispose();
  }
});

test("stop() ends watching — a later edit is ignored", async () => {
  const h = harness(["web"]);
  try {
    h.watcher.stop();
    writeFileSync(h.file, projectJson(["web", "api"]));
    await settle();
    expect(h.processIds()).toEqual(["web"]);
  } finally {
    h.manager.dispose();
  }
});

test("the watch set self-syncs off the manager: a project removed is unwatched", async () => {
  const h = harness(["web"]);
  try {
    expect(h.watcher.watchedFiles().length).toBe(1);
    await h.manager.removeProject(h.manager.listProjects()[0]!.id);
    expect(h.watcher.watchedFiles()).toEqual([]);
  } finally {
    h.dispose();
  }
});

test("a project loaded AFTER start() is picked up and watched", async () => {
  const h = harness(["web"]);
  try {
    const dir2 = tempDir("devwebui-watch-2-");
    const file2 = path.join(dir2, ".devwebui");
    writeFileSync(
      file2,
      JSON.stringify({
        name: "Second",
        processes: [{ id: "s1", name: "s1", command: "node -e 0" }],
      }),
    );
    h.manager.addProject(readDevWebUIFile(file2), { autostart: false });
    expect(h.watcher.watchedFiles().length).toBe(2);

    writeFileSync(
      file2,
      JSON.stringify({
        name: "Second",
        processes: [
          { id: "s1", name: "s1", command: "node -e 0" },
          { id: "s2", name: "s2", command: "node -e 0" },
        ],
      }),
    );
    // Wait for the reload rather than a fixed settle: this watcher's directory watch was
    // created a moment before the write, and macOS delivers that first event late enough
    // that 700ms went red on CI once (2026-09-18) and green on the rerun.
    const second = () => h.manager.listProjects().find((p) => p.name === "Second");
    await waitFor(() => second()?.processes.length === 2);
    expect(second()?.processes.map((x) => x.localId)).toEqual(["s1", "s2"]);
  } finally {
    h.dispose();
  }
});
