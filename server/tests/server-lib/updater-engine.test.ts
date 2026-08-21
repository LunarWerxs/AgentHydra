// Tests for the shared self-update engine (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/updater-engine.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/updater-engine.mjs` import resolves only from that synced location — sync.mjs
// validates the placement — so this file is NOT runnable inside the kit repo itself.
//
// Exercises the real engine against a scratch git remote + clone (no mocking of git/spawn) so the
// stage-then-swap / rollback-on-failure path around applyUpdate() is verified against actual repo
// state, not just the transcript log. installCmd/buildCmd are real `bun -e` invocations that log
// each call and can be made to fail on demand, so "did install/build actually run, how many times,
// and in what order" is checkable after the fact. All git operations are local (file:// clones of
// tmpdir repos) — no network — so the suite is hermetic and deterministic.
import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createUpdater } from "../../src/updater-engine.mjs";

// Every scratch dir (git remotes, clones, and per-test log/count dirs) is tracked here and
// removed in afterEach — each run otherwise leaks 9 full git repos into the temp dir, which
// accumulates unbounded on a long-lived CI runner. Mirrors the tempDir/tempHome + rmSync
// pattern the sibling kit tests use.
const dirs: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// 30s, stated here because this hook deletes NINE full git repos from the temp dir and a
// recursive delete of a git tree is thousands of small files - I/O time, not assertion time. On
// a loaded machine it crosses bun's 5s default, and bun reports a hook timeout as
// `(fail) (unnamed)` with no file and no hook name, which is the least actionable red a suite
// can print. Hooks DO honour setDefaultTimeout() as well (measured on bun 1.4.0), but this file
// is kit-synced into apps that may not set one, so it carries its own.
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}, 30_000);

async function remoteRepo(): Promise<string> {
  const dir = scratchDir("ue-remote-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.1.0" }));
  writeFileSync(join(dir, "marker.txt"), "v1\n");
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

async function cloneRepo(remote: string): Promise<string> {
  const dir = scratchDir("ue-local-");
  await $`git clone -q ${remote} ${dir}`.quiet();
  await $`git -C ${dir} config user.name S`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  return dir;
}

