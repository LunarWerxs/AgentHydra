/**
 * unit-tests — connections-arkitect check
 * ========================================
 * Two modes:
 *   1. Lightweight (default; runs in `--all`) — reads cached test results
 *      from `tmp/audit-cache/unit-tests-results.json`. If the cache is
 *      missing or stale (>maxAgeMs), emits a `unit-tests-stale-data`
 *      finding telling the AI to re-run with `--run`.
 *   2. Heavy (`--run` flag) — invokes `bun run test:full`, writes the
 *      result to the cache, and emits findings for any failures.
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check unit-tests
 *   bun packages/connections-arkitect/bin/audit.mjs --check unit-tests --run
 */

import {
  DEFAULT_CACHE_MAX_AGE_MS,
  buildTestFindings,
  cacheAgeMs,
  cacheFilePath,
  formatAge,
  isRunMode,
  parseBunTestOutput,
  readCacheJson,
  renderTestReport,
  runTestCommand,
  staleDataFinding,
  writeCacheJson,
} from "./_test-runner.mjs";

export const UNIT_TESTS_DEFAULTS = {
  command: "bun",
  args: ["run", "test:full"],
  timeoutMs: 300_000,
  cacheFile: "unit-tests-results.json",
  refreshCommand: "bun packages/connections-arkitect/bin/audit.mjs --check unit-tests --run",
  maxAgeMs: DEFAULT_CACHE_MAX_AGE_MS,
  outputPath: "tmp/audits/UNIT_TESTS_AUDIT.md",
};

const TITLE = "Unit Tests";
const RULE_PREFIX = "unit-tests";

/** Heavy mode: run the test suite, write cache, return findings. */
export async function runUnitTestsHeavy({ root, command, args, timeoutMs, cacheFile }) {
  const result = await runTestCommand(command, args, { cwd: root, timeoutMs });
  const counts = parseBunTestOutput(result.stdout);
  const cachePath = cacheFilePath(root, cacheFile);

  const cachePayload = {
    ranAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    counts,
    stdoutTail: result.stdout.slice(-12_000),
    stderrTail: result.stderr.slice(-4000),
  };
  writeCacheJson(cachePath, cachePayload);

  const findings = buildTestFindings({ title: TITLE, ruleIdPrefix: RULE_PREFIX, result, counts });
  const failed = findings.some((f) => f.severity === "error");

  return {
    failed,
    findings,
    jsonPayload: { mode: "run", ...counts, exitCode: result.exitCode, timedOut: result.timedOut, cachePath },
    report: renderTestReport({ title: TITLE, result, counts, findings }),
  };
}

/** Lightweight mode: read cache, emit findings from cached data. */
function lightUnitTests({ root, cacheFile, maxAgeMs, refreshCommand }) {
  const cachePath = cacheFilePath(root, cacheFile);
  const cached = readCacheJson(cachePath);
  const age = cacheAgeMs(cachePath);

  if (!cached) {
    const finding = staleDataFinding({
      checkId: "unit-tests",
      ruleId: "unit-tests-stale-data",
      filePath: cachePath,
      command: refreshCommand,
      ageMs: Number.POSITIVE_INFINITY,
      maxAgeMs,
      reason: `No cached unit-test results at \`${cachePath}\`.`,
    });
    return {
      failed: false,
      findings: [finding],
      jsonPayload: { mode: "parse", cached: false, cachePath },
      report: renderLightReport({ cached: null, age, maxAgeMs, refreshCommand, findings: [finding] }),
    };
  }

  const counts = cached.counts || { passed: 0, failed: 0, errors: 0 };
  const stale = age > maxAgeMs;

  // Reuse buildTestFindings against the cached result shape.
  const pseudoResult = {
    exitCode: cached.exitCode ?? 0,
    timedOut: cached.timedOut ?? false,
    stdout: cached.stdoutTail || "",
    stderr: cached.stderrTail || "",
  };
  const findings = buildTestFindings({ title: TITLE, ruleIdPrefix: RULE_PREFIX, result: pseudoResult, counts });

  if (stale) {
    findings.push(
      staleDataFinding({
        checkId: "unit-tests",
        ruleId: "unit-tests-stale-data",
        filePath: cachePath,
        command: refreshCommand,
        ageMs: age,
        maxAgeMs,
        reason: `Cached unit-test results are ${formatAge(age)} old (max ${formatAge(maxAgeMs)}).`,
      }),
    );
  }

  const failed = findings.some((f) => f.severity === "error");

  return {
    failed,
    findings,
    jsonPayload: { mode: "parse", cached: true, age, stale, cachePath, ...counts },
    report: renderLightReport({ cached, age, maxAgeMs, refreshCommand, findings }),
  };
}

function renderLightReport({ cached, age, maxAgeMs, refreshCommand, findings }) {
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.length - errorCount;
  const lines = [
    `# ${TITLE}`,
    "",
    "- **Mode:** parse (lightweight — reading cached results)",
    `- **Data age:** ${formatAge(age)} (refresh window: ${formatAge(maxAgeMs)})`,
    `- **Refresh:** \`${refreshCommand}\``,
  ];

  if (cached) {
    lines.push(`- **Ran at:** ${cached.ranAt || "unknown"}`);
    lines.push(`- **Exit code:** ${cached.exitCode}`);
    if (cached.counts) {
      lines.push(`- **Passed:** ${cached.counts.passed}`);
      lines.push(`- **Failed:** ${cached.counts.failed}`);
      if (cached.counts.errors > 0) lines.push(`- **Errors (process):** ${cached.counts.errors}`);
    }
  } else {
    lines.push("- **Cache:** missing — never run.");
  }
  lines.push(`- **Errors:** ${errorCount}`);
  lines.push(`- **Warnings:** ${warnCount}`);
  lines.push("");

  if (findings.length > 0) {
    lines.push("## Findings", "");
    for (const f of findings) {
      lines.push(`- **${f.severity.toUpperCase()}** \`${f.ruleId}\` — ${f.message}`);
    }
    lines.push("");
  }

  lines.push("");
  lines.push(`Errors: ${errorCount}`);
  lines.push(`Warnings: ${warnCount}`);
  return lines.join("\n");
}

export const audit = {
  id: "unit-tests",
  title: TITLE,
  category: "tests",
  outputContract: "parsed-findings",
  defaultConfig: {
    ...UNIT_TESTS_DEFAULTS,
    includeInAll: true,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = isRunMode(context.checkArgs)
      ? await runUnitTestsHeavy({
          root: context.root,
          command: cfg.command,
          args: cfg.args,
          timeoutMs: cfg.timeoutMs,
          cacheFile: cfg.cacheFile,
        })
      : lightUnitTests({
          root: context.root,
          cacheFile: cfg.cacheFile,
          maxAgeMs: cfg.maxAgeMs,
          refreshCommand: cfg.refreshCommand,
        });

    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      report: result.report,
      outputPath: cfg.outputPath,
    };
  },
};

