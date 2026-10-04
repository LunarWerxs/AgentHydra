/**
 * bem-specificity-tie — connections-arkitect check
 * =================================================
 * Detects CSS rules where a BEM modifier (--something) is meant to
 * override a base selector, but both have the same specificity and
 * the base rule wins because it comes later in source order.
 *
 * This is the bug that broke AppPreviewReveal's fade gradient:
 *   .gc-app-preview-reveal__viewport--collapsed::after { opacity: 1; }
 *   .gc-app-preview-reveal__viewport::after             { opacity: 0; }
 * Both have specificity (0,2,1); the base rule wins silently.
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check bem-specificity-tie
 */

import { runBemSpecificityTieAudit } from "@saydeploy/architect/engines/css/bem-specificity-tie-engine";

const BEM_SPECIFICITY_TIE_DEFAULTS = {
  roots: ["packages/connections-ui/src/styles", "src/styles"],
  extensions: [".css"],
  outputPath: "tmp/audits/BEM_SPECIFICITY_TIE_AUDIT.md",
};

export const audit = {
  id: "bem-specificity-tie",
  title: "BEM Specificity Tie",
  category: "codeRisk",
  defaultConfig: {
    ...BEM_SPECIFICITY_TIE_DEFAULTS,
    includeInAll: true,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = await runBemSpecificityTieAudit({
      root: context.root,
      roots: cfg.roots,
      extensions: cfg.extensions,
    });

    // Build a markdown report
    const lines = [];
    lines.push(`# ${audit.title}`);
    lines.push("");
    if (result.findings.length === 0) {
      lines.push("No BEM specificity ties detected.");
      lines.push("");
      lines.push("Errors: 0");
      lines.push("Warnings: 0");
    } else {
      lines.push(`Found ${result.findings.length} potential BEM specificity tie(s) where a modifier selector`);
      lines.push("has the same specificity as the base selector, making the modifier ineffectual.");
      lines.push("");
      lines.push("| File | Property | Modifier Value | Base Value | Selector |");
      lines.push("|------|----------|---------------|------------|----------|");
      for (const f of result.findings) {
        const file = (f.filePath || "").replace(/\\/g, "/");
        const meta = f.metadata || {};
        lines.push(
          `| ${file} | ${meta.prop || ""} | ${meta.modifierValue || ""} | ${meta.baseValue || ""} | ${(f.message || "").substring(0, 80)} |`,
        );
      }
      lines.push("");
      const errCount = result.findings.filter((f) => f.severity === "error").length;
      const warnCount = result.findings.filter((f) => f.severity !== "error").length;
      lines.push(`Errors: ${errCount}`);
      lines.push(`Warnings: ${warnCount}`);
    }

    return {
      failed: result.failed,
      findings: result.findings,
      report: lines.join("\n"),
      outputPath: cfg.outputPath,
    };
  },
};
