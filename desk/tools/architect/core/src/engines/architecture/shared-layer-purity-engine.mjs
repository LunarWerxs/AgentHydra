import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { normalizePath, relativePath } from "@saydeploy/architect/core/path";

export const SHARED_LAYER_PURITY_DEFAULTS = {
  sourceRoots: ["src", "infra/lambda/src", "packages/connections-ui/src"],
  sourceExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue"],
  sharedZones: [],
  features: [],
  allowedImports: [],
};

const IMPORT_PATTERN =
  /(?:import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?|export\s+(?:type\s+)?[^'"]*\s+from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "coverage"]);

function allowedImportKey(zoneId, importer, importee) {
  return `${zoneId}:${normalizePath(importer)}=>${normalizePath(importee)}`;
}

function walk(root, rootRelative, extensions) {
  const absolute = path.resolve(root, rootRelative);
  if (!existsSync(absolute)) return [];
  const out = [];
  const stack = [absolute];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (extensions.includes(path.extname(entry.name))) {
        out.push(child);
      }
    }
  }
  return out;
}

function matchByRoots(relativeFile, entries) {
  const normalized = normalizePath(relativeFile);
  for (const entry of entries) {
    for (const rootPath of entry.roots) {
      if (normalized.startsWith(rootPath)) {
        return entry.id;
      }
    }
  }
  return null;
}

