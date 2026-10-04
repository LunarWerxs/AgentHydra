import fs from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import {
  FEATURE_BOUNDARY_MATRIX_DEFAULTS,
  runFeatureBoundaryMatrixAudit,
} from "@saydeploy/architect/engines/architecture/feature-boundary-matrix-engine";

function loadPolicy(root, policyPath) {
  if (!policyPath) return null;
  const absolute = path.resolve(root, policyPath);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function writeReportDirect(root, outputPath, content) {
  const absolute = path.resolve(root, outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

function readDocIfPresent(root, outputPath) {
  const absolute = path.resolve(root, outputPath);
  if (!fs.existsSync(absolute)) return null;
  return fs.readFileSync(absolute, "utf8");
}

function normalizeForDriftCompare(text) {
  if (typeof text !== "string") return "";
  return text.replace(/on \d{4}-\d{2}-\d{2}\./, "on YYYY-MM-DD.");
}

export const audit = {
  id: "feature-boundary-matrix",
  title: "Feature Boundary Matrix",
  category: "architecture",
  defaultConfig: {
    ...FEATURE_BOUNDARY_MATRIX_DEFAULTS,
    policyPath: "packages/connections-arkitect/policies/connections/feature-boundaries.json",
    docPath: "docs/architecture/FEATURE_BOUNDARIES.md",
    includeInAll: false,
  },
  async run(context) {
    const policy = loadPolicy(context.root, context.checkConfig.policyPath);
    const merged = {
      sourceExtensions: policy?.sourceExtensions ?? context.checkConfig.sourceExtensions,
      features: policy?.features ?? context.checkConfig.features ?? [],
      allowedEdges: policy?.allowedEdges ?? context.checkConfig.allowedEdges ?? [],
      sharedZones: policy?.sharedZones ?? context.checkConfig.sharedZones ?? [],
      sharedLayerAllowedImports:
        policy?.sharedLayerAllowedImports ?? context.checkConfig.sharedLayerAllowedImports ?? [],
      routesFile: policy?.routesFile ?? context.checkConfig.routesFile ?? null,
      featureRoutePatterns: policy?.featureRoutePatterns ?? context.checkConfig.featureRoutePatterns ?? [],
      exampleFilesPerRoot: context.checkConfig.exampleFilesPerRoot,
    };

    const result = runFeatureBoundaryMatrixAudit({
      root: context.root,
      checkConfig: merged,
    });

    const checkArgs = Array.isArray(context.checkArgs) ? context.checkArgs : [];
    const checkDrift = checkArgs.includes("--check-drift");
    const docPath = context.checkConfig.docPath;

    if (checkDrift && docPath && result.report) {
      const onDisk = readDocIfPresent(context.root, docPath);
      const driftDetected =
        onDisk === null || normalizeForDriftCompare(onDisk) !== normalizeForDriftCompare(result.report);
      if (driftDetected) {
        const message =
          onDisk === null
            ? `${docPath} is missing. Run \`bun run audit:feature-boundary-matrix\` to generate it.`
            : `${docPath} is stale (does not match the current manifest). Run \`bun run audit:feature-boundary-matrix\` to regenerate.`;
        return {
          failed: true,
          findings: [
            createFinding({
              ruleId: "feature-boundary-matrix-drift",
              severity: "error",
              filePath: docPath,
              line: 0,
              message,
              metadata: {
                docPath,
                docMissing: onDisk === null,
              },
            }),
          ],
          jsonPayload: result.jsonPayload,
          report: `# Feature Boundary Matrix Drift\n\n${message}\n`,
        };
      }
      return {
        failed: false,
        findings: [],
        jsonPayload: result.jsonPayload,
        report: `# Feature Boundary Matrix\n\nNo drift — ${docPath} matches the current manifest.\n`,
      };
    }

    if (docPath && result.report) {
      writeReportDirect(context.root, docPath, result.report);
    }

    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      report: result.report,
    };
  },
};
