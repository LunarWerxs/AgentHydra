// Tests for the shared daemon self-log (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/log-file.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/log-file.mjs` import resolves only from that synced location — sync.mjs validates
// the placement — so this file is NOT runnable inside the kit repo itself.
//
// The daemon self-logs its console output to <CONFIG_DIR>/logs/daemon.log so a crash reason
// survives the (hidden-console) process. These tests pin the two things that make it useful:
// it actually captures console.* to the file, and it rotates before the file grows unbounded.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { initFileLogging, restoreFileLogging, logFilePath } from "../../src/log-file.mjs";

// The true native console methods, snapshotted before any test patches them. initFileLogging
// captures console.* via `.bind(console)` and restoreFileLogging re-installs that bound copy, so
// each init/restore cycle compounds a wrapper layer WITHIN one `bun test` process (the daemon
// calls initFileLogging once and never restores, so this is purely a test artifact). Forcing the
// natives back in afterEach guarantees this file leaves console.* pristine and can't leak a stale
// wrapper — or test 1's manual spy — into a later test file sharing the process.
const NATIVE_CONSOLE = { log: console.log, warn: console.warn, error: console.error };

const dirs: string[] = [];
function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "lunarwerx-log-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  // Always un-patch console (it's a global side effect) so one test can't leak into the next.
  restoreFileLogging();
  console.log = NATIVE_CONSOLE.log;
  console.warn = NATIVE_CONSOLE.warn;
  console.error = NATIVE_CONSOLE.error;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

test("tees console.log/warn/error to logs/daemon.log with level tags, while the console still prints", () => {
  const home = tempHome();
  const seen: string[] = [];
  const realLog = console.log.bind(console);
  console.log = (...a: unknown[]) => {
    seen.push(a.join(" "));
    realLog(...a);
  };

  const path = initFileLogging(home);
  expect(path).toBe(join(home, "logs", "daemon.log"));
  expect(logFilePath()).toBe(path);

  console.log("hello from the daemon");
  console.warn("a warning");
  console.error("boom", new Error("kaboom"));

  const body = readFileSync(path ?? "", "utf8");
  // File captured every line, tagged by level…
  expect(body).toContain("INFO  hello from the daemon");
  expect(body).toContain("WARN  a warning");
  expect(body).toContain("ERROR boom");
  // …an Error keeps its stack (Error: kaboom appears in the inspected output)…
  expect(body).toContain("kaboom");
  // …and the real console still received the wrapped call (tee, not redirect).
  expect(seen.some((l) => l.includes("hello from the daemon"))).toBe(true);

  console.log = realLog;
});

test("rotates to daemon.log.1.gz once the existing log exceeds the size cap", () => {
  const home = tempHome();
  const logsDir = join(home, "logs");
  const path = join(logsDir, "daemon.log");
  mkdirSync(logsDir, { recursive: true });
  // Seed an oversized previous log (> the 20 MiB cap) with a marker we can look for after rotation.
  writeFileSync(path, `OLD-MARKER\n${"x".repeat(21 * 1024 * 1024)}`);

  initFileLogging(home);

  // Old generations are gzipped since 2026-10-03 (3f394c98); no plain .1 is left behind.
  const rolled = `${path}.1.gz`;
  expect(existsSync(rolled)).toBe(true);
  expect(existsSync(`${path}.1`)).toBe(false);
  expect(gunzipSync(readFileSync(rolled)).toString("utf8")).toContain("OLD-MARKER");
  // The fresh log is small (just the boot marker) and does NOT carry the old content.
  const fresh = readFileSync(path, "utf8");
  expect(fresh).not.toContain("OLD-MARKER");
  expect(statSync(path).size).toBeLessThan(64 * 1024);
});

test("initFileLogging is idempotent — a second call keeps the same path and doesn't double-patch", () => {
  const home = tempHome();
  const first = initFileLogging(home);
  const beforeLog = console.log;
  const second = initFileLogging(home);
  expect(second).toBe(first);
  // Console wasn't re-wrapped a second time (same function reference).
  expect(console.log).toBe(beforeLog);
});
