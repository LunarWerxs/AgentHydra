/**
 * lighthouse — connections-arkitect check
 * ========================================
 * Two modes:
 *   1. Lightweight (default; runs in `--all`) — parses LHR JSON files
 *      already on disk under `.lighthouseci/`. If none exist or the data
 *      is older than `maxAgeMs`, emits a `lighthouse-stale-data` finding
 *      telling the AI to re-run the heavy variant.
 *   2. Heavy (`--run` flag) — runs Lighthouse CI itself to populate
 *      `.lighthouseci/`, then parses the results.
 *
 * The heavy variant requires a dev server on localhost:4173. The lightweight
 * variant doesn't need anything and is safe in every audit pass.
 *
 * Findings emitted (per URL):
 *   - lighthouse-<auditId>          (per failed assertion from lighthouserc.cjs)
 *   - lighthouse-category-<name>    (per poor category score)
 *   - lighthouse-stale-data         (cache missing or older than maxAgeMs)
 *   - lighthouse-lhr-parse-failed   (an LHR JSON file failed to parse)
 *   - lighthouse-no-data            (heavy run produced nothing)
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check lighthouse
 *   bun packages/connections-arkitect/bin/audit.mjs --check lighthouse --run
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { createFinding } from "@saydeploy/architect/core/finding";
import { DEFAULT_CACHE_MAX_AGE_MS, cacheAgeMs, formatAge, isRunMode, staleDataFinding } from "./_test-runner.mjs";

const require = createRequire(import.meta.url);

const DEFAULT_LHCI_DIR = ".lighthouseci";
const DEFAULT_LHCI_CONFIG = "scripts/config/lighthouserc.cjs";

function runCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code,
        signal,
        stdout: stdout.slice(-6000),
        stderr: stderr.slice(-3000),
        timedOut: signal !== null,
      });
    });
    child.on("error", (err) => {
      resolve({ exitCode: -1, signal: null, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}

/** Normalize an LHCI assertion entry into `{ level, options }`. */
function normalizeAssertion(value) {
  if (Array.isArray(value)) {
    const [level, options] = value;
    return { level: String(level || "warn"), options: options || {} };
  }
  if (value === "off") return null;
  if (typeof value === "string") return { level: value, options: {} };
  if (value && typeof value === "object") return { level: String(value.level || "warn"), options: value };
  return null;
}

/** Map LHCI level → arkitect severity. */
function severityForLevel(level) {
  if (level === "error") return "error";
  return "warning"; // 'warn' and unknown levels map to warning
}

/**
 * Evaluate a single assertion against an LHR audit result.
 * Returns { passed, actual, reason } or null if the audit is missing.
 *
 * Supports the subset of LHCI operators actually used in lighthouserc.cjs:
 *   - minScore (number, 0-1)
 *   - maxNumericValue (number, ms or bytes)
 */
function evaluateAssertion(auditId, options, lhr) {
  const auditResult = lhr.audits?.[auditId];
  if (!auditResult) return null;

  if (Object.prototype.hasOwnProperty.call(options, "maxNumericValue")) {
    if (auditResult.numericValue === null || auditResult.numericValue === undefined) {
      return { passed: true, actual: null, reason: "no numeric value" };
    }
    const actual = Number(auditResult.numericValue);
    const limit = Number(options.maxNumericValue);
    if (!Number.isFinite(actual)) return { passed: true, actual: null, reason: "no numeric value" };
    return {
      passed: actual <= limit,
      actual,
      reason: `${actual.toFixed(0)} > ${limit} (${auditResult.displayValue || ""})`.trim(),
    };
  }

  if (Object.prototype.hasOwnProperty.call(options, "minScore")) {
    if (auditResult.score === null || auditResult.score === undefined) {
      return { passed: true, actual: null, reason: "no score" };
    }
    const actual = Number(auditResult.score);
    const limit = Number(options.minScore);
    if (!Number.isFinite(actual)) return { passed: true, actual: null, reason: "no score" };
    return {
      passed: actual >= limit,
      actual,
      reason: `score=${actual.toFixed(2)} < ${limit}`,
    };
  }

  return null;
}

