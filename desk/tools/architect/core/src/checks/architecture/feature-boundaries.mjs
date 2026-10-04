import fs from "node:fs";
import path from "node:path";

import { FEATURE_BOUNDARIES_DEFAULTS, runFeatureBoundariesAudit } from "@saydeploy/architect/engines/architecture/feature-boundaries-engine";

function loadPolicy(root, policyPath) {
  if (!policyPath) return null;
  const absolute = path.resolve(root, policyPath);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

export const audit = {
  id: "feature-boundaries",
  title: "Feature Boundaries",
  category: "architecture",
  defaultConfig: {
    ...FEATURE_BOUNDARIES_DEFAULTS,
    policyPath: "packages/connections-arkitect/policies/connections/feature-boundaries.json",
    outputPath: "tmp/audits/FEATURE_BOUNDARIES_AUDIT.md",
  },
  async run(context) {
    const policy = loadPolicy(context.root, context.checkConfig.policyPath);
    const merged = {
      sourceRoots: policy?.sourceRoots ?? context.checkConfig.sourceRoots,
      sourceExtensions: policy?.sourceExtensions ?? context.checkConfig.sourceExtensions,
      features: policy?.features ?? context.checkConfig.features ?? [],
      allowedEdges: policy?.allowedEdges ?? context.checkConfig.allowedEdges ?? [],
    };

    const result = runFeatureBoundariesAudit({
      root: context.root,
      checkConfig: merged,
    });

    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      report: result.report,
      outputPath: context.checkConfig.outputPath,
    };
  },
};
