/**
 * Duplicate Functions — connections-arkitect check
 * =================================================
 * Detects identical function bodies across different files.
 * This catches copy-pasted code that should be extracted into
 * a shared module.
 *
 * Rules:
 *   1. dup-function-cross-file
 *      A function with identical body appears in 2+ files.
 *      Extract into a shared module and import from all callers.
 *
 *   2. dup-function-lambda-shared
 *      A function is duplicated across Lambda API files.
 *      Move to infra/lambda/src/_shared/ or infra/shared/.
 *
 * Because this scans many files, it is opt-in. Run with:
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check duplicate-functions
 */

import {
  runDuplicateFunctionDetector,
  DEFAULT_DUP_SOURCE_DIRS,
} from "@saydeploy/architect/engines/code-quality/duplicate-function-engine";

const RULES = {
  "dup-function-cross-file": {
    severity: "warning",
    description: "Identical function body found in multiple files. Extract to a shared module and import.",
  },
  "dup-function-lambda-shared": {
    severity: "warning",
    description: "Function duplicated across Lambda API files. Move to _shared/ or shared/.",
  },
  "dup-function-large": {
    severity: "warning",
    description: "Large function body (>500 chars) duplicated across files. High-value extraction target.",
  },
};

const LARGE_BODY_THRESHOLD = 500;

/**
 * Files in `crossTargetMirrors` are structural mirrors between the frontend
 * (`src/`) and Lambda (`infra/lambda/src/`) build targets. Every function
 * duplicated between them is architecturally intentional — the Lambda bundles
 * independently and cannot import from src/. These are not copy-paste errors;
 * they are mirrored implementations that must stay in sync manually.
 *
 * Naming convention: use the file basename (without extension). When both
 * sides name the file identically (e.g. src/lib/text/phone.ts ↔
 * infra/lambda/src/_shared/phone.ts), add the basename here to suppress
 * cross-target duplicate warnings for that file pair.
 *
 * When the basenames differ (e.g. src/lib/text/text-utils.ts ↔
 * infra/lambda/src/_shared/positive-integer.ts), the pair must be handled
 * via `suppressDuplicateNames` below instead.
 */
const DEFAULT_CROSS_TARGET_MIRRORS = [
  "hosted-event-social-card",
  "hosted-event-notification-email-shared",
  "hosted-event-notification-email",
  "phone",
];

/**
 * Function names that are known to be false-positive duplicates. Each entry
 * is a function name that the arkitect should skip when reporting duplicates.
 *
 * - "handler": every Lambda entry point exports a `handler` function. These
 *   are completely different functions with the same conventional name
 *   required by the AWS Lambda runtime — not copy-pasted code.
 */
const DEFAULT_SUPPRESS_DUPLICATE_NAMES = ["handler"];

/**
 * Function names where ANY src ↔ infra/lambda/src duplicate is architecturally
 * intentional. These functions are part of the mirrored validation /
 * serialization layer that must exist in both build targets because Lambda
 * bundles independently and cannot import from src/. Unlike crossTargetMirrors
 * (which require identical file basenames), this list catches cases where the
 * same function lives in differently-named files on each side (e.g.
 * text-utils.ts ↔ positive-integer.ts).
 */
const DEFAULT_SUPPRESS_CROSS_BOUNDARY_NAMES = [
  "truncateText",
  "fileUploadAllowedMimeTypes",
  "normalizeRegionName",
  "filterPublishedMyConnectShareCardPayloads",
  "isMeaningfulFollowingNameToken",
  "normalizeFiniteInteger",
  "normalizePositiveInteger",
];

/**
 * Returns true when ALL locations of a duplicate span only known mirror files
 * across the src ↔ infra/lambda boundary. In that case the duplicate is
 * intentional structural mirroring, not a candidate for extraction.
 */
function isCrossTargetMirror(locations, mirrors) {
  if (!mirrors || mirrors.length === 0) return false;
  const basenames = new Set(
    locations.map(
      (l) =>
        l.filePath
          .split("/")
          .pop()
          ?.replace(/\.\w+$/, "") ?? "",
    ),
  );
  // Must be exactly one basename across all locations
  if (basenames.size !== 1) return false;
  const basename = [...basenames][0];
  if (!mirrors.includes(basename)) return false;
  // Must span the src ↔ infra/lambda boundary
  const hasSrc = locations.some((l) => l.filePath.startsWith("src/"));
  const hasLambda = locations.some((l) => l.filePath.startsWith("infra/lambda/src/"));
  return hasSrc && hasLambda;
}

/**
 * Returns true when ALL locations span the src ↔ infra/lambda boundary
 * (i.e. this is a cross-build-target duplicate, not a within-target mistake).
 */