async function advanceRemote(remote: string, version: string): Promise<void> {
  writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "x", version }));
  writeFileSync(join(remote, "marker.txt"), `${version}\n`);
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io commit -q -m ${version}`.quiet();
}

/** A runtime `-e` step that appends `label` to a log file — a real subprocess, no mocking.
 *  Use the exact executable running the suite instead of the bare `bun` command: on Windows,
 *  npm-installed Bun can put only `bun.cmd`/`bun.ps1` on PATH, and the updater's shell fallback
 *  would then reinterpret the JavaScript argument and strip its quotes. */
function loggingCmd(logPath: string, label: string): string[] {
  const script = `require("fs").appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(label)} + "\\n")`;
  return [process.execPath, "-e", script];
}

/** A `bun -e` step that logs, then exits non-zero iff `failFlag` exists on disk. */
function failableCmd(logPath: string, label: string, failFlag: string): string[] {
  const script = [
    `require("fs").appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(label)} + "\\n")`,
    `if (require("fs").existsSync(${JSON.stringify(failFlag)})) { console.error("boom"); process.exit(1); }`,
  ].join("; ");
  return [process.execPath, "-e", script];
}

/** A `bun -e` step that logs, then exits non-zero on calls whose 1-based call number is in
 *  `failOnCalls` (call count persisted in `countFile`, which — unlike the git-tracked tree —
 *  survives a `git reset --hard`). */
function failsOnCallsCmd(logPath: string, label: string, countFile: string, failOnCalls: number[]): string[] {
  const script = [
    `const fs = require("fs")`,
    `const n = (fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, "utf8")) : 0) + 1`,
    `fs.writeFileSync(${JSON.stringify(countFile)}, String(n))`,
    `fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(label)} + "\\n")`,
    `if (${JSON.stringify(failOnCalls)}.includes(n)) { console.error("boom"); process.exit(1); }`,
  ].join("; ");
  return [process.execPath, "-e", script];
}

function updaterFor(appRoot: string, installCmd: string[], buildCmd: string[]) {
  return createUpdater({
    appRoot,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    installCmd,
    buildCmd,
  });
}

test("checkForUpdate + applyUpdate happy path: pulls, installs, builds, HEAD advances", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await advanceRemote(remote, "0.2.0");

  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const updater = updaterFor(local, loggingCmd(log, "install"), loggingCmd(log, "build"));

  const before = await updater.checkForUpdate();
  expect(before.updateAvailable).toBe(true);
  expect(before.canApply).toBe(true);

  const result = await updater.applyUpdate();
  expect(result.ok).toBe(true);
  expect(result.restartRequired).toBe(true);
  expect(result.message).toBe("TestSvc was updated. Restart the daemon to run the new code.");

  const head = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  const remoteHead = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();
  expect(head).toBe(remoteHead);
  expect(readFileSync(join(local, "marker.txt"), "utf8").trim()).toBe("0.2.0");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["install", "build"]);

  const after = await updater.checkForUpdate();
  expect(after.updateAvailable).toBe(false);
  expect(after.dirty).toBe(false);
  // 30s: this exercises REAL git pull + install + build in a scratch repo, which runs ~5s locally
  // and repeatedly hit the 5s default timeout on a cold Windows CI runner (2026-07-16). Widen the
  // allowance rather than let a timing flake gate the suite. (Push upstream to the kit source.)
}, 30_000);

test("applyUpdate rolls back the checkout when build fails after the code swap", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const preUpdateCommit = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  await advanceRemote(remote, "0.2.0");

  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const buildCount = join(scratch, "build.count");
  // build fails on call 1 (forward pass, triggers the rollback) and succeeds on call 2 (rollback
  // reinstall pass), so this test isolates a clean rollback from the reinstall-also-fails case.
  const updater = updaterFor(local, loggingCmd(log, "install"), failsOnCallsCmd(log, "build", buildCount, [1]));

  await expect(updater.applyUpdate()).rejects.toThrow("boom; rolled back to the previous version");

  // Checkout state, not just the log message: HEAD is back at the pre-update commit, the
  // pulled-in file change is gone, and the tree is clean (no half-applied swap left behind).
  const head = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  expect(head).toBe(preUpdateCommit);
  expect(readFileSync(join(local, "marker.txt"), "utf8").trim()).toBe("v1");
  const porcelain = (await $`git -C ${local} status --porcelain`.text()).trim();
  expect(porcelain).toBe("");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["install", "build", "install", "build"]);

  const status = await updater.checkForUpdate();
  expect(status.currentCommit).toBe(preUpdateCommit);
  expect(status.dirty).toBe(false);
}, 30_000); // real git+install+build — see the happy-path test's note on the widened timeout.

test("rollback message distinguishes a clean revert from a revert whose reinstall also fails", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const preUpdateCommit = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  await advanceRemote(remote, "0.2.0");

  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const installCount = join(scratch, "install.count");
  const buildFailFlag = join(scratch, "FAIL_BUILD");
  writeFileSync(buildFailFlag, "1");

  // install succeeds on the forward pass (call 1), fails on the rollback reinstall pass (call 2);
  // build fails on the forward pass, which is what triggers the rollback in the first place.
  const updater = updaterFor(
    local,
    failsOnCallsCmd(log, "install", installCount, [2]),
    failableCmd(log, "build", buildFailFlag),
  );

  await expect(updater.applyUpdate()).rejects.toThrow(
    "boom; code was rolled back, but reinstalling/rebuilding it failed; the previous version may not run until this is fixed",
  );

  const head = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  expect(head).toBe(preUpdateCommit);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["install", "build", "install"]);
}, 30_000); // real git+install+build — see the happy-path test's note on the widened timeout.
