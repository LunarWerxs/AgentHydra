// Tests for the shared crash sentinel (SHARED LunarWerx server-lib - source of truth:
// lunarwerx-ui/src/server-lib/crash-sentinel.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/crash-sentinel.mjs` import resolves only from that synced location, so this file is
// NOT runnable inside the kit repo itself.
//
// What is pinned: an unclosed run is reported by exactly one later launch, a closed run and a run
// whose owner is still alive are never reported, and safe mode is read from both the flag and the
// env var the tray host sets. Each of these failing is silent: the app either never offers safe
// mode after a crash, or accuses every clean start of having crashed.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SAFE_MODE_ENV,
  clearRunSentinels,
  isSafeModeRequested,
  openCrashSentinel,
} from "../../src/crash-sentinel.mjs";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crash-sentinel-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Every launch in these tests is a different fake pid, and liveness is decided by the test, so
// nothing depends on which real processes happen to exist.
const dead = () => false;
const open = (dir: string, pid: number, isAlive: (pid: number) => boolean = dead) =>
  openCrashSentinel({ dir, pid, isAlive, closeOnCleanExit: false });

test("a clean shutdown leaves nothing for the next launch to report", () => {
  const dir = freshDir();
  const first = open(dir, 1001);
  expect(first.written).toBe(true);
  expect(first.previousRunCrashed).toBe(false);
  first.close();
  expect(existsSync(first.file)).toBe(false);
  expect(open(dir, 1002).previousRunCrashed).toBe(false);
});

test("an unclosed run is reported by the next launch, and only by that one", () => {
  const dir = freshDir();
  const crashed = openCrashSentinel({ dir, pid: 1001, isAlive: dead, safeMode: true, closeOnCleanExit: false });
  // no close(): the process "crashed"
  const next = open(dir, 1002);
  expect(next.previousRunCrashed).toBe(true);
  expect(next.uncleanRuns).toHaveLength(1);
  const [run] = next.uncleanRuns;
  expect(run?.launchId).toBe(crashed.launchId);
  expect(run?.pid).toBe(1001);
  expect(run?.safeMode).toBe(true);
  next.close();
  expect(open(dir, 1003).previousRunCrashed).toBe(false);
});

test("a run whose owner is still alive is an overlapping sibling, not a crash", () => {
  // The update relaunch: the successor starts while its predecessor is still draining.
  const dir = freshDir();
  const predecessor = open(dir, 1001);
  const successor = open(dir, 1002, (pid) => pid === 1001);
  expect(successor.previousRunCrashed).toBe(false);
  expect(existsSync(predecessor.file)).toBe(true);
  // ...and the predecessor's graceful exit must not erase the successor's live marker.
  predecessor.close();
  expect(existsSync(successor.file)).toBe(true);
});

test("a live pid on a run file from an earlier boot is a recycled pid, so the crash is reported", () => {
  // Power loss: the run never closed, and after the reboot an unrelated process holds its pid.
  const dir = freshDir();
  const hour = 60 * 60 * 1000;
  const lost = openCrashSentinel({ dir, pid: 1001, isAlive: dead, closeOnCleanExit: false, bootTime: () => 0 });
  const next = openCrashSentinel({
    dir,
    pid: 1002,
    isAlive: (pid) => pid === 1001,
    closeOnCleanExit: false,
    bootTime: () => 5 * hour,
  });
  expect(next.uncleanRuns.map((run) => run.launchId)).toEqual([lost.launchId]);
  expect(existsSync(lost.file)).toBe(false);
});

test("an unreadable run file still counts as a run that never closed", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "run_torn"), "{\"pid\":10");
  const next = open(dir, 1002);
  expect(next.previousRunCrashed).toBe(true);
  expect(next.uncleanRuns[0]?.pid).toBeNull();
});

test("clearRunSentinels erases a deliberate kill so it is not reported as a crash", () => {
  const dir = freshDir();
  open(dir, 1001);
  writeFileSync(join(dir, "unrelated.txt"), "keep");
  expect(clearRunSentinels(dir)).toBe(1);
  expect(readdirSync(dir)).toEqual(["unrelated.txt"]);
  expect(open(dir, 1002).previousRunCrashed).toBe(false);
});

test("safe mode is read from the flag or the tray's env var, and the env var can pin it off", () => {
  expect(isSafeModeRequested(["bun", "app.ts", "start", "--safe-mode"], {})).toBe(true);
  expect(isSafeModeRequested(["bun", "app.ts", "start"], { [SAFE_MODE_ENV]: "1" })).toBe(true);
  expect(isSafeModeRequested(["bun", "app.ts", "start"], { [SAFE_MODE_ENV]: "0" })).toBe(false);
  expect(isSafeModeRequested(["bun", "app.ts", "start"], {})).toBe(false);
});
