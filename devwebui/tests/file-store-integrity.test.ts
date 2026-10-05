// ───────────────────────────────────────────────────────────────────────────────
// server/src/projects/file-store.ts owns every write to the user's .devwebui — usually a
// hand-authored, version-controlled file — plus the atomic-write primitive (atomic-write.ts)
// every writer in the codebase shares. Four properties matter enough to regression-guard
// directly: (a) a write that fails partway can't corrupt the file it was replacing, (b) a
// user's own hand-added keys survive a GUI-driven edit, (c) a partial update payload doesn't
// silently wipe fields it never mentioned, (d) a BOM-prefixed file (what Notepad writes) loads
// instead of throwing. File-store cases hit the on-disk file directly, no processes spawned.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../server/src/atomic-write";
import {
  addProcessToFile,
  readDevWebUIFile,
  setProcessStarred,
  updateProcessInFile,
} from "../server/src/projects/file-store";

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

function makeProjectFile(over: Record<string, unknown> = {}): string {
  const dir = tempDir("devwebui-fsintegrity-");
  const file = path.join(dir, ".devwebui");
  writeFileSync(
    file,
    JSON.stringify({
      name: "P",
      processes: [{ id: "web", name: "Web", command: "echo hi" }],
      ...over,
    }),
  );
  return file;
}

/** A .devwebui as it sits on disk: its processes plus any keys a user hand-added. */
interface RawProcess {
  id: string;
  [key: string]: unknown;
}
interface RawProjectFile {
  processes: RawProcess[];
  [key: string]: unknown;
}

function readRaw(file: string): RawProjectFile {
  return JSON.parse(readFileSync(file, "utf8")) as RawProjectFile;
}

// ── (a) atomic writes ───────────────────────────────────────────────────────────────────────

test("writeFileAtomic leaves the original file untouched and cleans up its .tmp when the write fails", () => {
  const dir = tempDir("devwebui-atomic-");
  const target = path.join(dir, "target.json");
  writeFileSync(target, "original");

  // Force a REAL failure rather than mocking, so this exercises the actual catch path. The
  // lever differs by platform, and getting that wrong is why this first shipped green on
  // Windows and red everywhere else:
  //   • Windows: renaming ONTO a read-only destination throws EPERM. Directory permissions
  //     don't gate file creation there, so the read-only-dir trick below is a no-op.
  //   • POSIX: a file's own mode does NOT gate rename (the DIRECTORY's write bit does), so a
  //     read-only target renames just fine. Make the containing directory read-only instead,
  //     which fails the .tmp creation.
  const isWin = process.platform === "win32";
  if (isWin) chmodSync(target, 0o444);
  else chmodSync(dir, 0o555);
  try {
    expect(() => writeFileAtomic(target, "new content")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("original");
    const leftoverTmp = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftoverTmp).toEqual([]);
  } finally {
    // Restore so the temp dir can be cleaned up.
    if (isWin) chmodSync(target, 0o666);
    else chmodSync(dir, 0o755);
  }
});

test("writeFileAtomic succeeds normally and leaves no .tmp litter behind", () => {
  const dir = tempDir("devwebui-atomic-ok-");
  const target = path.join(dir, "target.json");
  writeFileSync(target, "original");
  writeFileAtomic(target, "replaced");
  expect(readFileSync(target, "utf8")).toBe("replaced");
  expect(readdirSync(dir)).toEqual(["target.json"]);
});

// ── (b) unknown/hand-added keys survive a GUI-style edit, including across a rename ─────────

test("hand-added keys (top-level and per-process) survive star + rename edits", () => {
  const file = makeProjectFile({
    customTopLevel: "kept",
    processes: [
      { id: "web", name: "Web", command: "echo hi", customProcField: "kept-too" },
      { id: "api", name: "API", command: "echo api" },
    ],
  });

  setProcessStarred(file, "web", true);
  let raw = readRaw(file);
  expect(raw.customTopLevel).toBe("kept");
  let web = raw.processes.find((p: { id: string }) => p.id === "web");
  expect(web.customProcField).toBe("kept-too");
  expect(web.starred).toBe(true);

  // The rename itself: extras are keyed by in-file id, so a rename has to carry them across.
  updateProcessInFile(file, "web", { id: "web-renamed", name: "Web", command: "echo hi" });
  raw = readRaw(file);
  expect(raw.customTopLevel).toBe("kept");
  web = raw.processes.find((p: { id: string }) => p.id === "web-renamed");
  expect(web).toBeDefined();
  expect(web.customProcField).toBe("kept-too");
});

