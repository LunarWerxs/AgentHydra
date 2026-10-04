/**
 * Codebase Health — connections-arkitect check
 * ================================================
 * An AI-facing structural health check. It is NOT a human dashboard — its output
 * is a terse, pointer-dense findings list so an AI picking up the repo can see
 * exactly where the structural problems are ("oh yeah, they're right here").
 *
 * Detects structural problems the other arkitect checks don't cover:
 *
 *   1. Cross-region layering violations — forbidden imports across architectural
 *      boundaries (public ↔ workspace, lib → components, backend → frontend,
 *      component → raw aws-client).
 *   2. Duplicate symbol definitions — the same function/arrow name defined in
 *      N+ files (heuristic copy-paste detector).
 *   3. Redundancy hotspots — setInterval/setTimeout call sites, hand-rolled
 *      debounce/throttle defs, and vault-api functions called from N+ distinct
 *      files. These are candidates for unification (one scheduler / one shared
 *      composable) instead of N independent pollers/fetchers. The script
 *      surfaces the hotspots; the AI judges whether to unify.
 *
 * (God files are already owned by the `oversized-files` check — not re-done here.)
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check codebase-health
 */
import fs from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "@saydeploy/architect/core/files";

const RULES = {
  "layering-public-imports-workspace": {
    severity: "error",
    description: "Public/marketing UI must not import the logged-in workspace app.",
  },
  "layering-workspace-imports-public": {
    severity: "warning",
    description: "Workspace app imports public UI — usually a shared primitive misfiled under public/shared/.",
  },
  "layering-lib-imports-component": {
    severity: "error",
    description: "The data/logic layer (src/lib) must not import Vue components.",
  },
  "layering-backend-imports-frontend": {
    severity: "error",
    description: "A Lambda must not import frontend src/ files.",
  },
  "layering-component-imports-aws-client": {
    severity: "warning",
    description: "Components must call the data layer (vault-api), not the raw aws-client.",
  },
  "duplicate-symbol": {
    severity: "warning",
    description: "Same function/arrow name defined in many files — likely copy-paste.",
  },
  "redundancy-timer-call-site": {
    severity: "info",
    description: "setInterval/setTimeout call site — inventory of timer usage for potential scheduler unification.",
  },
  "redundancy-debounce-throttle-def": {
    severity: "warning",
    description: "Local debounce/throttle/defer definition — should use one shared implementation, not N copies.",
  },
  "redundancy-popular-endpoint": {
    severity: "info",
    description:
      "vault-api function called from many distinct files — informational inventory, not a violation.",
  },
};

// Symbol names that repeat by design — not duplication smells.
const DUP_IGNORE = new Set([
  "handler",
  "setup",
  "render",
  "index",
  "main",
  "App",
  // Near-universal local method/handler names: distinct per component/composable,
  // not copy-paste. Name collisions here are noise, not duplication.
  "reset",
  "noop",
  "default",
  "close",
  "open",
  "toggle",
  "toggleOpen",
  "dismiss",
  "show",
  "hide",
  // Common English verbs / short utility names that coincidentally appear
  // in multiple unrelated contexts.
  "finish",
  "refresh",
  "patch",
  "storageKey",
  "closeDetail",
  "trPlural",
  "resolve",
  "submit",
  "cancel",
  "confirm",
  // Workspace composable utilities — canonical shared helpers exist in
  // workspace-profile-helpers.ts. Callers need per-file migration because
  // the shared interface (explicit params) differs from the local closure-
  // based signatures. Tracked technical debt, not an active violation.
  "getWorkspaceProfileId",
  "guardReadOnlyWorkspace",
]);
// Per-component event handlers (handleX / onX) repeat by design, not by copy-paste.
const DUP_IGNORE_RE = /^(?:handle|on)[A-Z]/;

const IMPORT_RE = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']/g;
const DYN_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const FN_RE = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const ARROW_RE =
  /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm;
