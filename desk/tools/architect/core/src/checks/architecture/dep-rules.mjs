import fs from "node:fs";
import path from "node:path";

import { applySuppressions } from "@saydeploy/architect/core/suppressions";
import { DEP_RULES_DEFAULTS, runDepRulesAudit } from "@saydeploy/architect/engines/architecture/dep-rules-engine";

function loadPolicy(root, policyPath) {
  if (!policyPath) return null;
  const absolute = path.resolve(root, policyPath);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function loadFileTexts(root, filePaths) {
  const map = new Map();
  for (const filePath of filePaths) {
    try {
      map.set(filePath, fs.readFileSync(path.resolve(root, filePath), "utf8"));
    } catch {
      // skip
    }
  }
  return map;
}

export const audit = {
  id: "dep-rules",
  title: "Dependency Rules",
  category: "intelligence",
  defaultConfig: {
    ...DEP_RULES_DEFAULTS,
    enabled: false,
    includeInAll: false,
    policyPath: "",
    outputPath: "tmp/audits/DEP_RULES_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const policy = loadPolicy(context.root, cfg.policyPath);
    const merged = {
      ...DEP_RULES_DEFAULTS,
      ...cfg,
      roots: policy?.roots ?? cfg.roots,
      extensions: policy?.extensions ?? cfg.extensions,
      aliases: policy?.aliases ?? cfg.aliases,
      rules: policy?.rules ?? cfg.rules,
    };

    const result = await runDepRulesAudit({ root: context.root, checkConfig: merged });
    const filePaths = [...new Set(result.findings.map((finding) => finding.filePath))];
    const filtered = applySuppressions(result.findings, loadFileTexts(context.root, filePaths));

    return {
      failed: filtered.length > 0,
      findings: filtered,
      jsonPayload: { ...result.jsonPayload, violationCount: filtered.length, findings: filtered },
      report: result.report,
      outputPath: cfg.outputPath,
    };
  },
};
