import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { buildDecisionBrief, normalizeFindings } from "@saydeploy/architect/core/finding";
import { removeReport, writeReport } from "@saydeploy/architect/core/output";
import { buildSarifLog } from "@saydeploy/architect/core/sarif";
import { enrichFindingsWithSourceAnchors } from "@saydeploy/architect/core/source-anchor";
import { checkAppliesToProject, detectProject } from "@saydeploy/architect/core/project-detect";
import { parseAuditCliArgs } from "./args.mjs";

export const MARKDOWN_REPORT_LIFECYCLE_NOTE =
  "> Note: This file is a generated audit fix queue. Once every listed item is complete and the audit reruns clean, delete this completed Markdown file if the audit runner has not already removed it.";

export function withMarkdownReportLifecycleNote(report) {
  if (report.includes(MARKDOWN_REPORT_LIFECYCLE_NOTE)) {
    return report;
  }
  return `${MARKDOWN_REPORT_LIFECYCLE_NOTE}\n\n${report}`;
}

export function printAuditList(audits) {
  for (const audit of audits) {
    console.log(`${audit.id}\t${audit.title}`);
  }
}

// ── Summary-line counting regexes ───────────────────────────────
//
// Matches every variant we see across engines, including bolded labels
// and parenthetical qualifiers:
//   - "Errors: 0"
//   - "- Errors: 0"
//   - "- **Errors:** 5"
//   - "- **Errors (falsy guard present, no placeholder check):** 0"
//   - "**Total errors**: 5"
//
// We capture both the label tier ("total" prefix) and the count.
// The runner uses these in two places — keep them in sync.
const SUMMARY_ERRORS_RE =
  /(?:^|\n|\.?\s)\s*-?\s*\*{0,2}(?:Total\s+)?Errors?\s*(?:\([^)]*\))?\s*\*{0,2}\s*:\s*\*{0,2}\s*(\d+)/im;
const SUMMARY_WARNINGS_RE =
  /(?:^|\n|\.?\s)\s*-?\s*\*{0,2}(?:Total\s+)?Warnings?\s*(?:\([^)]*\))?\s*\*{0,2}\s*:\s*\*{0,2}\s*(\d+)/im;
const SUMMARY_FINDINGS_RE = /(?:^|\n)\s*-?\s*\*{0,2}(?:Total\s+)?[Ff]indings\s*\*{0,2}\s*:\s*\*{0,2}\s*(\d+)/im;
const HEADING_SEVERITY_RE = /^#{2,4}\s+[^\n]*?—\s*(\d+)\s*\((error|warning|warn)\)/gim;

/**
 * Count a report's finding bullets as a last-resort fallback when no
 * summary lines were emitted. Looks for the standard fix-queue bullet
 * format: `- **path:line** —` or `- **rule-id** —`.
 */
function countBulletFindings(report) {
  if (typeof report !== "string") return 0;
  const re = /^[ \t]*[-*]\s+\*\*[^*\n]+\*\*\s+—/gm;
  let n = 0;
  while (re.exec(report) !== null) n++;
  return n;
}

/**
 * Decide whether a markdown report has actionable findings.
 * Scans the report text for non-zero error/warning counts — the same
 * patterns the FIX_QUEUE generator uses.
 */
function shouldKeepReport(result) {
  if (result.failed === true) return true;
  const report = result.report;
  if (typeof report !== "string" || report.length === 0) return false;

  // Check for explicit error/warning counts in summary lines.
  const errMatch = report.match(SUMMARY_ERRORS_RE);
  const warnMatch = report.match(SUMMARY_WARNINGS_RE);
  if (errMatch && Number.parseInt(errMatch[1], 10) > 0) return true;
  if (warnMatch && Number.parseInt(warnMatch[1], 10) > 0) return true;

  // Check for severity-tagged section headings: `## name — N (error|warning)`
  HEADING_SEVERITY_RE.lastIndex = 0;
  let headingMatch;
  while ((headingMatch = HEADING_SEVERITY_RE.exec(report)) !== null) {
    if (Number.parseInt(headingMatch[1], 10) > 0) return true;
  }

  return false;
}