/** Read LHCI manifest.json and return the representative LHR file paths. */
function loadRepresentativeRuns(lhciDir) {
  const manifestPath = path.join(lhciDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    // Fall back to globbing lhr-*.json
    if (!existsSync(lhciDir)) return [];
    const files = readdirSync(lhciDir)
      .filter((f) => f.startsWith("lhr-") && f.endsWith(".json"))
      .map((f) => ({ url: f, jsonPath: path.join(lhciDir, f) }));
    return files;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(manifest)) return [];
  const reps = manifest.filter((e) => e.isRepresentativeRun !== false);
  return reps.map((e) => ({
    url: e.url || e.jsonPath || "",
    jsonPath: path.isAbsolute(e.jsonPath) ? e.jsonPath : path.join(lhciDir, path.basename(e.jsonPath || "")),
    summary: e.summary || {},
  }));
}

/**
 * Category thresholds — overall quality gates, independent of per-audit assertions.
 *
 * Performance is set to 0 for local-dev runs because Vite's unbundled ESM
 * serving (~700 modules, 60-70s load in headless Chrome) produces perf
 * scores that are 1-2 orders of magnitude worse than the production
 * CloudFront + S3 bundled build.  Measure prod perf separately.
 */
const CATEGORY_THRESHOLDS = {
  performance: 0,
  accessibility: 0.9,
  "best-practices": 0.9,
  seo: 0.9,
};

function categoryFindings(lhr, url) {
  const findings = [];
  const categories = lhr.categories || {};
  for (const [key, limit] of Object.entries(CATEGORY_THRESHOLDS)) {
    const cat = categories[key];
    if (!cat) continue;
    // A null score means the category had no applicable audits (e.g. all
    // audits were skipped).  Treat that as "not evaluated", not a failure.
    if (cat.score === null || cat.score === undefined) continue;
    const score = Number(cat.score);
    if (!Number.isFinite(score)) continue;
    if (score < limit) {
      findings.push(
        createFinding({
          ruleId: `lighthouse-category-${key}`,
          severity: "warning",
          filePath: url,
          line: 0,
          message: `${url}: ${cat.title || key} score = ${(score * 100).toFixed(0)} (threshold: ${(limit * 100).toFixed(0)}).`,
          metadata: { category: key, score, threshold: limit, url },
        }),
      );
    }
  }
  return findings;
}

/** Build findings from a single LHR file using the LHCI assertions. */
function findingsForLhr(lhr, url, assertions) {
  const findings = [];

  for (const [auditId, raw] of Object.entries(assertions)) {
    const norm = normalizeAssertion(raw);
    if (!norm) continue;
    const result = evaluateAssertion(auditId, norm.options, lhr);
    if (!result || result.passed) continue;
    const auditResult = lhr.audits[auditId] || {};
    findings.push(
      createFinding({
        ruleId: `lighthouse-${auditId}`,
        severity: severityForLevel(norm.level),
        filePath: url,
        line: 0,
        message:
          `${url}: ${auditResult.title || auditId} — ${result.reason}. ${auditResult.description ? stripMd(auditResult.description) : ""}`.trim(),
        metadata: {
          auditId,
          url,
          actual: result.actual,
          options: norm.options,
          level: norm.level,
        },
      }),
    );
  }

  return [...categoryFindings(lhr, url), ...findings];
}

function stripMd(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .slice(0, 240)
    .trim();
}

function loadLighthouserc(configPath) {
  // Lighthouserc is CJS; createRequire handles that from ESM.
  try {
    const cfg = require(configPath);
    return cfg?.ci?.assert?.assertions || {};
  } catch (err) {
    throw new Error(`Failed to load lighthouserc at ${configPath}: ${err.message}`, { cause: err });
  }
}

