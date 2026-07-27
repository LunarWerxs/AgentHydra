// Guardrail for a real bug that hid for months (found 2026-07-16): server/src/dispatch.ts's
// isRunnerAlive() asked Windows "is any process running this run's spec file?" with
//
//     Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%<id>.spec.json%'"
//
// spawned as `powershell -Command "<that query>"`. The needle is IN the powershell's own command
// line — it IS the LIKE pattern — so the query always matched ITSELF and the count was never zero.
// The probe therefore answered "runner alive" for every reattach on Windows, which silently
// disabled three things that look perfectly correct in the source:
//   · reattachRuns's "trust the stored childPid ONLY while the runner is verifiably alive" guard,
//     whose own comment names the stakes: "stuck run, or a cancel force-killing an innocent
//     process". A recycled pid answers isAlive() forever → the run sits 'running' for good, and
//     Cancel would killTree() whatever now owns that number;
//   · its "runner gone and left nothing to replay → mark failed" branch — unreachable;
//   · tailRun's dead-runner path — unreachable for the same reason.
// Nothing failed loudly. The probe just always said yes.
//
// THE RULE: a `CommandLine LIKE` process query executed through a spawned shell MUST exclude the
// querying process (`AND ProcessId <> $PID`). This is not defensive tidiness — without it the
// result is unconditionally non-empty, so the query cannot answer the question it was written to
// ask.
//
// Deliberately narrow, because the failure is specific to the needle living inside the filter
// string:
//   · `-Filter "Name='Claude.exe'"` (core/process.ts) is FINE — a name match can't hit the
//     powershell doing the asking, and there is no needle to echo.
//   · misc/Restart-Daemon.ps1 is FINE — it filters by Name, applies the tray-adapter needle in
//     PowerShell code against $p.CommandLine, and additionally skips $PID by hand. That is the
//     safe shape, and it is exactly why that script never broke while isRunnerAlive did.
//   · POSIX `ps -eo args=` is FINE — ps's own args don't contain the needle.
//
// Self-contained by design: imports nothing from the arkitect core (a bare
// `import "connections-arkitect"` doesn't resolve from a check that lives in the repo rather than
// the runner's node_modules), and returns plain finding objects — which the runner accepts as-is.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "wmi-commandline-query-excludes-self";

/** A WMI/CIM filter that matches on CommandLine — the only shape that can echo its own needle. */
const COMMANDLINE_FILTER = /CommandLine\s+LIKE/i;
/**
 * Either way of keeping the query from finding itself. Both are legitimate; the check is about the
 * INTENT (exclude the shell doing the asking), not one spelling:
 *
 *   · `ProcessId <> $PID` — excludes exactly the querying process. Always correct.
 *   · `Name <> 'powershell.exe'` — excludes the whole shell class. Correct whenever the thing being
 *     hunted is never itself a powershell (server/tests/dispatch.test.ts looks for a `bun` runner,
 *     so this is sound there), and it has the nice property of also excluding any OTHER powershell
 *     that happens to echo the needle.
 *
 * Comparison operators are matched loosely (`<>`, `!=`, `-ne`) because WQL and pwsh disagree.
 */
const SELF_EXCLUSION = [
  /ProcessId\s*(?:<>|!=|-ne)\s*\$PID/i,
  /Name\s*(?:<>|!=|-ne)\s*'(?:powershell|pwsh)(?:\.exe)?'/i,
];
const excludesSelf = (chunk) => SELF_EXCLUSION.some((re) => re.test(chunk));
/** How many lines either side of the match may carry the exclusion (a long filter can wrap). */
const WINDOW = 3;

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "tmp", ".arkitect", "coverage", "build", "data",
]);
const EXTS = [".ts", ".mjs", ".js", ".ps1", ".mts", ".cjs"];

/** This file's own path. It quotes the very pattern it hunts for, in its header and in its regexes,
 *  so scanning itself reports two guaranteed false positives. It used to live under `.arkitect`,
 *  which was in SKIP_DIRS; now that it sits in `scripts/`, it has to exclude itself by name. */
const SELF = fileURLToPath(import.meta.url);

/** Recursively yield every scannable source file under `dir`. */
function* sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* sourceFiles(p);
    } else if (EXTS.some((x) => e.name.endsWith(x))) {
      if (resolve(p) !== SELF) yield p;
    }
  }
}

/** Every line index whose `CommandLine LIKE` query has no self-exclusion nearby. Exported so the
 *  rule can be unit-tested against fixture strings rather than only against the live tree. */
export function findViolations(text) {
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!COMMANDLINE_FILTER.test(lines[i])) continue;
    const from = Math.max(0, i - WINDOW);
    const to = Math.min(lines.length, i + WINDOW + 1);
    if (excludesSelf(lines.slice(from, to).join("\n"))) continue;
    hits.push(i + 1); // 1-based
  }
  return hits;
}

export const audit = {
  id: ID,
  title: "a WMI CommandLine query must exclude the querying process ($PID) or it matches itself",
  category: "custom",
  domain: "code",
  requires: {},
  // Gating: this shape doesn't misbehave, it silently answers "yes" forever — the worst kind,
  // because every guard built on it keeps looking correct while doing nothing.
  gating: true,
  async run(ctx) {
    const root = ctx?.root ?? process.cwd();
    const findings = [];

    for (const file of sourceFiles(root)) {
      let text;
      try {
        if (statSync(file).size > 2_000_000) continue; // nothing real is this big; skip pathological
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!COMMANDLINE_FILTER.test(text)) continue; // cheap reject before splitting
      for (const line of findViolations(text)) {
        findings.push({
          id: ID,
          file: relative(root, file).replace(/\\/g, "/"),
          line,
          severity: "high",
          message:
            "A `CommandLine LIKE` process query with no `ProcessId <> $PID` exclusion. The shell " +
            "running this query carries the needle in its OWN command line, so the query matches " +
            "itself and can never return zero — it answers 'found' unconditionally.",
          fix: "Add `AND ProcessId <> $PID` to the filter (or `AND Name <> 'powershell.exe'` when the target is never a shell). Alternatively match on Name= and apply the needle in code against $_.CommandLine while skipping $PID — see misc/Restart-Daemon.ps1's Get-TrayHostPids, the shape that never broke.",
        });
      }
    }

    const failed = findings.length > 0;
    const report = failed
      ? `Found ${findings.length} self-matching CommandLine query/queries:\n` +
        findings.map((f) => `- ${f.file}:${f.line}`).join("\n")
      : "Every CommandLine process query excludes the querying process. ✓";

    return { failed, findings, report };
  },
};

// ── Standalone CLI (used by CI): `bun|node <thisfile>` prints the report and exits 1 on any
// violation. During an arkitect run the module is only IMPORTED (process.argv[1] = the arkitect
// bin, not this file), so this block is inert there — it fires only on a direct invocation. ──
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() });
  console.log(res.report);
  if (res.failed) process.exit(1);
}
