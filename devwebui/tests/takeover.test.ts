// server/src/takeover.ts edits the user's REAL .vscode/tasks.json and settings.json — files that
// are usually hand-authored and version-controlled, so a careless rewrite (losing comments,
// reordering keys, clobbering an unrelated task) would be a much worse outcome than the daemon
// merely failing to detect a trigger. Fixtures below are deliberately messy JSONC: comments,
// trailing-comma-free but irregularly spaced, multiple tasks, both trigger kinds in one folder —
// closer to a real .vscode than a minimal repro would be.
//
// No isolate.ts import: this module touches only the temp fixture paths it's given, never
// dataDir()/DEVWEBUI_HOME, so it isn't one of the writer modules docs/TESTING.md requires it for.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAutostartTriggers, takeOverAutostart } from "../server/src/takeover";

const TASKS_JSON = `{
  // Tasks for this repo — do not remove the dev-server task, CI depends on its label.
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Start dev server",
      "type": "shell",
      "command": "npm",
      "args": ["run", "dev"],
      "runOptions": {
        "runOn": "folderOpen" // launches the dev server as soon as the folder opens
      }
    },
    {
      "label": "Build",
      "type": "shell",
      "command": "npm",
      "args": ["run", "build"],
    },
  ],
}`;

const SETTINGS_JSON = `{
  // Vite extension config — keep in sync with vite.config.ts's dev script.
  "vite.autoStart": true,
  "vite.devCommand": "npm run dev",
  "editor.tabSize": 2,
}`;

const CLEAN_TASKS_JSON = `{
  "version": "2.0.0",
  "tasks": [
    { "label": "Build", "type": "shell", "command": "npm", "args": ["run", "build"] }
  ]
}`;

// Every scratch root this file creates is registered here and reaped by the file-wide
// afterAll below, so a failing (or crashing) test cannot leave one behind.
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp folder with a .vscode/tasks.json + settings.json, JSONC content as given. */
function makeFixtureDir(tasksJson: string | null, settingsJson: string | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwebui-takeover-test-"));
  scratchDirs.push(dir);
  const vscode = path.join(dir, ".vscode");
  mkdirSync(vscode, { recursive: true });
  if (tasksJson !== null) writeFileSync(path.join(vscode, "tasks.json"), tasksJson);
  if (settingsJson !== null) writeFileSync(path.join(vscode, "settings.json"), settingsJson);
  return dir;
}

test("detectAutostartTriggers finds both trigger kinds, tolerating JSONC comments/trailing commas/multiple tasks", () => {
  const dir = makeFixtureDir(TASKS_JSON, SETTINGS_JSON);
  const triggers = detectAutostartTriggers(dir);

  expect(triggers).toHaveLength(2);
  const task = triggers.find((t) => t.kind === "vscode-task");
  expect(task?.detail).toBe("runs `npm run dev` when the folder opens");
  const vite = triggers.find((t) => t.kind === "vite-extension");
  expect(vite?.detail).toBe("auto-starts `npm run dev` when the folder opens");
});

test("detectAutostartTriggers finds nothing when runOn isn't folderOpen and vite.autoStart isn't true", () => {
  const dir = makeFixtureDir(CLEAN_TASKS_JSON, null);
  expect(detectAutostartTriggers(dir)).toEqual([]);
});

test("takeOverAutostart disables both triggers, backs up first, and leaves everything else unmangled", () => {
  const dir = makeFixtureDir(TASKS_JSON, SETTINGS_JSON);
  const tasksFile = path.join(dir, ".vscode", "tasks.json");
  const settingsFile = path.join(dir, ".vscode", "settings.json");

  const result = takeOverAutostart(dir);

  expect(result.disabled).toHaveLength(2);
  expect(result.skipped).toEqual([]);
  expect(result.backups.sort()).toEqual(
    [`${tasksFile}.devwebui-bak`, `${settingsFile}.devwebui-bak`].sort(),
  );

  // Backups are the PRISTINE originals, byte for byte — the whole point of backing up before
  // a surgical string replace is being able to recover exactly what the user had.
  expect(readFileSync(`${tasksFile}.devwebui-bak`, "utf8")).toBe(TASKS_JSON);
  expect(readFileSync(`${settingsFile}.devwebui-bak`, "utf8")).toBe(SETTINGS_JSON);

  const tasksAfter = readFileSync(tasksFile, "utf8");
  expect(tasksAfter).toContain('"runOn": "default"');
  expect(tasksAfter).not.toContain("folderOpen");
  // Surgical replace, not a parse+reserialize: the comment, the untouched second task, and the
  // trailing commas the user had are all still there verbatim.
  expect(tasksAfter).toContain("// launches the dev server as soon as the folder opens");
  expect(tasksAfter).toContain('"label": "Build"');
  expect(tasksAfter).toContain('"args": ["run", "build"],');

  const settingsAfter = readFileSync(settingsFile, "utf8");
  expect(settingsAfter).toContain('"vite.autoStart": false');
  expect(settingsAfter).toContain("// Vite extension config");
  expect(settingsAfter).toContain('"vite.devCommand": "npm run dev"');
  expect(settingsAfter).toContain('"editor.tabSize": 2');

  // Retired — a second detection pass over the same folder finds nothing left to take over.
  expect(detectAutostartTriggers(dir)).toEqual([]);
});

test("takeOverAutostart skips the write entirely when nothing matches — no edit, no backup", () => {
  const dir = makeFixtureDir(CLEAN_TASKS_JSON, null);
  const tasksFile = path.join(dir, ".vscode", "tasks.json");
  const before = readFileSync(tasksFile, "utf8");

  const result = takeOverAutostart(dir);

  expect(result.disabled).toEqual([]);
  expect(result.backups).toEqual([]);
  // No triggers were ever detected, so the file is never even opened for a rewrite —
  // "skipped" (the per-file "nothing to change" report) only fires for a file that WAS
  // a detected trigger's file but whose text didn't match the replace regex.
  expect(result.skipped).toEqual([]);
  expect(readFileSync(tasksFile, "utf8")).toBe(before);
  expect(existsSync(`${tasksFile}.devwebui-bak`)).toBe(false);
});

test("takeOverAutostart reports (not throws) when a detected trigger's file can't be surgically matched", () => {
  // A trigger jsonc-parser can see structurally (a real folderOpen task — JSONC tolerates a
  // comment between the colon and the value) but whose exact text the plain-string replace
  // regex can't find, since a comment there isn't whitespace to the regex. Proves the "nothing
  // to change (already retired?)" skip branch reports gracefully instead of silently doing
  // nothing or throwing.
  const commentBreaksTheRegex = `{
  "tasks": [
    { "label": "Dev", "command": "npm", "runOptions": { "runOn": /* eslint-disable-line */ "folderOpen" } }
  ]
}`;
  const dir = makeFixtureDir(commentBreaksTheRegex, null);
  const tasksFile = path.join(dir, ".vscode", "tasks.json");

  // Sanity: detection itself is JSONC-structural, so it still finds the trigger.
  expect(detectAutostartTriggers(dir)).toHaveLength(1);

  const result = takeOverAutostart(dir);
  expect(result.disabled).toEqual([]);
  expect(result.backups).toEqual([]);
  expect(result.skipped).toEqual([
    { file: tasksFile, reason: "nothing to change (already retired?)" },
  ]);
  expect(readFileSync(tasksFile, "utf8")).toBe(commentBreaksTheRegex);
});
