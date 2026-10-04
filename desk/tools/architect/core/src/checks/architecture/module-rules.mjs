import fs from "node:fs";
import path from "node:path";

import { applySuppressions } from "@saydeploy/architect/core/suppressions";
import {
  MODULE_RULES_DEFAULTS,
  runModuleRulesAudit,
} from "@saydeploy/architect/engines/architecture/module-rules-engine";

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
  id: "module-rules",
  title: "Module Rules — Reachability & Dependents",
  category: "intelligence",
  defaultConfig: {
    ...MODULE_RULES_DEFAULTS,
    enabled: false,
    includeInAll: false,
    policyPath: "",
    outputPath: "tmp/audits/MODULE_RULES_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const policy = loadPolicy(context.root, cfg.policyPath);
    const merged = {
      ...MODULE_RULES_DEFAULTS,
      ...cfg,
      roots: policy?.roots ?? cfg.roots,
      extensions: policy?.extensions ?? cfg.extensions,
      skipImporterPatterns: policy?.skipImporterPatterns ?? cfg.skipImporterPatterns,
      rules: policy?.rules ?? cfg.rules,
    };

    const result = await runModuleRulesAudit({ root: context.root, checkConfig: merged });
    const filePaths = [...new Set(result.findings.map((finding) => finding.filePath))];
    const filtered = applySuppressions(result.findings, loadFileTexts(context.root, filePaths));

    // Reachability violations (error/warn) gate; dependents findings are
    // advisory (info) and never fail the build.
    const gating = filtered.filter((finding) => finding.severity === "error" || finding.severity === "warn");

    return {
      failed: gating.length > 0,
      findings: filtered,
      jsonPayload: {
        ...result.jsonPayload,
        gatingCount: gating.length,
        advisoryCount: filtered.length - gating.length,
        findings: filtered,
      },
      report: result.report,
      baselineDocument: result.baselineDocument,
      outputPath: cfg.outputPath,
    };
  },
};
