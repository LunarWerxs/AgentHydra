// ───────────────────────────────────────────────────────────────────────────────
// Project-level metadata editing (GUI "Edit project"): a project's top-level `name`
// and optional accent `color` can be rewritten in place without touching its
// processes. These pin the file-store boundary — the on-disk .devwebui is the source
// of truth, so a rename/recolor edits the file and every write is schema-validated.
// File-store cases hit the on-disk .devwebui directly; no processes are spawned.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDevWebUIFile, updateProjectMeta } from "../server/src/projects/file-store";

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

function makeTempProjectFile(over: Record<string, unknown> = {}): string {
  const dir = tempDir("devwebui-project-meta-");
  const file = path.join(dir, ".devwebui");
  writeFileSync(
    file,
    JSON.stringify({
      name: "Original",
      processes: [{ id: "web", name: "Web", command: "bun run dev" }],
      ...over,
    }),
  );
  return file;
}

function readFile(file: string): {
  name: string;
  color?: string;
  processes: Array<{ id: string }>;
} {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("updateProjectMeta renames the project and preserves its processes", () => {
  const file = makeTempProjectFile();
  updateProjectMeta(file, { name: "Renamed" });
  const raw = readFile(file);
  expect(raw.name).toBe("Renamed");
  expect(raw.processes.map((p) => p.id)).toEqual(["web"]);
});

test("updateProjectMeta trims the name", () => {
  const file = makeTempProjectFile();
  updateProjectMeta(file, { name: "  Spaced  " });
  expect(readFile(file).name).toBe("Spaced");
});

test("updateProjectMeta sets a color, and an empty color clears the key", () => {
  const file = makeTempProjectFile();
  updateProjectMeta(file, { name: "P", color: "#ff8800" });
  expect(readFile(file).color).toBe("#ff8800");

  updateProjectMeta(file, { name: "P", color: "" });
  expect("color" in readFile(file)).toBe(false);
});

test("updateProjectMeta rejects an empty name and leaves the file intact", () => {
  const file = makeTempProjectFile();
  expect(() => updateProjectMeta(file, { name: "   " })).toThrow();
  expect(readFile(file).name).toBe("Original"); // the schema-validated write never ran
});

test("updateProjectMeta leaves the name untouched when only a color is given", () => {
  const file = makeTempProjectFile({ name: "KeepMe" });
  updateProjectMeta(file, { color: "#123456" });
  const raw = readFile(file);
  expect(raw.name).toBe("KeepMe");
  expect(raw.color).toBe("#123456");
});

test("readDevWebUIFile surfaces the top-level color on the loaded project", () => {
  const file = makeTempProjectFile({ color: "#abcdef" });
  expect(readDevWebUIFile(file).color).toBe("#abcdef");
});
