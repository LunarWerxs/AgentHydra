// ───────────────────────────────────────────────────────────────────────────────
// Time-Travel Log Vault: rotation and tail retrieval. The module
// resolves its directory via the shared dataDir() (DEVWEBUI_HOME-overridable), so
// under the test preload everything lands in the suite's temp dir — never the real
// ~/.devwebui/logs. Tests still use randomized process ids and clean up after
// themselves so parallel test files sharing the temp dir can't collide.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  appendLog,
  BufferedLogWriter,
  LOG_ROTATION_KEEP,
  LOG_ROTATION_MAX_BYTES,
  logVaultDir,
  tailLog,
} from "../server/src/log-vault";

const idsToClean = new Set<string>();

function uniqueId(label: string): string {
  const id = `logvault-test.${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  idsToClean.add(id);
  return id;
}

function cleanup(id: string) {
  const dir = logVaultDir();
  for (const suffix of ["", ".1", ".2", ".3"]) {
    const f = path.join(dir, `${id}.log${suffix}`);
    if (existsSync(f)) rmSync(f, { force: true });
  }
}

afterEach(() => {
  for (const id of idsToClean) cleanup(id);
  idsToClean.clear();
});

// ---- appendLog / tailLog ---------------------------------------------------

test("tailLog returns [] for a process that hasn't logged anything", () => {
  const id = uniqueId("empty");
  expect(tailLog(id, 50)).toEqual([]);
});

test("appendLog + tailLog round-trip recent lines in order", () => {
  const id = uniqueId("roundtrip");
  appendLog(id, ["line one", "line two"]);
  appendLog(id, ["line three"]);
  expect(tailLog(id, 10)).toEqual(["line one", "line two", "line three"]);
});

test("tailLog caps to the requested line count (most recent last)", () => {
  const id = uniqueId("cap");
  appendLog(
    id,
    Array.from({ length: 30 }, (_, i) => `line ${i}`),
  );
  const tail = tailLog(id, 5);
  expect(tail).toEqual(["line 25", "line 26", "line 27", "line 28", "line 29"]);
});

test("appendLog is a no-op for an empty batch", () => {
  const id = uniqueId("noop");
  appendLog(id, []);
  expect(tailLog(id, 10)).toEqual([]);
});

test("BufferedLogWriter holds a burst and flushes it in process order", () => {
  const id = uniqueId("buffered");
  const writer = new BufferedLogWriter();
  writer.push(id, ["one", "two"]);
  writer.push(id, ["three"]);
  expect(tailLog(id, 10)).toEqual([]);
  writer.flush();
  expect(tailLog(id, 10)).toEqual(["one", "two", "three"]);
  writer.dispose();
});

// ---- rotation ---------------------------------------------------------------

test("log rotates once the current file crosses the size cap, keeping older rotations", () => {
  const id = uniqueId("rotate");
  // Comfortably exceed the ~1MB cap in the FIRST append so the very next append
  // rotates it out to .1 before writing a fresh current file.
  const bigLine = "x".repeat(1000);
  const bigBatch = Array.from(
    { length: Math.ceil(LOG_ROTATION_MAX_BYTES / 1000) + 10 },
    () => bigLine,
  );
  appendLog(id, bigBatch); // current file now >= MAX_BYTES
  appendLog(id, ["fresh line after rotation"]); // should rotate old -> .1, start a new current file

  const dir = logVaultDir();
  expect(existsSync(path.join(dir, `${id}.log`))).toBe(true);
  expect(existsSync(path.join(dir, `${id}.log.1`))).toBe(true);

  // The tail should still surface the newest line (from the fresh current file).
  const tail = tailLog(id, 5);
  expect(tail.at(-1)).toBe("fresh line after rotation");
});

test("rotation keeps only LOG_ROTATION_KEEP older files — the oldest is dropped", () => {
  const id = uniqueId("rotate-cap");
  const bigLine = "x".repeat(1000);
  const bigBatch = Array.from(
    { length: Math.ceil(LOG_ROTATION_MAX_BYTES / 1000) + 10 },
    () => bigLine,
  );

  // Force rotation LOG_ROTATION_KEEP + 2 times so the oldest rotation gets pushed
  // past the keep limit and discarded.
  for (let i = 0; i < LOG_ROTATION_KEEP + 2; i++) {
    appendLog(id, bigBatch);
    appendLog(id, [`marker-${i}`]); // small append that triggers the NEXT rotation check
  }

  const dir = logVaultDir();
  expect(existsSync(path.join(dir, `${id}.log`))).toBe(true);
  expect(existsSync(path.join(dir, `${id}.log.${LOG_ROTATION_KEEP}`))).toBe(true);
  expect(existsSync(path.join(dir, `${id}.log.${LOG_ROTATION_KEEP + 1}`))).toBe(false);
});

// ---- the vault writes log files ONLY -----------------------------------------

test("appendLog writes nothing but .log files — no crash sidecar", () => {
  const id = uniqueId("no-sidecar");
  appendLog(id, ["a line"]);
  const strays = readdirSync(logVaultDir()).filter(
    (f) => f.startsWith(id) && !/\.log(\.\d+)?$/.test(f),
  );
  expect(strays).toEqual([]);
});
