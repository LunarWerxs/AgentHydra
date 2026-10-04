import fs from "node:fs";
import path from "node:path";

import { SHARED_LAYER_PURITY_DEFAULTS, runSharedLayerPurityAudit } from "@saydeploy/architect/engines/architecture/shared-layer-purity-engine";

function loadPolicy(root, policyPath) {
  if (!policyPath) return null;
  const absolute = path.resolve(root, policyPath);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

export const audit = {
  id: "shared-layer-purity",
  title: "Shared Layer Purity",
  category: "architecture",
  defaultConfig: {
    ...SHARED_LAYER_PURITY_DEFAULTS,
    policyPath: "packages/connections-arkitect/policies/connections/feature-boundaries.json",
    outputPath: "tmp/audits/SHARED_LAYER_PURITY_AUDIT.md",
  },
  async run(context) {
    const policy = loadPolicy(context.root, context.checkConfig.policyPath);
    const merged = {
      sourceRoots: policy?.sourceRoots ?? context.checkConfig.sourceRoots,
      sourceExtensions: policy?.sourceExtensions ?? context.checkConfig.sourceExtensions,
      sharedZones: policy?.sharedZones ?? context.checkConfig.sharedZones ?? [],
      features: policy?.features ?? context.checkConfig.features ?? [],
      allowedImports: policy?.sharedLayerAllowedImports ?? context.checkConfig.allowedImports ?? [],
    };

    const result = runSharedLayerPurityAudit({
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
