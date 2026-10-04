/**
 * maintainability-index — radon-style MI per file
 * ===============================================
 * Port of the SEI Maintainability Index (as used by radon and Visual Studio):
 *
 *   MI = max(0, 100 * (171 - 5.2 ln V - 0.23 G - 16.2 ln L + 50 sin(sqrt(2.4 C))) / 171)
 *
 * - V = Halstead volume
 * - G = total cyclomatic complexity
 * - L = source lines of code
 * - C = comment ratio
 *
 * Common interpretation: ≥20 maintainable, 10-19 moderate, <10 difficult.
 * Default failure threshold is 10 (the "difficult" cliff).
 */
import fs from "node:fs/promises";
import path from "node:path";

import { fileMaintainabilityIndex } from "@saydeploy/architect/engines/code-quality/code-metrics-engine";
import { walkFiles } from "@saydeploy/architect/core/files";

export const audit = {
  id: "maintainability-index",
  title: "Maintainability Index (radon port)",
  category: "codeRisk",
  defaultConfig: {
    includeInAll: false,
    roots: ["src"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py"],
    threshold: 10,
    moderateThreshold: 20,
    topN: 30,
    minFileBytes: 200,
    outputPath: "tmp/audits/MAINTAINABILITY_INDEX_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const threshold = Number(cfg.threshold ?? 10);
    const moderate = Number(cfg.moderateThreshold ?? 20);
    const minBytes = Number(cfg.minFileBytes ?? 200);

    const files = await walkFiles({ root, roots: cfg.roots, extensions: cfg.extensions });
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
      if (text.length < minBytes) continue;
      const mi = fileMaintainabilityIndex(text);
      const entry = { key: rel, filePath: rel, mi };
      scored.push(entry);
      if (mi < threshold) {
        findings.push({
          ruleId: "maintainability-index-difficult",
          severity: "error",
          filePath: rel,
          line: 1,
          message: `MI=${mi.toFixed(1)} (below threshold ${threshold})`,
          metadata: { baselineKey: rel, mi },
        });
      } else if (mi < moderate) {
        findings.push({
          ruleId: "maintainability-index-moderate",
          severity: "warning",
          filePath: rel,
          line: 1,
          message: `MI=${mi.toFixed(1)} (moderate; threshold ${moderate})`,
          metadata: { baselineKey: rel, mi },
        });
      }
    }
    scored.sort((a, b) => a.mi - b.mi);
    const top = scored.slice(0, Number(cfg.topN ?? 30));

    const baselineMap = new Map((context.baseline?.scores ?? []).map((e) => [e.key, e.mi]));
    const drift = [];
    for (const entry of scored) {
      const base = baselineMap.get(entry.key);
      if (base !== undefined && entry.mi < base - 0.5) {
        drift.push({ ...entry, baselineMI: base, delta: base - entry.mi });
      }
    }

    return {
      failed: drift.length > 0 || findings.some((f) => f.severity === "error"),
      findings,
      jsonPayload: { threshold, moderate, scored, top, drift, findings },
      baselineDocument: {
        version: 1,
        generatedAt: new Date().toISOString(),
        scores: scored.map(({ key, mi }) => ({ key, mi })),
      },
      outputPath: cfg.outputPath,
      report: renderReport({ scored, top, drift, threshold, moderate, findings }),
    };
  },
};

function renderReport({ scored, top, drift, threshold, moderate, findings }) {
  const lines = [
    "# Maintainability Index Audit",
    "",
    `_Files scored 0..100; <${threshold} difficult, <${moderate} moderate._`,
    "",
    `- Files scored: ${scored.length}`,
    `- Difficult/moderate: ${findings.length}`,
    `- Drift since baseline: ${drift.length}`,
    "",
  ];
  if (drift.length > 0) {
    lines.push("## ⚠️ MI dropped since baseline", "");
    for (const d of drift.slice(0, 40)) {
      lines.push(`- \`${d.filePath}\` ${d.baselineMI.toFixed(1)} → ${d.mi.toFixed(1)} (−${d.delta.toFixed(1)})`);
    }
    lines.push("");
  }
  lines.push(`## Lowest-MI ${top.length} files`, "");
  for (const e of top) {
    lines.push(`- \`${e.filePath}\` — MI **${e.mi.toFixed(1)}**`);
  }
  if (scored.length === 0) lines.push("- (no files matched)", "");
  return `${lines.join("\n")}\n`;
}
