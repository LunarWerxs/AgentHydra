/**
 * actionable-output-coverage — connections-arkitect check
 * ========================================================
 * Guards against silent wrappers: arkitect checks that spawn an external
 * tool (Lighthouse, bun test, playwright, lhci, etc.) but only emit a
 * pass/fail finding from the subprocess exit code, swallowing the
 * tool's own structured output.
 *
 * Every wrapper check must declare its contract explicitly:
 *
 *   export const audit = {
 *     id: "...",
 *     outputContract: "parsed-findings",   // tool output is parsed into findings
 *     // or "exit-code-only" if the tool genuinely emits nothing parseable
 *     ...
 *   };
 *
 * Without this declaration, a future regression (someone wraps a new tool
 * but never parses its output) is invisible — the FIX_QUEUE shows no
 * findings, so the AI thinks the check passed.
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check actionable-output-coverage
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFinding } from "@saydeploy/architect/core/finding";
import { discoverAudits } from "@saydeploy/architect/cli/discovery";

const VALID_CONTRACTS = new Set(["parsed-findings", "exit-code-only"]);

/** Files we know are helpers, not checks (start with `_`). */
function isHelperFile(name) {
  return path.basename(name).startsWith("_");
}

function readCheckSources(checksRoot) {
  const out = new Map();
  for (const dir of readdirSync(checksRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    walk(path.join(checksRoot, dir.name), out);
  }
  return out;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name.endsWith(".mjs") && !isHelperFile(entry.name)) {
      try {
        out.set(full, readFileSync(full, "utf8"));
      } catch {
        // skip unreadable
      }
    }
  }
}

/**
 * Source-level wrapper heuristic.
 *
 * A check is a "wrapper" if it spawns a subprocess to delegate work to an
 * external tool. The reliable signal is an explicit `child_process` import
 * (you can't call spawn/exec without one). We also catch checks that reuse
 * our shared test-runner helper.
 *
 * Bare `exec(` / `spawn(` calls are deliberately NOT used as signals
 * because `RegExp.prototype.exec` and similar method calls produce false
 * positives that would noise the check.
 */
