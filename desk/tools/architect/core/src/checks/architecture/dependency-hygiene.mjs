import fs from "node:fs";
import path from "node:path";

import { applySuppressions } from "@saydeploy/architect/core/suppressions";
import {
  DEPENDENCY_HYGIENE_DEFAULTS,
  runDependencyHygieneAudit,
} from "@saydeploy/architect/engines/architecture/dependency-hygiene-engine";

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
  id: "dependency-hygiene",
  title: "Dependency Hygiene — Phantom & Unused Deps",
  category: "intelligence",
  defaultConfig: {
    ...DEPENDENCY_HYGIENE_DEFAULTS,
    enabled: false,
    includeInAll: false,
    policyPath: "",
    outputPath: "tmp/audits/DEPENDENCY_HYGIENE_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const policy = loadPolicy(context.root, cfg.policyPath);
    const merged = {
      ...DEPENDENCY_HYGIENE_DEFAULTS,
      ...cfg,
      manifests: policy?.manifests ?? cfg.manifests,
      ignoreUnused: policy?.ignoreUnused ?? cfg.ignoreUnused,
      ignoreUnlisted: policy?.ignoreUnlisted ?? cfg.ignoreUnlisted,
      skipPatterns: policy?.skipPatterns ?? cfg.skipPatterns,
    };

    const result = await runDependencyHygieneAudit({ root: context.root, checkConfig: merged });
    const filePaths = [...new Set(result.findings.map((finding) => finding.filePath))];
    const filtered = applySuppressions(result.findings, loadFileTexts(context.root, filePaths));

    // Only phantom (unlisted) + unreadable-manifest findings gate. `unused` is
    // advisory (severity "info") and never fails the build.
    const gating = filtered.filter((finding) => finding.ruleId !== "dep-hygiene:unused");

    return {
      failed: gating.length > 0,
      findings: filtered,
      jsonPayload: {
        ...result,
        unlistedCount: filtered.filter((f) => f.ruleId === "dep-hygiene:unlisted").length,
        unusedCount: filtered.filter((f) => f.ruleId === "dep-hygiene:unused").length,
        findings: filtered,
      },
      report: result.report,
      baselineDocument: result.baselineDocument,
      outputPath: cfg.outputPath,
    };
  },
};