function buildReport({
  runMode,
  dataAge,
  maxAgeMs,
  refreshCommand,
  runResult,
  perUrlFindings,
  errorCount,
  warnCount,
  runError,
}) {
  const lines = ["# Lighthouse Audit", ""];

  lines.push(`- **Mode:** ${runMode ? "run (heavy — invoked LHCI)" : "parse (lightweight — read cached LHR)"}`);
  lines.push(`- **Data age:** ${formatAge(dataAge)} (refresh window: ${formatAge(maxAgeMs)})`);
  if (!runMode) {
    lines.push(`- **Refresh:** \`${refreshCommand}\``);
  }
  if (runError) {
    lines.push(`- **⚠️ Run error:** ${runError}`);
  }
  if (runMode) {
    lines.push(`- **Subprocess exit:** ${runResult.exitCode}${runResult.timedOut ? " (timed out)" : ""}`);
  }
  lines.push(`- **URLs analyzed:** ${perUrlFindings.length}`);
  lines.push(`- **Errors:** ${errorCount}`);
  lines.push(`- **Warnings:** ${warnCount}`);
  lines.push("");

  if (perUrlFindings.length === 0 && runMode) {
    lines.push("> No LHR files were parsed. See the subprocess output below to diagnose.");
    lines.push("");
  } else if (perUrlFindings.length === 0) {
    lines.push(`> No cached Lighthouse data on disk. Run \`${refreshCommand}\` to populate.`);
    lines.push("");
  }

  for (const entry of perUrlFindings) {
    const errs = entry.findings.filter((f) => f.severity === "error").length;
    const warns = entry.findings.filter((f) => f.severity !== "error").length;
    lines.push(`## ${entry.url} — ${entry.findings.length} (${errs > 0 ? "error" : "warning"})`);
    lines.push("");
    lines.push(`- Errors: ${errs}`);
    lines.push(`- Warnings: ${warns}`);
    lines.push("");
    if (entry.findings.length === 0) {
      lines.push("Clean.");
      lines.push("");
      continue;
    }
    for (const f of entry.findings) {
      lines.push(`- **${f.severity.toUpperCase()}** \`${f.ruleId}\` — ${f.message}`);
    }
    lines.push("");
  }

  if (runResult.stdout) {
    lines.push("## Subprocess stdout (tail)");
    lines.push("```");
    lines.push(runResult.stdout);
    lines.push("```");
  }
  if (runResult.stderr) {
    lines.push("");
    lines.push("## Subprocess stderr (tail)");
    lines.push("```");
    lines.push(runResult.stderr);
    lines.push("```");
  }

  // Canonical plain footer the audit runner regex scans for.
  // Without this, a report with only **bold** counts is treated as empty
  // and auto-deleted by runner.shouldKeepReport.
  lines.push("");
  lines.push(`Errors: ${errorCount}`);
  lines.push(`Warnings: ${warnCount}`);

  return lines.join("\n");
}