export async function runAuditCli({
  argv = [],
  audits,
  getAudit,
  loadConfig,
  printHelp,
  root = process.cwd(),
  toolName = "arkitect",
} = {}) {
  const options = parseAuditCliArgs(argv);

  if (options.command === "help") {
    printHelp?.();
    return;
  }

  if (options.command === "list") {
    printAuditList(audits);
    return;
  }

  const config = await loadConfig({
    root,
    configPath: options.configPath,
    policyDir: options.policyDir,
    policy: options.policy,
  });
  const project = await resolveProjectShape(root, config);

  const selectedAudits = options.all ? selectAllAuditsForConfig(audits, config) : [getAudit(options.checkId)];
  if (selectedAudits.some((audit) => !audit)) {
    console.error(`Unknown audit check: ${options.checkId || "(missing check id)"}`);
    printHelp?.();
    process.exitCode = 1;
    return;
  }

  // Clear old audit reports before running so only fresh results remain.
  const auditOutputDir = path.resolve(root, "tmp", "audits");
  if (existsSync(auditOutputDir)) {
    await rm(auditOutputDir, { recursive: true, force: true });
  }
  await mkdir(auditOutputDir, { recursive: true });

  // ── Plan the audit tasks (filter enabled + includeInAll). ────────
  //
  // `--all` runs every static check. The only opt-outs are DYNAMIC checks
  // that need a dev server, browser, or live data cache (HAR / lighthouse
  // captures / runnyknows ndjson) — running them blindly without their
  // setup produces stale-data warnings that erode signal.
  //
  // Everything else (codeRisk, qualityAgnostic, dead-code, circular-deps,
  // dep-rules, …) participates in `--all` so an agent that runs the
  // strict sweep gets the full static-analysis surface in one command.
  const DYNAMIC_CHECK_IDS = new Set([
    "browser-perf",
    "workspace-interaction-perf",
    "memory-monitor",
    "e2e-capture",
    "media-cors",
    "arkitect-live-smoke",
  ]);

  const skippedDynamicChecks = []; // dynamic checks still skipped in --all
  const tasks = [];
  for (const audit of selectedAudits) {
    const checkConfig = {
      ...audit.defaultConfig,
      ...(config.checks?.[audit.id] ?? {}),
    };
    if (!checkAppliesToProject(checkWithConfiguredRequires(audit, checkConfig), project)) {
      continue;
    }
    const isDynamic = isDynamicCheck(audit, checkConfig, config, DYNAMIC_CHECK_IDS);
    if (options.all && isDynamic) {
      skippedDynamicChecks.push({ id: audit.id, title: audit.title });
      continue;
    }
    // A check's author opt-out signals (`enabled: false` / `includeInAll: false`)
    // mean it was deliberately excluded from the default suite — typically a
    // whole-codebase quality metric (circular-deps, dead-code) that reports the
    // entire pre-existing debt. `--all` still force-RUNS these for visibility
    // (the findings stay in the report), but they must NOT gate `--fail-on-drift`
    // or they'd keep the strict gate permanently red, making it useless as a
    // signal. The real contract/architecture gates ship enabled+includeInAll
    // true and are unaffected. Project config (arkitect.config.json) can still
    // opt a check back into the gate by setting enabled/includeInAll true.
    const gatesUnderStrict = checkConfig.enabled !== false && checkConfig.includeInAll !== false;
    if (checkConfig.enabled === false) {
      // In `--all` mode, flip on static checks that ship disabled by
      // default (dead-code, circular-deps, dep-rules). Their authors
      // gated them because they need policy configuration — but
      // running them with default policy is still informative.
      if (options.all && !isDynamic) {
        checkConfig.enabled = true;
      } else {
        continue;
      }
    }
    // `includeInAll: false` is now a no-op for *running* a static check in
    // `--all` (it still runs); it only suppresses strict-gate participation
    // via `gatesUnderStrict` above.
    tasks.push({ audit, checkConfig, gatesUnderStrict });
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, tasks.length || 1));
  const parallel = concurrency > 1;
  const shouldPrintJson = options.format === "json" || options.rawCheckArgs.includes("--json");
  const isQuiet = options.quiet;

  // Serial mode preserves the old "stream each report to stdout as it runs"
  // behavior. Parallel mode suppresses streaming (interleaved markdown is
  // unreadable) and prints a per-check `[OK]` / `[FAIL]` progress line instead.
  const streamReports = !parallel && !shouldPrintJson;

  // ── Concurrency-limited worker pool. ─────────────────────────────
  let failed = false;
  const runResults = [];
  const startedAt = Date.now();
  let nextTaskIndex = 0;
  let completed = 0;
  const totalTasks = tasks.length;

  async function runTask({ audit, checkConfig, gatesUnderStrict }) {
    const taskStart = Date.now();
    let result;
    try {
      result = await audit.run({
        checkArgs: options.rawCheckArgs,
        config,
        checkConfig,
        root,
        options,
        project,
      });
    } catch (err) {
      result = {
        failed: true,
        findings: [],
        report: `# ${audit.title}\n\n**Audit threw:** ${err?.message || err}\n\nErrors: 1\nWarnings: 0\n`,
        outputPath: checkConfig.outputPath,
        jsonPayload: { error: String(err?.stack || err?.message || err) },
      };
    }
    if (Array.isArray(result.findings) && result.findings.length > 0) {
      const findings = enrichFindingsWithSourceAnchors(result.findings, { root });
      result = {
        ...result,
        findings,
        jsonPayload: syncJsonPayloadFindings(result.jsonPayload, findings),
      };
    }

    const outputPath = options.outputPath || result.outputPath || checkConfig.outputPath || "";
    if (outputPath) {
      const absoluteOutputPath = path.resolve(root, outputPath);
      const isMarkdownReport = [".md", ".markdown"].includes(path.extname(outputPath).toLowerCase());
      if (isMarkdownReport && !shouldKeepReport(result)) {
        await removeReport(absoluteOutputPath);
      } else if (result.report) {
        await writeReport(
          absoluteOutputPath,
          isMarkdownReport ? withMarkdownReportLifecycleNote(result.report) : result.report,
        );
      }
    }

    if (shouldPrintJson) {
      // JSON mode: still print per-check JSON (callers may pipe through jq).
      console.log(JSON.stringify(result.jsonPayload ?? result, null, 2));
    } else if (streamReports && result.report && (!isQuiet || (options.failOnDrift && result.failed))) {
      process.stdout.write(result.report);
    } else if (parallel && !isQuiet) {
      const elapsedMs = Date.now() - taskStart;
      // Opted-out checks that "fail" are informational (they run for visibility
      // but don't gate), so label them INFO rather than FAIL to avoid implying
      // they broke the strict gate.
      const flag = result.failed ? (gatesUnderStrict ? "FAIL" : "INFO") : "OK";
      completed += 1;
      process.stdout.write(`  [${flag}] ${audit.id.padEnd(34)} (${elapsedMs}ms)  ${completed}/${totalTasks}\n`);
    }

    if (options.failOnDrift && result.failed && gatesUnderStrict) {
      failed = true;
    }

    runResults.push({
      id: audit.id,
      title: audit.title,
      category: audit.category,
      outputPath,
      findings: Array.isArray(result.findings) ? result.findings : [],
      gatesUnderStrict,
    });
  }

  if (parallel && !isQuiet) {
    process.stdout.write(`\n[arkitect] running ${totalTasks} checks with concurrency ${concurrency}\n\n`);
  }

  // Simple promise pool: spawn `concurrency` workers that pull from a shared
  // task index until exhausted. Avoids depending on p-limit or similar.
  async function worker() {
    while (true) {
      const idx = nextTaskIndex++;
      if (idx >= tasks.length) return;
      await runTask(tasks[idx]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (parallel && !isQuiet) {
    process.stdout.write(`\n[arkitect] ${totalTasks} checks finished in ${Date.now() - startedAt}ms\n\n`);
  }

  // Write consolidated fix queue index after all checks complete.
  // Scan the audit output directory directly — don't rely on in-memory
  // tracking which varies across check implementations.
  if (runResults.length > 0) {
    const { readdir } = await import("node:fs/promises");
    let reportNames = [];
    try {
      const entries = await readdir(auditOutputDir);
      reportNames = entries.filter((e) => e.endsWith(".md") && e !== "FIX_QUEUE.md");
    } catch {
      /* dir may not exist */
    }

    const runResultByReportName = new Map(
      runResults.filter((r) => r.outputPath).map((r) => [path.basename(r.outputPath), r]),
    );
    // Map each report filename → whether its check gates the strict suite, so
    // advisory (opted-out, force-run-for-visibility) findings are listed but
    // never counted as gate-blocking in the summary / nextAction.
    const gatingByReportName = new Map();
    for (const task of tasks) {
      const op = task.checkConfig.outputPath;
      if (op) gatingByReportName.set(path.basename(op), task.gatesUnderStrict !== false);
    }

    const reportEntries = [];

    for (const name of reportNames) {
      const absPath = path.join(auditOutputDir, name);
      let text;
      try {
        text = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }

      // Count findings from the report's own summary lines, not from keyword matching.
      // Patterns handle bolded `**Errors:**`, parenthetical labels
      // `**Errors (with qualifier):** N`, and bare `Errors: N`.
      const errMatch = text.match(SUMMARY_ERRORS_RE);
      const warnMatch = text.match(SUMMARY_WARNINGS_RE);
      const totalMatch = text.match(SUMMARY_FINDINGS_RE);
      let errorCount = errMatch ? Number.parseInt(errMatch[1], 10) : 0;
      let warnCount = warnMatch ? Number.parseInt(warnMatch[1], 10) : 0;
      let totalFindings = totalMatch ? Number.parseInt(totalMatch[1], 10) : null;

      // Fallback: if no Errors:/Warnings: lines found, count severity tags in
      // section headings like `## rule-name — 3 (warning)` or
      // `### rule-name — 1 (error)`. This is the primary severity encoding for
      // many checks (perf-hot-paths, bundle-size-budget, etc.).
      if (errorCount === 0 && warnCount === 0) {
        HEADING_SEVERITY_RE.lastIndex = 0;
        let headingMatch;
        while ((headingMatch = HEADING_SEVERITY_RE.exec(text)) !== null) {
          const count = Number.parseInt(headingMatch[1], 10) || 0;
          const severity = headingMatch[2].toLowerCase();
          if (severity === "error") {
            errorCount += count;
          } else {
            warnCount += count;
          }
        }
      }

      // Last-resort fallback: if a report has no summary lines AND no
      // severity-tagged headings, count finding bullets directly. This
      // catches engines that emit findings without machine-readable totals
      // (e.g. detail-overlay-lifecycle pre-standardization). Treat them as
      // warnings — engines that want error severity must emit summary lines.
      if (errorCount === 0 && warnCount === 0 && totalFindings === null) {
        const bulletCount = countBulletFindings(text);
        if (bulletCount > 0) {
          warnCount = bulletCount;
          totalFindings = bulletCount;
        }
      }

      // Structured findings are the source of truth when a reused/non-infra
      // check emits markdown that is human-readable but does not carry the
      // standard Errors:/Warnings: summary lines. Without this fallback the
      // decision brief sees findings that the manifest/FIX_QUEUE under-counts.
      if (errorCount === 0 && warnCount === 0 && totalFindings === null) {
        const structured = runResultByReportName.get(name)?.findings ?? [];
        if (structured.length > 0) {
          errorCount = structured.filter((finding) => finding?.severity === "error").length;
          warnCount = structured.filter((finding) => {
            const severity = finding?.severity ?? "warn";
            return severity !== "error" && severity !== "info";
          }).length;
          totalFindings = errorCount + warnCount;
        }
      }

      // Skip only if the report is truly empty of content.
      if (text.length < 100) continue;

      // Derive a short label from the filename.
      const label = name.replace(/_AUDIT\.md$|_REPORT\.md$|\.md$/i, "").replace(/_/g, " ");

      reportEntries.push({
        name,
        label,
        errorCount,
        warnCount,
        totalFindings,
        gating: gatingByReportName.get(name) ?? true,
      });
    }

    reportEntries.sort((a, b) => b.errorCount - a.errorCount || b.warnCount - a.warnCount);

    const lines = [
      "# Arkitect Fix Queue",
      "",
      "> Work through these reports in order. All findings are equal — fix everything.",
      "> Run `bun audit.mjs --check <id>` to re-run a specific check after fixing.",
      "> Run `bun audit.mjs --all --fail-on-drift --quiet` to confirm everything is clean.",
      ">",
      "> **For AI agents:** `tmp/audits/manifest.json` has the machine-readable",
      "> summary including a `pass.nextAction` field. Don't stop until that",
      '> field reads `"done"`. If it says `"run-dynamic"`, the dynamic / test',
      "> pass (browser, HAR, lighthouse) still owes — `bun run audit:dynamic`",
      "> and `bun run audit:tests` cover that.",
      "",
      `| # | Check | Report | Errors | Warnings | Total |`,
      `| --- | --- | --- | ---: | ---: | ---: |`,
    ];

    let priority = 1;
    for (const r of reportEntries) {
      lines.push(
        `| ${priority++} | \`${r.label}\` | [${r.name}](${r.name}) | ${r.errorCount || "-"} | ${r.warnCount || "-"} | ${r.totalFindings || "-"} |`,
      );
    }

    if (reportEntries.length === 0) {
      lines.push("| | | *No findings — codebase is clean!* | | | |");
    }

    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## How to use this queue");
    lines.push("");
    lines.push("1. Start at the top (highest error count first).");
    lines.push("2. Open the linked report to see exact file:line locations.");
    lines.push("3. Fix each issue, then re-run: `bun audit.mjs --check <id>`");
    lines.push("4. When a report is clean, it's auto-deleted on the next `--all` run.");
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## 🧬 Evolve the Arkitect");
    lines.push("");
    lines.push(
      "After fixing findings, review them for arkitect gaps — the arkitect is a living organism that must rapidly evolve.",
    );
    lines.push("");
    lines.push("- **False negatives?** → Add a new check so this class of problem is caught proactively next time.");
    lines.push("- **False positives?** → Refine the detection to eliminate noise.");
    lines.push("- **Repeated manual fix?** → Automate it as an arkitect check.");
    lines.push("- **Missing grouping?** → Add a root-cause detector.");
    lines.push("");
    lines.push("The arkitect must never be surprised twice by the same class of problem.");
    lines.push("A lightweight check that catches 80% of cases today beats a perfect check that ships next month.");
    lines.push("");
    lines.push(
      "How: `src/engines/<domain>/` → `src/checks/<domain>/` → `src/cli/registry.mjs` → `arkitect.config.json` → re-run → update `INSTRUCTION_MANUAL.md`.",
    );

    // Dynamic checks reference — these need a dev server, browser, or live
    // data cache, so `--all` skips them. They ARE still required for a
    // complete architectural pass — agents must run them separately.
    if (skippedDynamicChecks.length > 0) {
      const sorted = skippedDynamicChecks.sort((a, b) => a.id.localeCompare(b.id));
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push("## ⚠️ Dynamic checks still pending");
      lines.push("");
      lines.push(
        "These checks need a dev server / browser / live data cache, so `--all` skips them. Run them separately for a complete pass.",
      );
      lines.push("");
      lines.push("| Check | Command |");
      lines.push("| --- | --- |");
      for (const c of sorted) {
        lines.push(`| ${c.title} | \`bun audit.mjs --check ${c.id}\` |`);
      }
      lines.push("");
      lines.push("**One command for everything:** `bun run audit:everything`");
      lines.push("");
    }

    await writeReport(path.join(auditOutputDir, "FIX_QUEUE.md"), lines.join("\n"));

    // Machine-readable manifest so AI agents can consume counts directly.
    const manifestEntries = reportEntries.map((r) => ({
      check: r.label,
      report: r.name,
      errors: r.errorCount,
      warnings: r.warnCount,
      totalFindings: r.totalFindings,
    }));
    // Pass-shape classification — agents can ask "are we done?" in one read.
    // pass.complete means every check ran (no dynamic checks were skipped)
    // AND no report has findings. Static opt-ins are part of `--all` now
    // and don't need a separate flag.
    const totalErrors = reportEntries.reduce((s, r) => s + r.errorCount, 0);
    const totalWarnings = reportEntries.reduce((s, r) => s + r.warnCount, 0);
    // Only findings from gating checks decide the strict outcome. Advisory
    // (opted-out) checks are force-run for visibility but never block the gate.
    const gatingErrors = reportEntries.reduce((s, r) => s + (r.gating ? r.errorCount : 0), 0);
    const gatingWarnings = reportEntries.reduce((s, r) => s + (r.gating ? r.warnCount : 0), 0);
    const gatingFindings = gatingErrors + gatingWarnings;
    // All findings are equal — warnings gate just like errors.
    if (gatingFindings > 0 && options.failOnDrift) {
      failed = true;
    }
    const advisoryFindings = reportEntries.reduce((s, r) => s + (r.gating ? 0 : r.errorCount + r.warnCount), 0);
    const ranFullSuite = options.all === true;
    const dynamicMissing = skippedDynamicChecks.map((c) => c.id);
    const manifest = {
      generatedAt: new Date().toISOString(),
      mode: ranFullSuite ? "all" : "single",
      totalReports: reportEntries.length,
      totalErrors,
      totalWarnings,
      gatingErrors,
      gatingWarnings,
      advisoryFindings,
      reports: manifestEntries,
      pass: {
        // `failed` controls the process exit under --fail-on-drift. The clean
        // flag and next action reflect posture findings even in exploratory
        // non-strict runs, where the command may exit 0 while still reporting
        // work to do.
        complete: ranFullSuite && gatingFindings === 0 && dynamicMissing.length === 0,
        clean: gatingFindings === 0,
        ran: tasks.length,
        skipped: {
          dynamic: dynamicMissing,
        },
        nextAction:
          gatingFindings > 0
            ? "fix-errors"
            : !ranFullSuite
              ? "run-all"
              : dynamicMissing.length > 0
                ? "run-dynamic"
                : "done",
      },
    };
    await writeReport(path.join(auditOutputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    // ── Structured, AI-consumable outputs (additive; never gates). ──────
    //
    // Every engine already returns a structured `findings[]`; the runner
    // historically discarded it and reconstructed counts by re-parsing
    // markdown. Persist the findings flat (`findings.json`), a ranked
    // first-read (`DECISION_BRIEF.json` / `DEVOPZ_DECISION_BRIEF.json`),
    // and SARIF so an AI agent (and GitHub Code Scanning / the VS Code SARIF
    // viewer) can reason over machine data. The markdown reports / FIX_QUEUE /
    // manifest above are unchanged. Wrapped so this layer can never break a run.
    try {
      const sarifInputs = [];
      for (const r of runResults) {
        const list = Array.isArray(r.findings) ? r.findings : [];
        sarifInputs.push({ check: { id: r.id, title: r.title, category: r.category }, findings: list });
      }
      const flatFindings = normalizeFindings(runResults);
      await writeReport(path.join(auditOutputDir, "findings.json"), JSON.stringify(flatFindings, null, 2) + "\n");

      const decisionBrief = buildDecisionBrief({ findings: flatFindings, manifest, toolName });
      await writeReport(
        path.join(auditOutputDir, "DECISION_BRIEF.json"),
        JSON.stringify(decisionBrief, null, 2) + "\n",
      );
      if (toolName === "devopz") {
        await writeReport(
          path.join(auditOutputDir, "DEVOPZ_DECISION_BRIEF.json"),
          JSON.stringify(decisionBrief, null, 2) + "\n",
        );
      }

      const sarif = buildSarifLog(sarifInputs);
      await writeReport(path.join(auditOutputDir, "findings.sarif"), JSON.stringify(sarif, null, 2) + "\n");
    } catch (structuredErr) {
      process.stdout.write(
        `[arkitect] (non-fatal) could not write structured outputs: ${structuredErr?.message || structuredErr}\n`,
      );
    }

    // Print the summary directly so the AI sees it without opening another file.
    if (!options.quiet || reportEntries.length > 0) {
      process.stdout.write(`\n══════════════════════════════════════════\n`);
      process.stdout.write(`  ${reportEntries.length} reports with findings\n`);
      process.stdout.write(`══════════════════════════════════════════\n\n`);
      for (const r of reportEntries) {
        const flag = !r.gating ? "ℹ️" : r.errorCount > 0 || r.warnCount > 0 ? "🔴" : "🟡";
        const advisoryNote = r.gating ? "" : "  (advisory — opted out of the strict gate)";
        process.stdout.write(
          `${flag} ${r.label}: ${r.errorCount || 0} errors, ${r.warnCount || 0} warnings → tmp/audits/${r.name}${advisoryNote}\n`,
        );
      }
      if (gatingFindings > 0) {
        process.stdout.write(`\nAll findings are equal — fix every one. Work top-down.\n`);
      }
      process.stdout.write(`\n`);

      // ── NEXT ACTION — single instruction the agent must follow. ──
      // This block is INTENTIONALLY plain text (no ASCII art) because
      // agent context windows truncate boxed banners disproportionately.
      // Whatever `manifest.pass.nextAction` is, the line below is the
      // literal command/state the agent should act on next.
      const next = manifest.pass.nextAction;
      const strictCommand = toolName === "devopz" ? "bun run devopz:strict" : "bun run audit:strict";
      process.stdout.write(`NEXT ACTION → `);
      if (next === "fix-errors") {
        const totalGatingFindings = gatingErrors + gatingWarnings;
        process.stdout.write(`fix the ${totalGatingFindings} finding(s) above, then re-run \`${strictCommand}\`.\n`);
      } else if (next === "run-all") {
        process.stdout.write(`single check passed. Run \`${strictCommand}\` to confirm the full --all sweep.\n`);
      } else if (next === "run-dynamic") {
        process.stdout.write(
          `static sweep passed clean. Run \`bun run audit:dynamic\` and \`bun run audit:tests\` to cover the ${dynamicMissing.length} dynamic checks that need a dev server / browser / cached results.\n`,
        );
      } else {
        const advisoryNote =
          advisoryFindings > 0
            ? ` ${advisoryFindings} advisory finding(s) from opted-out checks remain (visible above, non-gating).`
            : "";
        process.stdout.write(`every gating check passed — the strict gate is clean. Done.${advisoryNote}\n`);
      }
      process.stdout.write(`\n`);

      // Self-evolution prompt — the arkitect is a living organism.
      process.stdout.write(`══════════════════════════════════════════\n`);
      process.stdout.write(`  🧬 EVOLVE THE ARKITECT\n`);
      process.stdout.write(`══════════════════════════════════════════\n\n`);
      process.stdout.write(`After fixing findings, review them for arkitect gaps:\n`);
      process.stdout.write(`  • False negatives? → Add a new check so this is caught next time.\n`);
      process.stdout.write(`  • False positives? → Refine the detection to eliminate noise.\n`);
      process.stdout.write(`  • Repeated manual fix? → Automate it as an arkitect check.\n`);
      process.stdout.write(`  • Missing grouping? → Add a root-cause detector.\n`);
      process.stdout.write(`\n`);
      process.stdout.write(`The arkitect must never be surprised twice by the same class of problem.\n`);
      process.stdout.write(`A lightweight check today beats a perfect check tomorrow.\n`);
      process.stdout.write(`\n`);
      process.stdout.write(`How: engine → check → register → config → re-run → update manual.\n`);
      process.stdout.write(`See INSTRUCTION_MANUAL.md § Arkitect Self-Evolution.\n`);
      process.stdout.write(`\n`);

      // ═══════════════════════════════════════════════════════════
      // DYNAMIC CHECKS — need dev server / browser / live data cache.
      // Excluded from --all by design; agents must run them separately.
      // ═══════════════════════════════════════════════════════════
      if (skippedDynamicChecks.length > 0) {
        const sorted = skippedDynamicChecks.sort((a, b) => a.id.localeCompare(b.id));

        process.stdout.write(`\n`);
        process.stdout.write(`═══════════════════════════════════════════════════════\n`);
        process.stdout.write(`  ⚠️  DYNAMIC CHECKS STILL PENDING\n`);
        process.stdout.write(`═══════════════════════════════════════════════════════\n`);
        process.stdout.write(`\n`);
        process.stdout.write(`  These checks need a dev server, browser, or live data\n`);
        process.stdout.write(`  cache, so --all skips them. Run them for a complete pass.\n`);
        process.stdout.write(`\n`);
        for (const c of sorted) {
          process.stdout.write(`    bun audit.mjs --check ${c.id}  →  ${c.title}\n`);
        }
        process.stdout.write(`\n`);
        process.stdout.write(`  One command for everything:\n`);
        process.stdout.write(`    bun run audit:everything\n`);
        process.stdout.write(`\n`);
      }
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

async function resolveProjectShape(root, config) {
  const configProject = normalizeConfigProject(config?.project);
  const detectRoots =
    configProject.detectRoots ??
    config?.projectDetection?.roots ??
    config?.roots?.source ??
    config?.paths?.sourceRoots ??
    ["src", "."];
  const detected = await detectProject(root, { roots: Array.isArray(detectRoots) ? detectRoots : [detectRoots] }).catch(
    () => ({
      root,
      languages: [],
      frameworks: [],
      ecosystems: [],
      primary_language: null,
    }),
  );

  return {
    ...detected,
    ...configProject,
    root: configProject.root ?? detected.root ?? root,
    languages: mergeUnique(detected.languages, configProject.languages),
    frameworks: mergeUnique(detected.frameworks, configProject.frameworks),
    ecosystems: mergeUnique(detected.ecosystems, configProject.ecosystems),
  };
}

function normalizeConfigProject(project) {
  if (!project) return {};
  if (typeof project === "string") return { name: project };
  if (typeof project !== "object") return {};
  return project;
}

function checkWithConfiguredRequires(audit, checkConfig) {
  if (Object.hasOwn(checkConfig, "requires")) {
    return { ...audit, requires: checkConfig.requires };
  }
  return audit;
}

function mergeUnique(...lists) {
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      if (typeof value !== "string" || !value || out.includes(value)) continue;
      out.push(value);
    }
  }
  return out;
}

function selectAllAuditsForConfig(audits, config) {
  const mode = config?.suite?.mode ?? config?.suiteMode ?? "discovered";
  if (mode !== "configured") return audits;

  const configuredIds = new Set();
  const configuredGroups = config?.groups && typeof config.groups === "object" ? Object.values(config.groups) : [];
  for (const group of configuredGroups) {
    for (const id of group?.checks ?? []) {
      if (typeof id === "string" && id) configuredIds.add(id);
    }
  }
  for (const [id, checkConfig] of Object.entries(config?.checks ?? {})) {
    if (checkConfig?.enabled !== false) configuredIds.add(id);
  }

  if (configuredIds.size === 0) return [];
  return audits.filter((audit) => configuredIds.has(audit.id));
}

function isDynamicCheck(audit, checkConfig, config, defaultDynamicCheckIds) {
  if (audit.dynamic === true || checkConfig.dynamic === true) return true;
  if (Array.isArray(config?.dynamicChecks) && config.dynamicChecks.includes(audit.id)) return true;
  return defaultDynamicCheckIds.has(audit.id);
}

function syncJsonPayloadFindings(jsonPayload, findings) {
  if (!jsonPayload || typeof jsonPayload !== "object" || !Array.isArray(jsonPayload.findings)) {
    return jsonPayload;
  }
  return { ...jsonPayload, findings };
}
