import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { relativePath } from "@saydeploy/architect/core/path";

export const FEATURE_BOUNDARY_MATRIX_DEFAULTS = {
  sourceExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue"],
  features: [],
  allowedEdges: [],
  sharedLayerAllowedImports: [],
  routesFile: null,
  featureRoutePatterns: [],
  exampleFilesPerRoot: 3,
};

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "coverage"]);
const ROUTE_PATH_PATTERN = /\bpath:\s*["']([^"']+)["']/g;

function extractRoutePaths(absoluteRoot, routesFile) {
  if (!routesFile) return [];
  const absolute = path.resolve(absoluteRoot, routesFile);
  if (!existsSync(absolute)) return [];
  const text = readFileSync(absolute, "utf8");
  const paths = [];
  ROUTE_PATH_PATTERN.lastIndex = 0;
  for (let match = ROUTE_PATH_PATTERN.exec(text); match; match = ROUTE_PATH_PATTERN.exec(text)) {
    const candidate = match[1];
    if (candidate.startsWith("/")) {
      paths.push(candidate);
    }
  }
  return [...new Set(paths)];
}

function assignRoutes(routes, featureRoutePatterns) {
  const compiled = featureRoutePatterns
    .map((entry, idx) => {
      try {
        return { feature: entry.feature, match: entry.match, regex: new RegExp(entry.match), originalIndex: idx };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const usedPatternIndices = new Set();
  const byFeature = new Map();
  const unassigned = [];
  for (const route of routes) {
    let matched = null;
    for (const entry of compiled) {
      if (entry.regex.test(route)) {
        matched = entry.feature;
        usedPatternIndices.add(entry.originalIndex);
        break;
      }
    }
    if (matched) {
      if (!byFeature.has(matched)) byFeature.set(matched, []);
      byFeature.get(matched).push(route);
    } else {
      unassigned.push(route);
    }
  }
  for (const list of byFeature.values()) {
    list.sort();
  }
  const unusedPatterns = featureRoutePatterns
    .map((pattern, idx) => ({ pattern, idx }))
    .filter(({ idx }) => !usedPatternIndices.has(idx))
    .map(({ pattern }) => pattern);
  return { byFeature, unassigned: unassigned.sort(), unusedPatterns };
}

function walk(absoluteRoot, extensions) {
  if (!existsSync(absoluteRoot)) return [];
  if (statSync(absoluteRoot).isFile()) {
    return [absoluteRoot];
  }
  const out = [];
  const stack = [absoluteRoot];
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

function resolveRoot(absoluteRoot, rootPath, extensions) {
  const absolute = path.resolve(absoluteRoot, rootPath);
  if (existsSync(absolute)) {
    return absolute;
  }
  // Prefix root (no extension, no trailing slash). Find files in parent dir whose name starts with the prefix's basename.
  const parent = path.dirname(absolute);
  if (!existsSync(parent)) return null;
  const basename = path.basename(absolute);
  const out = [];
  const entries = readdirSync(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(basename)) continue;
    const child = path.join(parent, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(child, extensions));
    } else if (extensions.includes(path.extname(entry.name))) {
      out.push(child);
    }
  }
  return out;
}

function discoverRootFiles(absoluteRoot, rootPath, extensions) {
  const resolved = resolveRoot(absoluteRoot, rootPath, extensions);
  if (!resolved) return [];
  if (Array.isArray(resolved)) return resolved;
  return walk(resolved, extensions);
}

function classifyRoot(rootPath) {
  if (rootPath.startsWith("infra/lambda/src/")) return "backend";
  if (rootPath.startsWith("src/lib/vault-api/")) return "api-client";
  if (rootPath.startsWith("src/lib/")) return "domain";
  if (rootPath.startsWith("src/composables/")) return "state";
  if (rootPath.startsWith("src/components/workspace/views/")) return "workspace-ui";
  if (rootPath.startsWith("src/components/workspace/")) return "workspace-ui";
  if (rootPath.startsWith("src/components/public/")) return "public-ui";
  if (rootPath.startsWith("src/components/account/")) return "account-ui";
  if (rootPath.startsWith("src/components/")) return "ui";
  if (rootPath.startsWith("src/products/")) return "product";
  if (rootPath.startsWith("packages/")) return "package";
  return "other";
}

function groupRootsByClass(roots) {
  const groups = new Map();
  for (const root of roots) {
    const className = classifyRoot(root);
    if (!groups.has(className)) groups.set(className, []);
    groups.get(className).push(root);
  }
  return groups;
}

const CLASS_DISPLAY = {
  "workspace-ui": "Workspace UI",
  "public-ui": "Public UI",
  "account-ui": "Account UI",
  ui: "Shared UI",
  state: "State/composables",
  domain: "Domain logic",
  "api-client": "API clients",
  backend: "Backend Lambdas",
  product: "Product modules",
  package: "Packages",
  other: "Other",
};

const CLASS_ORDER = [
  "workspace-ui",
  "public-ui",
  "account-ui",
  "ui",
  "state",
  "domain",
  "api-client",
  "backend",
  "product",
  "package",
  "other",
];

function bridgesFor(featureId, allowedEdges) {
  const outgoing = allowedEdges.filter((edge) => edge.from === featureId);
  const incoming = allowedEdges.filter((edge) => edge.to === featureId);
  return { outgoing, incoming };
}

function summarizeBridgePair(featureId, edges, direction) {
  const counts = new Map();
  const reasons = new Map();
  for (const edge of edges) {
    const other = direction === "outgoing" ? edge.to : edge.from;
    counts.set(other, (counts.get(other) ?? 0) + 1);
    if (!reasons.has(other)) reasons.set(other, []);
    reasons.get(other).push(edge.reason ?? "");
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([other, count]) => ({ feature: other, count }));
}

function countSpecFiles(byRoot) {
  let count = 0;
  for (const files of byRoot.values()) {
    for (const file of files) {
      if (file.endsWith(".spec.ts") || file.endsWith(".spec.tsx") || file.endsWith(".test.ts")) {
        count += 1;
      }
    }
  }
  return count;
}

function formatMarkdownLinkLabel(filePath) {
  return filePath.replaceAll("_shared", "\\_shared").replaceAll("__tests__", "**tests**");
}

function renderFeatureCard({ feature, files, allowedEdges, routes, exampleFilesPerRoot }) {
  const lines = [];
  const { outgoing, incoming } = bridgesFor(feature.id, allowedEdges);
  const specCount = countSpecFiles(files.byRoot);
  const nonSpecCount = files.totalCount - specCount;

  lines.push(`## ${feature.id}`, "");
  if (feature.displayName && feature.displayName !== feature.id) {
    lines.push(`_${feature.displayName}_`, "");
  }
  lines.push(`**Owned files:** ${files.totalCount} (${nonSpecCount} source, ${specCount} test)`, "");

  if (routes && routes.length) {
    lines.push("**Routes:**", "");
    for (const route of routes) {
      lines.push(`- \`${route}\``);
    }
    lines.push("");
  }

  const groups = groupRootsByClass(feature.roots);
  for (const className of CLASS_ORDER) {
    const roots = groups.get(className);
    if (!roots || roots.length === 0) continue;
    lines.push(`### ${CLASS_DISPLAY[className]}`, "");
    for (const root of roots) {
      const rootFiles = files.byRoot.get(root) ?? [];
      const examples = rootFiles.slice(0, exampleFilesPerRoot);
      const more = rootFiles.length - examples.length;
      lines.push(`- \`${root}\` (${rootFiles.length} ${rootFiles.length === 1 ? "file" : "files"})`);
      for (const example of examples) {
        lines.push(`  - [${formatMarkdownLinkLabel(example)}](${"../../" + example})`);
      }
      if (more > 0) {
        lines.push(`  - …and ${more} more`);
      }
    }
    lines.push("");
  }

  const outSummary = summarizeBridgePair(feature.id, outgoing, "outgoing");
  const inSummary = summarizeBridgePair(feature.id, incoming, "incoming");

  if (outSummary.length || inSummary.length) {
    lines.push(`### Approved bridges`, "");
    if (inSummary.length) {
      const parts = inSummary.map(({ feature: f, count }) => `${f} (${count})`);
      lines.push(`**Inbound** (others → this feature): ${parts.join(", ")}`);
      lines.push("");
    }
    if (outSummary.length) {
      const parts = outSummary.map(({ feature: f, count }) => `${f} (${count})`);
      lines.push(`**Outbound** (this feature → others): ${parts.join(", ")}`);
      lines.push("");
      lines.push("<details><summary>Outbound bridge details</summary>", "");
      const sortedOutgoing = [...outgoing].sort(
        (a, b) =>
          a.to.localeCompare(b.to) || a.importer.localeCompare(b.importer) || a.importee.localeCompare(b.importee),
      );
      for (const edge of sortedOutgoing) {
        lines.push(`- **→ ${edge.to}**: \`${edge.importer}\` → \`${edge.importee}\``);
        if (edge.reason) {
          lines.push(`  - ${edge.reason}`);
        }
      }
      lines.push("", "</details>", "");
    }
  }

  return lines.join("\n");
}

function renderReport({
  features,
  allowedEdges,
  sharedZones,
  sharedLayerAllowedImports,
  files,
  routesByFeature,
  unassignedRoutes,
  unusedRoutePatterns,
  exampleFilesPerRoot,
  generatedAt,
}) {
  let totalOwnedFiles = 0;
  let totalSpecFiles = 0;
  for (const feature of features) {
    const f = files.get(feature.id);
    totalOwnedFiles += f.totalCount;
    totalSpecFiles += countSpecFiles(f.byRoot);
  }

  const lines = [
    "# Feature Boundaries — Surface Matrix",
    "",
    `_Auto-generated by \`bun run audit:feature-boundary-matrix\` on ${generatedAt}._`,
    "",
    "_Do not hand-edit. Update [`feature-boundaries.json`](../../packages/connections-arkitect/policies/connections/feature-boundaries.json) and regenerate._",
    "",
    "## Summary",
    "",
    `- **Features:** ${features.length}`,
    `- **Files claimed by features:** ${totalOwnedFiles} (${totalOwnedFiles - totalSpecFiles} source, ${totalSpecFiles} test)`,
    `- **Approved bridges:** ${allowedEdges.length}`,
    `- **Shared zones:** ${sharedZones.length}`,
    `- **Approved shared-layer exceptions:** ${sharedLayerAllowedImports.length}`,
    "",
    "## Features",
    "",
  ];

  for (const feature of features) {
    lines.push(
      renderFeatureCard({
        feature,
        files: files.get(feature.id),
        allowedEdges,
        routes: routesByFeature.get(feature.id) ?? [],
        exampleFilesPerRoot,
      }),
    );
  }

  if (unassignedRoutes && unassignedRoutes.length) {
    lines.push("## Unassigned routes", "");
    lines.push(
      "Routes that didn't match any `featureRoutePatterns` entry — likely belong to the workspace shell, marketing, or a feature that doesn't have route patterns declared yet.",
      "",
    );
    for (const route of unassignedRoutes) {
      lines.push(`- \`${route}\``);
    }
    lines.push("");
  }

  if (unusedRoutePatterns && unusedRoutePatterns.length) {
    lines.push("## Unused route patterns", "");
    lines.push(
      "These `featureRoutePatterns` entries match no current route — likely left over from a route that was removed or renamed. Update or delete.",
      "",
    );
    for (const entry of unusedRoutePatterns) {
      lines.push(`- **${entry.feature}** \`${entry.match}\``);
    }
    lines.push("");
  }

  if (sharedZones.length) {
    lines.push("## Shared zones", "");
    lines.push(
      "These directories are intentionally feature-neutral. The `shared-layer-purity` audit forbids them from importing feature-owned modules unless explicitly allowlisted with a reason.",
    );
    lines.push("");
    for (const zone of sharedZones) {
      lines.push(`### ${zone.id}`, "");
      for (const root of zone.roots) {
        lines.push(`- \`${root}\``);
      }
      const zoneExceptions = sharedLayerAllowedImports.filter((entry) => entry.zone === zone.id);
      if (zoneExceptions.length) {
        lines.push("");
        lines.push(`**Approved exceptions (${zoneExceptions.length}):**`);
        for (const entry of zoneExceptions) {
          lines.push(`- \`${entry.importer}\` → \`${entry.importee}\` — ${entry.reason}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function runFeatureBoundaryMatrixAudit({ root, checkConfig = {} } = {}) {
  const absoluteRoot = path.resolve(root ?? process.cwd());
  const features = Array.isArray(checkConfig.features) ? checkConfig.features : [];
  const allowedEdges = Array.isArray(checkConfig.allowedEdges) ? checkConfig.allowedEdges : [];
  const sharedZones = Array.isArray(checkConfig.sharedZones) ? checkConfig.sharedZones : [];
  const sharedLayerAllowedImports = Array.isArray(checkConfig.sharedLayerAllowedImports)
    ? checkConfig.sharedLayerAllowedImports
    : [];
  const sourceExtensions = checkConfig.sourceExtensions?.length
    ? checkConfig.sourceExtensions
    : FEATURE_BOUNDARY_MATRIX_DEFAULTS.sourceExtensions;
  const exampleFilesPerRoot = checkConfig.exampleFilesPerRoot ?? FEATURE_BOUNDARY_MATRIX_DEFAULTS.exampleFilesPerRoot;

  const files = new Map();
  for (const feature of features) {
    const byRoot = new Map();
    let totalCount = 0;
    for (const root of feature.roots) {
      const rootFiles = discoverRootFiles(absoluteRoot, root, sourceExtensions)
        .map((abs) => relativePath(absoluteRoot, abs))
        .sort();
      byRoot.set(root, rootFiles);
      totalCount += rootFiles.length;
    }
    files.set(feature.id, { byRoot, totalCount });
  }

  const routesFile = checkConfig.routesFile ?? FEATURE_BOUNDARY_MATRIX_DEFAULTS.routesFile;
  const featureRoutePatterns = Array.isArray(checkConfig.featureRoutePatterns) ? checkConfig.featureRoutePatterns : [];
  const allRoutes = extractRoutePaths(absoluteRoot, routesFile);
  const {
    byFeature: routesByFeature,
    unassigned: unassignedRoutes,
    unusedPatterns: unusedRoutePatterns,
  } = assignRoutes(allRoutes, featureRoutePatterns);

  const generatedAt = new Date().toISOString().slice(0, 10);
  const report = renderReport({
    features,
    allowedEdges,
    sharedZones,
    sharedLayerAllowedImports,
    files,
    routesByFeature,
    unassignedRoutes,
    unusedRoutePatterns,
    exampleFilesPerRoot,
    generatedAt,
  });

  return {
    failed: false,
    findings: [],
    jsonPayload: {
      featureCount: features.length,
      allowedEdgeCount: allowedEdges.length,
      sharedZoneCount: sharedZones.length,
      sharedLayerAllowedImportCount: sharedLayerAllowedImports.length,
      features: features.map((feature) => ({
        id: feature.id,
        rootCount: feature.roots.length,
        fileCount: files.get(feature.id).totalCount,
        outgoingBridgeCount: allowedEdges.filter((edge) => edge.from === feature.id).length,
        incomingBridgeCount: allowedEdges.filter((edge) => edge.to === feature.id).length,
      })),
    },
    report,
  };
}
