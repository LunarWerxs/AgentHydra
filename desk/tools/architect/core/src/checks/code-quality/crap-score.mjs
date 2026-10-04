/**
 * crap-score — Change Risk Anti-Patterns
 * ======================================
 * Ports the CRAP score from cargo-crap / CRAP4J. CRAP combines cyclomatic
 * complexity with test coverage to flag functions that are both complex AND
 * under-tested:
 *
 *     CRAP(m) = comp(m)^2 * (1 - cov(m)/100)^3 + comp(m)
 *
 * Codebase-agnostic: takes a `roots` list, a file `extensions` list, and an
 * `lcovPath` pointing to any LCOV report (cargo llvm-cov, c8, nyc, istanbul,
 * vitest's coverage-v8/coverage-istanbul, jest's lcov.info, etc.).
 *
 * Output mirrors cargo-crap's flagging model:
 *   - default threshold = 30 (anything above is "in CRAP territory")
 *   - --missing strategy = pessimistic|optimistic|skip
 */
import fs from "node:fs/promises";
import path from "node:path";

import { extractFunctions } from "@saydeploy/architect/engines/code-quality/code-metrics-engine";
import { findLcovFile, functionCoverage, loadLcov } from "@saydeploy/architect/engines/code-quality/lcov-engine";
import { CRAP_DEFAULT_THRESHOLD, crapScore, scoreFunctions } from "@saydeploy/architect/engines/code-quality/crap-engine";
import { walkFiles } from "@saydeploy/architect/core/files";

export const audit = {
  id: "crap-score",
  title: "CRAP score (cargo-crap port)",
  category: "codeRisk",
  defaultConfig: {
    includeInAll: false,
    roots: ["src"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
    lcovPath: "coverage/lcov.info",
    threshold: CRAP_DEFAULT_THRESHOLD,
    missing: "pessimistic",
    topN: 50,
    outputPath: "tmp/audits/CRAP_SCORE_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const threshold = Number(cfg.threshold ?? CRAP_DEFAULT_THRESHOLD);
    const missing = cfg.missing ?? "pessimistic";

    const files = await walkFiles({ root, roots: cfg.roots, extensions: cfg.extensions });
    const lcovAbs = path.resolve(root, cfg.lcovPath);
    const lcov = await loadLcov(lcovAbs);

    const scored = [];
    const findings = [];
    for (const rel of files) {
      const abs = path.resolve(root, rel);
      let text;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const functions = extractFunctions(text);
      const lcovFile = lcov.missing ? null : findLcovFile(lcov.files, rel, root);
      const fnsScored = scoreFunctions(functions, {
        coverageFor: (fn) => (lcovFile ? functionCoverage(lcovFile, fn.startLine, fn.endLine) : null),
        missing,
      });
      for (const fn of fnsScored) {
        const entry = {
          key: `${rel}#${fn.name}@${fn.startLine}`,
          filePath: rel,
          line: fn.startLine,
          name: fn.name,
          complexity: fn.cyclomaticComplexity,
          coveragePercent: fn.coveragePercent,
          coverageMissing: fn.coverageMissing,
          score: fn.crapScore,
        };
        scored.push(entry);
        if (entry.score >= threshold) {
          findings.push({
            ruleId: "crap-score-over-threshold",
            severity: entry.score >= threshold * 2 ? "error" : "warning",
            filePath: rel,
            line: entry.line,
            message:
              `\`${fn.name}\` CRAP=${entry.score.toFixed(1)} (CC=${fn.cyclomaticComplexity}, ` +
              `cov=${entry.coverageMissing ? "missing" : `${entry.coveragePercent.toFixed(0)}%`})`,
            metadata: { baselineKey: entry.key, ...entry },
          });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Number(cfg.topN ?? 50));
    const baselineMap = baselineScores(context.baseline);
    const drift = [];
    for (const entry of scored) {
      const baseScore = baselineMap.get(entry.key);
      if (baseScore !== undefined && entry.score > baseScore + 0.0001) {
        drift.push({ ...entry, baselineScore: baseScore, delta: entry.score - baseScore });
      }
    }

    return {
      failed: lcov.missing ? false : drift.length > 0 || findings.some((f) => f.severity === "error"),
      findings,
      jsonPayload: {
        threshold,
        missing,
        lcovMissing: lcov.missing,
        scored,
        top,
        drift,
        findings,
      },
      baselineDocument: {
        version: 1,
        generatedAt: new Date().toISOString(),
        scores: scored.map(({ key, score }) => ({ key, score })),
      },
      outputPath: cfg.outputPath,
      report: renderReport({ scored, top, drift, threshold, lcov, missing, findings }),
    };
  },
};

function baselineScores(baseline) {
  const map = new Map();
  for (const entry of baseline?.scores ?? []) {
    map.set(entry.key, entry.score);
  }
  return map;
}

function renderReport({ scored, top, drift, threshold, lcov, missing, findings }) {
  const lines = [
    "# CRAP Score Audit",
    "",
    "_Change Risk Anti-Patterns: complex AND under-tested functions. Lower is better._",
    "",
    `- Functions scored: ${scored.length}`,
    `- Threshold: ${threshold}`,
    `- Missing-coverage strategy: ${missing}`,
    `- LCOV: ${lcov.missing ? `MISSING (\`${lcov.path}\`) — coverage treated as ${missing}` : "loaded"}`,
    `- Over threshold: ${findings.length}`,
    `- Drift (new since baseline): ${drift.length}`,
    "",
  ];
  if (drift.length > 0) {
    lines.push("## ⚠️ Regressions since baseline", "");
    for (const d of drift.slice(0, 40)) {
      lines.push(
        `- \`${d.filePath}:${d.line}\` · \`${d.name}\` ${d.baselineScore.toFixed(1)} → ${d.score.toFixed(1)} (+${d.delta.toFixed(1)})`,
      );
    }
    if (drift.length > 40) lines.push(`- …and ${drift.length - 40} more`);
    lines.push("");
  }
  lines.push(`## Top ${top.length} by CRAP score`, "");
  for (const entry of top) {
    const cov = entry.coverageMissing ? "missing" : `${entry.coveragePercent.toFixed(0)}%`;
    lines.push(
      `- \`${entry.filePath}:${entry.line}\` · \`${entry.name}\` — CRAP **${entry.score.toFixed(1)}** (CC=${entry.complexity}, cov=${cov})`,
    );
  }
  if (scored.length === 0) lines.push("- (no functions found)", "");
  return `${lines.join("\n")}\n`;
}

export { crapScore };
