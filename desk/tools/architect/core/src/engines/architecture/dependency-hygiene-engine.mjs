/**
 * Dependency hygiene — phantom (unlisted) and unused npm dependencies.
 *
 * Built entirely on the existing import graph: every bare `external` specifier
 * the graph already extracts is normalized to a package name (`rxjs/operators`
 * → `rxjs`, `@scope/pkg/sub` → `@scope/pkg`), Node builtins are dropped, and
 * the result is diffed against each manifest's declared dependencies.
 *
 *   - UNLISTED (phantom): imported in source but absent from package.json. A
 *     real bug — works locally via hoisting, breaks a clean install / Lambda
 *     bundle. Error severity.
 *   - UNUSED: declared in `dependencies` but never imported under the governed
 *     roots. Lower confidence (a dep can be used only via config or a dynamic
 *     string), so it is advisory only — `info` severity, never gates, scoped to
 *     runtime `dependencies`.
 *
 * Each manifest is paired with the source roots it governs, so a monorepo
 * checks the SPA, the Lambda package, and the UI package against their own
 * package.json rather than one global pool.
 *
 * Policy schema:
 *   {
 *     "manifests": [{ "packageJson": "package.json", "roots": ["src"] }],
 *     "ignoreUnused": ["polyfill-only-pkg"],
 *     "ignoreUnlisted": ["virtual:foo"],
 *     "detectUnused": true,
 *     "detectUnlisted": true
 *   }
 */
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export const DEPENDENCY_HYGIENE_DEFAULTS = {
  manifests: [{ packageJson: "package.json", roots: ["src"] }],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
  // Test files import test frameworks (vitest/bun:test) and devDeps that are
  // not runtime dependencies — excluded so they don't read as phantom deps.
  skipPatterns: ["\\.spec\\.", "\\.test\\.", "__tests__/", "/test/"],
  ignoreUnused: [],
  ignoreUnlisted: [],
  detectUnused: true,
  detectUnlisted: true,
};

// A bare import of `x` is "declared" if `@types/x` is present (type-only deps
// like `aws-lambda` ship their runtime as ambient types). Scoped: `@scope/pkg`
// → `@types/scope__pkg`.
function typesPackageFor(name) {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.slice(1).split("/");
    return pkg ? `@types/${scope}__${pkg}` : null;
  }
  return `@types/${name}`;
}

export function packageNameFromSpecifier(specifier) {
  if (!specifier) return null;
  // Strip a `node:` prefix only for builtin checks; real packages never use it.
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return specifier.split("/")[0];
}

function isBuiltin(specifier) {
  if (BUILTINS.has(specifier)) return true;
  const base = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return BUILTINS.has(base) || BUILTINS.has(`node:${base}`);
}

function isBareSpecifier(specifier) {
  // Bare = a package import, not a path, alias, protocol, or URL.
  return Boolean(specifier) && !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":");
}

async function collectUsedPackages(root, roots, extensions, skipMatchers) {
  const graph = await buildImportGraph({ root, roots, extensions });
  const used = new Map(); // packageName -> { file, line, specifier }
  for (const [filePath, node] of graph.nodes) {
    if (skipMatchers.some((matcher) => matcher.test(filePath))) continue;
    for (const edge of node.imports) {
      if (!edge.external) continue;
      const specifier = edge.specifier;
      if (!isBareSpecifier(specifier) || isBuiltin(specifier)) continue;
      const name = packageNameFromSpecifier(specifier);
      if (!name) continue;
      if (!used.has(name)) used.set(name, { file: filePath, line: edge.line, specifier });
    }
  }
  return { used, fileCount: graph.files.length };
}

