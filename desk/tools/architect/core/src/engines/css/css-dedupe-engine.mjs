#!/usr/bin/env bun
/**
 * CSS de-dup workspace audit.
 *
 * CSS duplication auditor.
 *
 * Parses every CSS, SCSS, and Vue <style> block in the workspace via PostCSS
 * (no regex hacks for nested rules / media queries / scoped blocks), then
 * surfaces seven classes of duplication that minifiers won't show you and that
 * authored sources accumulate over time:
 *
 *   1. HOT DECLARATIONS         Single `property: value` pairs sorted by
 *                               frequency. Catches "200× font-family: var(--gc-font-ui)".
 *
 *   2. DUPLICATE DECLARATION SETS  Selectors that share an *identical* set of
 *                                  declarations (≥ given size). The "47 selectors
 *                                  all set {color, font-family, line-height}" report.
 *
 *   3. DUPLICATE FULL RULES     Identical rule bodies under different
 *                               selectors in the same merge-safe scope —
 *                               exact selector-list candidates.
 *
 *   4. NEAR-DUPLICATE RULES     Rule pairs with Jaccard ≥ threshold on their
 *                               declaration sets. Candidates for shared base
 *                               + delta extraction.
 *
 *   5. SHARED BASE SUBSETS      Rules in the same CSS scope that share a
 *                               multi-declaration subset but keep small deltas.
 *                               Catches vendor pseudo-element families like
 *                               range tracks/progress.
 *
 *   6. SELECTOR-LIST CANDIDATES Single-declaration rules that share the same
 *                               declaration → trivially mergeable into a comma
 *                               selector list (.a, .b, .c { color: X; }).
 *
 *   7. COLOR DRIFT              Hex/rgb literals that match the resolved value
 *                               of an existing token in src/styles/tokens.css.
 *
 *   8. LOCAL CONSOLIDATION      Same-file candidates ranked by confidence and
 *                               likely source cleanup value. This is the
 *                               "what should I touch next?" view.
 *
 * Detection only. No source rewrites — postcss-merge-rules / cssnano operate
 * on build output; this tool reports against authored sources so you can
 * refactor the actual files.
 *
 * Suppression policy (lazy-merge filters):
 *   The audit deliberately *does not* flag candidates where mechanical
 *   deduplication would make the source worse. These are filtered out via
 *   getLocalCandidateSuppression() and isCoincidentalCrossFileGroup():
 *
 *     • Shared-base candidates with ≤ 2 shared declarations where ANY of
 *       them is layout plumbing (align-items:center, justify-content:center,
 *       display:flex, flex:0 0 auto, gap:Npx, min-width:0, padding:0, …).
 *       The remaining "real" declaration is too thin to justify a selector-
 *       list extraction; 3+ shared declarations are the real refactor zone.
 *
 *     • Same-file shared-base candidates whose rules belong to fully unrelated
 *       selector namespaces over a > 80-line span. They happen to share
 *       declarations but they are different UI elements (e.g., a chevron icon
 *       at line 87 and an avatar circle at line 261 of editor.css).
 *
 *     • Shared-base candidates inside @keyframes blocks. Each percentage step
 *       is a frame in a motion curve; the *deltas* between frames define the
 *       animation. Extracting a shared base hides those deltas.
 *
 *     • Single-declaration / selector-list candidates spread across ≥ 4
 *       unrelated selector namespaces in a stylesheet that is NOT explicitly
 *       a shared-declarations file. The shared-marker pattern only belongs
 *       in files like shared-declarations.css.
 *
 *     • Cross-file duplicate-full-rule groups whose rules span ≥ 3 unrelated
 *       selector namespaces with no dominant namespace. Mathematically
 *       identical, architecturally coincidence; merging would couple
 *       unrelated route packages.
 *
 *   Single-file exact-rule selector-list candidates (the real refactor wins —
 *   e.g., five rules all setting border-radius: var(--gc-radius-section-card)
 *   on related card surfaces) are NEVER suppressed.
 *
 * Honored ignore comments:
 *   /* css-audit-ignore: <reason> *\/
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check css-dedupe
 *   bun packages/connections-arkitect/bin/audit.mjs --check css-dedupe -- --section=hot
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import postcssScss from "postcss-scss";

const engineDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(engineDirectory, "../../..");

let repoRoot = defaultRepoRoot;
let tokensCssPath = path.join(repoRoot, "src", "styles", "core", "tokens.css");
let utilitiesCssPath = path.join(repoRoot, "src", "styles", "core", "utilities.css");
// Declarations that ALREADY have a 1:1 `.gc-*` utility class. The hot-declaration
// review flags `property:value` pairs on the premise that "a utility is missing" —
// which is a false positive when the utility demonstrably exists (e.g. display:flex →
// .gc-flex). These are excluded from the warning tally (adoption, not extraction, is
// the lever); they remain visible in the dashboard tagged `has-utility`.
let utilityBackedFingerprints = new Set();
let sourceRootPaths = [path.join(repoRoot, "src")];
let reportOutputPath = path.join(repoRoot, "tmp", "audit-css-dedupe-report.md");
let jsonOutputPath = path.join(repoRoot, "tmp", "audit-css-dedupe-report.json");

/** Paths excluded by default. Pass --include-all to scan them anyway. */
let defaultExcludedRelativePaths = [
  "src/app/app-config.ts",
  "src/lib/profile/builder-theme.ts",
  "infra/lambda",
  "src/__tests__",
];

let ignoreFilenameSuffixes = [".spec.ts", ".test.ts", ".d.ts"];
let scannedExtensions = new Set([".vue", ".css", ".scss"]);

let cliFlags = parseCliFlags([]);

export async function runCssDedupeAudit(options = {}) {
  configureCssDedupeAudit(options);
  const tokenIndex = await buildTokenIndex(tokensCssPath);
  utilityBackedFingerprints = await buildUtilityFingerprintSet(utilitiesCssPath);
  const sourceFileSet = new Set();
  for (const sourcePath of sourceRootPaths) {
    const files = await collectSourceFiles(sourcePath);
    for (const file of files) sourceFileSet.add(file);
  }
  const sourceFiles = [...sourceFileSet].sort();

  /** @type {Rule[]} */
  const allRules = [];
  for (const file of sourceFiles) {
    const fileRules = await parseFileForRules(file);
    allRules.push(...fileRules);
  }

  const sections = {
    hotDeclarations:
      cliFlags.section === null || cliFlags.section === "hot"
        ? findHotDeclarations(allRules, cliFlags.thresholdHot)
        : null,
    vendorPrefixFamilies:
      cliFlags.section === null || cliFlags.section === "hot" || cliFlags.section === "prefixes"
        ? findVendorPrefixFamilies(allRules, Math.max(2, Math.floor(cliFlags.thresholdHot / 5)))
        : null,
    duplicateDeclarationSets:
      cliFlags.section === null || cliFlags.section === "sets"
        ? findDuplicateDeclarationSets(allRules, cliFlags.thresholdSet, cliFlags.thresholdSetSize)
        : null,
    duplicateFullRules:
      cliFlags.section === null || cliFlags.section === "exact" ? findDuplicateFullRules(allRules) : null,
    nearDuplicateRules:
      cliFlags.section === null || cliFlags.section === "near"
        ? findNearDuplicateRules(allRules, cliFlags.jaccard, cliFlags.thresholdSetSize)
        : null,
    sharedBaseSubsets:
      cliFlags.section === null || cliFlags.section === "subset"
        ? findSharedBaseSubsets(allRules, Math.min(cliFlags.thresholdSet, 2), cliFlags.thresholdSetSize)
        : null,
    selectorListCandidates:
      cliFlags.section === null || cliFlags.section === "list"
        ? findSelectorListCandidates(allRules, cliFlags.thresholdSet)
        : null,
    localConsolidationCandidates:
      cliFlags.section === null || cliFlags.section === "local"
        ? findLocalConsolidationCandidates(allRules, cliFlags.thresholdSetSize)
        : null,
    colorDrift: cliFlags.section === null || cliFlags.section === "drift" ? findColorDrift(allRules, tokenIndex) : null,
  };

  const stats = {
    filesScanned: sourceFiles.length,
    rulesScanned: allRules.length,
    declarationsScanned: allRules.reduce((sum, rule) => sum + rule.declarations.length, 0),
    tokenCatalogSize: tokenIndex.tokenToValue.size,
    tokenHexEntries: tokenIndex.hexToTokens.size,
  };

  const markdownReport = renderMarkdownReport(stats, sections);
  const jsonPayload = buildJsonPayload(stats, sections);

  if (cliFlags.writeFiles) {
    if (cliFlags.json) {
      await writeJsonReport(jsonPayload);
    } else {
      await writeMarkdownReport(markdownReport);
    }
  }

  return {
    failed: Boolean(sections.colorDrift && sections.colorDrift.length > 0),
    jsonPayload,
    markdownReport,
    sections,
    stats,
    summary: renderConsoleSummary(stats, sections),
  };
}

function configureCssDedupeAudit(options) {
  repoRoot = path.resolve(options.root ?? defaultRepoRoot);
  tokensCssPath = path.resolve(repoRoot, options.tokensCssPath ?? "src/styles/core/tokens.css");
  utilitiesCssPath = path.resolve(repoRoot, options.utilitiesCssPath ?? "src/styles/core/utilities.css");
  sourceRootPaths = (options.sourceRoots ?? ["src"]).map((sourceRoot) => path.resolve(repoRoot, sourceRoot));
  reportOutputPath = path.resolve(repoRoot, options.reportOutputPath ?? "tmp/audit-css-dedupe-report.md");
  jsonOutputPath = path.resolve(repoRoot, options.jsonOutputPath ?? "tmp/audit-css-dedupe-report.json");
  defaultExcludedRelativePaths = options.excludedPaths ?? [
    "src/app/app-config.ts",
    "src/lib/profile/builder-theme.ts",
    "infra/lambda",
    "src/__tests__",
  ];
  ignoreFilenameSuffixes = options.ignoreFilenameSuffixes ?? [".spec.ts", ".test.ts", ".d.ts"];
  scannedExtensions = new Set(options.extensions ?? [".vue", ".css", ".scss"]);
  cliFlags = {
    ...parseCliFlags([]),
    ...(options.flags ?? {}),
    writeFiles: options.writeFiles === true,
  };
}

async function main() {
  const flags = parseCliFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(renderCssDedupeHelp());
    return;
  }

  const result = await runCssDedupeAudit({
    flags,
    root: defaultRepoRoot,
    writeFiles: true,
  });

  console.log(result.summary);
  if (cliFlags.failOnDrift && result.failed) process.exitCode = 1;
}

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

