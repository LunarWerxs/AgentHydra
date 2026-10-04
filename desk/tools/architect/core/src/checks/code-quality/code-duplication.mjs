/**
 * code-duplication — token-based clone detector (jscpd port)
 * ==========================================================
 * Surfaces copy-paste hotspots using a Rabin-Karp rolling-hash over a
 * language-agnostic token stream (the same approach jscpd takes).
 *
 * Defaults match jscpd: minTokens=50, minLines=5. Tuning down catches smaller
 * duplicates; tuning up keeps the report focused on serious copies.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { detectClones } from "@saydeploy/architect/engines/code-quality/code-duplication-engine";
import { walkFiles } from "@saydeploy/architect/core/files";

export const audit = {
  id: "code-duplication",
  title: "Code duplication (jscpd port)",
  category: "codeRisk",
  defaultConfig: {
    includeInAll: false,
    roots: ["src"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".rs", ".java"],
    minTokens: 50,
    minLines: 5,
    topN: 30,
    outputPath: "tmp/audits/CODE_DUPLICATION_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const minTokens = Number(cfg.minTokens ?? 50);
    const minLines = Number(cfg.minLines ?? 5);

    const files = await walkFiles({ root, roots: cfg.roots, extensions: cfg.extensions });
    const sources = [];
    for (const rel of files) {
      const abs = path.resolve(root, rel);
      try {
        const text = await fs.readFile(abs, "utf8");
        sources.push({ path: rel, text });
      } catch {
        // ignore unreadable files
      }
    }
    const clones = detectClones(sources, { minTokens, minLines });
    const top = clones.slice(0, Number(cfg.topN ?? 30));

    const findings = [];
    for (const clone of clones) {
      const key = clone.instances
        .map((i) => `${i.path}:${i.startLine}-${i.endLine}`)
        .sort()
        .join("|");
      for (const inst of clone.instances) {
        findings.push({
          ruleId: "code-duplication-clone",
          severity: clone.instances.length >= 4 ? "error" : "warning",
          filePath: inst.path,
          line: inst.startLine,
          message:
            `clone (${clone.tokens} tokens, ${inst.endLine - inst.startLine + 1} lines) shared with ` +
            clone.instances
              .filter((other) => other !== inst)
              .slice(0, 3)
              .map((other) => `\`${other.path}:${other.startLine}\``)
              .join(", "),
          metadata: { baselineKey: key, clone },
        });
      }
    }

    const baselineKeys = new Set(context.baseline?.clones ?? []);
    const drift = findings.filter((f) => !baselineKeys.has(f.metadata.baselineKey));

    return {
      failed: drift.length > 0,
      findings,
      jsonPayload: { minTokens, minLines, clones, top, drift, findings },
      baselineDocument: {
        version: 1,
        generatedAt: new Date().toISOString(),
        clones: [...new Set(findings.map((f) => f.metadata.baselineKey))],
      },
      outputPath: cfg.outputPath,
      report: renderReport({ clones, top, drift, minTokens, minLines }),
    };
  },
};

function renderReport({ clones, top, drift, minTokens, minLines }) {
  const lines = [
    "# Code Duplication Audit",
    "",
    `_Token-based copy/paste clones (minTokens=${minTokens}, minLines=${minLines})._`,
    "",
    `- Clone clusters: ${clones.length}`,
    `- New since baseline: ${drift.length}`,
    "",
    `## Top ${top.length}`,
    "",
  ];
  for (const c of top) {
    const where = c.instances.map((i) => `\`${i.path}:${i.startLine}-${i.endLine}\``).join(", ");
    lines.push(`- ${c.tokens} tokens across ${c.instances.length} sites: ${where}`);
  }
  if (top.length === 0) lines.push("- (no clones)", "");
  return `${lines.join("\n")}\n`;
}