export async function runDependencyHygieneAudit({ root, checkConfig = {} } = {}) {
  const config = { ...DEPENDENCY_HYGIENE_DEFAULTS, ...checkConfig };
  const ignoreUnused = new Set(config.ignoreUnused ?? []);
  const ignoreUnlisted = new Set(config.ignoreUnlisted ?? []);
  const skipMatchers = (config.skipPatterns ?? []).map((pattern) => new RegExp(pattern));
  const findings = [];
  const summaries = [];

  for (const manifest of config.manifests ?? []) {
    const manifestRel = manifest.packageJson;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.resolve(root, manifestRel), "utf8"));
    } catch {
      findings.push(
        createFinding({
          ruleId: "dep-hygiene:manifest-unreadable",
          severity: "error",
          filePath: manifestRel,
          line: 0,
          message: `Cannot read or parse \`${manifestRel}\`.`,
          metadata: { baselineKey: `manifest:${manifestRel}` },
        }),
      );
      continue;
    }

    const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}));
    const allDeclared = new Set([
      ...runtimeDeps,
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);

    const { used, fileCount } = await collectUsedPackages(root, manifest.roots, config.extensions, skipMatchers);

    if (config.detectUnlisted) {
      for (const [name, where] of used) {
        if (allDeclared.has(name)) continue;
        const typesPkg = typesPackageFor(name);
        if (typesPkg && allDeclared.has(typesPkg)) continue;
        if (ignoreUnlisted.has(name) || ignoreUnlisted.has(where.specifier)) continue;
        findings.push(
          createFinding({
            ruleId: "dep-hygiene:unlisted",
            severity: "error",
            filePath: where.file,
            line: where.line,
            message: `\`${name}\` is imported but not declared in \`${manifestRel}\` — phantom dependency (resolves via hoisting now; breaks a clean install / Lambda bundle).`,
            metadata: { baselineKey: `unlisted:${manifestRel}:${name}`, package: name, manifest: manifestRel },
          }),
        );
      }
    }

    if (config.detectUnused) {
      for (const name of runtimeDeps) {
        if (used.has(name)) continue;
        if (ignoreUnused.has(name)) continue;
        if (name.startsWith("@types/")) continue; // implicit — paired with its host package
        findings.push(
          createFinding({
            // Advisory only — `info`, not `warn`. Unused-dep detection on a
            // regex graph is inherently low-confidence (deps used via config,
            // CSS @import, or dynamic string look unused), so it must never
            // gate CI. Promote a real one by removing the dep or allowlisting.
            ruleId: "dep-hygiene:unused",
            severity: "info",
            filePath: manifestRel,
            line: 0,
            message: `\`${name}\` is in "dependencies" of \`${manifestRel}\` but never imported under [${manifest.roots.join(", ")}] — possibly unused (or used only via config / a dynamic string).`,
            metadata: { baselineKey: `unused:${manifestRel}:${name}`, package: name, manifest: manifestRel },
          }),
        );
      }
    }

    summaries.push({
      manifest: manifestRel,
      governedRoots: manifest.roots,
      declaredRuntime: runtimeDeps.size,
      usedPackages: used.size,
      fileCount,
    });
  }

  return {
    findings,
    summaries,
    report: renderReport(findings, summaries),
    baselineDocument: {
      version: 1,
      generatedAt: new Date().toISOString(),
      keys: findings.map((finding) => finding.metadata.baselineKey).filter(Boolean),
    },
  };
}

function renderReport(findings, summaries) {
  const unlisted = findings.filter((finding) => finding.ruleId === "dep-hygiene:unlisted");
  const manifestErrors = findings.filter((finding) => finding.ruleId === "dep-hygiene:manifest-unreadable");
  const unused = findings.filter((finding) => finding.ruleId === "dep-hygiene:unused");
  // Only phantom/unreadable findings gate; unused is advisory and excluded from
  // the counts the strict-gate summarizer parses.
  const errors = unlisted.length + manifestErrors.length;

  const lines = ["# Dependency Hygiene", ""];
  for (const summary of summaries) {
    lines.push(
      `- \`${summary.manifest}\` — ${summary.declaredRuntime} runtime deps, ${summary.usedPackages} packages used across ${summary.fileCount} files [roots: ${summary.governedRoots.join(", ")}]`,
    );
  }
  lines.push("", `Errors: ${errors}`, `Warnings: 0`, "");

  if (manifestErrors.length > 0) {
    lines.push(`## Unreadable manifests — ${manifestErrors.length}`, "");
    for (const finding of manifestErrors) lines.push(`- ${finding.message}`);
    lines.push("");
  }
  if (unlisted.length > 0) {
    lines.push(`## Phantom (unlisted) dependencies — ${unlisted.length}`, "");
    lines.push("_Imported in source but missing from package.json. Add them to `dependencies`._", "");
    for (const finding of unlisted) {
      lines.push(
        `- **${finding.metadata.package}** — \`${finding.filePath}:${finding.line}\` (${finding.metadata.manifest})`,
      );
    }
    lines.push("");
  }
  if (unused.length > 0) {
    lines.push(`## Advisory: possibly-unused dependencies — ${unused.length} (does not gate)`, "");
    lines.push(
      "_Declared in `dependencies` but not imported under the governed roots. Verify, then remove or add to `ignoreUnused`._",
      "",
    );
    for (const finding of unused) lines.push(`- ${finding.metadata.package} — ${finding.metadata.manifest}`);
    lines.push("");
  }
  if (unlisted.length === 0 && manifestErrors.length === 0) {
    lines.push("No phantom dependencies. ✅", "");
  }
  return `${lines.join("\n")}\n`;
}
