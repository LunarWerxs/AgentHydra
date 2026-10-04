/**
 * cyclomatic-complexity — McCabe CC per function
 * ==============================================
 * Codebase-agnostic CC reporter (lizard-style, no AST). Flags functions whose
 * cyclomatic complexity exceeds a threshold. Default 15 matches lizard's
 * default; cargo-crap uses 10. Configure per project.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { extractFunctions } from "@saydeploy/architect/engines/code-quality/code-metrics-engine";
import { walkFiles } from "@saydeploy/architect/core/files";

export const audit = {
  id: "cyclomatic-complexity",
  title: "Cyclomatic complexity (McCabe / lizard port)",
  category: "codeRisk",
  defaultConfig: {
    includeInAll: false,
    roots: ["src"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".rs", ".java"],
    threshold: 15,
    topN: 50,
    outputPath: "tmp/audits/CYCLOMATIC_COMPLEXITY_AUDIT.md",
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
          complexity: fn.cyclomaticComplexity,
          nloc: fn.nloc,
          paramCount: fn.paramCount,
        };
        all.push(entry);
        if (entry.complexity >= threshold) {
          findings.push({
            ruleId: "cyclomatic-complexity-over-threshold",
            severity: entry.complexity >= threshold * 2 ? "error" : "warning",
            filePath: rel,
            line: entry.line,
            message: `\`${fn.name}\` CC=${entry.complexity} (NLOC=${fn.nloc}, params=${fn.paramCount})`,
            metadata: { baselineKey: entry.key, ...entry },
          });
        }
      }
    }
    all.sort((a, b) => b.complexity - a.complexity);
    const top = all.slice(0, Number(cfg.topN ?? 50));

    const baselineMap = new Map((context.baseline?.scores ?? []).map((e) => [e.key, e.complexity]));
    const drift = [];
    for (const entry of all) {
      const base = baselineMap.get(entry.key);
      if (base !== undefined && entry.complexity > base) {
        drift.push({ ...entry, baselineComplexity: base, delta: entry.complexity - base });
      }
    }

    return {
      failed: drift.length > 0,
      findings,
      jsonPayload: { threshold, all, top, drift, findings },
      baselineDocument: {
        version: 1,
        generatedAt: new Date().toISOString(),
        scores: all.map(({ key, complexity }) => ({ key, complexity })),
      },
      outputPath: cfg.outputPath,
      report: renderReport({ all, top, drift, threshold, findings }),
    };
  },
};

function renderReport({ all, top, drift, threshold, findings }) {
  const lines = [
    "# Cyclomatic Complexity Audit",
    "",
    "_McCabe CC per function. Threshold-driven flagging._",
    "",
    `- Functions analyzed: ${all.length}`,
    `- Threshold: ${threshold}`,
    `- Over threshold: ${findings.length}`,
    `- Drift since baseline: ${drift.length}`,
    "",
  ];
  if (drift.length > 0) {
    lines.push("## ⚠️ New complexity since baseline", "");
    for (const d of drift.slice(0, 40)) {
      lines.push(`- \`${d.filePath}:${d.line}\` · \`${d.name}\` ${d.baselineComplexity} → ${d.complexity}`);
    }
    lines.push("");
  }
  lines.push(`## Top ${top.length} most complex`, "");
  for (const e of top) {
    lines.push(
      `- \`${e.filePath}:${e.line}\` · \`${e.name}\` — CC **${e.complexity}**, NLOC ${e.nloc}, params ${e.paramCount}`,
    );
  }
  if (all.length === 0) lines.push("- (no functions found)", "");
  return `${lines.join("\n")}\n`;
}