function isWrapperCheckSource(source) {
  return (
    /from\s+["']node:child_process["']/.test(source) ||
    /from\s+["']child_process["']/.test(source) ||
    /require\(\s*["']node:child_process["']\s*\)/.test(source) ||
    /require\(\s*["']child_process["']\s*\)/.test(source) ||
    /from\s+["'][^"']*_test-runner(?:\.mjs)?["']/.test(source)
  );
}

/** Find the source file an audit came from by scanning sources for `id: "<x>"`. */
function locateAuditSource(auditId, sources) {
  const idMatcher = new RegExp(`id\\s*:\\s*['"]${escapeRegex(auditId)}['"]`);
  for (const [file, source] of sources) {
    if (idMatcher.test(source)) return { file, source };
  }
  return null;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relativize(absPath, root) {
  try {
    return path.relative(root, absPath).replace(/\\/g, "/");
  } catch {
    return absPath;
  }
}

export const audit = {
  id: "actionable-output-coverage",
  title: "Actionable Output Coverage",
  category: "meta",
  outputContract: "parsed-findings",
  defaultConfig: {
    // Cheap static scan, safe to include in --all.
    includeInAll: true,
    outputPath: "tmp/audits/ACTIONABLE_OUTPUT_COVERAGE_AUDIT.md",
  },
  async run(context) {
    const root = context.root;

    // Find the arkitect checks root regardless of where we run from.
    // Prefer the in-tree location; fall back to derived path via import.meta.
    const candidates = [
      path.resolve(root, "packages/connections-arkitect/src/checks"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    ].filter((p) => existsSync(p) && safeIsDir(p));

    if (candidates.length === 0) {
      return {
        failed: false,
        findings: [],
        jsonPayload: { wrappers: [], coverage: 0 },
        report: "# Actionable Output Coverage\n\n_Could not locate `src/checks` directory; skipping._\n\nErrors: 0\nWarnings: 0\n",
        outputPath: context.checkConfig.outputPath,
      };
    }

    const checksRoot = candidates[0];
    const sources = readCheckSources(checksRoot);
    const { audits } = await discoverAudits(checksRoot);

    const wrappers = [];
    const findings = [];

    for (const candidate of audits) {
      const located = locateAuditSource(candidate.id, sources);
      if (!located) continue;
      const { file, source } = located;
      const isWrapper = isWrapperCheckSource(source);
      if (!isWrapper) continue;

      const contract = candidate.outputContract;
      const relFile = relativize(file, root);

      wrappers.push({ id: candidate.id, file: relFile, contract: contract || null });

      if (!contract) {
        findings.push(
          createFinding({
            ruleId: "actionable-output-missing-contract",
            severity: "warning",
            filePath: relFile,
            line: 0,
            message:
              `Check \`${candidate.id}\` wraps a subprocess but does not declare ` +
              `\`outputContract\`. Add \`outputContract: "parsed-findings"\` (preferred) ` +
              `or \`outputContract: "exit-code-only"\` to the audit export, and parse the ` +
              `subprocess output into findings if possible.`,
            metadata: { checkId: candidate.id },
          }),
        );
        continue;
      }

      if (!VALID_CONTRACTS.has(contract)) {
        findings.push(
          createFinding({
            ruleId: "actionable-output-invalid-contract",
            severity: "error",
            filePath: relFile,
            line: 0,
            message:
              `Check \`${candidate.id}\` declares \`outputContract: "${contract}"\`. ` +
              `Valid values: ${[...VALID_CONTRACTS].map((c) => `"${c}"`).join(", ")}.`,
            metadata: { checkId: candidate.id, contract },
          }),
        );
        continue;
      }

      if (contract === "exit-code-only") {
        findings.push(
          createFinding({
            ruleId: "actionable-output-exit-code-only",
            severity: "warning",
            filePath: relFile,
            line: 0,
            message:
              `Check \`${candidate.id}\` is declared \`exit-code-only\` — the FIX_QUEUE ` +
              `cannot show specific failures inside the subprocess output. Consider ` +
              `parsing its output into findings so AI agents see actionable items.`,
            metadata: { checkId: candidate.id, contract },
          }),
        );
      }
    }

    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warnCount = findings.length - errorCount;

    return {
      failed: errorCount > 0,
      findings,
      jsonPayload: {
        wrappers,
        totalWrappers: wrappers.length,
        missingContract: findings.filter((f) => f.ruleId === "actionable-output-missing-contract").length,
        exitCodeOnly: findings.filter((f) => f.ruleId === "actionable-output-exit-code-only").length,
        invalid: findings.filter((f) => f.ruleId === "actionable-output-invalid-contract").length,
      },
      report: renderReport({ wrappers, findings, errorCount, warnCount }),
      outputPath: context.checkConfig.outputPath,
    };
  },
};

function safeIsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function renderReport({ wrappers, findings, errorCount, warnCount }) {
  const lines = [
    "# Actionable Output Coverage",
    "",
    "Guards against silent subprocess-wrapping checks. Every check that spawns an external tool must declare an `outputContract` so we know whether its findings are parsed (actionable) or only its exit code is consulted (silent).",
    "",
    `- **Wrapper checks detected:** ${wrappers.length}`,
    `- **Errors:** ${errorCount}`,
    `- **Warnings:** ${warnCount}`,
    "",
  ];

  if (findings.length > 0) {
    lines.push("## Findings", "");
    for (const f of findings) {
      lines.push(`- **${f.severity.toUpperCase()}** \`${f.ruleId}\` at \`${f.filePath}\`: ${f.message}`);
    }
    lines.push("");
  }

  lines.push("## Wrapper checks", "");
  lines.push("| Check | File | outputContract |");
  lines.push("| --- | --- | --- |");
  for (const w of wrappers) {
    lines.push(`| \`${w.id}\` | \`${w.file}\` | ${w.contract ? `\`${w.contract}\`` : "_missing_"} |`);
  }
  lines.push("");

  lines.push("## How to fix", "");
  lines.push("Add to the audit export:");
  lines.push("");
  lines.push("```js");
  lines.push("export const audit = {");
  lines.push('  id: "your-check",');
  lines.push('  outputContract: "parsed-findings", // or "exit-code-only"');
  lines.push("  ...");
  lines.push("};");
  lines.push("```");
  lines.push("");
  lines.push("Prefer `parsed-findings`: read the subprocess output file (or stdout) and emit one `createFinding(...)` per real issue. `exit-code-only` is allowed but warned because the AI can't act on what it can't see.");

  // Canonical plain footer the runner regex scans for — without this
  // the runner thinks the report has no findings and deletes it.
  lines.push("");
  lines.push(`Errors: ${errorCount}`);
  lines.push(`Warnings: ${warnCount}`);

  return lines.join("\n");
}
