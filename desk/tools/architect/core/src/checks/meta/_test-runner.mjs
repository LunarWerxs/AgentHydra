/**
 * Shared helpers for test-runner-wrapping arkitect checks.
 *
 * Consumed by:
 *   - meta/unit-tests.mjs
 *   - meta/e2e-tests.mjs
 *
 * Centralizes:
 *   - subprocess execution with timeout/signal handling
 *   - bun-test stdout parsing (pass/fail/error counts + failing block names)
 *   - structured-findings rendering with the canonical
 *     `Errors: N / Warnings: M` footer the runner scans for
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";

/**
 * Default cache staleness window: 24 hours.
 * After this, the lightweight check emits a `*-stale-data` finding telling
 * the AI to re-run the heavy `--run` variant.
 */
export const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Cache directory that survives `tmp/audits/` wipes performed by the runner. */
export const CACHE_DIR = "tmp/audit-cache";

export function cacheFilePath(root, name) {
  return path.resolve(root, CACHE_DIR, name);
}

/** Returns the cache age in ms, or `Infinity` if the file is missing. */
export function cacheAgeMs(filePath) {
  if (!existsSync(filePath)) return Number.POSITIVE_INFINITY;
  try {
    const stat = statSync(filePath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function readCacheJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeCacheJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function formatAge(ms) {
  if (!Number.isFinite(ms)) return "never";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Build a "stale-data" finding directing the AI to rerun the heavy
 * variant of a check (or a higher-level package script).
 */
export function staleDataFinding({ checkId, ruleId, filePath, command, ageMs, maxAgeMs, reason }) {
  const ageLabel = formatAge(ageMs);
  const limitLabel = formatAge(maxAgeMs);
  const message = reason
    ? `${reason} Run \`${command}\` to refresh.`
    : `Cached data for \`${checkId}\` is ${ageLabel} old (max ${limitLabel}). Run \`${command}\` to refresh.`;
  return createFinding({
    ruleId,
    severity: "warning",
    filePath: filePath || checkId,
    line: 0,
    message,
    metadata: { checkId, command, ageMs, maxAgeMs },
  });
}

export function isRunMode(checkArgs) {
  return Array.isArray(checkArgs) && checkArgs.includes("--run");
}

export function runTestCommand(command, args, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("close", (code, signal) => {
      resolve({
        exitCode: code,
        signal,
        stdout: stdout.slice(-12_000),
        stderr: stderr.slice(-4000),
        timedOut: signal === "SIGTERM" || false,
      });
    });

    child.on("error", (err) => {
      resolve({
        exitCode: -1,
        signal: null,
        stdout: "",
        stderr: err.message,
        timedOut: false,
      });
    });
  });
}

/** Parse `bun test` summary lines like `123 pass`, `4 fail`, `1 error`. */
export function parseBunTestOutput(stdout) {
  const passMatch = stdout.match(/(\d+)\s+pass/);
  const failMatch = stdout.match(/(\d+)\s+fail/);
  const errorMatch = stdout.match(/(\d+)\s+error/);
  return {
    passed: passMatch ? Number.parseInt(passMatch[1], 10) : 0,
    failed: failMatch ? Number.parseInt(failMatch[1], 10) : 0,
    errors: errorMatch ? Number.parseInt(errorMatch[1], 10) : 0,
  };
}

/** Extract failing-test names from bun stdout `(fail) ...` blocks. */
export function extractFailureBlocks(stdout, limit = 50) {
  const blocks = stdout.match(/\(fail\).*?(?=\n\s*$|\n\s*\n)/gs);
  if (!blocks) return [];
  return blocks.slice(0, limit).map((b) => b.trim().split("\n")[0]);
}

/**
 * Build a findings list for a test run.
 * Always returns a summary finding when tests fail, plus one finding per failing test.
 */
export function buildTestFindings({ title, ruleIdPrefix, result, counts }) {
  const findings = [];
  const { passed, failed, errors } = counts;
  const testFailed = result.exitCode !== 0 || failed > 0 || errors > 0;

  if (testFailed) {
    findings.push(
      createFinding({
        ruleId: `${ruleIdPrefix}-failed`,
        severity: "error",
        filePath: title,
        line: 0,
        message: `${title} failed: ${passed} pass, ${failed} fail, ${errors} errors (exit ${result.exitCode}).`,
        metadata: { passed, failed, errors, exitCode: result.exitCode },
      }),
    );

    for (const name of extractFailureBlocks(result.stdout)) {
      findings.push(
        createFinding({
          ruleId: `${ruleIdPrefix}-case`,
          severity: "error",
          filePath: title,
          line: 0,
          message: name,
        }),
      );
    }
  }

  if (result.timedOut) {
    findings.push(
      createFinding({
        ruleId: `${ruleIdPrefix}-timeout`,
        severity: "error",
        filePath: title,
        line: 0,
        message: `${title} timed out before completing.`,
      }),
    );
  }

  return findings;
}

/**
 * Render a markdown report ending in the canonical
 * `Errors: N\nWarnings: M\n` footer the audit runner scans for.
 */
export function renderTestReport({ title, result, counts, findings }) {
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.length - errorCount;
  const failureBlocks = extractFailureBlocks(result.stdout);

  const lines = [`# ${title}`, "", `- **Exit code:** ${result.exitCode}`];

  if (result.timedOut) {
    lines.push("- **⚠️ Timed out** — tests did not complete within the configured timeout.");
  }

  if (counts.passed > 0 || counts.failed > 0 || counts.errors > 0) {
    lines.push(`- **Passed:** ${counts.passed}`);
    lines.push(`- **Failed:** ${counts.failed}`);
    if (counts.errors > 0) lines.push(`- **Errors:** ${counts.errors}`);
  }

  if (counts.failed > 0 || result.exitCode !== 0) {
    lines.push("");
    lines.push("## Test failures");
    lines.push("");
    if (failureBlocks.length > 0) {
      for (const name of failureBlocks) {
        lines.push(`- ${name}`);
      }
    } else {
      lines.push("See subprocess stdout below for details.");
    }
  }

  if (result.stderr) {
    lines.push("");
    lines.push("## stderr");
    lines.push("```");
    lines.push(result.stderr.slice(-2000));
    lines.push("```");
  }

  if (result.stdout) {
    lines.push("");
    lines.push("## stdout (tail)");
    lines.push("```");
    lines.push(result.stdout.slice(-3000));
    lines.push("```");
  }

  lines.push("");
  lines.push(`Errors: ${errorCount}`);
  lines.push(`Warnings: ${warnCount}`);

  return lines.join("\n");
}