export function parseCssDedupeArgs(argv) {
  const flags = {
    includeAll: false,
    thresholdHot: 10,
    hotReviewThreshold: 50,
    hotTargetThreshold: 20,
    thresholdSet: 3,
    thresholdSetSize: 2,
    jaccard: 0.75,
    json: false,
    section: null, // null = all sections
    failOnDrift: false,
  };

  for (const argument of argv) {
    if (argument === "--include-all") flags.includeAll = true;
    else if (argument === "--json") flags.json = true;
    else if (argument === "--fail-on-drift") flags.failOnDrift = true;
    else if (argument === "--help" || argument === "-h") flags.help = true;
    else if (argument.startsWith("--threshold-hot=")) {
      flags.thresholdHot = parsePositiveInt(argument);
    } else if (argument.startsWith("--hot-review-threshold=")) {
      flags.hotReviewThreshold = parsePositiveInt(argument);
    } else if (argument.startsWith("--hot-target-threshold=")) {
      flags.hotTargetThreshold = parsePositiveInt(argument);
    } else if (argument.startsWith("--threshold-set=")) {
      flags.thresholdSet = parsePositiveInt(argument);
    } else if (argument.startsWith("--threshold-set-size=")) {
      flags.thresholdSetSize = parsePositiveInt(argument);
    } else if (argument.startsWith("--jaccard=")) {
      const parsed = Number.parseFloat(argument.slice("--jaccard=".length));
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
        throw new Error(`--jaccard must be in (0, 1]: ${argument}`);
      }
      flags.jaccard = parsed;
    } else if (argument.startsWith("--section=")) {
      const value = argument.slice("--section=".length);
      const allowed = ["hot", "sets", "exact", "near", "subset", "list", "local", "drift"];
      if (!allowed.includes(value)) {
        throw new Error(`--section must be one of ${allowed.join("|")}`);
      }
      flags.section = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return flags;
}

function parseCliFlags(argv) {
  return parseCssDedupeArgs(argv);
}

function parsePositiveInt(argument) {
  const value = Number.parseInt(argument.split("=")[1], 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Invalid integer: ${argument}`);
  }
  return value;
}

export function renderCssDedupeHelp() {
  return [
    "audit-css-dedupe — surface CSS duplication that minifiers don't reveal in authored sources",
    "",
    "Reports seven axes:",
    "  1. Hot declarations         Single property:value pairs by frequency",
    "  2. Duplicate decl-sets      Selectors sharing an identical declaration set",
    "  3. Duplicate full rules     Identical bodies under merge-safe selectors",
    "  4. Near-duplicate rules     Jaccard-similar rules (shared base candidates)",
    "  5. Shared base subsets      Common multi-decl bases with small deltas",
    "  6. Selector-list candidates Trivially mergeable single-decl rules",
    "  7. Color drift              Literals matching existing tokens",
    "  8. Local consolidation      Same-file candidates ranked by confidence",
    "",
    "Flags:",
    "  --threshold-hot=<n>        Min count for a hot declaration (default 10)",
    "  --hot-review-threshold=<n> Count where a hot declaration becomes a review queue item (default 50)",
    "  --hot-target-threshold=<n> Long-term target after a shared abstraction exists (default 20)",
    "  --threshold-set=<n>        Min selectors sharing a decl set (default 3)",
    "  --threshold-set-size=<n>   Min size of a shared decl set (default 2)",
    "  --jaccard=<0..1>           Min similarity for near-duplicates (default 0.75)",
    "  --section=<hot|sets|exact|near|subset|list|local|drift>  Run only one section",
    "  --include-all              Include excluded paths",
    "  --json                     Emit JSON instead of Markdown",
    "  --fail-on-drift            Exit 1 if any color drift exists",
    "  -h, --help                 Show help",
    "",
    "Inline ignore: /* audit-css-dedupe-ignore: <reason> */ (legacy /* cssdedewp-ignore: */ and /* css-audit-ignore: */ still honored)",
    "Reports: tmp/audit-css-dedupe-report.{md,json}",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// File collection
// ─────────────────────────────────────────────────────────────────────────

async function collectSourceFiles(directory) {
  /** @type {string[]} */
  const collected = [];

  async function walk(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const repoRelative = path.relative(repoRoot, absolutePath).replaceAll("\\", "/");

      if (!cliFlags.includeAll && isExcludedPath(repoRelative)) continue;

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name);
      if (!scannedExtensions.has(extension)) continue;

      if (!cliFlags.includeAll && ignoreFilenameSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
        continue;
      }

      collected.push(absolutePath);
    }
  }

  await walk(directory);
  return collected;
}

function isExcludedPath(repoRelativePath) {
  return defaultExcludedRelativePaths.some(
    (excluded) => repoRelativePath === excluded || repoRelativePath.startsWith(`${excluded}/`),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// File → Rule[] extraction (handles .vue, .css, .scss)
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Declaration
 * @property {string} prop      Lowercased property name
 * @property {string} value     Normalized value
 * @property {string} fingerprint  `${prop}:${value}` canonical form
 *
 * @typedef {Object} Rule
 * @property {string} file              Repo-relative file path
 * @property {number} line              1-indexed source line of the rule
 * @property {string} selector          Full selector string (may include commas)
 * @property {string[]} selectorList    Comma-split, trimmed selectors
 * @property {string} mediaContext      Concatenated @media / @supports / parent context (or "")
 * @property {Declaration[]} declarations
 * @property {string} declarationSetHash  Stable hash of the sorted declaration set
 * @property {string} fullRuleHash      Hash of selector + declarations (for pair identity)
 * @property {boolean} ignored          Honored css-audit-ignore comment
 * @property {string | null} ignoreReason
 * @property {"global" | "scoped" | "module"} scopeKind  CSS scope category
 * @property {string} scopeKey  Stable key shared by rules in the same selector-merge namespace.
 *                              Two rules can be merged into a single comma-separated selector
 *                              ONLY if they share the same scopeKey AND mediaContext.
 */

async function parseFileForRules(absolutePath) {
  const repoRelative = path.relative(repoRoot, absolutePath).replaceAll("\\", "/");
  const extension = path.extname(absolutePath);
  const source = await fs.readFile(absolutePath, "utf8");

  /** @type {Array<{cssText: string, lineOffset: number, scopeKind: "global" | "scoped" | "module", scopeKey: string}>} */
  const cssChunks = [];

  if (extension === ".vue") {
    cssChunks.push(...extractVueStyleBlocks(source, repoRelative));
  } else if (extension === ".css" || extension === ".scss") {
    // Global stylesheets are merge-safe only inside the same cascade layer.
    // A primitive-layer rule and a route-layer rule with identical declarations
    // are not automatically equivalent: moving either one can change which
    // later layer wins. Keep canonical app CSS grouped by inferred layer so
    // exact selector-list candidates stay mechanically actionable.
    const isCanonicalGlobal = repoRelative.startsWith("src/styles/") || repoRelative === "src/style.css";
    cssChunks.push({
      cssText: source,
      lineOffset: 0,
      scopeKind: "global",
      scopeKey: isCanonicalGlobal ? resolveCanonicalStylesScopeKey(repoRelative) : `global:${repoRelative}`,
    });
  } else {
    return [];
  }

  /** @type {Rule[]} */
  const rules = [];

  for (const chunk of cssChunks) {
    const parser = extension === ".scss" ? postcssScss : postcss;
    let root;
    try {
      // Use the SCSS parser for .scss, otherwise let postcss handle it.
      // The default parser tolerates Vue-style nested rules in <style scoped>
      // for our purposes (we only enumerate rules, not regenerate CSS).
      root = parser.parse(chunk.cssText, { from: repoRelative });
    } catch {
      // Skip files PostCSS can't parse (rare; usually template syntax in
      // <style> blocks). Fail silently — we don't want broken content to
      // halt the audit.
      continue;
    }

    root.walkRules((rule) => {
      const ignoreInfo = resolveRuleIgnoreContext(rule);
      const declarations = collectDeclarations(rule);
      if (declarations.length === 0) return;

      const mediaContext = collectMediaContext(rule);
      const lineInChunk = rule.source?.start?.line ?? 1;
      const sourceLine = lineInChunk + chunk.lineOffset;

      const selectorList = (rule.selector || "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

      const declarationSetHash = hashDeclarationSet(declarations);
      const fullRuleHash = hashFullRule(rule.selector ?? "", declarations);

      rules.push({
        file: repoRelative,
        line: sourceLine,
        selector: rule.selector ?? "",
        selectorList,
        mediaContext,
        declarations,
        declarationSetHash,
        fullRuleHash,
        ignored: ignoreInfo.ignored,
        ignoreReason: ignoreInfo.reason,
        scopeKind: chunk.scopeKind,
        scopeKey: chunk.scopeKey,
      });
    });
  }

  return rules;
}

/** Extract every <style ...> block from a Vue SFC, with the line offset of
 *  the block's opening line and a scope kind derived from the block's
 *  attributes. Scoped blocks each get their OWN scopeKey because Vite
 *  injects a unique [data-v-*] hash per SFC at build time — selectors from
 *  two scoped blocks cannot be merged into one rule even if they look
 *  identical in source.
 *
 *  CSS Modules (`<style module>`) likewise localize class names per file,
 *  so they get a per-file scopeKey.
 *
 *  Non-scoped <style> blocks are global at runtime, but they are usually
 *  authored and loaded with their component or route. Treat them as per-file
 *  merge scopes so the audit does not suggest combining them with canonical
 *  layered CSS. */
function extractVueStyleBlocks(source, repoRelative) {
  /** @type {Array<{cssText: string, lineOffset: number, scopeKind: "global" | "scoped" | "module", scopeKey: string}>} */
  const blocks = [];
  const styleBlockPattern = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;

  for (const match of source.matchAll(styleBlockPattern)) {
    const attributes = match[1] ?? "";
    const cssText = match[2];
    const fullMatchStart = match.index ?? 0;
    const innerStart = fullMatchStart + match[0].indexOf(">") + 1;
    const lineOffset = countNewlines(source.slice(0, innerStart));

    const isScoped = /\bscoped\b/.test(attributes);
    const isModule = /\bmodule\b/.test(attributes);

    /** @type {"global" | "scoped" | "module"} */
    let scopeKind;
    let scopeKey;
    if (isScoped) {
      scopeKind = "scoped";
      scopeKey = `scoped:${repoRelative}`;
    } else if (isModule) {
      scopeKind = "module";
      scopeKey = `module:${repoRelative}`;
    } else {
      scopeKind = "global";
      scopeKey = `global:${repoRelative}`;
    }

    blocks.push({ cssText, lineOffset, scopeKind, scopeKey });
  }

  return blocks;
}

function resolveCanonicalStylesScopeKey(repoRelative) {
  // Route stylesheets each get their OWN per-file merge scope. They all load
  // into the gc-routes cascade layer, but consolidating identical declarations
  // ACROSS route files is NOT a safe win: the only place to host a cross-file
  // comma-selector list is routes/shared-declarations.css, and sinking
  // coincidental cross-feature overlap there is exactly how that file grew into
  // a 1.9k-line value-keyed mega-file. Per-file scoping keeps within-file
  // cleanup actionable while never proposing cross-route merges. The gc-shared
  // and gc-primitives layers intentionally keep their shared sink (see the main
  // shared-declarations dissemination plan), so they are unaffected.
  if (repoRelative.startsWith("src/styles/routes/")) {
    return `global:${repoRelative}`;
  }
  const layer = inferCanonicalStylesLayer(repoRelative);
  return layer ? `global:src/styles:${layer}` : `global:${repoRelative}`;
}

function inferCanonicalStylesLayer(repoRelative) {
  if (repoRelative === "src/style.css") return "entry";
  if (repoRelative === "src/styles/shared-declarations.css") return "gc-shared";
  if (repoRelative.startsWith("src/styles/primitives/")) return "gc-primitives";

  if (repoRelative === "src/styles/core/base.css") return "gc-reset";
  if (repoRelative === "src/styles/core/forced-colors.css") return "gc-overrides";
  if (
    repoRelative === "src/styles/core/tokens.css" ||
    repoRelative === "src/styles/core/public-theme-bridge.css" ||
    repoRelative === "src/styles/core/transitions.css"
  ) {
    return "gc-tokens";
  }

  return null;
}

function countNewlines(text) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

/** @param {import("postcss").Rule} rule */
function collectDeclarations(rule) {
  /** @type {Declaration[]} */
  const declarations = [];
  rule.walkDecls((decl) => {
    // Only enumerate this rule's *own* declarations, not nested children.
    // PostCSS's walkDecls descends, but the default CSS dialect doesn't have
    // nested rules at the AST level except via plugins; we still guard for
    // safety in case a SCSS file is parsed.
    if (decl.parent !== rule) return;
    const prop = decl.prop.trim().toLowerCase();
    const value = normalizeDeclarationValue(decl.value);
    declarations.push({
      prop,
      value,
      fingerprint: `${prop}:${value}`,
    });
  });
  return declarations;
}

function normalizeDeclarationValue(rawValue) {
  // Collapse whitespace and lowercase to canonicalize equivalent values.
  // We deliberately do NOT lowercase string contents, but values rarely
  // contain quoted strings except for font-family, which is fine to
  // lowercase for comparison purposes (we're hashing for similarity).
  return rawValue.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Build the set of `property:value` fingerprints that already have a dedicated
 * single-declaration `.gc-*` utility class. A hot declaration whose fingerprint is
 * in this set is NOT a "missing utility" — the utility exists and adoption is the
 * lever — so it must not inflate the warning tally.
 */
async function buildUtilityFingerprintSet(cssPath) {
  const set = new Set();
  let source;
  try {
    source = await fs.readFile(cssPath, "utf8");
  } catch {
    return set;
  }
  let root;
  try {
    root = postcss.parse(source, { from: cssPath });
  } catch {
    return set;
  }
  root.walkRules((rule) => {
    const declarations = (rule.nodes ?? []).filter((node) => node.type === "decl");
    if (declarations.length !== 1) return;
    const selectors = (rule.selector || "").split(",").map((part) => part.trim());
    if (selectors.length === 0 || !selectors.every((selector) => /^\.[A-Za-z][\w-]*$/.test(selector))) return;
    const prop = declarations[0].prop.trim().toLowerCase();
    const value = normalizeDeclarationValue(declarations[0].value);
    set.add(`${prop}:${value}`);
  });
  return set;
}

/** @param {import("postcss").Rule} rule */
function collectMediaContext(rule) {
  const parts = [];
  let parent = rule.parent;
  while (parent && parent.type !== "root") {
    if (parent.type === "atrule") {
      const atRule = /** @type {import("postcss").AtRule} */ (parent);
      parts.unshift(`@${atRule.name} ${atRule.params}`.trim());
    }
    parent = parent.parent;
  }
  return parts.join(" / ");
}

/** Honor /* css-audit-ignore: reason *\/ comments inside or directly above
 *  the rule. */
function resolveRuleIgnoreContext(rule) {
  // Both spellings honored so renaming the tool didn't invalidate prior
  // annotations. Either marker silences a rule.
  const ignorePattern = /(?:audit-css-dedupe|cssdedewp|css-audit)-ignore\s*:\s*([^*\n\r]*)/i;

  // Inside the rule body
  let inside = null;
  rule.walkComments((comment) => {
    if (inside) return;
    const match = comment.text.match(ignorePattern);
    if (match) inside = match[1].trim() || "(no reason)";
  });
  if (inside) return { ignored: true, reason: inside };

  // Comment directly preceding the rule
  let previous = rule.prev();
  if (previous && previous.type === "comment") {
    const match = previous.text.match(ignorePattern);
    if (match) return { ignored: true, reason: match[1].trim() || "(no reason)" };
  }

  return { ignored: false, reason: null };
}

function hashDeclarationSet(declarations) {
  const sorted = [...declarations]
    .map((decl) => decl.fingerprint)
    .sort()
    .join("\n");
  return crypto.createHash("sha1").update(sorted).digest("hex").slice(0, 12);
}

function hashFullRule(selector, declarations) {
  const declarationsKey = [...declarations]
    .map((decl) => decl.fingerprint)
    .sort()
    .join("\n");
  return crypto.createHash("sha1").update(`${selector}\n${declarationsKey}`).digest("hex").slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Hot declarations
// ─────────────────────────────────────────────────────────────────────────

function findHotDeclarations(rules, threshold) {
  /** @type {Map<string, {count: number, examples: Array<{file: string, line: number, selector: string}>}>} */
  const counts = new Map();

  for (const rule of rules) {
    if (rule.ignored) continue;
    for (const declaration of rule.declarations) {
      const entry = counts.get(declaration.fingerprint);
      if (entry) {
        entry.count += 1;
        if (entry.examples.length < 8) {
          entry.examples.push({ file: rule.file, line: rule.line, selector: rule.selector });
        }
      } else {
        counts.set(declaration.fingerprint, {
          count: 1,
          examples: [{ file: rule.file, line: rule.line, selector: rule.selector }],
        });
      }
    }
  }

  /** @type {Array<{fingerprint: string, count: number, examples: Array<{file: string, line: number, selector: string}>}>} */
  const result = [];
  for (const [fingerprint, value] of counts.entries()) {
    if (value.count >= threshold) {
      result.push({ fingerprint, count: value.count, examples: value.examples });
    }
  }

  result.sort((a, b) => b.count - a.count);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// 1b. Vendor-prefix families
// ─────────────────────────────────────────────────────────────────────────

const VENDOR_PREFIX_PATTERN = /^-(?:webkit|moz|ms|o)-/;

function stripVendorPrefix(prop) {
  return prop.replace(VENDOR_PREFIX_PATTERN, "");
}

function findVendorPrefixFamilies(rules, threshold) {
  // Group declarations by (unprefixedProp:value). Report families where
  // at least two distinct prefix forms (or unprefixed + prefixed) exist —
  // these are real candidates either for autoprefixer generation or for
  // dropping legacy prefixes whose target browsers are no longer supported.
  // A prefixed-only vendor pseudo in one selector plus an unprefixed rule in
  // a different selector is usually noise, so only surface families that show
  // multiple prefix forms co-located in at least one rule.
  /** @type {Map<string, {prefixCounts: Map<string, number>, examples: Array<{file: string, line: number, selector: string, fingerprint: string}>, coLocatedRuleCount: number}>} */
  const families = new Map();

  for (const rule of rules) {
    if (rule.ignored) continue;
    /** @type {Map<string, Set<string>>} */
    const ruleFamilyPrefixForms = new Map();

    for (const declaration of rule.declarations) {
      const stripped = stripVendorPrefix(declaration.prop);
      if (stripped === declaration.prop && !VENDOR_PREFIX_PATTERN.test(declaration.prop)) {
        // Unprefixed and never going to be in a prefix family by itself —
        // skip allocating a bucket. We still track unprefixed forms when a
        // prefixed sibling brings the family into existence below.
      }
      const familyKey = `${stripped}:${declaration.value}`;
      const family = families.get(familyKey);
      const prefixForm =
        declaration.prop === stripped ? "(none)" : (declaration.prop.match(VENDOR_PREFIX_PATTERN)?.[0] ?? "(none)");
      if (family) {
        family.prefixCounts.set(prefixForm, (family.prefixCounts.get(prefixForm) ?? 0) + 1);
        if (family.examples.length < 8) {
          family.examples.push({
            file: rule.file,
            line: rule.line,
            selector: rule.selector,
            fingerprint: declaration.fingerprint,
          });
        }
      } else {
        families.set(familyKey, {
          prefixCounts: new Map([[prefixForm, 1]]),
          examples: [
            {
              file: rule.file,
              line: rule.line,
              selector: rule.selector,
              fingerprint: declaration.fingerprint,
            },
          ],
          coLocatedRuleCount: 0,
        });
      }

      const prefixForms = ruleFamilyPrefixForms.get(familyKey) ?? new Set();
      prefixForms.add(prefixForm);
      ruleFamilyPrefixForms.set(familyKey, prefixForms);
    }

    for (const [familyKey, prefixForms] of ruleFamilyPrefixForms.entries()) {
      if (prefixForms.size < 2) continue;
      const family = families.get(familyKey);
      if (!family) continue;
      family.coLocatedRuleCount += 1;
    }
  }

  const result = [];
  for (const [familyKey, family] of families.entries()) {
    // We only care about families where multiple prefix forms appear and the
    // total count is above the threshold — otherwise it's not a hot family
    // and the caller already sees the prop:value pair via findHotDeclarations.
    if (family.prefixCounts.size < 2) continue;
    if (family.coLocatedRuleCount < 1) continue;
    if (isRequiredCompatibilityPrefixFamily(familyKey, family.examples)) continue;
    const total = [...family.prefixCounts.values()].reduce((a, b) => a + b, 0);
    if (total < threshold) continue;
    result.push({ familyKey, total, prefixCounts: family.prefixCounts, examples: family.examples });
  }

  result.sort((a, b) => b.total - a.total);
  return result;
}

function isRequiredCompatibilityPrefixFamily(familyKey, examples) {
  if (/^(?:line-clamp|mask(?:-[^:]+)?|backdrop-filter):/.test(familyKey)) return true;
  if (familyKey.startsWith("box-shadow:") && examples.some((example) => /:-webkit-autofill/.test(example.selector))) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Duplicate declaration sets
// ─────────────────────────────────────────────────────────────────────────

function findDuplicateDeclarationSets(rules, threshold, minSetSize) {
  // Bucket by (declSetHash, scopeKey, mediaContext). Rules that share an
  // identical declaration set across DIFFERENT scopes are still useful
  // signal (the same shape exists in many places — candidate for a shared
  // utility class), so we ALSO compute a cross-scope view as a secondary
  // grouping. Same-scope groups are higher confidence and shown first.
  /** @type {Map<string, {hash: string, declarations: Declaration[], rules: Rule[], sameScope: boolean, scopeLabel: string}>} */
  const sameScopeGroups = new Map();
  /** @type {Map<string, {hash: string, declarations: Declaration[], rules: Rule[], sameScope: boolean, scopeLabel: string}>} */
  const crossScopeGroups = new Map();

  for (const rule of rules) {
    if (rule.ignored) continue;
    if (rule.declarations.length < minSetSize) continue;

    const sameScopeKey = `${rule.declarationSetHash}|${rule.scopeKey}|${rule.mediaContext}`;
    const sameScopeEntry = sameScopeGroups.get(sameScopeKey);
    if (sameScopeEntry) {
      sameScopeEntry.rules.push(rule);
    } else {
      sameScopeGroups.set(sameScopeKey, {
        hash: rule.declarationSetHash,
        declarations: rule.declarations,
        rules: [rule],
        sameScope: true,
        scopeLabel: describeScope(rule),
      });
    }

    const crossScopeEntry = crossScopeGroups.get(rule.declarationSetHash);
    if (crossScopeEntry) {
      crossScopeEntry.rules.push(rule);
    } else {
      crossScopeGroups.set(rule.declarationSetHash, {
        hash: rule.declarationSetHash,
        declarations: rule.declarations,
        rules: [rule],
        sameScope: false,
        scopeLabel: "mixed scopes",
      });
    }
  }

  /** @type {Array<{hash: string, declarations: Declaration[], rules: Rule[], sameScope: boolean, scopeLabel: string}>} */
  const result = [];
  const sameScopeHashes = new Set();
  for (const value of sameScopeGroups.values()) {
    if (value.rules.length >= threshold) {
      result.push(value);
      sameScopeHashes.add(value.hash);
    }
  }
  for (const value of crossScopeGroups.values()) {
    if (
      value.rules.length >= threshold &&
      value.declarations.length >= Math.max(minSetSize + 1, 3) &&
      !sameScopeHashes.has(value.hash) &&
      !value.rules.some((rule) => isKeyframeSelector(rule))
    ) {
      result.push(value);
    }
  }

  result.sort((a, b) => {
    if (a.sameScope !== b.sameScope) return a.sameScope ? -1 : 1;
    const sizeDelta = b.rules.length - a.rules.length;
    if (sizeDelta !== 0) return sizeDelta;
    return b.declarations.length - a.declarations.length;
  });
  return result;
}

function describeScope(rule) {
  if (rule.scopeKind === "global") {
    if (rule.scopeKey.startsWith("global:src/styles:")) {
      return `global stylesheets — ${rule.scopeKey.slice("global:src/styles:".length)} layer`;
    }
    return `global — ${rule.file}`;
  }
  if (rule.scopeKind === "scoped") return `Vue scoped — ${rule.file}`;
  return `Vue module — ${rule.file}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Duplicate full rules (identical body under different selectors)
// ─────────────────────────────────────────────────────────────────────────

function findDuplicateFullRules(rules) {
  /** @type {Map<string, {hash: string, scopeLabel: string, mediaContext: string, rules: Rule[]}>} */
  const grouped = new Map();

  for (const rule of rules) {
    if (rule.ignored) continue;
    // Exact selector-list merges are safe only inside the same generated CSS
    // namespace and conditional context. The previous implementation grouped
    // by fullRuleHash, which includes the selector, so it could only find
    // duplicate copies of the same selector and missed the actual cleanup case:
    // `.a { x:y }` + `.b { x:y }`.
    const key = `${rule.declarationSetHash}|${rule.scopeKey}|${rule.mediaContext}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.rules.push(rule);
    } else {
      grouped.set(key, {
        hash: rule.declarationSetHash,
        scopeLabel: describeScope(rule),
        mediaContext: rule.mediaContext,
        rules: [rule],
      });
    }
  }

  /** @type {Array<{hash: string, scopeLabel: string, mediaContext: string, rules: Rule[]}>} */
  const result = [];
  for (const group of grouped.values()) {
    if (group.rules.length < 2) continue;
    // Filter out groups whose selectors are identical — those are just
    // re-declarations of the same rule (legitimate cascading), not
    // duplicates worth merging.
    const distinctSelectors = new Set(group.rules.map((rule) => rule.selector));
    if (distinctSelectors.size < 2) continue;
    if (isNoisySingleDeclarationGroup(group)) continue;
    if (isCoincidentalCrossFileGroup(group)) continue;
    result.push(group);
  }

  result.sort((a, b) => {
    const savingsDelta = duplicateRuleSavings(b) - duplicateRuleSavings(a);
    if (savingsDelta !== 0) return savingsDelta;
    const declarationDelta = b.rules[0].declarations.length - a.rules[0].declarations.length;
    if (declarationDelta !== 0) return declarationDelta;
    return b.rules.length - a.rules.length;
  });
  return result;
}

function duplicateRuleSavings(group) {
  return group.rules[0].declarations.length * (group.rules.length - 1);
}

function isNoisySingleDeclarationGroup(group) {
  if (group.rules[0].declarations.length !== 1) return false;

  const fingerprint = group.rules[0].declarations[0].fingerprint;
  if (group.rules.some((rule) => selectorHasVendorPseudo(rule.selector)) && isNoisySingleDeclaration(fingerprint)) {
    return true;
  }

  const distinctFiles = new Set(group.rules.map((rule) => rule.file));
  if (distinctFiles.size < 2) return false;

  if (isNoisySingleDeclaration(fingerprint)) return true;

  return false;
}

/**
 * Cross-file groups where the participating rules belong to many unrelated
 * selector namespaces (different route/component packages) and no single
 * namespace dominates. Merging these would force unrelated route stylesheets
 * to share a selector list across files — not a real refactor, just
 * coincidental cascade overlap. Keep single-file groups untouched (those are
 * genuine selector-list wins).
 */
function isCoincidentalCrossFileGroup(group) {
  const distinctFiles = new Set(group.rules.map((rule) => rule.file));
  if (distinctFiles.size < 2) return false;
  // Dedicated shared-declaration stylesheets are an explicit consolidation
  // target — never suppress groups that already live there.
  if ([...distinctFiles].some((file) => isSharedDeclarationsFile(file))) return false;
  const cohesion = getSelectorNamespaceCohesion(group.rules);
  if (cohesion.distinctCount >= 3 && cohesion.dominantShare < 0.5) return true;
  return false;
}

function selectorHasVendorPseudo(selector) {
  return /::-(?:webkit|moz|ms)-/.test(selector);
}

function isKeyframeSelector(rule) {
  return /(?:^| \/ )@keyframes\b/.test(rule.mediaContext) || /^(?:from|to|\d+(?:\.\d+)?%)$/.test(rule.selector.trim());
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Near-duplicate rules (Jaccard similarity)
// ─────────────────────────────────────────────────────────────────────────

function findNearDuplicateRules(rules, jaccardThreshold, minSize) {
  // Bucket rules by file scope to limit O(n²) explosion. Cross-file
  // near-duplicates are still found because we also bucket by "shared
  // declaration anchor" — a high-frequency declaration that appears in both
  // candidates. This trades a bit of recall for tractable runtime on
  // large codebases.

  const eligibleRules = rules.filter((rule) => !rule.ignored && rule.declarations.length >= minSize);

  /** @type {Map<string, Rule[]>} */
  const buckets = new Map();
  for (const rule of eligibleRules) {
    // Use the lexicographically-smallest declaration fingerprint as anchor.
    // Any two rules that share at least one declaration will land in at
    // least one shared bucket (whichever contains their min element).
    // This is correct for Jaccard ≥ 0 and approximate-but-good for higher
    // thresholds — we'll rescue missed pairs by also bucketing by the
    // second-smallest fingerprint when present.
    const fingerprints = rule.declarations.map((decl) => decl.fingerprint).sort();
    const anchor = fingerprints[0];
    const secondaryAnchor = fingerprints[1] ?? anchor;

    for (const key of new Set([anchor, secondaryAnchor])) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(rule);
      else buckets.set(key, [rule]);
    }
  }

  /** @type {Map<string, {a: Rule, b: Rule, jaccard: number, shared: string[], onlyA: string[], onlyB: string[]}>} */
  const pairs = new Map();

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    // Cap bucket size to avoid pathological hot-decl-only buckets.
    if (bucket.length > 200) continue;

    for (let indexA = 0; indexA < bucket.length; indexA += 1) {
      for (let indexB = indexA + 1; indexB < bucket.length; indexB += 1) {
        const ruleA = bucket[indexA];
        const ruleB = bucket[indexB];
        if (ruleA.scopeKey !== ruleB.scopeKey || ruleA.mediaContext !== ruleB.mediaContext) continue;
        if (isKeyframeSelector(ruleA) || isKeyframeSelector(ruleB)) continue;

        // Skip identical-set hits — those are reported in section 2 already.
        if (ruleA.declarationSetHash === ruleB.declarationSetHash) continue;

        const fingerprintsA = new Set(ruleA.declarations.map((decl) => decl.fingerprint));
        const fingerprintsB = new Set(ruleB.declarations.map((decl) => decl.fingerprint));

        const shared = [...fingerprintsA].filter((value) => fingerprintsB.has(value));
        if (shared.length < minSize) continue;

        const unionSize = new Set([...fingerprintsA, ...fingerprintsB]).size;
        const jaccard = shared.length / unionSize;
        if (jaccard < jaccardThreshold) continue;

        const pairKey =
          ruleA.fullRuleHash < ruleB.fullRuleHash
            ? `${ruleA.fullRuleHash}|${ruleB.fullRuleHash}`
            : `${ruleB.fullRuleHash}|${ruleA.fullRuleHash}`;
        if (pairs.has(pairKey)) continue;

        const onlyA = [...fingerprintsA].filter((value) => !fingerprintsB.has(value));
        const onlyB = [...fingerprintsB].filter((value) => !fingerprintsA.has(value));
        pairs.set(pairKey, { a: ruleA, b: ruleB, jaccard, shared, onlyA, onlyB });
      }
    }
  }

  const result = [...pairs.values()].sort((a, b) => {
    const sharedDelta = b.shared.length - a.shared.length;
    if (sharedDelta !== 0) return sharedDelta;
    return b.jaccard - a.jaccard;
  });
  return result.slice(0, 200);
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Shared base subsets (common multi-decl bases with small deltas)
// ─────────────────────────────────────────────────────────────────────────

function findSharedBaseSubsets(rules, threshold, minSetSize) {
  const eligibleRules = rules.filter((rule) => !rule.ignored && rule.declarations.length > minSetSize);

  /** @type {Map<string, {fingerprint: string, rules: Set<Rule>}>} */
  const declarationToRules = new Map();
  for (const rule of eligibleRules) {
    for (const declaration of rule.declarations) {
      const entry = declarationToRules.get(declaration.fingerprint);
      if (entry) entry.rules.add(rule);
      else
        declarationToRules.set(declaration.fingerprint, {
          fingerprint: declaration.fingerprint,
          rules: new Set([rule]),
        });
    }
  }

  /** @type {Map<string, {shared: string[], rules: Rule[], scopeLabel: string, mediaContext: string}>} */
  const groups = new Map();

  for (const anchor of declarationToRules.values()) {
    if (anchor.rules.size < threshold) continue;

    /** @type {Map<string, Rule[]>} */
    const scopedRules = new Map();
    for (const rule of anchor.rules) {
      const key = `${rule.scopeKey}|${rule.mediaContext}|${selectorPseudoSignature(rule.selector)}`;
      const existing = scopedRules.get(key);
      if (existing) existing.push(rule);
      else scopedRules.set(key, [rule]);
    }

    for (const candidates of scopedRules.values()) {
      if (candidates.length < threshold) continue;
      const shared = intersectionOfDeclarationFingerprints(candidates);
      if (shared.length < minSetSize) continue;
      if (shared.length >= Math.max(...candidates.map((rule) => rule.declarations.length))) continue;
      if (candidates.some((rule) => isCustomPropertyMapRule(rule)) || isCustomPropertyHeavyFingerprints(shared)) {
        continue;
      }
      if (shared.length * (candidates.length - 1) < 3) continue;

      const distinctDeclarationSets = new Set(candidates.map((rule) => rule.declarationSetHash));
      if (distinctDeclarationSets.size < 2) continue;

      const key = `${shared.join("\n")}|${candidates[0].scopeKey}|${candidates[0].mediaContext}`;
      const existing = groups.get(key);
      if (!existing || candidates.length > existing.rules.length) {
        groups.set(key, {
          shared,
          rules: candidates,
          scopeLabel: describeScope(candidates[0]),
          mediaContext: candidates[0].mediaContext,
        });
      }
    }
  }

  const results = [...groups.values()].sort((a, b) => {
    const savingsDelta = sharedBaseSavings(b) - sharedBaseSavings(a);
    if (savingsDelta !== 0) return savingsDelta;
    return b.rules.length - a.rules.length;
  });

  return pruneNestedSharedBaseGroups(results).slice(0, 120);
}

function selectorPseudoSignature(selector) {
  const pseudoElements = selector.match(/::[-a-zA-Z0-9]+/g);
  return pseudoElements ? "pseudo-element" : "regular";
}

function intersectionOfDeclarationFingerprints(rules) {
  const [firstRule, ...remainingRules] = rules;
  let shared = new Set(firstRule.declarations.map((declaration) => declaration.fingerprint));
  for (const rule of remainingRules) {
    const fingerprints = new Set(rule.declarations.map((declaration) => declaration.fingerprint));
    shared = new Set([...shared].filter((fingerprint) => fingerprints.has(fingerprint)));
    if (shared.size === 0) break;
  }
  return [...shared].sort();
}

function sharedBaseSavings(group) {
  return group.shared.length * (group.rules.length - 1);
}

function pruneNestedSharedBaseGroups(groups) {
  /** @type {Array<{shared: string[], rules: Rule[], scopeLabel: string, mediaContext: string}>} */
  const pruned = [];
  for (const candidate of groups) {
    const candidateRules = new Set(candidate.rules.map((rule) => `${rule.file}:${rule.line}:${rule.selector}`));
    const candidateShared = new Set(candidate.shared);
    const isCovered = pruned.some((existing) => {
      if (existing.mediaContext !== candidate.mediaContext) return false;
      const existingRules = new Set(existing.rules.map((rule) => `${rule.file}:${rule.line}:${rule.selector}`));
      const existingShared = new Set(existing.shared);
      return isSubset(candidateRules, existingRules) && isSubset(candidateShared, existingShared);
    });
    if (!isCovered) pruned.push(candidate);
  }
  return pruned;
}

function isSubset(candidate, existing) {
  for (const value of candidate) {
    if (!existing.has(value)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Selector-list candidates (single-decl rules sharing the same decl)
// ─────────────────────────────────────────────────────────────────────────

function findSelectorListCandidates(rules, threshold) {
  // Selector-list merges are ONLY safe when the candidate selectors all
  // live in the same scope namespace (same global file group, same Vue
  // scoped block, same Vue module block) AND the same @media/@supports
  // context. Different scopes resolve to different generated selectors at
  // build time, so merging would silently change which elements match.
  /** @type {Map<string, {fingerprint: string, scopeKey: string, scopeLabel: string, mediaContext: string, rules: Rule[]}>} */
  const grouped = new Map();

  for (const rule of rules) {
    if (rule.ignored) continue;
    if (rule.declarations.length !== 1) continue;
    if (rule.selectorList.length !== 1) continue;

    const fingerprint = rule.declarations[0].fingerprint;
    const key = `${fingerprint}|${rule.scopeKey}|${rule.mediaContext}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.rules.push(rule);
    } else {
      grouped.set(key, {
        fingerprint,
        scopeKey: rule.scopeKey,
        scopeLabel: describeScope(rule),
        mediaContext: rule.mediaContext,
        rules: [rule],
      });
    }
  }

  /** @type {Array<{fingerprint: string, scopeKey: string, scopeLabel: string, mediaContext: string, rules: Rule[]}>} */
  const result = [];
  for (const value of grouped.values()) {
    if (value.rules.length >= threshold) {
      result.push(value);
    }
  }

  result.sort((a, b) => b.rules.length - a.rules.length);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// 7. Local consolidation candidates
// ─────────────────────────────────────────────────────────────────────────

function findLocalConsolidationCandidates(rules, minSharedSize) {
  const exactCandidates = findLocalExactCandidates(rules);
  const sharedBaseCandidates = findLocalSharedBaseCandidates(rules, minSharedSize);
  const singleDeclarationCandidates = findLocalSingleDeclarationCandidates(rules);

  return [...exactCandidates, ...sharedBaseCandidates, ...singleDeclarationCandidates]
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      const savingsDelta = b.estimatedSavings - a.estimatedSavings;
      if (savingsDelta !== 0) return savingsDelta;
      return a.file.localeCompare(b.file) || a.lineSpan - b.lineSpan;
    })
    .slice(0, 80);
}

function findLocalExactCandidates(rules) {
  /** @type {Map<string, Rule[]>} */
  const groups = new Map();
  for (const rule of rules) {
    if (rule.ignored) continue;
    const key = `${rule.file}|${rule.scopeKey}|${rule.mediaContext}|${rule.declarationSetHash}`;
    const existing = groups.get(key);
    if (existing) existing.push(rule);
    else groups.set(key, [rule]);
  }

  const candidates = [];
  for (const groupRules of groups.values()) {
    const distinctSelectors = new Set(groupRules.map((rule) => rule.selector));
    if (distinctSelectors.size < 2) continue;
    if (isCustomPropertyMapRule(groupRules[0])) continue;
    const declarationCount = groupRules[0].declarations.length;
    if (
      declarationCount === 1 &&
      groupRules.some((rule) => selectorHasVendorPseudo(rule.selector)) &&
      isNoisySingleDeclaration(groupRules[0].declarations[0].fingerprint)
    ) {
      continue;
    }
    const estimatedSavings = declarationCount * (groupRules.length - 1);
    const lineSpan = getLineSpan(groupRules);
    const confidence = getLocalConfidence(groupRules);
    const candidateKind = declarationCount === 1 ? "selector-list" : "exact-rule";
    const sharedFingerprints = groupRules[0].declarations.map((declaration) => declaration.fingerprint).sort();
    if (
      getLocalCandidateSuppression({
        kind: candidateKind,
        shared: sharedFingerprints,
        rules: groupRules,
        lineSpan,
        file: groupRules[0].file,
      })
    ) {
      continue;
    }
    candidates.push({
      kind: candidateKind,
      confidence,
      score: scoreLocalCandidate({ confidence, estimatedSavings, lineSpan, declarationCount }),
      estimatedSavings,
      lineSpan,
      file: groupRules[0].file,
      mediaContext: groupRules[0].mediaContext,
      scopeLabel: describeScope(groupRules[0]),
      shared: sharedFingerprints,
      rules: groupRules.sort((a, b) => a.line - b.line),
      note:
        declarationCount === 1
          ? "Single declaration repeated in one file; merge only when the selectors are semantically related."
          : "Identical rule body repeated in one file; usually safe to combine as a selector list.",
    });
  }
  return candidates;
}

function findLocalSharedBaseCandidates(rules, minSharedSize) {
  /** @type {Map<string, Rule[]>} */
  const fileBuckets = new Map();
  for (const rule of rules) {
    if (rule.ignored || rule.declarations.length <= minSharedSize) continue;
    const key = `${rule.file}|${rule.scopeKey}|${rule.mediaContext}|${selectorPseudoSignature(rule.selector)}`;
    const existing = fileBuckets.get(key);
    if (existing) existing.push(rule);
    else fileBuckets.set(key, [rule]);
  }

  const candidates = [];
  const seen = new Set();
  for (const bucket of fileBuckets.values()) {
    if (bucket.length < 2) continue;
    for (let indexA = 0; indexA < bucket.length; indexA += 1) {
      for (let indexB = indexA + 1; indexB < bucket.length; indexB += 1) {
        const ruleA = bucket[indexA];
        const ruleB = bucket[indexB];
        if (ruleA.declarationSetHash === ruleB.declarationSetHash) continue;
        const shared = intersectionOfDeclarationFingerprints([ruleA, ruleB]);
        if (shared.length < minSharedSize) continue;
        if (
          isCustomPropertyMapRule(ruleA) ||
          isCustomPropertyMapRule(ruleB) ||
          isCustomPropertyHeavyFingerprints(shared)
        ) {
          continue;
        }

        const pairRules = [ruleA, ruleB].sort((a, b) => a.line - b.line);
        const lineSpan = getLineSpan(pairRules);
        const confidence = getLocalConfidence(pairRules);
        const estimatedSavings = shared.length;
        const key = `${ruleA.file}|${ruleA.line}|${ruleB.line}|${shared.join("\n")}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (
          getLocalCandidateSuppression({
            kind: "shared-base",
            shared,
            rules: pairRules,
            lineSpan,
            file: ruleA.file,
          })
        ) {
          continue;
        }

        candidates.push({
          kind: "shared-base",
          confidence,
          score: scoreLocalCandidate({
            confidence,
            estimatedSavings,
            lineSpan,
            declarationCount: shared.length,
          }),
          estimatedSavings,
          lineSpan,
          file: ruleA.file,
          mediaContext: ruleA.mediaContext,
          scopeLabel: describeScope(ruleA),
          shared,
          rules: pairRules,
          note: "Two nearby same-file rules share a base; extract a selector-list base only if the remaining deltas stay readable.",
        });
      }
    }
  }

  return candidates;
}

function findLocalSingleDeclarationCandidates(rules) {
  /** @type {Map<string, Rule[]>} */
  const groups = new Map();
  for (const rule of rules) {
    if (rule.ignored || rule.declarations.length !== 1 || rule.selectorList.length !== 1) continue;
    const fingerprint = rule.declarations[0].fingerprint;
    const key = `${rule.file}|${rule.scopeKey}|${rule.mediaContext}|${fingerprint}`;
    const existing = groups.get(key);
    if (existing) existing.push(rule);
    else groups.set(key, [rule]);
  }

  const candidates = [];
  for (const groupRules of groups.values()) {
    if (groupRules.length < 2) continue;
    const sortedRules = groupRules.sort((a, b) => a.line - b.line);
    const lineSpan = getLineSpan(sortedRules);
    const confidence = getLocalConfidence(sortedRules);
    const fingerprint = sortedRules[0].declarations[0].fingerprint;
    if (isCustomPropertyHeavyFingerprints([fingerprint])) continue;
    if (confidence === "low" && isNoisySingleDeclaration(fingerprint)) continue;

    if (
      getLocalCandidateSuppression({
        kind: "single-declaration",
        shared: [fingerprint],
        rules: sortedRules,
        lineSpan,
        file: sortedRules[0].file,
      })
    ) {
      continue;
    }

    const estimatedSavings = groupRules.length - 1;
    candidates.push({
      kind: "single-declaration",
      confidence,
      score: scoreLocalCandidate({
        confidence,
        estimatedSavings,
        lineSpan,
        declarationCount: 1,
      }),
      estimatedSavings,
      lineSpan,
      file: sortedRules[0].file,
      mediaContext: sortedRules[0].mediaContext,
      scopeLabel: describeScope(sortedRules[0]),
      shared: [fingerprint],
      rules: sortedRules,
      note: "Same declaration repeats in one file. Prefer adjacent or shared-prefix selectors; skip unrelated utilities.",
    });
  }
  return candidates;
}

function getLineSpan(rules) {
  const lines = rules.map((rule) => rule.line);
  return Math.max(...lines) - Math.min(...lines);
}

function getLocalConfidence(rules) {
  const lineSpan = getLineSpan(rules);
  if (lineSpan <= 40) return "high";
  const prefixes = rules.map((rule) => selectorNamespace(rule.selector)).filter(Boolean);
  const uniquePrefixes = new Set(prefixes);
  if (prefixes.length === rules.length && uniquePrefixes.size === 1 && lineSpan <= 360) return "high";
  if (lineSpan <= 180 || uniquePrefixes.size === 1) return "medium";
  return "low";
}

function selectorNamespace(selector) {
  const firstClass = selector.match(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/);
  if (!firstClass) return "";
  const className = firstClass[1];
  const bemBoundary = className.search(/__(?!$)|--(?!$)/);
  if (bemBoundary > 0) return className.slice(0, bemBoundary);
  const parts = className.split("-");
  return parts.length >= 2 ? parts.slice(0, 2).join("-") : className;
}

function isNoisySingleDeclaration(fingerprint) {
  return /^(display|position|width|height|block-size|inline-size|min-width|min-height|max-width|max-height|margin|padding|inset|top|right|bottom|left|content|opacity|color|background|border(?:-[a-z-]+)?|box-shadow|outline|overflow|transform|transition|appearance|font-size|font-weight|line-height|letter-spacing):/.test(
    fingerprint,
  );
}

/**
 * "Layout plumbing" fingerprints — declarations that show up trivially in
 * almost every flex/grid container in the codebase. When a shared-base
 * candidate's *entire* shared set is layout plumbing AND the set is small
 * (≤ 2 declarations), extracting a selector-list base is net-negative:
 * it splits a coherent rule and hides locality just to remove 1-2 lines of
 * duplication. The audit should not flag these as actionable.
 */
const LAYOUT_TRIVIAL_FINGERPRINTS = new Set([
  "align-items:center",
  "align-items:flex-start",
  "align-items:flex-end",
  "align-items:stretch",
  "justify-content:center",
  "justify-content:flex-start",
  "justify-content:flex-end",
  "justify-content:space-between",
  "justify-items:center",
  "place-items:center",
  "place-content:center",
  "display:flex",
  "display:inline-flex",
  "display:grid",
  "display:inline-grid",
  "display:block",
  "display:inline-block",
  "flex-direction:row",
  "flex-direction:column",
  "flex-wrap:wrap",
  "flex:0 0 auto",
  "flex:1 1 auto",
  "flex:1",
  "box-sizing:border-box",
  "pointer-events:none",
  "user-select:none",
  "white-space:nowrap",
  "overflow:hidden",
]);

/**
 * Patterns that match trivially-common parametric declarations: small pixel
 * gaps and paddings, `min-width:0` flex-min unblockers, etc. These are the
 * sort of values that coincidentally match across unrelated rules without
 * implying any shared design intent.
 */
const LAYOUT_TRIVIAL_PATTERNS = [
  /^gap:\d+(?:\.\d+)?(?:px|rem)$/,
  /^row-gap:\d+(?:\.\d+)?(?:px|rem)$/,
  /^column-gap:\d+(?:\.\d+)?(?:px|rem)$/,
  /^min-width:0$/,
  /^min-height:0$/,
  /^margin:0$/,
  /^padding:0$/,
];

function isLayoutTrivialFingerprint(fingerprint) {
  if (LAYOUT_TRIVIAL_FINGERPRINTS.has(fingerprint)) return true;
  for (const pattern of LAYOUT_TRIVIAL_PATTERNS) {
    if (pattern.test(fingerprint)) return true;
  }
  return false;
}

/**
 * Files whose explicit purpose is to host cross-component shared declarations
 * (utility classes, base mixins, design-token bridges). Single-declaration
 * consolidation across unrelated selector namespaces is appropriate here and
 * nowhere else.
 */
function isSharedDeclarationsFile(file) {
  if (!file) return false;
  const basename = file.split("/").pop() ?? "";
  return /(?:^|[-_./])(shared|shared-declarations|base|common|utilities|utils|tokens)(?:\.|-)/.test(basename);
}

/**
 * Cohesion metric over a candidate's rules: how many distinct selector
 * namespaces (BEM block roots / two-segment prefixes) participate, and what
 * fraction of the rules share the most common one. Used to detect
 * "coincidental overlap across unrelated component families" — the kind of
 * shared-base / single-declaration candidate that is mathematically valid
 * but architecturally noise.
 */
function getSelectorNamespaceCohesion(rules) {
  const namespaces = rules.map((rule) => selectorNamespace(rule.selector)).filter(Boolean);
  if (namespaces.length === 0) {
    return { distinctCount: 0, dominantShare: 0 };
  }
  const counts = new Map();
  for (const ns of namespaces) {
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  const dominant = Math.max(...counts.values());
  return {
    distinctCount: counts.size,
    dominantShare: dominant / namespaces.length,
  };
}

/**
 * Decide whether a same-file consolidation candidate is a lazy / net-negative
 * merge that the audit should suppress. Returns the suppression reason for
 * diagnostics, or null when the candidate is worth surfacing.
 *
 *   kind          : "exact-rule" | "selector-list" | "shared-base"
 *                   | "single-declaration"
 *   shared        : fingerprints contributed to the merge
 *   rules         : participating Rule[]
 *   lineSpan      : max(line) - min(line)
 *   file          : workspace-relative path
 */
function getLocalCandidateSuppression({ kind, shared, rules, lineSpan, file }) {
  if (kind === "exact-rule") {
    // Same-file rules with byte-identical bodies are almost always a real win
    // (the .--public-card-radius five-way merge, etc.). Don't second-guess.
    return null;
  }

  const cohesion = getSelectorNamespaceCohesion(rules);
  const sharedFile = isSharedDeclarationsFile(file);

  if (kind === "shared-base") {
    // Inside @keyframes, each percentage step is a distinct animation frame
    // whose *deltas* (e.g. transform, opacity, box-shadow values) define the
    // motion curve. Extracting a shared base across frames hides those
    // deltas behind a selector list and degrades animation readability.
    if (rules.every((rule) => isKeyframeSelector(rule))) {
      return "keyframe percentage steps — deltas define the motion curve, do not extract";
    }
    // 2-declaration shared bases where ANY declaration is layout plumbing
    // are too thin to justify a base extraction: the remaining "real"
    // declaration is just one line, and pairing it with plumbing in a
    // selector list hides locality instead of clarifying intent.
    // 3+ shared declarations (with at least some non-trivial members) are
    // the real refactor zone — e.g., align-items + display + border-radius
    // + justify-content = an icon-pill container.
    if (shared.length <= 2 && shared.some((fingerprint) => isLayoutTrivialFingerprint(fingerprint))) {
      return "shared set is ≤ 2 declarations with layout plumbing — not enough shared design intent";
    }
    // Large line span AND every rule has its own distinct selector namespace
    // ⇒ different UI elements that happen to share declarations. Suppress
    // regardless of the *file's* dominant namespace (e.g., both selectors
    // live under .host-guest-detail-pane but one is a label-chip and the
    // other is an answer-link 150 lines away — coincidental overlap, not a
    // refactor target).
    if (lineSpan > 80 && cohesion.distinctCount === rules.length && cohesion.dominantShare < 0.6) {
      return "rules belong to unrelated selector namespaces across a large line span";
    }
    return null;
  }

  if (kind === "single-declaration" || kind === "selector-list") {
    // Single-declaration consolidation across many unrelated selector
    // namespaces is only appropriate in dedicated shared-declarations files,
    // where the file's stated purpose IS cross-component consolidation.
    if (!sharedFile && cohesion.distinctCount >= 4 && cohesion.dominantShare < 0.5) {
      return "many unrelated selector namespaces in a non-shared stylesheet";
    }
    return null;
  }

  return null;
}

function isCustomPropertyMapRule(rule) {
  return isCustomPropertyHeavyFingerprints(rule.declarations.map((declaration) => declaration.fingerprint));
}

function isCustomPropertyHeavyFingerprints(fingerprints) {
  const customPropertyCount = fingerprints.filter((fingerprint) => fingerprint.startsWith("--")).length;
  return fingerprints.length > 0 && customPropertyCount / fingerprints.length >= 0.6;
}

function scoreLocalCandidate({ confidence, estimatedSavings, lineSpan, declarationCount }) {
  const confidenceWeight = confidence === "high" ? 60 : confidence === "medium" ? 35 : 10;
  const proximityWeight = Math.max(0, 25 - Math.floor(lineSpan / 20));
  return confidenceWeight + proximityWeight + estimatedSavings * 4 + declarationCount * 3;
}

// ─────────────────────────────────────────────────────────────────────────
// 8. Color drift (token-aware hex/rgb detection inside declaration values)
// ─────────────────────────────────────────────────────────────────────────

function findColorDrift(rules, tokenIndex) {
  const colorLiteralPattern = /(#[0-9a-fA-F]{3,8}\b)|(rgba?\(\s*[^)]+\))|(hsla?\(\s*[^)]+\))/g;

  /** @type {Map<string, {normalized: string, tokens: string[], occurrences: Array<{file: string, line: number, selector: string, prop: string, raw: string}>}>} */
  const buckets = new Map();

  for (const rule of rules) {
    if (rule.ignored) continue;
    if (rule.file === path.relative(repoRoot, tokensCssPath).replaceAll("\\", "/")) continue;

    for (const declaration of rule.declarations) {
      // Custom-property declarations (--foo: #fff) ARE the literal definition of a
      // local palette token; flagging them as drift creates an unresolvable loop —
      // you can't "use a token" because this IS the token definition.
      if (declaration.prop.startsWith("--")) continue;
      for (const match of declaration.value.matchAll(colorLiteralPattern)) {
        const raw = match[0];
        if (isColorFallbackInsideVarFunction(declaration.value, match.index ?? 0)) continue;
        // Only accept genuinely-shaped hex literals (3/4/6/8 digits)
        if (raw.startsWith("#")) {
          const digitCount = raw.length - 1;
          if (![3, 4, 6, 8].includes(digitCount)) continue;
        }

        const normalized = normalizeColorLiteral(raw);
        if (!normalized) continue;

        const matchedTokens = tokenIndex.hexToTokens.get(normalized) ?? [];
        if (matchedTokens.length === 0) continue;

        const bucket = buckets.get(normalized);
        const entry = {
          file: rule.file,
          line: rule.line,
          selector: rule.selector,
          prop: declaration.prop,
          raw,
        };
        if (bucket) bucket.occurrences.push(entry);
        else
          buckets.set(normalized, {
            normalized,
            tokens: matchedTokens,
            occurrences: [entry],
          });
      }
    }
  }

  return [...buckets.values()].sort((a, b) => b.occurrences.length - a.occurrences.length);
}

function isColorFallbackInsideVarFunction(value, matchIndex) {
  let depth = 0;
  let varDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("var(", index)) {
      depth += 1;
      varDepth = depth;
      index += "var(".length - 1;
      continue;
    }

    const char = value[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      if (depth === varDepth) varDepth = 0;
      depth = Math.max(0, depth - 1);
    } else if (index === matchIndex) {
      return varDepth > 0;
    }
  }

  return false;
}

async function buildTokenIndex(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  /** @type {Map<string, string>} */
  const tokenToValue = new Map();
  /** @type {Map<string, string[]>} */
  const hexToTokens = new Map();

  const declarationPattern = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  for (const match of source.matchAll(declarationPattern)) {
    const tokenName = match[1];
    const rawValue = match[2].trim();
    if (tokenToValue.has(tokenName)) continue;
    tokenToValue.set(tokenName, rawValue);

    const trimmed = rawValue.trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
      const normalized = normalizeColorLiteral(trimmed);
      if (!normalized) continue;
      const existing = hexToTokens.get(normalized);
      if (existing) existing.push(tokenName);
      else hexToTokens.set(normalized, [tokenName]);
    }
  }

  return { hexToTokens, tokenToValue };
}

function normalizeColorLiteral(raw) {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("#")) return normalizeHex(trimmed);
  if (trimmed.startsWith("rgb")) return normalizeRgb(trimmed);
  return null;
}

function normalizeHex(hex) {
  let value = hex.startsWith("#") ? hex.slice(1) : hex;
  if (value.length === 3 || value.length === 4) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (value.length === 8 && value.endsWith("ff")) value = value.slice(0, 6);
  return `#${value}`;
}

function normalizeRgb(value) {
  const inner = value
    .replace(/^rgba?\(/, "")
    .replace(/\)$/, "")
    .trim();
  const parts = inner.split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  const alpha = parts.length >= 4 ? parseAlpha(parts[3]) : 1;
  if (r === null || g === null || b === null || alpha === null) return null;
  if (alpha === 1) return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}${toHexByte(Math.round(alpha * 255))}`;
}

function parseChannel(text) {
  const trimmed = text.trim();
  if (trimmed.endsWith("%")) {
    const percentage = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percentage) ? Math.round((percentage / 100) * 255) : null;
  }
  const numeric = Number.parseFloat(trimmed);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(255, Math.round(numeric))) : null;
}

function parseAlpha(text) {
  const trimmed = text.trim();
  if (trimmed.endsWith("%")) {
    const percentage = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percentage) ? percentage / 100 : null;
  }
  const numeric = Number.parseFloat(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function toHexByte(value) {
  return value.toString(16).padStart(2, "0");
}

// ─────────────────────────────────────────────────────────────────────────
// Reporting — Markdown
// ─────────────────────────────────────────────────────────────────────────

function renderMarkdownReport(stats, sections) {
  const lines = [];
  lines.push("# CSS De-duplication Audit");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- Files scanned: **${stats.filesScanned}**`);
  lines.push(`- Rules parsed: **${stats.rulesScanned}**`);
  lines.push(`- Declarations parsed: **${stats.declarationsScanned}**`);
  lines.push(`- Token catalog: **${stats.tokenCatalogSize}** tokens (${stats.tokenHexEntries} unique hex entries)`);
  // Standard metadata for the fix-queue scanner.
  {
    const hotReview = (sections.hotDeclarations ?? []).filter(
      (e) => e.count >= cliFlags.hotReviewThreshold && !utilityBackedFingerprints.has(e.fingerprint),
    ).length;
    const dupRules = (sections.duplicateFullRules ?? []).length;
    const nearDupRules = (sections.nearDuplicateRules ?? []).length;
    const dupSets = (sections.duplicateDeclarationSets ?? []).length;
    const warnTotal = hotReview + dupRules + nearDupRules + dupSets;
    lines.push(`- Errors: 0`);
    lines.push(`- Warnings: ${warnTotal}`);
    lines.push(`- Findings: ${warnTotal}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  if (sections.hotDeclarations) renderHotDeclarations(lines, sections.hotDeclarations);
  if (sections.vendorPrefixFamilies) renderVendorPrefixFamilies(lines, sections.vendorPrefixFamilies);
  if (sections.duplicateDeclarationSets) renderDuplicateDeclarationSets(lines, sections.duplicateDeclarationSets);
  if (sections.duplicateFullRules) renderDuplicateFullRules(lines, sections.duplicateFullRules);
  if (sections.nearDuplicateRules) renderNearDuplicates(lines, sections.nearDuplicateRules);
  if (sections.sharedBaseSubsets) renderSharedBaseSubsets(lines, sections.sharedBaseSubsets);
  if (sections.selectorListCandidates) renderSelectorListCandidates(lines, sections.selectorListCandidates);
  if (sections.localConsolidationCandidates) {
    renderLocalConsolidationCandidates(lines, sections.localConsolidationCandidates);
  }
  if (sections.colorDrift) renderColorDrift(lines, sections.colorDrift);

  return lines.join("\n");
}

async function writeMarkdownReport(report) {
  await fs.mkdir(path.dirname(reportOutputPath), { recursive: true });
  await fs.writeFile(reportOutputPath, report, "utf8");
  console.log(`[audit-css-dedupe] wrote ${path.relative(repoRoot, reportOutputPath)}`);
}

function renderHotDeclarations(lines, hot) {
  const reviewQueue = hot.filter(
    (entry) => entry.count >= cliFlags.hotReviewThreshold && !utilityBackedFingerprints.has(entry.fingerprint),
  );
  lines.push("## 🔥 Hot declarations");
  lines.push("");
  lines.push(
    `Single \`property: value\` pairs appearing ≥ ${cliFlags.thresholdHot} times. High counts suggest a base class, CSS variable, or utility is missing.`,
  );
  lines.push(
    `Review budget: counts ≥ ${cliFlags.hotReviewThreshold} should be learned from during cleanup work. The long-term target is < ${cliFlags.hotTargetThreshold} once a real shared abstraction exists; do not chase layout-plumbing declarations mechanically if merging them would make the source worse.`,
  );
  lines.push("");
  if (reviewQueue.length > 0) {
    lines.push(
      `Review queue: ${reviewQueue.length} declaration${reviewQueue.length === 1 ? "" : "s"} at or above the ${cliFlags.hotReviewThreshold} threshold.`,
    );
  } else {
    lines.push(`Review queue: empty; no hot declaration is at or above ${cliFlags.hotReviewThreshold}.`);
  }
  lines.push("");
  if (hot.length === 0) {
    lines.push("_No declarations exceed the threshold._");
    lines.push("");
    return;
  }
  lines.push("| Count | Review | Declaration | Example sites |");
  lines.push("| ---: | --- | --- | --- |");
  for (const entry of hot.slice(0, 80)) {
    const examples = entry.examples
      .slice(0, 3)
      .map((example) => `\`${example.file}:${example.line}\``)
      .join(", ");
    const review = utilityBackedFingerprints.has(entry.fingerprint)
      ? "has-utility"
      : entry.count >= cliFlags.hotReviewThreshold
        ? "learn/extract"
        : entry.count >= cliFlags.hotTargetThreshold
          ? "watch"
          : "";
    lines.push(`| ${entry.count} | ${review} | \`${entry.fingerprint}\` | ${examples} |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
}

function renderVendorPrefixFamilies(lines, families) {
  lines.push("## 🧪 Vendor-prefix families");
  lines.push("");
  lines.push(
    "Properties that appear in two or more prefix forms (or unprefixed + prefixed) for the same value. Modern Chrome/Edge/Safari/Firefox no longer need most legacy prefixes; either delete the prefixed forms, let autoprefixer regenerate them at build, or document why a particular prefix is still needed.",
  );
  lines.push("");
  if (families.length === 0) {
    lines.push("_No vendor-prefix families detected above the threshold._");
    lines.push("");
    lines.push("---");
    lines.push("");
    return;
  }
  lines.push("| Total | Family | Per-prefix breakdown | Example site |");
  lines.push("| ---: | --- | --- | --- |");
  for (const family of families.slice(0, 40)) {
    const breakdown = [...family.prefixCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([prefix, count]) => `\`${prefix}\`×${count}`)
      .join(", ");
    const example = family.examples[0];
    lines.push(`| ${family.total} | \`${family.familyKey}\` | ${breakdown} | \`${example.file}:${example.line}\` |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
}

function renderDuplicateDeclarationSets(lines, sets) {
  lines.push("## 🧩 Duplicate declaration sets");
  lines.push("");
  lines.push(
    `Selectors that share an *identical* set of ≥ ${cliFlags.thresholdSetSize} declarations, with ≥ ${cliFlags.thresholdSet} selectors. Strong refactor candidates: extract a shared class, \`@apply\` group, or selector list.`,
  );
  lines.push("");
  if (sets.length === 0) {
    lines.push("_No duplicate declaration sets above the threshold._");
    lines.push("");
    return;
  }
  for (const group of sets.slice(0, 60)) {
    lines.push(`### ${group.rules.length} selectors share ${group.declarations.length} declarations`);
    lines.push("");
    lines.push("Shared declarations:");
    lines.push("```css");
    for (const declaration of group.declarations) {
      lines.push(`  ${declaration.fingerprint};`);
    }
    lines.push("```");
    lines.push("");
    lines.push("| Selector | File | Line |");
    lines.push("| --- | --- | ---: |");
    for (const rule of group.rules.slice(0, 30)) {
      lines.push(`| \`${truncate(rule.selector, 80)}\` | \`${rule.file}\` | ${rule.line} |`);
    }
    if (group.rules.length > 30) {
      lines.push(`| _…${group.rules.length - 30} more_ | | |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
}

function renderDuplicateFullRules(lines, groups) {
  lines.push("## 🧬 Duplicate full rules");
  lines.push("");
  lines.push(
    "Distinct selectors with identical declaration bodies in the same CSS scope and conditional context. These are exact merge candidates — combine into one selector list.",
  );
  lines.push("");
  if (groups.length === 0) {
    lines.push("_No byte-identical rule duplicates._");
    lines.push("");
    return;
  }
  for (const group of groups) {
    lines.push(
      `### ${group.rules.length} identical rules — ✅ ${group.scopeLabel}${group.mediaContext ? ` @ ${group.mediaContext}` : ""}`,
    );
    lines.push("");
    lines.push("Suggested merge:");
    lines.push("```css");
    const allSelectors = group.rules
      .map((rule) => rule.selector)
      .slice(0, 12)
      .join(",\n");
    lines.push(`${allSelectors}${group.rules.length > 12 ? ",\n/* … */" : ""} {`);
    for (const declaration of group.rules[0].declarations) {
      lines.push(`  ${declaration.fingerprint};`);
    }
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("| Selector | File | Line |");
    lines.push("| --- | --- | ---: |");
    for (const rule of group.rules) {
      lines.push(`| \`${truncate(rule.selector, 80)}\` | \`${rule.file}\` | ${rule.line} |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
}

function renderNearDuplicates(lines, pairs) {
  lines.push("## 🪞 Near-duplicate rules");
  lines.push("");
  lines.push(
    `Rule pairs with Jaccard ≥ ${cliFlags.jaccard} on their declaration sets. Candidates for shared-base extraction.`,
  );
  lines.push("");
  if (pairs.length === 0) {
    lines.push("_No near-duplicates above the similarity threshold._");
    lines.push("");
    return;
  }
  lines.push(`Showing top ${Math.min(pairs.length, 60)} of ${pairs.length} pairs.`);
  lines.push("");
  for (const pair of pairs.slice(0, 60)) {
    lines.push(`### ${(pair.jaccard * 100).toFixed(0)}% similar — ${pair.shared.length} shared declarations`);
    lines.push("");
    lines.push(`- A: \`${truncate(pair.a.selector, 80)}\` — \`${pair.a.file}:${pair.a.line}\``);
    lines.push(`- B: \`${truncate(pair.b.selector, 80)}\` — \`${pair.b.file}:${pair.b.line}\``);
    lines.push("");
    lines.push("Shared:");
    lines.push("```css");
    for (const fingerprint of pair.shared) lines.push(`  ${fingerprint};`);
    lines.push("```");
    if (pair.onlyA.length > 0) {
      lines.push("Only A:");
      lines.push("```css");
      for (const fingerprint of pair.onlyA) lines.push(`  ${fingerprint};`);
      lines.push("```");
    }
    if (pair.onlyB.length > 0) {
      lines.push("Only B:");
      lines.push("```css");
      for (const fingerprint of pair.onlyB) lines.push(`  ${fingerprint};`);
      lines.push("```");
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
}

function renderSharedBaseSubsets(lines, groups) {
  lines.push("## 🧱 Shared base subsets");
  lines.push("");
  lines.push(
    `Rules that share ≥ ${cliFlags.thresholdSetSize} declarations but keep small deltas. Extract the shared declarations into one selector list, then leave only each selector's delta behind.`,
  );
  lines.push("");
  if (groups.length === 0) {
    lines.push("_No shared-base subsets above the threshold._");
    lines.push("");
    return;
  }
  for (const group of groups) {
    lines.push(
      `### ${group.rules.length} rules share ${group.shared.length} base declarations — ✅ ${group.scopeLabel}${group.mediaContext ? ` @ ${group.mediaContext}` : ""}`,
    );
    lines.push("");
    lines.push("Suggested base extraction:");
    lines.push("```css");
    const allSelectors = group.rules
      .map((rule) => rule.selector)
      .slice(0, 12)
      .join(",\n");
    lines.push(`${allSelectors}${group.rules.length > 12 ? ",\n/* … */" : ""} {`);
    for (const fingerprint of group.shared) lines.push(`  ${fingerprint};`);
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("| Selector | File | Line | Delta declarations |");
    lines.push("| --- | --- | ---: | --- | ");
    const shared = new Set(group.shared);
    for (const rule of group.rules.slice(0, 30)) {
      const delta = rule.declarations
        .map((declaration) => declaration.fingerprint)
        .filter((fingerprint) => !shared.has(fingerprint));
      lines.push(
        `| \`${truncate(rule.selector, 80)}\` | \`${rule.file}\` | ${rule.line} | ${delta.map((fingerprint) => `\`${truncate(fingerprint, 60)}\``).join("<br>") || "_none_"} |`,
      );
    }
    if (group.rules.length > 30) {
      lines.push(`| _…${group.rules.length - 30} more_ | | | |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
}

function renderSelectorListCandidates(lines, groups) {
  lines.push("## 📚 Selector-list merge candidates");
  lines.push("");
  lines.push(
    `Single-declaration rules sharing the same declaration. Merge into one comma-separated selector list (cheapest possible win).`,
  );
  lines.push("");
  if (groups.length === 0) {
    lines.push("_No candidates above the threshold._");
    lines.push("");
    return;
  }
  for (const group of groups.slice(0, 50)) {
    lines.push(
      `### \`${group.fingerprint}\` — ${group.rules.length} selectors — ✅ ${group.scopeLabel}${group.mediaContext ? ` @ ${group.mediaContext}` : ""}`,
    );
    lines.push("");
    lines.push("Suggested merge:");
    lines.push("```css");
    const allSelectors = group.rules
      .map((rule) => rule.selector)
      .slice(0, 12)
      .join(",\n  ");
    lines.push(
      `${group.rules.length > 12 ? "/* (showing 12 of " + group.rules.length + ") */\n" : ""}  ${allSelectors}${group.rules.length > 12 ? ",\n  /* … */" : ""} {`,
    );
    lines.push(`    ${group.fingerprint};`);
    lines.push("  }");
    lines.push("```");
    lines.push("");
    lines.push("| Selector | File | Line |");
    lines.push("| --- | --- | ---: |");
    for (const rule of group.rules.slice(0, 20)) {
      lines.push(`| \`${truncate(rule.selector, 80)}\` | \`${rule.file}\` | ${rule.line} |`);
    }
    if (group.rules.length > 20) {
      lines.push(`| _…${group.rules.length - 20} more_ | | |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
}

function renderLocalConsolidationCandidates(lines, candidates) {
  lines.push("## 🛠️ Local consolidation candidates");
  lines.push("");
  lines.push(
    "Same-file candidates ranked by confidence and estimated source cleanup. This section intentionally favors cohesive, maintainable merges over cross-file coincidences.",
  );
  lines.push("");
  if (candidates.length === 0) {
    lines.push("_No local consolidation candidates above the threshold._");
    lines.push("");
    return;
  }
  for (const candidate of candidates.slice(0, 60)) {
    lines.push(
      `### ${candidate.confidence.toUpperCase()} · ${candidate.kind} · score ${candidate.score} — \`${candidate.file}\`${candidate.mediaContext ? ` @ ${candidate.mediaContext}` : ""}`,
    );
    lines.push("");
    lines.push(
      `Estimated savings: **${candidate.estimatedSavings}** declaration copies · line span: **${candidate.lineSpan}** · ${candidate.note}`,
    );
    lines.push("");
    lines.push("Shared declarations:");
    lines.push("```css");
    for (const fingerprint of candidate.shared) lines.push(`  ${fingerprint};`);
    lines.push("```");
    lines.push("");
    lines.push("| Selector | Line |");
    lines.push("| --- | ---: |");
    for (const rule of candidate.rules.slice(0, 16)) {
      lines.push(`| \`${truncate(rule.selector, 90)}\` | ${rule.line} |`);
    }
    if (candidate.rules.length > 16) {
      lines.push(`| _…${candidate.rules.length - 16} more_ | |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
}

function renderColorDrift(lines, drift) {
  lines.push("## 🎨 Color drift (literal matches existing token)");
  lines.push("");
  if (drift.length === 0) {
    lines.push("_No drift detected._");
    lines.push("");
    return;
  }
  for (const bucket of drift.slice(0, 40)) {
    lines.push(`### \`${bucket.normalized}\` — ${bucket.occurrences.length} occurrences`);
    lines.push("");
    lines.push(`**Replace with:** ${bucket.tokens.map((token) => `\`var(${token})\``).join(" or ")}`);
    lines.push("");
    lines.push("| File | Line | Property | Selector |");
    lines.push("| --- | ---: | --- | --- |");
    for (const occurrence of bucket.occurrences.slice(0, 20)) {
      lines.push(
        `| \`${occurrence.file}\` | ${occurrence.line} | \`${occurrence.prop}\` | \`${truncate(occurrence.selector, 60)}\` |`,
      );
    }
    if (bucket.occurrences.length > 20) {
      lines.push(`| _…${bucket.occurrences.length - 20} more_ | | | |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
}

// ─────────────────────────────────────────────────────────────────────────
// Reporting — JSON + console
// ─────────────────────────────────────────────────────────────────────────

function buildJsonPayload(stats, sections) {
  return {
    generatedAt: new Date().toISOString(),
    flags: cliFlags,
    stats,
    sections,
  };
}

async function writeJsonReport(payload) {
  await fs.mkdir(path.dirname(jsonOutputPath), { recursive: true });
  await fs.writeFile(jsonOutputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[audit-css-dedupe] wrote ${path.relative(repoRoot, jsonOutputPath)}`);
}

function renderConsoleSummary(stats, sections) {
  const lines = [];
  lines.push("");
  lines.push("──────────── audit-css-dedupe summary ────────────");
  lines.push(`  Files scanned:                ${stats.filesScanned}`);
  lines.push(`  Rules / declarations:         ${stats.rulesScanned} / ${stats.declarationsScanned}`);
  lines.push("");
  if (sections.hotDeclarations) {
    lines.push(`  🔥 Hot declarations (≥${cliFlags.thresholdHot}):     ${sections.hotDeclarations.length}`);
    lines.push(
      `  🔎 Hot review queue (≥${cliFlags.hotReviewThreshold}): ${sections.hotDeclarations.filter((entry) => entry.count >= cliFlags.hotReviewThreshold).length}`,
    );
  }
  if (sections.vendorPrefixFamilies) {
    lines.push(`  🧪 Vendor-prefix families:     ${sections.vendorPrefixFamilies.length}`);
  }
  if (sections.duplicateDeclarationSets) {
    const totalSelectors = sections.duplicateDeclarationSets.reduce((sum, group) => sum + group.rules.length, 0);
    lines.push(
      `  🧩 Duplicate decl-sets:        ${sections.duplicateDeclarationSets.length} groups across ${totalSelectors} selectors`,
    );
  }
  if (sections.duplicateFullRules) {
    lines.push(`  🧬 Byte-identical rule groups: ${sections.duplicateFullRules.length}`);
  }
  if (sections.nearDuplicateRules) {
    lines.push(`  🪞 Near-duplicate pairs:       ${sections.nearDuplicateRules.length}`);
  }
  if (sections.sharedBaseSubsets) {
    const totalRules = sections.sharedBaseSubsets.reduce((sum, group) => sum + group.rules.length, 0);
    lines.push(
      `  🧱 Shared base subsets:        ${sections.sharedBaseSubsets.length} groups across ${totalRules} rules`,
    );
  }
  if (sections.selectorListCandidates) {
    const totalSelectors = sections.selectorListCandidates.reduce((sum, group) => sum + group.rules.length, 0);
    lines.push(
      `  📚 Selector-list candidates:   ${sections.selectorListCandidates.length} groups across ${totalSelectors} selectors`,
    );
  }
  if (sections.localConsolidationCandidates) {
    const highConfidence = sections.localConsolidationCandidates.filter(
      (candidate) => candidate.confidence === "high",
    ).length;
    lines.push(
      `  🛠️ Local candidates:           ${sections.localConsolidationCandidates.length} (${highConfidence} high confidence)`,
    );
  }
  if (sections.colorDrift) {
    const total = sections.colorDrift.reduce((sum, bucket) => sum + bucket.occurrences.length, 0);
    lines.push(`  🎨 Color drift hits:           ${total} (${sections.colorDrift.length} colors)`);
  }
  lines.push("─────────────────────────────────────────────────");

  if (sections.hotDeclarations && sections.hotDeclarations.length > 0) {
    lines.push("");
    lines.push("Top 5 hot declarations:");
    for (const entry of sections.hotDeclarations.slice(0, 5)) {
      lines.push(`  ×${String(entry.count).padStart(4)}  ${entry.fingerprint}`);
    }
  }
  if (sections.duplicateDeclarationSets && sections.duplicateDeclarationSets.length > 0) {
    lines.push("");
    lines.push("Top 3 duplicate decl-sets:");
    for (const group of sections.duplicateDeclarationSets.slice(0, 3)) {
      const props = group.declarations.map((decl) => decl.prop).join(", ");
      lines.push(`  ${group.rules.length} selectors share {${props}}`);
    }
  }
  if (sections.localConsolidationCandidates && sections.localConsolidationCandidates.length > 0) {
    lines.push("");
    lines.push("Top 5 local consolidation candidates:");
    for (const candidate of sections.localConsolidationCandidates.slice(0, 5)) {
      lines.push(
        `  ${candidate.confidence.padEnd(6)} ${String(candidate.score).padStart(3)}  ${candidate.kind}  ${candidate.file}:${candidate.rules[0].line}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function truncate(text, max) {
  const cleaned = text.replace(/\s+/g, " ").replace(/`/g, "'");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[audit-css-dedupe] failed:", error);
    process.exitCode = 1;
  });
}
