/**
 * cognitive-complexity — SonarSource Cognitive Complexity
 * =======================================================
 * Codebase-agnostic implementation of the SonarSource Cognitive Complexity
 * algorithm (Campbell, 2018). Where cyclomatic complexity counts decision
 * points, cognitive complexity penalizes *nested* flow-breakers, so deeply
 * indented logic scores worse than flat logic.
 *
 * Scoring rules (Sonar B1/B2/B3):
 *   B1 +1: if, else if, else, for, while, case, catch, ternary, recursion,
 *          goto/break/continue with label.
 *   B2 +nesting: each level of nesting adds incrementally.
 *   B3 ignored: method declaration itself, "shorthand" structures.
 *   Boolean ops: each run of like operators is +1; mixed runs split.
 *
 * Default threshold: 15 (Sonar's default).
 */
import fs from "node:fs/promises";
import path from "node:path";

import { extractFunctions } from "@saydeploy/architect/engines/code-quality/code-metrics-engine";
import { walkFiles } from "@saydeploy/architect/core/files";

export const audit = {
  id: "cognitive-complexity",
  title: "Cognitive complexity (SonarSource port)",
  category: "codeRisk",
  defaultConfig: {
    includeInAll: false,
    roots: ["src"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".rs", ".java"],
    threshold: 15,
    topN: 50,
    outputPath: "tmp/audits/COGNITIVE_COMPLEXITY_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const threshold = Number(cfg.threshold ?? 15);

    const files = await walkFiles({ root, roots: cfg.roots, extensions: cfg.extensions });
    const all = [];
    const findings = [];
    for (const rel of files) {
      const abs = path.resolve(root, rel);
      let text;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      for (const fn of extractFunctions(text)) {
        const entry = {
          key: `${rel}#${fn.name}@${fn.startLine}`,
          filePath: rel,
          line: fn.startLine,
          name: fn.name,
          cognitive: fn.cognitiveComplexity,
          cyclomatic: fn.cyclomaticComplexity,
        };
        all.push(entry);
        if (entry.cognitive >= threshold) {
          findings.push({
            ruleId: "cognitive-complexity-over-threshold",
            severity: entry.cognitive >= threshold * 2 ? "error" : "warning",
            filePath: rel,
            line: entry.line,
            message: `\`${fn.name}\` cognitive=${entry.cognitive} (CC=${entry.cyclomatic})`,
            metadata: { baselineKey: entry.key, ...entry },
          });
        }
      }
    }
    all.sort((a, b) => b.cognitive - a.cognitive);
    const top = all.slice(0, Number(cfg.topN ?? 50));

    const baselineMap = new Map((context.baseline?.scores ?? []).map((e) => [e.key, e.cognitive]));
    const drift = [];
    for (const entry of all) {
      const base = baselineMap.get(entry.key);
      if (base !== undefined && entry.cognitive > base) {
        drift.push({ ...entry, baselineCognitive: base, delta: entry.cognitive - base });
      }
    }

    return {
      failed: drift.length > 0,
      findings,
      jsonPayload: { threshold, all, top, drift, findings },
      baselineDocument: {
        version: 1,
        generatedAt: new Date().toISOString(),
        scores: all.map(({ key, cognitive }) => ({ key, cognitive })),
      },
      outputPath: cfg.outputPath,
      report: renderReport({ all, top, drift, threshold, findings }),
    };
  },
};

function renderReport({ all, top, drift, threshold, findings }) {
  const lines = [
    "# Cognitive Complexity Audit",
    "",
    "_SonarSource cognitive complexity — penalizes nesting._",
    "",
    `- Functions analyzed: ${all.length}`,
    `- Threshold: ${threshold}`,
    `- Over threshold: ${findings.length}`,
    `- Drift since baseline: ${drift.length}`,
    "",
  ];
  if (drift.length > 0) {
    lines.push("## ⚠️ New cognitive load since baseline", "");
    for (const d of drift.slice(0, 40)) {
      lines.push(`- \`${d.filePath}:${d.line}\` · \`${d.name}\` ${d.baselineCognitive} → ${d.cognitive}`);
    }
    lines.push("");
  }
  lines.push(`## Top ${top.length} hardest to read`, "");
  for (const e of top) {
    lines.push(`- \`${e.filePath}:${e.line}\` · \`${e.name}\` — cog **${e.cognitive}** (CC=${e.cyclomatic})`);
  }
  if (all.length === 0) lines.push("- (no functions found)", "");
  return `${lines.join("\n")}\n`;
}