export const audit = {
  id: "lighthouse",
  title: "Lighthouse Performance",
  category: "tests",
  outputContract: "parsed-findings",
  defaultConfig: {
    // Lightweight mode (parse-only) is safe in --all. Heavy run requires --run.
    includeInAll: true,
    command: "bun",
    args: ["run", "audit:browser-perf:lighthouse"],
    timeoutMs: 240_000,
    /** Directory LHCI writes its LHR JSON + manifest to (relative to repo root). */
    lhciDir: DEFAULT_LHCI_DIR,
    /** Lighthouse CI config file — source of truth for assertion thresholds. */
    lhciConfigPath: DEFAULT_LHCI_CONFIG,
    /** Cache freshness window for the lightweight parse-only mode (default 24h). */
    maxAgeMs: DEFAULT_CACHE_MAX_AGE_MS,
    /** Shell command surfaced in stale-data findings so the AI knows what to run. */
    refreshCommand: "bun packages/connections-arkitect/bin/audit.mjs --check lighthouse --run",
    outputPath: "tmp/audits/LIGHTHOUSE_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const lhciDir = path.resolve(context.root, cfg.lhciDir || DEFAULT_LHCI_DIR);
    const lhciConfigPath = path.resolve(context.root, cfg.lhciConfigPath || DEFAULT_LHCI_CONFIG);
    const runMode = isRunMode(context.checkArgs);
    const manifestPath = path.join(lhciDir, "manifest.json");

    let runResult = { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false };
    let runError = "";

    // Heavy mode: invoke LHCI to populate `.lighthouseci/`.
    if (runMode) {
      runResult = await runCommand(cfg.command, cfg.args, context.root, cfg.timeoutMs);
    }

    let assertions;
    try {
      assertions = loadLighthouserc(lhciConfigPath);
    } catch (err) {
      runError = err.message;
      assertions = {};
    }

    const runs = loadRepresentativeRuns(lhciDir);
    const findings = [];
    const perUrlFindings = [];

    for (const run of runs) {
      let lhr;
      try {
        lhr = JSON.parse(readFileSync(run.jsonPath, "utf8"));
      } catch (err) {
        const finding = createFinding({
          ruleId: "lighthouse-lhr-parse-failed",
          severity: "error",
          filePath: run.jsonPath,
          line: 0,
          message: `Could not parse LHR at ${run.jsonPath}: ${err.message}`,
        });
        findings.push(finding);
        perUrlFindings.push({ url: run.url, findings: [finding] });
        continue;
      }
      const urlFindings = findingsForLhr(lhr, run.url || run.jsonPath, assertions);
      findings.push(...urlFindings);
      perUrlFindings.push({ url: run.url || run.jsonPath, findings: urlFindings });
    }

    // Lightweight mode: if no data on disk, emit a stale-data finding.
    if (!runMode && runs.length === 0) {
      findings.push(
        staleDataFinding({
          checkId: "lighthouse",
          ruleId: "lighthouse-stale-data",
          filePath: lhciDir,
          command: cfg.refreshCommand,
          ageMs: Number.POSITIVE_INFINITY,
          maxAgeMs: cfg.maxAgeMs,
          reason: `No Lighthouse data on disk at \`${cfg.lhciDir}\`.`,
        }),
      );
    } else if (!runMode && existsSync(manifestPath)) {
      // Data exists — check freshness.
      const age = cacheAgeMs(manifestPath);
      if (age > cfg.maxAgeMs) {
        findings.push(
          staleDataFinding({
            checkId: "lighthouse",
            ruleId: "lighthouse-stale-data",
            filePath: manifestPath,
            command: cfg.refreshCommand,
            ageMs: age,
            maxAgeMs: cfg.maxAgeMs,
            reason: `Lighthouse data is ${formatAge(age)} old (max ${formatAge(cfg.maxAgeMs)}).`,
          }),
        );
      }
    }

    // Heavy mode: if LHCI ran and produced no LHR files, that's an error.
    if (runMode && runs.length === 0) {
      const message = runResult.timedOut
        ? "Lighthouse subprocess timed out before producing LHR files."
        : runResult.exitCode !== 0
          ? `Lighthouse subprocess failed (exit ${runResult.exitCode}) and produced no LHR files at ${lhciDir}.`
          : `Lighthouse subprocess exited cleanly but produced no LHR files at ${lhciDir}. Is the dev server running on localhost:4173?`;
      findings.push(
        createFinding({
          ruleId: "lighthouse-no-data",
          severity: "error",
          filePath: lhciDir,
          line: 0,
          message,
          metadata: { exitCode: runResult.exitCode, timedOut: runResult.timedOut },
        }),
      );
    }

    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warnCount = findings.length - errorCount;
    const failed = errorCount > 0;
    const dataAge = existsSync(manifestPath) ? cacheAgeMs(manifestPath) : Number.POSITIVE_INFINITY;

    return {
      failed,
      findings,
      jsonPayload: {
        mode: runMode ? "run" : "parse",
        exitCode: runResult.exitCode,
        timedOut: runResult.timedOut,
        urlsAnalyzed: runs.length,
        dataAgeMs: dataAge,
        errors: errorCount,
        warnings: warnCount,
        findings,
      },
      report: buildReport({
        runMode,
        dataAge,
        maxAgeMs: cfg.maxAgeMs,
        refreshCommand: cfg.refreshCommand,
        runResult,
        perUrlFindings,
        errorCount,
        warnCount,
        runError,
      }),
      outputPath: cfg.outputPath,
    };
  },
};
