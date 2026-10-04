/**
 * churn-hotspots — git churn × complexity (Tornhill / CodeScene port)
 * ===================================================================
 * Combines git change frequency with code complexity to find the files where
 * refactoring pays the most: they're both complex AND under active change.
 * Idea from Adam Tornhill's code-maat and "Your Code as a Crime Scene".
 *
 *     hotspotScore = revisions(file, since=12.months.ago) * cyclomaticComplexity(file)
 *
 * Codebase-agnostic: requires only `git` on PATH. If the working tree is not a
 * git repo, the check is a clean no-op (reports `available: false`).
 */
import fs from "node:fs/promises";
import path from "node:path";

import { extractFunctions } from "@saydeploy/architect/engines/code-quality/code-metrics-engine";
import { computeHotspots, gitChurn } from "@saydeploy/architect/engines/code-quality/git-churn-engine";
import { walkFiles } from "@saydeploy/architect/core/files";

export const audit = {
  id: "churn-hotspots",
  title: "Churn × complexity hotspots (Tornhill port)",
  category: "codeRisk",
  defaultConfig: {
    includeInAll: false,
    roots: ["src"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".rs", ".java"],
    since: "12.months.ago",
    minRevisions: 5,
    minComplexity: 20,
    topN: 30,
    outputPath: "tmp/audits/CHURN_HOTSPOTS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const minRevs = Number(cfg.minRevisions ?? 5);
    const minCC = Number(cfg.minComplexity ?? 20);

    const files = await walkFiles({ root, roots: cfg.roots, extensions: cfg.extensions });
    const complexityMap = new Map();
    for (const rel of files) {
      const abs = path.resolve(root, rel);
      let text;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const total = extractFunctions(text).reduce((acc, fn) => acc + fn.cyclomaticComplexity, 0);
      complexityMap.set(rel, total || 1);
    }

    const churn = await gitChurn({ root, since: cfg.since ?? "12.months.ago" });
    if (!churn.available) {
      return {
        failed: false,
        findings: [],
        jsonPayload: { available: false, reason: "not a git repository (or git unavailable)" },
        outputPath: cfg.outputPath,
        report: "# Churn Hotspots\n\n_Skipped: not a git repository or git is unavailable._\n",
      };
    }

    const hotspots = computeHotspots(churn.revisions, complexityMap);
    const findings = [];
    for (const h of hotspots) {
      if (h.revisions < minRevs || h.weight < minCC) continue;
      findings.push({
        ruleId: "churn-complexity-hotspot",
        severity: h.hotspotScore >= minRevs * minCC * 4 ? "error" : "warning",
        filePath: h.file,
        line: 1,
        message: `revisions=${h.revisions} × complexity=${h.weight} → hotspot=${h.hotspotScore}`,
        metadata: { baselineKey: h.file, ...h },
      });
    }
    const top = hotspots.slice(0, Number(cfg.topN ?? 30));

    return {
      failed: false,
      findings,
      jsonPayload: { available: true, top, findings, hotspots },
      baselineDocument: {
        version: 1,
        generatedAt: new Date().toISOString(),
        hotspots: hotspots.map(({ file, hotspotScore }) => ({ file, hotspotScore })),
      },
      outputPath: cfg.outputPath,
      report: renderReport({ top, findings, since: cfg.since }),
    };
  },
};

function renderReport({ top, findings, since }) {
  const lines = [
    "# Churn × Complexity Hotspots",
    "",
    `_Tornhill-style hotspots — files complex AND frequently changed (since ${since})._`,
    "",
    `- Hotspots above threshold: ${findings.length}`,
    "",
    `## Top ${top.length}`,
    "",
  ];
  for (const h of top) {
    lines.push(`- \`${h.file}\` — revs **${h.revisions}**, CC ${h.weight}, hotspot **${h.hotspotScore}**`);
  }
  if (top.length === 0) lines.push("- (no overlap of churn and complexity)", "");
  return `${lines.join("\n")}\n`;
}
