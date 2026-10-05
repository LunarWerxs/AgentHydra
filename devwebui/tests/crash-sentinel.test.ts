// Crash sentinel: the boot-time signal that puts the daemon in safe mode. What it must get right
// is WHICH leftovers mean "crashed": a dead run's file (safe mode, once), a clean shutdown's
// absence of one (normal boot), and a still-alive sibling's file, which is the auto-update
// predecessor mid-handover and must neither trigger safe mode nor be deleted out from under it.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armCrashSentinel,
  disarmCrashSentinel,
  noteCrashReason,
} from "../server/src/crash-sentinel";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwebui-sentinel-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  disarmCrashSentinel();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const dead = () => false;
// The fixture runs below are dated in the ms after epoch; a boot at 0 keeps them "this boot".
const bootTime = 0;

test("a dead run's leftover is reported once, then a clean shutdown boots normally", () => {
  const dir = freshDir();
  writeFileSync(
    path.join(dir, "run_old"),
    JSON.stringify({ id: "old", pid: 999_999, startedAt: 5, reason: "boom" }),
  );
  const crash = armCrashSentinel({ dir, isAlive: dead, bootTime });
  expect(crash?.id).toBe("old");
  expect(crash?.reason).toBe("boom");
  expect(existsSync(path.join(dir, "run_old"))).toBe(false); // consumed: safe mode once, not forever

  disarmCrashSentinel(); // clean shutdown
  expect(armCrashSentinel({ dir, isAlive: dead, bootTime })).toBeNull();
});

// A reboot or logoff ends the daemon with no shutdown(); its run file predates this boot. Reading
// it as a crash would boot every login into safe mode, and its pid may now belong to anything.
test("a run from before the current OS boot is dropped, not reported, whatever its pid", () => {
  const dir = freshDir();
  const stale = path.join(dir, "run_prevboot");
  writeFileSync(stale, JSON.stringify({ id: "prevboot", pid: 4242, startedAt: 1_000 }));
  expect(armCrashSentinel({ dir, isAlive: (pid) => pid === 4242, bootTime: 2_000 })).toBeNull();
  expect(existsSync(stale)).toBe(false); // cleaned up even though pid 4242 is "alive" (reused)
});

test("a live sibling's run is not a crash and is left for its owner to remove", () => {
  const dir = freshDir();
  const sibling = path.join(dir, "run_pred");
  writeFileSync(sibling, JSON.stringify({ id: "pred", pid: 4242, startedAt: 1 }));
  expect(armCrashSentinel({ dir, isAlive: (pid) => pid === 4242, bootTime })).toBeNull();
  expect(existsSync(sibling)).toBe(true);
  expect(readdirSync(dir).filter((n) => n.startsWith("run_"))).toHaveLength(2);
});

test("the crash handler's reason reaches the next boot", () => {
  const dir = freshDir();
  expect(armCrashSentinel({ dir, isAlive: dead })).toBeNull();
  noteCrashReason(new Error("kaboom")); // uncaughtException; no disarm follows
  const crash = armCrashSentinel({ dir, isAlive: dead }); // the tray's revive
  expect(crash?.reason).toContain("kaboom");
});