function resolveCandidate(basePath, extensions) {
  const candidates = [basePath];
  for (const extension of extensions) {
    candidates.push(`${basePath}${extension}`);
  }
  for (const extension of extensions) {
    candidates.push(path.join(basePath, `index${extension}`));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function resolveImport({ root, importerAbsolute, specifier, extensions }) {
  if (specifier.startsWith("@/")) {
    return resolveCandidate(path.join(root, "src", specifier.slice(2)), extensions);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveCandidate(path.resolve(path.dirname(importerAbsolute), specifier), extensions);
  }
  return null;
}

function collectImports(fileAbsolute) {
  const text = readFileSync(fileAbsolute, "utf8");
  const imports = [];
  IMPORT_PATTERN.lastIndex = 0;
  for (let match = IMPORT_PATTERN.exec(text); match; match = IMPORT_PATTERN.exec(text)) {
    imports.push(match[1]);
  }
  return imports;
}

function buildAllowedImportSet(allowedImports) {
  const set = new Set();
  for (const entry of allowedImports) {
    if (!entry || typeof entry !== "object") continue;
    set.add(allowedImportKey(entry.zone, entry.importer, entry.importee));
  }
  return set;
}

function renderReport({ violations, orphans, sharedZoneCount, scannedFileCount, allowedImportCount }) {
  const lines = [
    "# Shared Layer Purity",
    "",
    `Scanned ${scannedFileCount} files across ${sharedZoneCount} shared zones with ${allowedImportCount} approved feature-shared exceptions.`,
    "",
  ];

  if (violations.length === 0 && orphans.length === 0) {
    lines.push("No shared-layer purity violations found.", "");
    return lines.join("\n");
  }

  if (violations.length > 0) {
    lines.push(`## Violations (${violations.length})`, "");
    for (const violation of violations) {
      lines.push(
        `- **${violation.zoneId} → ${violation.toFeature}** \`${violation.importer}\` imports \`${violation.specifier}\` (resolved to \`${violation.importee}\`).`,
      );
    }
    lines.push(
      "",
      "Move the feature behavior out of the shared layer, register the dependency as a neutral injection point, or add an approved exception in `packages/connections-arkitect/policies/connections/feature-boundaries.json` under `sharedLayerAllowedImports`.",
      "",
    );
  }

  if (orphans.length > 0) {
    lines.push(`## Orphan exceptions (${orphans.length})`, "");
    lines.push(
      "These `sharedLayerAllowedImports` entries no longer match any real import. The refactor that motivated them is done — delete them from `feature-boundaries.json`.",
      "",
    );
    for (const orphan of orphans) {
      lines.push(`- **${orphan.zone}** \`${orphan.importer}\` → \`${orphan.importee}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function runSharedLayerPurityAudit({ root, checkConfig = {} } = {}) {
  const absoluteRoot = path.resolve(root ?? process.cwd());
  const sourceRoots = checkConfig.sourceRoots?.length
    ? checkConfig.sourceRoots
    : SHARED_LAYER_PURITY_DEFAULTS.sourceRoots;
  const sourceExtensions = checkConfig.sourceExtensions?.length
    ? checkConfig.sourceExtensions
    : SHARED_LAYER_PURITY_DEFAULTS.sourceExtensions;
  const sharedZones = Array.isArray(checkConfig.sharedZones) ? checkConfig.sharedZones : [];
  const features = Array.isArray(checkConfig.features) ? checkConfig.features : [];
  const allowedImports = Array.isArray(checkConfig.allowedImports) ? checkConfig.allowedImports : [];
  const allowedImportSet = buildAllowedImportSet(allowedImports);

  const files = sourceRoots.flatMap((rootRelative) => walk(absoluteRoot, rootRelative, sourceExtensions));
  const violations = [];
  const observedImportKeys = new Set();

  for (const fileAbsolute of files) {
    const importerRelative = relativePath(absoluteRoot, fileAbsolute);
    const zoneId = matchByRoots(importerRelative, sharedZones);
    if (!zoneId) continue;

    const importerFeature = matchByRoots(importerRelative, features);
    if (importerFeature) continue;

    for (const specifier of collectImports(fileAbsolute)) {
      const resolved = resolveImport({
        root: absoluteRoot,
        importerAbsolute: fileAbsolute,
        specifier,
        extensions: sourceExtensions,
      });
      if (!resolved) continue;

      const importeeRelative = relativePath(absoluteRoot, resolved);
      const toFeature = matchByRoots(importeeRelative, features);
      if (!toFeature) continue;

      const key = allowedImportKey(zoneId, importerRelative, importeeRelative);
      if (allowedImportSet.has(key)) {
        observedImportKeys.add(key);
        continue;
      }

      violations.push({
        zoneId,
        toFeature,
        importer: importerRelative,
        importee: importeeRelative,
        specifier,
      });
    }
  }

  const orphans = [];
  for (const entry of allowedImports) {
    if (!entry || typeof entry !== "object") continue;
    const key = allowedImportKey(entry.zone, entry.importer, entry.importee);
    if (!observedImportKeys.has(key)) {
      orphans.push({
        zone: entry.zone,
        importer: entry.importer,
        importee: entry.importee,
      });
    }
  }
  orphans.sort(
    (a, b) =>
      a.zone.localeCompare(b.zone) || a.importer.localeCompare(b.importer) || a.importee.localeCompare(b.importee),
  );

  violations.sort(
    (a, b) =>
      a.zoneId.localeCompare(b.zoneId) ||
      a.toFeature.localeCompare(b.toFeature) ||
      a.importer.localeCompare(b.importer) ||
      a.importee.localeCompare(b.importee),
  );

  const violationFindings = violations.map((violation) =>
    createFinding({
      ruleId: "shared-layer-feature-import",
      severity: "error",
      filePath: violation.importer,
      line: 0,
      message: `${violation.zoneId} → ${violation.toFeature}: ${violation.importer} imports ${violation.specifier} (${violation.importee}). Shared layers must not depend on feature modules — move the behavior, invert the dependency, or add an approved exception.`,
      metadata: {
        zoneId: violation.zoneId,
        toFeature: violation.toFeature,
        importer: violation.importer,
        importee: violation.importee,
        specifier: violation.specifier,
      },
    }),
  );

  const orphanFindings = orphans.map((orphan) =>
    createFinding({
      ruleId: "shared-layer-orphan-exception",
      severity: "error",
      filePath: "packages/connections-arkitect/policies/connections/feature-boundaries.json",
      line: 0,
      message: `Orphan shared-layer exception: ${orphan.zone} (${orphan.importer} → ${orphan.importee}). The importer no longer imports the importee — delete this entry from sharedLayerAllowedImports.`,
      metadata: orphan,
    }),
  );

  const findings = [...violationFindings, ...orphanFindings];

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: {
      sharedZoneCount: sharedZones.length,
      allowedImportCount: allowedImports.length,
      scannedFileCount: files.length,
      violationCount: violations.length,
      orphanCount: orphans.length,
      violations,
      orphans,
      findings,
    },
    report: renderReport({
      violations,
      orphans,
      sharedZoneCount: sharedZones.length,
      scannedFileCount: files.length,
      allowedImportCount: allowedImports.length,
    }),
  };
}
