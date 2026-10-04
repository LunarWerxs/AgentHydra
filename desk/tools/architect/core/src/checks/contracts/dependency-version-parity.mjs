/**
 * dependency-version-parity — connections-arkitect check
 * ======================================================
 * Catches the class of bug found in the cb_issues_01 audit (H12): the FE,
 * Lambda, and CDK package manifests are separate install roots, so a dependency
 * that must behave identically on both sides of a boundary can silently drift to
 * different versions. The audit found `valibot`/`libphonenumber-js` (which encode
 * validation/parsing CONTRACTS that cross the client↔server boundary) on
 * different ranges in root vs infra/lambda, and `@aws-sdk/*` clients spanning
 * ~450 minor releases inside a single Lambda manifest.
 *
 * Rules:
 *   1. contract-dep-version-drift (error) — a dependency in `contractDeps` is
 *      declared with DIFFERENT version ranges across manifests. These libraries
 *      encode behavior shared across a build boundary; a mismatch means a value
 *      valid on one side can be rejected on the other.
 *
 *   2. toolchain-version-drift (warn) — a dependency in `toolchainDeps`
 *      (typescript, @types/*) differs across manifests. Lower severity: a
 *      compiler/type split is a maintenance smell, not a runtime contract break.
 *
 *   3. aws-sdk-minor-spread (warn) — within ONE manifest, `@aws-sdk/*` clients
 *      span more than `maxAwsSdkMinorSpread` minor releases. A wide spread pulls
 *      mismatched `@smithy/*` cores into the same bundle and bloats cold starts.
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check dependency-version-parity
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";

export const DEPENDENCY_VERSION_PARITY_DEFAULTS = {
  manifests: [
    "package.json",
    "infra/lambda/package.json",
    "infra/aws/package.json",
    "packages/connections-arkitect/package.json",
    "packages/connections-ui/package.json",
  ],
  // Runtime libraries whose behavior must match across the FE↔Lambda boundary.
  // A version mismatch here is a real contract break (error).
  contractDeps: ["valibot", "libphonenumber-js", "luxon", "tz-lookup", "pg"],
  // Toolchain/type packages — a split is a maintenance smell, not a runtime
  // contract break (warn). TypeScript major bumps are managed via dependabot.
  toolchainDeps: ["typescript", "@types/node", "@types/luxon", "@types/pg"],
  awsSdkPrefix: "@aws-sdk/",
  // AWS SDK v3 versions are 3.<minor>.<patch>; flag a single manifest whose
  // clients span more than this many minor releases (446 in the original audit).
  maxAwsSdkMinorSpread: 100,
  outputPath: "tmp/audits/DEPENDENCY_VERSION_PARITY_AUDIT.md",
};

const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function lineOfDep(source, depName) {
  const lines = source.split("\n");
  const needle = `"${depName}"`;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return 1;
}

function collectDeps(pkg) {
  const out = new Map();
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === "string") out.set(name, range);
    }
  }
  return out;
}

/** Parse the minor component from an `@aws-sdk` caret range like `^3.1040.0`. */
function awsSdkMinor(range) {
  const match = String(range).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return Number(match[2]);
}

export async function runDependencyVersionParityAudit(cfg, root) {
  const { manifests, contractDeps, toolchainDeps, awsSdkPrefix, maxAwsSdkMinorSpread } = cfg;
  const findings = [];

  // Load every manifest that exists.
  const loaded = [];
  for (const rel of manifests) {
    const abs = path.resolve(root, rel);
    let source;
    try {
      source = await fs.readFile(abs, "utf8");
    } catch {
      continue; // manifest absent (e.g. connections-ui has no package.json)
    }
    let pkg;
    try {
      pkg = JSON.parse(source);
    } catch {
      continue;
    }
    loaded.push({ rel, source, deps: collectDeps(pkg) });
  }

  // --- Rules 1 & 2: cross-manifest parity for named deps ---
  const checkParity = (names, ruleId, severity) => {
    for (const name of names) {
      const occurrences = loaded
        .map((m) => ({ rel: m.rel, range: m.deps.get(name), source: m.source }))
        .filter((o) => o.range);
      if (occurrences.length < 2) continue;
      const ranges = new Set(occurrences.map((o) => o.range));
      if (ranges.size === 1) continue; // aligned
      const summary = occurrences.map((o) => `${o.rel} → ${o.range}`).join(", ");
      for (const o of occurrences) {
        findings.push(
          createFinding({
            ruleId,
            severity,
            filePath: o.rel,
            line: lineOfDep(o.source, name),
            message: `"${name}" version drifts across manifests: ${summary}. Pin it to one range so it can't behave differently across the build boundary.`,
            snippet: `"${name}": "${o.range}"`,
            metadata: { dependency: name, ranges: [...ranges], occurrences: occurrences.map((x) => x.rel) },
          }),
        );
      }
    }
  };
  checkParity(contractDeps, "contract-dep-version-drift", "error");
  checkParity(toolchainDeps, "toolchain-version-drift", "warn");

  // --- Rule 3: aws-sdk minor spread within a single manifest ---
  for (const m of loaded) {
    const minors = [];
    for (const [name, range] of m.deps) {
      if (!name.startsWith(awsSdkPrefix)) continue;
      const minor = awsSdkMinor(range);
      if (minor != null) minors.push({ name, range, minor });
    }
    if (minors.length < 2) continue;
    const values = minors.map((x) => x.minor);
    const spread = Math.max(...values) - Math.min(...values);
    if (spread <= maxAwsSdkMinorSpread) continue;
    const lo = minors.reduce((a, b) => (a.minor <= b.minor ? a : b));
    const hi = minors.reduce((a, b) => (a.minor >= b.minor ? a : b));
    findings.push(
      createFinding({
        ruleId: "aws-sdk-minor-spread",
        severity: "warn",
        filePath: m.rel,
        line: lineOfDep(m.source, lo.name),
        message: `@aws-sdk/* clients span ${spread} minor releases in ${m.rel} (${lo.name}@${lo.range} … ${hi.name}@${hi.range}). Normalize to one minor line to avoid mismatched @smithy cores and cold-start bloat.`,
        snippet: `"${lo.name}": "${lo.range}"`,
        metadata: { manifest: m.rel, spread, low: lo, high: hi },
      }),
    );
  }

  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath));

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const report = renderReport(
    findings,
    loaded.map((m) => m.rel),
  );
  return {
    failed: errorCount > 0,
    findings,
    jsonPayload: { findings, manifestsScanned: loaded.map((m) => m.rel) },
    report,
  };
}

function renderReport(findings, scanned) {
  const lines = [
    "# Dependency Version Parity Audit",
    "",
    `- Manifests scanned: ${scanned.join(", ") || "(none)"}`,
    `- Findings: ${findings.length} (${findings.filter((f) => f.severity === "error").length} error)`,
    "",
  ];
  if (findings.length === 0) {
    lines.push("All cross-boundary dependencies are version-aligned.");
    return lines.join("\n");
  }
  for (const f of findings) {
    lines.push(`- **[${f.severity}] ${f.filePath}:${f.line}** (${f.ruleId}) — ${f.message}`);
  }
  return lines.join("\n");
}

export const audit = {
  id: "dependency-version-parity",
  title: "Dependency Version Parity",
  category: "backend",
  defaultConfig: {
    ...DEPENDENCY_VERSION_PARITY_DEFAULTS,
    includeInAll: true,
  },
  async run(context) {
    const result = await runDependencyVersionParityAudit(context.checkConfig, context.root);
    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      report: result.report,
      outputPath: context.checkConfig.outputPath,
    };
  },
};