// ── (c) partial update merges omitted fields, but an explicit undefined still clears ────────

test("updateProcessInFile merges every field the payload omits, but an explicitly-sent undefined still clears it", () => {
  const file = makeProjectFile({
    processes: [
      {
        id: "web",
        name: "Web",
        command: "echo hi",
        port: 3000,
        links: ["api"],
        companion: true,
        starred: true,
        url: "/admin",
      },
      { id: "api", name: "API", command: "echo api" },
    ],
  });

  // A minimal {id,name,command} payload must NOT wipe port/links/companion/starred/url.
  updateProcessInFile(file, "web", { id: "web", name: "Web Renamed", command: "echo hi2" });
  let web = readRaw(file).processes.find((p: { id: string }) => p.id === "web");
  expect(web.name).toBe("Web Renamed");
  expect(web.port).toBe(3000);
  expect(web.links).toEqual(["api"]);
  expect(web.companion).toBe(true);
  expect(web.starred).toBe(true);
  expect(web.url).toBe("/admin");

  // Same call shape, but `port` is now explicitly present (as undefined) — that DOES clear it,
  // while every other omitted field stays merged from what's stored.
  updateProcessInFile(file, "web", {
    id: "web",
    name: "Web Renamed",
    command: "echo hi2",
    port: undefined,
  });
  web = readRaw(file).processes.find((p: { id: string }) => p.id === "web");
  expect(web.port).toBeUndefined();
  expect(web.links).toEqual(["api"]);
  expect(web.starred).toBe(true);
});

// Prompt answers are file-only (the GUI form does not edit them), so a GUI edit must keep them.
test("prompt answers survive a GUI-style edit", () => {
  const answers = [{ expect: "Proceed?", send: "y", optional: true }];
  const file = makeProjectFile({
    processes: [{ id: "web", name: "Web", command: "echo hi", answers }],
  });
  updateProcessInFile(file, "web", { id: "web", name: "Web Renamed", command: "echo hi" });
  setProcessStarred(file, "web", true);
  const web = readRaw(file).processes.find((p: { id: string }) => p.id === "web");
  expect(web.answers).toEqual(answers);
  const loaded = readDevWebUIFile(file).processes[0];
  expect(loaded.answers).toEqual(answers);
});

test("addProcessToFile does not need to merge (a brand new process has nothing stored to preserve)", () => {
  const file = makeProjectFile();
  addProcessToFile(file, { id: "api", name: "API", command: "echo api", port: 4001 });
  const api = readRaw(file).processes.find((p: { id: string }) => p.id === "api");
  expect(api.port).toBe(4001);
});

// ── (d) BOM-prefixed .devwebui ───────────────────────────────────────────────────────────────

test("a UTF-8 BOM-prefixed .devwebui loads instead of throwing a JSON parse error", () => {
  const dir = tempDir("devwebui-bom-");
  const file = path.join(dir, ".devwebui");
  const body = JSON.stringify({
    name: "BOMTest",
    processes: [{ id: "web", name: "Web", command: "echo hi" }],
  });
  writeFileSync(file, `﻿${body}`, "utf8"); // what Notepad and some editors write
  const loaded = readDevWebUIFile(file);
  expect(loaded.name).toBe("BOMTest");
  expect(loaded.processes[0]?.localId).toBe("web");

  // The GUI-edit path (readRaw internally) tolerates the same BOM.
  expect(() => setProcessStarred(file, "web", true)).not.toThrow();
  expect(readRaw(file).processes[0].starred).toBe(true);
});