function isCrossBoundaryOnly(locations) {
  if (locations.length < 2) return false;
  const hasSrc = locations.some((l) => l.filePath.startsWith("src/"));
  const hasLambda = locations.some((l) => l.filePath.startsWith("infra/lambda/src/"));
  const allCrossBoundary = locations.every(
    (l) => l.filePath.startsWith("src/") || l.filePath.startsWith("infra/lambda/src/"),
  );
  return hasSrc && hasLambda && allCrossBoundary;
}

function buildReport(findings, result) {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const lines = [
    `# Duplicate Function Detection`,
    ``,
    `**Scanned:** ${result.totalFunctions} functions across ${result.uniqueFiles || "?"} files`,
    ``,
    `Errors: ${errors}. Warnings: ${warnings}.`,
    ``,
  ];
  if (findings.length === 0) {
    lines.push(`## No duplicate functions found — codebase is clean!`);
    return lines.join("\n");
  }
  const byRule = new Map();
  for (const f of findings) {
    const list = byRule.get(f.ruleId) || [];
    list.push(f);
    byRule.set(f.ruleId, list);
  }
  for (const [ruleId, items] of byRule) {
    const sev = items[0].severity;
    lines.push(`## ${ruleId} — ${items.length} (${sev})`);
    for (const item of items) {
      lines.push(`- ${item.message}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export const audit = {
  id: "duplicate-functions",
  title: "Duplicate Function Detection",
  category: "code-quality",
  defaultConfig: {
    includeInAll: false,
    sourceDirs: DEFAULT_DUP_SOURCE_DIRS,
    outputPath: "tmp/audits/DUPLICATE_FUNCTIONS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const sourceDirs = cfg.sourceDirs || DEFAULT_DUP_SOURCE_DIRS;

    let result;
    try {
      result = await runDuplicateFunctionDetector({ root, sourceDirs });
    } catch (err) {
      return {
        findings: [
          {
            ruleId: "dup-function-cross-file",
            severity: "error",
            message: `Duplicate detection failed: ${err.message}`,
            filePath: root,
          },
        ],
        filesScanned: 0,
      };
    }

    const findings = [];
    let filesScanned = result.uniqueFiles || 0;
    const mirrors = cfg.crossTargetMirrors || DEFAULT_CROSS_TARGET_MIRRORS;
    const suppressNames = cfg.suppressDuplicateNames || DEFAULT_SUPPRESS_DUPLICATE_NAMES;
    const suppressCrossBoundary = cfg.suppressCrossBoundaryNames || DEFAULT_SUPPRESS_CROSS_BOUNDARY_NAMES;

    for (const dup of result.duplicates) {
      const locations = dup.locations || [];

      // Skip intentional cross-target structural mirrors (Lambda ↔ Frontend)
      if (isCrossTargetMirror(locations, mirrors)) continue;

      // Skip known false-positive function names (e.g. Lambda "handler" convention)
      if (suppressNames.includes(dup.name)) continue;

      // Skip intentional cross-boundary duplicates where the function is part
      // of the mirrored validation/serialization layer and ALL locations span
      // the src ↔ infra/lambda boundary (different file basenames)
      if (suppressCrossBoundary.includes(dup.name) && isCrossBoundaryOnly(locations)) continue;

      const hasLambdaFile = locations.some(
        (l) => l.filePath.includes("infra/lambda/src/") && !l.filePath.includes("_shared"),
      );
      const isLarge = dup.bodyLength > LARGE_BODY_THRESHOLD;

      // Rule: Lambda-specific duplication
      if (hasLambdaFile && locations.length >= 2) {
        findings.push({
          ruleId: "dup-function-lambda-shared",
          severity: RULES["dup-function-lambda-shared"].severity,
          message: `"${dup.name}" duplicated in ${locations.length} files: ${locations.map((l) => `${l.filePath}:${l.line}`).join(", ")}`,
          filePath: locations[0].filePath,
          line: locations[0].line,
        });
        continue;
      }

      // Rule: Cross-file duplication
      findings.push({
        ruleId: "dup-function-cross-file",
        severity: RULES["dup-function-cross-file"].severity,
        message: `"${dup.name}" duplicated in ${locations.length} files: ${locations.map((l) => `${l.filePath}:${l.line}`).join(", ")}`,
        filePath: locations[0].filePath,
        line: locations[0].line,
      });

      // Rule: Large body duplication (higher priority)
      if (isLarge) {
        findings.push({
          ruleId: "dup-function-large",
          severity: RULES["dup-function-large"].severity,
          message: `"${dup.name}" has ${dup.bodyLength} chars duplicated across ${locations.length} files — high-value extraction target`,
          filePath: locations[0].filePath,
          line: locations[0].line,
        });
      }
    }

    return {
      findings,
      filesScanned,
      report: buildReport(findings, result),
      failed: findings.some((f) => f.severity === "error"),
      summary: {
        totalFunctions: result.totalFunctions,
        duplicateGroups: result.duplicates.length,
      },
    };
  },
};
