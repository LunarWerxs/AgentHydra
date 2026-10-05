#!/usr/bin/env node
/**
 * Pre-push kit drift gate: refuse a push that carries a kit-synced file away from the kit, judged by
 * what the push contains, as the pre-commit guard (check-kit-sync-staged.mjs) judges a commit by what
 * it stages.
 *
 * It replaced `bun run check:local` in .githooks/pre-push, which ran `sync.mjs --check` over the whole
 * working tree. This tree has many sessions editing at once, so one session's unfinished, uncommitted
 * edit to a synced file blocked every other session's push however unrelated (2026-10-05: five tray
 * host files edited in the working tree for hours held a Desk 2 and CliMayte push that touched none of
 * them).
 *
 * A drifted file blocks the push when the push could carry it:
 *   - a commit in the push changed it, or
 *   - it has no uncommitted change, so the drift is what the branch itself holds.
 * A drifted file with an uncommitted change that no pushed commit touches is someone's work in
 * progress: the remote keeps the copy it had. It is named and left alone.
 * Any other failure of the kit check (nothing it calls drifted) still refuses the push.
 *
 * It never reimplements the kit's path rules: it runs `sync.mjs --check --app <key>` and reads that
 * report. Without the sibling kit checkout it exits 0 (pre-push already says so before calling it).
 *
 * Usage: node .githooks/check-kit-sync-pushed.mjs <remote> <kit.config app key>...  (refs on stdin)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [remote, ...apps] = process.argv.slice(2);
if (!remote || apps.length === 0) {
  console.error("check-kit-sync-pushed: usage: <remote> <app key>...  (refs on stdin)");
  process.exit(2);
}

const REPO = process.cwd();
const KIT = resolve(REPO, "..", "..", "lunarwerx-ui");
if (!existsSync(join(KIT, "sync.mjs"))) process.exit(0);

const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

// Files the push changes: every commit it sends that the remote does not have yet.
const pushed = new Set();
const ZERO = /^0+$/;
for (const line of lines(readFileSync(0, "utf8"))) {
  const [, localSha] = line.split(/\s+/);
  if (!localSha || ZERO.test(localSha)) continue; // a deletion sends no files
  for (const p of lines(git(["log", "--name-only", "--format=", localSha, "--not", `--remotes=${remote}`])))
    pushed.add(norm(resolve(REPO, p)));
}

// Files with an uncommitted change (staged or not, untracked included).
// Porcelain lines start with two status columns and a space, the first often a space: never trimmed.
const dirty = new Set(
  git(["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => norm(resolve(REPO, l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "")))),
);

let failed = false;
for (const app of apps) {
  let report = "";
  let ok = true;
  try {
    report = execFileSync("node", [join(KIT, "sync.mjs"), "--check", "--app", app], { cwd: KIT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    ok = false;
    report = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  if (ok) continue;
  // Report lines look like:  "      ! differs  D:/path/to/file.ts"
  const drifted = [...report.matchAll(/^\s*!\s+differs\s+(.+?)\s*$/gm)].map((m) => m[1].replace(/\\/g, "/"));
  if (drifted.length === 0) {
    console.error(report);
    console.error(`✗ kit check for ${app} failed (see above).`);
    failed = true;
    continue;
  }
  const carried = drifted.filter((p) => pushed.has(norm(p)) || !dirty.has(norm(p)));
  const inProgress = drifted.filter((p) => !carried.includes(p));
  if (inProgress.length)
    console.error(
      [`› kit drift in uncommitted work this push does not carry (${app}), left alone:`, ...inProgress.map((p) => `    ${p}`)].join("\n"),
    );
  if (carried.length) {
    console.error(
      [
        "",
        `✗ this push carries kit-synced files that differ from the kit (${app}):`,
        ...carried.map((p) => `    ${p}`),
        "",
        `  Make the edit in ${KIT.replace(/\\/g, "/")}/src/..., run \`node sync.mjs\` there, and commit the`,
        "  kit and the re-synced app copies.",
        "",
      ].join("\n"),
    );
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
