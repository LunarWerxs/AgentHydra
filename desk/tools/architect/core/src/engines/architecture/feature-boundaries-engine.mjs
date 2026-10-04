import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { normalizePath, relativePath } from "@saydeploy/architect/core/path";

export const FEATURE_BOUNDARIES_DEFAULTS = {
  sourceRoots: ["src", "infra/lambda/src"],
  sourceExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue"],
  features: [],
  allowedEdges: [],
};

const IMPORT_PATTERN =
  /(?:import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?|export\s+(?:type\s+)?[^'"]*\s+from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "coverage"]);

function edgeKey(fromFeature, toFeature, fromPath, toPath) {
  return `${fromFeature}->${toFeature}:${normalizePath(fromPath)}=>${normalizePath(toPath)}`;
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

function featureFor(relativeFile, features) {
  const normalized = normalizePath(relativeFile);
  for (const feature of features) {
    for (const rootPath of feature.roots) {
      if (normalized.startsWith(rootPath)) {
        return feature.id;
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

function buildAllowedEdgeSet(allowedEdges) {
  const set = new Set();
  for (const edge of allowedEdges) {
    if (!edge || typeof edge !== "object") continue;
    set.add(edgeKey(edge.from, edge.to, edge.importer, edge.importee));
  }
  return set;
}

function renderReport({ violations, orphans, missingRoots, features, allowedEdgeCount, scannedFileCount }) {
  const lines = [
    "# Feature Boundaries",
    "",
    `Scanned ${scannedFileCount} files across ${features.length} feature roots with ${allowedEdgeCount} approved bridges.`,
    "",
  ];

  if (violations.length === 0 && orphans.length === 0 && (!missingRoots || missingRoots.length === 0)) {
    lines.push("No cross-feature import violations found.", "");
    return lines.join("\n");
  }

  if (violations.length > 0) {
    lines.push(`## Violations (${violations.length})`, "");
    for (const violation of violations) {
      lines.push(
        `- **${violation.fromFeature} → ${violation.toFeature}** \`${violation.importer}\` imports \`${violation.specifier}\` (resolved to \`${violation.importee}\`).`,
      );
    }
    lines.push(
      "",
      "Move shared behavior into a shared module, or add an approved bridge with a reason in `packages/connections-arkitect/policies/connections/feature-boundaries.json`.",
      "",
    );
  }

  if (orphans.length > 0) {
    lines.push(`## Orphan bridges (${orphans.length})`, "");
    lines.push(
      "These allowlist entries no longer match any real import. The refactor that motivated them is done — delete them from `feature-boundaries.json`.",
      "",
    );
    for (const orphan of orphans) {
      lines.push(`- **${orphan.from} → ${orphan.to}** \`${orphan.importer}\` → \`${orphan.importee}\``);
    }
    lines.push("");
  }

  if (missingRoots && missingRoots.length > 0) {
    lines.push(`## Missing roots (${missingRoots.length})`, "");
    lines.push(
      "These feature roots in `feature-boundaries.json` match no files on disk. The directory was renamed, moved, or removed — update or delete the root.",
      "",
    );
    for (const entry of missingRoots) {
      lines.push(`- **${entry.feature}** \`${entry.root}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function runFeatureBoundariesAudit({ root, checkConfig = {} } = {}) {
  const absoluteRoot = path.resolve(root ?? process.cwd());
  const sourceRoots = checkConfig.sourceRoots?.length
    ? checkConfig.sourceRoots
    : FEATURE_BOUNDARIES_DEFAULTS.sourceRoots;
  const sourceExtensions = checkConfig.sourceExtensions?.length
    ? checkConfig.sourceExtensions
    : FEATURE_BOUNDARIES_DEFAULTS.sourceExtensions;
  const features = Array.isArray(checkConfig.features) ? checkConfig.features : [];
  const allowedEdges = Array.isArray(checkConfig.allowedEdges) ? checkConfig.allowedEdges : [];
  const allowedEdgeSet = buildAllowedEdgeSet(allowedEdges);

  const files = sourceRoots.flatMap((rootRelative) => walk(absoluteRoot, rootRelative, sourceExtensions));
  const allFilesSet = new Set(files.map((abs) => normalizePath(relativePath(absoluteRoot, abs))));

  const missingRoots = [];
  for (const feature of features) {
    for (const rootPath of feature.roots) {
      let matched = false;
      for (const file of allFilesSet) {
        if (file.startsWith(rootPath)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        missingRoots.push({ feature: feature.id, root: rootPath });
      }
    }
  }

  const violations = [];
  const observedEdgeKeys = new Set();

  for (const fileAbsolute of files) {
    const importerRelative = relativePath(absoluteRoot, fileAbsolute);
    const importerFeature = featureFor(importerRelative, features);
    if (!importerFeature) continue;

    for (const specifier of collectImports(fileAbsolute)) {
      const resolved = resolveImport({
        root: absoluteRoot,
        importerAbsolute: fileAbsolute,
        specifier,
        extensions: sourceExtensions,
      });
      if (!resolved) continue;

      const importeeRelative = relativePath(absoluteRoot, resolved);
      const importeeFeature = featureFor(importeeRelative, features);
      if (!importeeFeature || importeeFeature === importerFeature) continue;

      const key = edgeKey(importerFeature, importeeFeature, importerRelative, importeeRelative);
      if (allowedEdgeSet.has(key)) {
        observedEdgeKeys.add(key);
        continue;
      }

      violations.push({
        fromFeature: importerFeature,
        toFeature: importeeFeature,
        importer: importerRelative,
        importee: importeeRelative,
        specifier,
      });
    }
  }

  const orphans = [];
  for (const edge of allowedEdges) {
    if (!edge || typeof edge !== "object") continue;
    const key = edgeKey(edge.from, edge.to, edge.importer, edge.importee);
    if (!observedEdgeKeys.has(key)) {
      orphans.push({
        from: edge.from,
        to: edge.to,
        importer: edge.importer,
        importee: edge.importee,
      });
    }
  }
  orphans.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.importer.localeCompare(b.importer) ||
      a.importee.localeCompare(b.importee),
  );

  violations.sort(
    (a, b) =>
      a.fromFeature.localeCompare(b.fromFeature) ||
      a.toFeature.localeCompare(b.toFeature) ||
      a.importer.localeCompare(b.importer) ||
      a.importee.localeCompare(b.importee),
  );

  const violationFindings = violations.map((violation) =>
    createFinding({
      ruleId: "feature-boundary-cross-import",
      severity: "error",
      filePath: violation.importer,
      line: 0,
      message: `${violation.fromFeature} → ${violation.toFeature}: ${violation.importer} imports ${violation.specifier} (${violation.importee}). Move the shared behavior or add an approved bridge in feature-boundaries.json.`,
      metadata: {
        fromFeature: violation.fromFeature,
        toFeature: violation.toFeature,
        importer: violation.importer,
        importee: violation.importee,
        specifier: violation.specifier,
      },
    }),
  );

  const orphanFindings = orphans.map((orphan) =>
    createFinding({
      ruleId: "feature-boundary-orphan-bridge",
      severity: "error",
      filePath: "packages/connections-arkitect/policies/connections/feature-boundaries.json",
      line: 0,
      message: `Orphan bridge: ${orphan.from} → ${orphan.to} (${orphan.importer} → ${orphan.importee}). The importer no longer imports the importee — delete this entry from feature-boundaries.json.`,
      metadata: orphan,
    }),
  );

  const missingRootFindings = missingRoots.map((entry) =>
    createFinding({
      ruleId: "feature-boundary-missing-root",
      severity: "error",
      filePath: "packages/connections-arkitect/policies/connections/feature-boundaries.json",
      line: 0,
      message: `Missing root for feature ${entry.feature}: \`${entry.root}\` matches no files. The directory was renamed or removed — update or delete the root in feature-boundaries.json.`,
      metadata: entry,
    }),
  );

  const findings = [...violationFindings, ...orphanFindings, ...missingRootFindings];

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: {
      featureCount: features.length,
      allowedEdgeCount: allowedEdges.length,
      scannedFileCount: files.length,
      violationCount: violations.length,
      orphanCount: orphans.length,
      missingRootCount: missingRoots.length,
      violations,
      orphans,
      missingRoots,
      findings,
    },
    report: renderReport({
      violations,
      orphans,
      missingRoots,
      features,
      allowedEdgeCount: allowedEdges.length,
      scannedFileCount: files.length,
    }),
  };
}
