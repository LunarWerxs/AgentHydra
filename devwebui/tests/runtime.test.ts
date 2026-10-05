import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDevWebUIFile } from "../server/src/projects/file-store";
import { detectProjectRuntime, effectiveRuntime, withRuntime } from "../server/src/runtime";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dwrt-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── detectProjectRuntime: read the lockfile, decide the runtime ─────────────────────────────────

test("detectProjectRuntime reads the lockfile: bun → bun, npm/yarn/pnpm → node, none → undefined", () => {
  const cases: Array<[string | null, "node" | "bun" | undefined]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "node"],
    ["npm-shrinkwrap.json", "node"],
    ["yarn.lock", "node"],
    ["pnpm-lock.yaml", "node"],
    [null, undefined],
  ];
  for (const [lockfile, expected] of cases) {
    withTempDir((dir) => {
      if (lockfile) writeFileSync(path.join(dir, lockfile), "");
      expect(detectProjectRuntime(dir)).toBe(expected);
    });
  }
});

test("detectProjectRuntime prefers Bun when a project has both a bun and a node lockfile", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "bun.lock"), "");
    writeFileSync(path.join(dir, "package-lock.json"), "");
    expect(detectProjectRuntime(dir)).toBe("bun");
  });
});

// ── effectiveRuntime: precedence pin > explicit global > detected(auto) ──────────────────────────

test("a per-process runtime pin always wins", () => {
  expect(effectiveRuntime("node", "bun", "bun")).toBe("node");
  expect(effectiveRuntime("bun", "auto", undefined)).toBe("bun");
});

test("an explicit global (node/bun) overrides the project's detected runtime", () => {
  expect(effectiveRuntime(undefined, "node", "bun")).toBe("node");
  expect(effectiveRuntime(undefined, "bun", "node")).toBe("bun");
});

test("under `auto`, the project's detected runtime is used (or nothing, if undetected)", () => {
  expect(effectiveRuntime(undefined, "auto", "bun")).toBe("bun");
  expect(effectiveRuntime(undefined, "auto", "node")).toBe("node");
  expect(effectiveRuntime(undefined, "auto", undefined)).toBeUndefined();
});

test("the real fix: a Bun project's literal `node …/vite.js` command becomes `bun …` under auto", () => {
  const command =
    "node ../../../node_modules/vite/bin/vite.js --host 0.0.0.0 --port 4173 --strictPort";
  const rt = effectiveRuntime(undefined, "auto", "bun"); // pin unset, global auto, project = bun
  expect(withRuntime(command, rt)).toBe(
    "bun ../../../node_modules/vite/bin/vite.js --host 0.0.0.0 --port 4173 --strictPort",
  );
});

// ── end-to-end: loading a .devwebui stamps the detected runtime onto every process ───────────────

test("readDevWebUIFile stamps detectedRuntime from the project's lockfile", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "bun.lock"), ""); // this is a Bun project
    const file = path.join(dir, ".devwebui");
    writeFileSync(
      file,
      JSON.stringify({
        name: "T",
        processes: [
          { id: "web", name: "Web", command: "node ../node_modules/vite/bin/vite.js --port 5000" },
        ],
      }),
    );
    const loaded = readDevWebUIFile(file);
    expect(loaded.processes[0]!.detectedRuntime).toBe("bun");
    expect(loaded.processes[0]!.runtime).toBeUndefined(); // NOT a pin — only the detected hint
  });
});