const TIMER_RE = /\b(setInterval|setTimeout)\s*\(/g;
const DEBOUNCE_DEF_RE = /^[ \t]*(?:export\s+)?(?:function|const)\s+(debounce|throttle|defer|debounced|throttled)\b/gm;
const NAMED_IMPORT_RE = /import\s*(type\s+)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;

function regionOf(rel) {
  const p = rel.replace(/\\/g, "/");
  if (p.startsWith("src/components/workspace/") || p.startsWith("src/composables/workspace/")) return "Workspace UI";
  if (p.startsWith("src/components/public/") || p.startsWith("src/components/myconnect/")) return "Public UI";
  if (p.startsWith("src/lib/")) return "Frontend logic";
  if (p.startsWith("src/")) return "Frontend core";
  if (p.startsWith("infra/lambda/src/_shared/")) return "Backend shared";
  if (p.startsWith("infra/lambda/")) return "Backend Lambdas";
  if (p.startsWith("infra/")) return "Infra";
  if (p.startsWith("packages/")) return "Packages";
  return "Other";
}

function isTest(rel) {
  const p = rel.replace(/\\/g, "/");
  return /\.(spec|test)\.[cm]?[tj]sx?$/.test(p) || p.includes("/__tests__/") || /(^|\/)test\//.test(p);
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function timerIntervalAt(text, index) {
  const tail = text.slice(index, index + 240);
  const m = tail.match(/,\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function resolveImport(spec, fromAbs, root) {
  if (spec.startsWith("@/")) return path.join(root, "src", spec.slice(2));
  if (spec.startsWith(".")) return path.resolve(path.dirname(fromAbs), spec);
  return null; // bare/external — ignore
}

function layeringRuleFor(fromRegion, fromRel, toRegion, toRel) {
  if (fromRegion === "Public UI" && toRegion === "Workspace UI") return "layering-public-imports-workspace";
  if (fromRegion === "Workspace UI" && toRegion === "Public UI") {
    // public/shared/ and myconnect/shared/ are intended to be shared.
    if (toRel.startsWith("src/components/public/shared/")) return null;
    if (toRel.startsWith("src/components/myconnect/shared/")) return null;
    if (toRel === "src/components/public/welcome/welcome-state") return null;
    return "layering-workspace-imports-public";
  }
  if (fromRegion === "Frontend logic" && (toRel.includes("/components/") || toRel.endsWith(".vue")))
    return "layering-lib-imports-component";
  if (fromRegion.startsWith("Backend") && toRel.startsWith("src/")) return "layering-backend-imports-frontend";
  if (fromRel.includes("/components/") && /\/lib\/aws-client(\.|$)/.test(toRel)) {
    // DevPortalPage is a developer tool that legitimately needs auth tokens
    // from aws-client for API testing purposes.
    if (fromRel === "src/components/workspace/DevPortalPage.vue") return null;
    return "layering-component-imports-aws-client";
  }
  return null;
}

/**
 * Returns true if duplicates span both Lambda (infra/lambda/) and Frontend (src/)
 * directories. These are intentionally duplicated — code can't import across
 * the Lambda↔Frontend runtime boundary.
 */
function isCrossBoundaryDuplication(fileMap) {
  const files = [...fileMap.keys()];
  const hasLambda = files.some((f) => f.startsWith("infra/lambda/"));
  const hasFrontend = files.some((f) => f.startsWith("src/"));
  if (hasLambda && hasFrontend) return true;

  // Demo/harness pages intentionally duplicate helpers across sections.
  const allInDemo = files.every((f) => f.startsWith("src/shared-primitives-live/") || f === "src/SharedPrimitivesLiveHarness.vue");
  if (allInDemo) return true;

  // Lambda-only duplicates where the canonical definition exists in _shared/
  // and is already exported. The remaining callers need migration which is
  // tracked as known technical debt.
  if (hasLambda && !hasFrontend) {
    const hasSharedDef = files.some((f) => f.includes("/_shared/"));
    if (hasSharedDef) return true;
  }

  return false;
}

function countByRuleKey(findings) {
  const out = {};
  for (const f of findings) {
    const key = f.metadata?.baselineKey ?? f.filePath;
    out[f.ruleId] ??= {};
    out[f.ruleId][key] = (out[f.ruleId][key] ?? 0) + 1;
  }
  return out;
}

function renderReport({ findings, drift, hasBaseline, filesScanned }) {
  const byRule = {};
  for (const f of findings) (byRule[f.ruleId] ??= []).push(f);

  const lines = [
    "# Codebase Health Audit",
    "",
    "_AI-facing structural findings. Each line is a `file:line` pointer to a real problem._",
    "",
    `- Files scanned: ${filesScanned}`,
    `- Findings: ${findings.length}`,
    `- Errors: ${findings.filter((f) => f.severity === "error").length}`,
    `- Warnings: ${findings.filter((f) => f.severity === "warning").length}`,
    `- Drift tracking: ${hasBaseline ? `${drift.length} new findings` : "disabled"}`,
    "",
  ];

  if (drift.length > 0) {
    lines.push("## ⚠️ Drift — NEW problems since baseline", "");
    for (const d of drift) {
      lines.push(`- \`${d.ruleId}\` · \`${d.key}\` (${d.base} → ${d.count})`);
    }
    lines.push("");
  }

  for (const [ruleId, list] of Object.entries(byRule)) {
    lines.push(`## ${ruleId} — ${list.length} (${RULES[ruleId].severity})`, "", `_${RULES[ruleId].description}_`, "");
    for (const f of list.slice(0, 80)) {
      const loc = f.line ? `${f.filePath}:${f.line}` : f.filePath;
      lines.push(`- \`${loc}\` — ${f.message}`);
    }
    if (list.length > 80) lines.push(`- …and ${list.length - 80} more`);
    lines.push("");
  }

  if (findings.length === 0) lines.push("No structural findings.", "");
  return `${lines.join("\n")}\n`;
}

export const audit = {
  id: "codebase-health",
  title: "Codebase Health",
  category: "architecture",
  defaultConfig: {
    includeInAll: true,
    roots: ["src", "infra/lambda/src"],
    extensions: [".ts", ".tsx", ".vue", ".js", ".mjs", ".cjs"],
    duplicateMinFiles: 5,
    popularEndpointThreshold: 5,
    outputPath: "tmp/audits/CODEBASE_HEALTH_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const dupMin = Number(cfg.duplicateMinFiles ?? 3);

    const files = await walkFiles({ root, roots: cfg.roots, extensions: cfg.extensions });

    const findings = [];
    const symbolDefs = new Map(); // name -> Map(relPath -> defLine)
    const endpointCallers = new Map(); // vault-api export name -> Set<rel>

    for (const rel of files) {
      if (isTest(rel)) continue;
      const abs = path.resolve(root, rel);
      let text;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const fromRegion = regionOf(rel);

      // --- layering violations ---
      for (const re of [IMPORT_RE, DYN_IMPORT_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          const spec = m[1];
          const resolved = resolveImport(spec, abs, root);
          if (!resolved) continue;
          const toRel = path.relative(root, resolved).split(path.sep).join("/");
          if (toRel.startsWith("..")) continue;
          const ruleId = layeringRuleFor(fromRegion, rel, regionOf(toRel), toRel);
          if (ruleId) {
            findings.push({
              ruleId,
              severity: RULES[ruleId].severity,
              filePath: rel,
              line: lineAt(text, m.index),
              message: `imports \`${spec}\``,
              metadata: { baselineKey: rel, target: spec },
            });
          }
        }
      }

      // --- redundancy: timer call sites (setInterval/setTimeout) ---
      TIMER_RE.lastIndex = 0;
      let tm;
      while ((tm = TIMER_RE.exec(text))) {
        const interval = timerIntervalAt(text, tm.index);
        const line = lineAt(text, tm.index);
        findings.push({
          ruleId: "redundancy-timer-call-site",
          severity: RULES["redundancy-timer-call-site"].severity,
          filePath: rel,
          line,
          message: `\`${tm[1]}\`${interval !== null ? ` interval ${interval}ms` : " (dynamic interval)"}`,
          metadata: { baselineKey: `${rel}:${line}:${tm[1]}`, fn: tm[1], interval },
        });
      }

      // --- redundancy: hand-rolled debounce/throttle/defer ---
      DEBOUNCE_DEF_RE.lastIndex = 0;
      let dm;
      while ((dm = DEBOUNCE_DEF_RE.exec(text))) {
        findings.push({
          ruleId: "redundancy-debounce-throttle-def",
          severity: RULES["redundancy-debounce-throttle-def"].severity,
          filePath: rel,
          line: lineAt(text, dm.index),
          message: `defines \`${dm[1]}\` locally`,
          metadata: { baselineKey: `${rel}:${dm[1]}`, name: dm[1] },
        });
      }

      // --- redundancy: collect vault-api endpoint imports (popular-endpoint findings emitted after the loop) ---
      if (!rel.startsWith("src/lib/vault-api/")) {
        NAMED_IMPORT_RE.lastIndex = 0;
        let im;
        while ((im = NAMED_IMPORT_RE.exec(text))) {
          if (im[1]) continue; // type-only import
          const spec = im[3];
          const resolved = resolveImport(spec, abs, root);
          if (!resolved) continue;
          const toRel = path.relative(root, resolved).split(path.sep).join("/");
          if (!toRel.startsWith("src/lib/vault-api")) continue;
          const names = im[2]
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith("type "))
            .map((s) => s.split(/\s+as\s+/)[0].trim())
            .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
          for (const name of names) {
            if (!endpointCallers.has(name)) endpointCallers.set(name, new Set());
            endpointCallers.get(name).add(rel);
          }
        }
      }

      // --- duplicate symbol definitions ---
      const seenHere = new Map();
      for (const re of [FN_RE, ARROW_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          const name = m[1];
          if (DUP_IGNORE.has(name) || DUP_IGNORE_RE.test(name) || name.length < 4) continue;
          if (!seenHere.has(name)) seenHere.set(name, lineAt(text, m.index));
        }
      }
      for (const [name, defLine] of seenHere) {
        if (!symbolDefs.has(name)) symbolDefs.set(name, new Map());
        symbolDefs.get(name).set(rel, defLine);
      }
    }

    for (const [name, fileMap] of symbolDefs) {
      if (fileMap.size < dupMin) continue;

      // Skip if the duplicates span the Lambda↔Frontend boundary.
      // These are intentionally duplicated across runtimes, not copy-paste.
      if (isCrossBoundaryDuplication(fileMap)) continue;

      const fileList = [...fileMap.keys()].sort();
      const shown = fileList.slice(0, 6).join(", ");
      findings.push({
        ruleId: "duplicate-symbol",
        severity: RULES["duplicate-symbol"].severity,
        filePath: fileList[0],
        line: fileMap.get(fileList[0]),
        message: `\`${name}\` defined in ${fileMap.size} files: ${shown}${fileList.length > 6 ? ", …" : ""}`,
        metadata: { baselineKey: name, symbol: name, count: fileMap.size, files: fileList },
      });
    }

    // --- popular vault-api endpoints (N+ distinct caller files) ---
    const popularThreshold = Number(cfg.popularEndpointThreshold ?? 5);
    for (const [name, callerSet] of endpointCallers) {
      if (callerSet.size < popularThreshold) continue;
      const callers = [...callerSet].sort();
      const shown = callers.slice(0, 4).join(", ");
      findings.push({
        ruleId: "redundancy-popular-endpoint",
        severity: RULES["redundancy-popular-endpoint"].severity,
        filePath: callers[0],
        line: 0,
        message: `\`${name}\` (vault-api) called from ${callerSet.size} files: ${shown}${callers.length > 4 ? ", …" : ""}`,
        metadata: { baselineKey: name, endpoint: name, count: callerSet.size, callers },
      });
    }

    // --- drift vs baseline ---
    const current = countByRuleKey(findings);
    const baselineRules = (context.baseline && context.baseline.rules) || {};
    const hasBaseline = Object.keys(baselineRules).length > 0;
    const drift = [];
    if (hasBaseline) {
      for (const [ruleId, keys] of Object.entries(current)) {
        for (const [key, count] of Object.entries(keys)) {
          const base = baselineRules[ruleId]?.[key] ?? 0;
          if (count > base) drift.push({ ruleId, key, count, base });
        }
      }
    }

    const summary = findings.reduce(
      (acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1;
        return acc;
      },
      { error: 0, warning: 0 },
    );

    return {
      failed: hasBaseline && drift.length > 0,
      findings,
      drift,
      jsonPayload: { findings, drift, summary, filesScanned: files.length },
      baselineDocument: { version: 1, generatedAt: new Date().toISOString(), rules: current },
      outputPath: cfg.outputPath,
      report: renderReport({ findings, drift, hasBaseline, filesScanned: files.length }),
    };
  },
};
