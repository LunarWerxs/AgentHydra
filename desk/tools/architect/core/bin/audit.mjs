#!/usr/bin/env bun
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadAuditConfig, resolveAuditConfigPath } from "@saydeploy/architect/core/config";
import { parseAuditCliArgs } from "@saydeploy/architect/cli/args";
import { discoverAudits } from "@saydeploy/architect/cli/discovery";
import { runAuditCli } from "@saydeploy/architect/cli/runner";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checksRoot = path.resolve(__dirname, "..", "src", "checks");

// The standard model: every check that ships inside core.
const { audits: coreAudits } = await discoverAudits(checksRoot);

// Workspace-custom checks: core "loops through" the local pack's check dir(s) as
// if they lived inside core. The active config declares `checkDirs` (paths
// relative to the config file); each existing dir is discovered and merged. This
// is what keeps core pristine + copyable while the specialization lives outside
// it. Unresolved config (e.g. `list`/`help` with no policy) → core checks only.
const externalAudits = [];
try {
  const opts = parseAuditCliArgs(process.argv.slice(2));
  const configPath = await resolveAuditConfigPath(process.cwd(), {
    configPath: opts.configPath,
    policyDir: opts.policyDir,
    policy: opts.policy,
  });
  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  const baseDir = path.dirname(configPath);
  for (const entry of Array.isArray(rawConfig.checkDirs) ? rawConfig.checkDirs : []) {
    if (typeof entry !== "string" || !entry) continue;
    const dir = path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry);
    if (!existsSync(dir)) continue; // no custom checks present yet — fine
    const { audits: extra } = await discoverAudits(dir);
    externalAudits.push(...extra);
  }
} catch {
  // No resolvable config → run the core standard model alone.
}

const audits = [...coreAudits, ...externalAudits];

function getAudit(checkId) {
  return audits.find((audit) => audit.id === checkId) ?? null;
}

function printHelp() {
  console.log("Arkitect — codebase audit & contract-check framework");
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log('  AUDIT WORKFLOW — when told to "run the arkitect":');
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Step 1 — Full sweep:");
  console.log("    bun packages/connections-arkitect/bin/audit.mjs --all --fail-on-drift --quiet");
  console.log("    If this exits 0, the codebase is clean. Stop.");
  console.log("");
  console.log("  Step 2 — If failures, see everything:");
  console.log("    bun packages/connections-arkitect/bin/audit.mjs --all");
  console.log("    Then read tmp/audits/FIX_QUEUE.md — the consolidated priority list.");
  console.log("    Group findings into errors (must fix) vs warnings (should fix).");
  console.log("");
  console.log("  Step 3 — Fix one check at a time in priority order:");
  console.log("    1. product-contracts          (broken product invariants)");
  console.log("    2. feature-boundaries         (forbidden cross-feature imports)");
  console.log("    3. shared-layer-purity        (shared layer violations)");
  console.log("    4. vue-layering               (component layering breaks)");
  console.log("    5. workflow-outcome-contracts (workflow contract drift)");
  console.log("    6. All remaining errors");
  console.log("    7. All warnings");
  console.log("");
  console.log("    For each: bun audit.mjs --check <id>, read tmp/audits/, fix, re-run.");
  console.log("");
  console.log("  Step 4 — Confirm clean:");
  console.log("    bun packages/connections-arkitect/bin/audit.mjs --all --fail-on-drift --quiet");
  console.log('    Must exit 0. Never skip a check because "it\'s just a warning."');
  console.log("    Never add suppressions to silence findings — fix the root cause.");
  console.log("");
  console.log("  Step 5 — Evolve the arkitect:");
  console.log("    The arkitect is a living organism. After every run, review findings");
  console.log("    for detection gaps. False negatives → new checks. False positives →");
  console.log("    refine detection. Repeated fixes → automate. Never be surprised twice.");
  console.log("    See INSTRUCTION_MANUAL.md § Arkitect Self-Evolution.");
  console.log("");
  console.log("  Step 6 — Companion checks (run after arkitect is clean):");
  console.log("    npx @lunawerx/normwind --fix    # Tailwind shorthand normalization");
  console.log("    npx npm-check                   # Outdated & unused package check");
  console.log("");
  console.log("  Step 7 — Dynamic checks (require the project-configured dev server/browser inputs):");
  console.log("    bun run audit:har:capture       # Capture HAR files from dev server");
  console.log("    bun run audit:browser-perf      # Collect + audit browser perf metrics");
  console.log("    bun run audit:mobile:full       # Full mobile browser/device audit");
  console.log("    bun run audit:icon-optics       # Icon alignment visual check");
  console.log("    bun run audit:screenshot --list # Visual regression scenarios");
  console.log("");
  console.log("  Step 8 — Tests (unit, E2E, Lighthouse):");
  console.log("    bun audit.mjs --check unit-tests   # Full unit test suite");
  console.log("    bun audit.mjs --check e2e-tests    # Integration / E2E tests");
  console.log("    bun audit.mjs --check lighthouse   # Lighthouse performance audit");
  console.log("");
  console.log("  One-command full pass:");
  console.log("    bun run audit:full              # static + normwind + npm-check");
  console.log("    bun run audit:tests             # unit + e2e + lighthouse");
  console.log("    bun run audit:dynamic           # all dynamic checks (needs dev server)");
  console.log("    bun run audit:everything        # static + dynamic + tests + normwind + npm-check");
  console.log("    bun run audit:knip              # strict variant, fails on any issue");
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  USAGE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  bun packages/connections-arkitect/bin/audit.mjs list");
  console.log("  bun packages/connections-arkitect/bin/audit.mjs --all");
  console.log("  bun packages/connections-arkitect/bin/audit.mjs --check <id>");
  console.log("  bun packages/connections-arkitect/bin/audit.mjs --check <id> --fail-on-drift");
  console.log("  bun packages/connections-arkitect/bin/audit.mjs --check <id> --section=<name>");
  console.log("");
  console.log("  Flags: --all, --check, --config, --policy-dir, --policy, --fail-on-drift, --quiet, --format, --output");
  console.log("  Formats: markdown (default), json");
  console.log("");
  console.log("  Full manual: packages/connections-arkitect/docs/INSTRUCTION_MANUAL.md");
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  QUICK REFERENCE — common checks");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  architecture:  feature-boundaries, shared-layer-purity, vue-layering,");
  console.log("                 css-dedupe, circular-deps, dep-rules, boot-graph");
  console.log("  contracts:     product-contracts, analytics-contracts,");
  console.log("                 workflow-outcome-contracts");
  console.log("  design-system: design-tokens, m3-guidelines, motion-policy, icon-policy,");
  console.log("                 ui-drift, z-index-policy, mobile-audit");
  console.log("  code-quality:  crap-score, cyclomatic-complexity, churn-hotspots,");
  console.log("                 no-deep-relative-imports, code-duplication (opt-in)");
  console.log("  meta:          arkitect-report, arkitect-matrix, bundle-size-budget");
  console.log("");
  console.log("  Run 'bun audit.mjs list' for every registered check.");
}

runAuditCli({
  argv: process.argv.slice(2),
  audits,
  getAudit,
  loadConfig: loadAuditConfig,
  printHelp,
  root: process.cwd(),
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
