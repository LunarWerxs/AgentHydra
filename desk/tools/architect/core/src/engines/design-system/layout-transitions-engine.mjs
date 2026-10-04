/**
 * Layout Transitions Engine
 * =========================
 * Detects CSS transition declarations that animate layout-triggering properties
 * (width, height, padding, margin, etc.). These force the browser to recalculate
 * layout on every animation frame, causing jank/stutter — especially when the
 * transitioning element is a flex/grid sibling.
 *
 * Fix: either remove the layout property from the transition (let it snap) and
 * use a compositor-only property (transform, opacity) for the visual animation,
 * OR add `contain: layout style` on siblings to isolate the layout impact.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { expandTransitionProperties, loadTokenMap } from "@saydeploy/architect/core/css-var-resolver";

let ROOT = process.cwd();

// Properties that trigger layout recalculation when animated.
// https://csstriggers.com / https://gist.github.com/paulirish/5d52fb081b3570c81e3a
const LAYOUT_TRIGGERING_PROPERTIES = new Set([
  // Box model
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-block",
  "padding-block-start",
  "padding-block-end",
  "padding-inline",
  "padding-inline-start",
  "padding-inline-end",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-block",
  "margin-block-start",
  "margin-block-end",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
  // Positioning
  "left",
  "right",
  "top",
  "bottom",
  "inset",
  "inset-inline",
  "inset-inline-start",
  "inset-inline-end",
  "inset-block",
  "inset-block-start",
  "inset-block-end",
  // Flex / Grid
  "flex-basis",
  "grid-template-columns",
  "grid-template-rows",
  "grid-template",
  "gap",
  "row-gap",
  "column-gap",
  // Borders (affect box size)
  "border-width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-block-width",
  "border-inline-width",
  // Typography (affects line boxes)
  "font-size",
  "line-height",
  "letter-spacing",
  "word-spacing",
  // Scroll
  "scroll-padding",
  "scroll-margin",
]);

// Properties that are compositor-only (GPU) — safe to animate.
const COMPOSITOR_ONLY_PROPERTIES = new Set([
  "transform",
  "translate",
  "scale",
  "rotate",
  "opacity",
  "filter",
  "backdrop-filter",
]);

// Properties that trigger only paint (not layout) — acceptable.
const PAINT_ONLY_PROPERTIES = new Set([
  "color",
  "background",
  "background-color",
  "border-color",
  "outline-color",
  "box-shadow",
  "outline",
  "border-radius",
  "visibility",
  "z-index",
  "fill",
  "stroke",
  "caret-color",
  "column-rule-color",
  "text-decoration-color",
  "text-emphasis-color",
]);

const CSS_EXTENSIONS = new Set([".css"]);
const SOURCE_EXTENSIONS = new Set([".css", ".vue", ".tsx", ".ts", ".mjs", ".js"]);
const SKIP_SEGMENTS = new Set([".git", "coverage", "dist", "node_modules", "tmp"]);

// Design-system token/transition files define the approved transition classes.
// They are the authoritative source, not violations.
const TOKEN_LAYER_FILES = new Set(["src/styles/core/tokens.css", "src/styles/core/transitions.css"]);

// Public/demo CSS, dev pages, and harness pages use intentionally custom
// animations that are not part of the production design system.
const PUBLIC_DEMO_DEV_PATTERN =
  /^(?:src\/styles\/routes\/public\/|src\/styles\/routes\/dev\/|src\/components\/dev\/|src\/shared-primitives-live\/)/;

// Spec/test files and harness pages may intentionally test or demo transitions.
const SKIP_FILE_PATTERNS = [/\.spec\.[cm]?[tj]sx?$/, /\.test\.[cm]?[tj]sx?$/, /\/__tests__\//, /\/__fixtures__\//];

const RULES = {
  "layout-triggering-transition": {
    severity: "warning",
    description:
      "Transitioning a layout-triggering property (width, height, padding, margin, etc.) forces the browser to recalculate layout on every animation frame. Prefer compositor-only properties (transform, opacity) for animations, or add contain:layout to sibling elements.",
  },
  "transition-all-shorthand-layout": {
    severity: "error",
    description:
      "`transition: all` captures every property including layout-triggering ones. List only the specific compositor/paint properties you intend to animate.",
  },
};

/**
 * @param {string} filePath
 * @param {string} source
 * @param {Map<string, string>} varMap
 * @returns {{ ruleId: string, severity: string, filePath: string, line: number, message: string, snippet: string }[]}
 */
function scanCssSource(filePath, source, varMap) {
  const findings = [];
  const rel = normalizePath(path.relative(ROOT, filePath));

  // Find transition declarations.
  // Matches: `transition: width 300ms ease, opacity 200ms;`
  // Also matches: `transition: all 300ms;`
  // Also matches: `transition: var(--token);`
  const transitionBlockRe = /transition\s*:\s*([^;{}]+)/gi;

  let match;
  while ((match = transitionBlockRe.exec(source)) !== null) {
    const rawValue = match[1].trim();
    const line = lineNumberAt(source, match.index);

    // Check for `transition: all`
    if (/^all\b/.test(rawValue)) {
      findings.push({
        ruleId: "transition-all-shorthand-layout",
        severity: RULES["transition-all-shorthand-layout"].severity,
        filePath: rel,
        line,
        message: "`transition: all` will animate every layout-triggering property. List specific properties instead.",
        snippet: cleanSnippet(match[0]),
      });
      continue;
    }

    // Resolve CSS custom properties in the transition value, then expand
    // to individual property names.
    const expandedProps = expandTransitionProperties(rawValue, varMap);

    // Skip if the transition references a design-system-approved token.
    // These tokens intentionally include layout properties for specific
    // patterns (e.g. progress bars, sheet resizing).
    if (isApprovedDesignToken(rawValue)) continue;

    // Skip if the transition uses M3 motion duration/easing tokens —
    // this indicates a designed, intentional animation.
    if (/\bvar\(--(?:md-sys-motion|gc-motion)-/.test(rawValue)) continue;

    const layoutProps = [];
    for (const propName of expandedProps) {
      if (COMPOSITOR_ONLY_PROPERTIES.has(propName)) continue;
      if (PAINT_ONLY_PROPERTIES.has(propName)) continue;
      if (LAYOUT_TRIGGERING_PROPERTIES.has(propName)) {
        // Skip if the same CSS rule already isolates layout via contain or
        // will-change — the developer already optimized the transition.
        if (hasLayoutContainment(source, match.index, propName)) continue;
        layoutProps.push(propName);
      }
    }

    if (layoutProps.length > 0) {
      const suggestion =
        layoutProps.length === 1
          ? `"${layoutProps[0]}" triggers layout on every frame`
          : `${layoutProps.map((p) => `"${p}"`).join(", ")} trigger layout on every frame`;
      findings.push({
        ruleId: "layout-triggering-transition",
        severity: RULES["layout-triggering-transition"].severity,
        filePath: rel,
        line,
        message: `${suggestion}. Use compositor-only properties (transform, opacity) for the visual animation and let the layout property snap, or add \`contain: layout style\` on flex siblings.`,
        snippet: cleanSnippet(match[0]),
      });
    }
  }

  return findings;
}

/**
 * Scan inline `style` attributes in Vue/TSX files for transition declarations.
 */
function scanInlineStyle(filePath, source, varMap) {
  const findings = [];
  const rel = normalizePath(path.relative(ROOT, filePath));

  // Match style="..." attributes
  const styleAttrRe = /style\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = styleAttrRe.exec(source)) !== null) {
    const styleValue = match[1];
    if (!/\btransition\s*:/.test(styleValue)) continue;

    const line = lineNumberAt(source, match.index);

    // Simple check: if the style contains transition, flag it for review
    if (/\btransition\s*:\s*all\b/i.test(styleValue)) {
      findings.push({
        ruleId: "transition-all-shorthand-layout",
        severity: RULES["transition-all-shorthand-layout"].severity,
        filePath: rel,
        line,
        message: "Inline `transition: all` will animate layout-triggering properties.",
        snippet: cleanSnippet(match[0]),
      });
      continue;
    }

    // Check if any layout-triggering property is being transitioned inline
    const transitionMatch = styleValue.match(/transition\s*:\s*([^";]+)/i);
    if (transitionMatch) {
      // Delegate to the same parsing logic
      const inlineFindings = scanCssSource(filePath, `transition: ${transitionMatch[1]}`, varMap);
      for (const f of inlineFindings) {
        f.line = line;
        f.filePath = rel;
        f.message = `Inline style: ${f.message}`;
        findings.push(f);
      }
    }
  }

  return findings;
}

function cleanSnippet(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Check if the CSS rule containing `matchIndex` already isolates layout
 * via `contain: layout` or `will-change` for the given property.
 * This indicates the developer already optimized for the transition.
 */
function hasLayoutContainment(source, matchIndex, propName) {
  const blockStart = source.lastIndexOf("{", matchIndex);
  const blockEnd = source.indexOf("}", matchIndex);
  if (blockStart === -1 || blockEnd === -1) return false;

  const ruleBlock = source.slice(blockStart, blockEnd);

  // `contain: layout` or `contain: strict` fully isolates layout
  if (/\bcontain\s*:\s*[^;}]*(?:layout|strict|content)\b/.test(ruleBlock)) return true;

  // `will-change` for the specific property or general hints
  if (new RegExp(`will-change\\s*:\\s*[^;}]*(?:${propName}|auto|transform)[^;}]*`, "i").test(ruleBlock)) return true;

  return false;
}

// Design-system tokens that intentionally include layout-triggering properties
// for approved patterns (progress bars, sheet resize, detail dock, etc.).
const APPROVED_DESIGN_TOKENS = new Set([
  "--gc-transition-progress-fill-motion",
  "--gc-detail-dock-transition-motion",
  "--gc-sheet-transition-motion",
  "--gc-sheet-resize-transition-motion",
  "--gc-inline-slot-transition-motion",
  "--gc-transition-fast-width-margin-fade-transform-motion",
]);

function isApprovedDesignToken(transitionValue) {
  const trimmed = transitionValue.trim();
  // Single-token reference: `var(--gc-*)` or `var(--md-sys-*)`
  // Any gc- or md-sys- prefixed token used alone is a design-system pattern.
  const singleVarMatch = trimmed.match(/^var\((--[\w-]+)\)$/);
  if (singleVarMatch) {
    const name = singleVarMatch[1];
    if (APPROVED_DESIGN_TOKENS.has(name)) return true;
    // All gc- and md-sys- prefixed tokens are design-system approved.
    if (/^--(?:gc-|md-sys-)/.test(name)) return true;
  }
  // Multi-property token reference: `var(--token1), var(--token2)`
  const varRefs = trimmed.match(/var\((--[\w-]+)\)/g);
  if (varRefs && varRefs.length > 0) {
    const allApproved = varRefs.every((ref) => {
      const name = ref.match(/var\((--[\w-]+)\)/)?.[1];
      return name ? APPROVED_DESIGN_TOKENS.has(name) || /^--(?:gc-|md-sys-)/.test(name) : false;
    });
    if (allApproved) return true;
  }
  return false;
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

/**
 * @param {string} root
 * @param {string[]} roots
 * @param {Set<string>} extensions
 * @returns {Promise<string[]>}
 */
async function walkFiles({ root, roots, extensions }) {
  const files = [];

  async function walk(dir) {
    if (!existsSync(dir)) return;
    const { readdir } = await import("node:fs/promises");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = normalizePath(path.relative(root, full));
      if (SKIP_SEGMENTS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(rel);
      }
    }
  }

  for (const r of roots) {
    const abs = path.resolve(root, r);
    if (!existsSync(abs)) continue;
    const s = await import("node:fs/promises").then((m) => m.stat(abs));
    if (s.isFile()) {
      if (extensions.has(path.extname(abs).toLowerCase())) {
        files.push(normalizePath(path.relative(root, abs)));
      }
    } else {
      await walk(abs);
    }
  }

  return files;
}

/**
 * @param {object} options
 * @param {string} options.root
 * @param {string[]} options.roots
 * @param {string[]} [options.allowlist]
 * @param {string[]} [options.tokenFiles]
 * @returns {Promise<{ findings: object[], filesScanned: number }>}
 */
export async function runLayoutTransitionsAudit({ root, roots, allowlist = [], tokenFiles = [] }) {
  ROOT = root;
  const allowSet = new Set(allowlist.map((p) => normalizePath(p)));

  // Load CSS custom property tokens so we can resolve var() references.
  const varMap = await loadTokenMap(root, tokenFiles);

  const files = await walkFiles({ root, roots, extensions: SOURCE_EXTENSIONS });
  const allFindings = [];

  for (const rel of files) {
    if (allowSet.has(rel)) continue;
    if (TOKEN_LAYER_FILES.has(rel)) continue;
    if (PUBLIC_DEMO_DEV_PATTERN.test(rel)) continue;
    if (SKIP_FILE_PATTERNS.some((p) => p.test(rel))) continue;

    const abs = path.resolve(root, rel);
    let source;
    try {
      source = await readFile(abs, "utf8");
    } catch {
      continue;
    }

    const ext = path.extname(rel).toLowerCase();

    if (CSS_EXTENSIONS.has(ext) || ext === ".vue" || ext === ".tsx" || ext === ".ts") {
      const cssFindings = scanCssSource(abs, source, varMap);
      allFindings.push(...cssFindings);

      if (ext === ".vue" || ext === ".tsx") {
        const inlineFindings = scanInlineStyle(abs, source, varMap);
        allFindings.push(...inlineFindings);
      }
    }
  }

  return { findings: allFindings, filesScanned: files.length };
}

/**
 * Render a markdown report.
 */
export function renderReport({ findings, filesScanned }) {
  const byRule = {};
  for (const f of findings) {
    (byRule[f.ruleId] ??= []).push(f);
  }

  const errCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.filter((f) => f.severity !== "error").length;

  const lines = [
    "# Layout Transitions Audit",
    "",
    "_Detects CSS transition declarations that animate layout-triggering properties, causing per-frame reflows._",
    "",
    `- Files scanned: ${filesScanned}`,
    `- Findings: ${findings.length}`,
    `- Errors: ${errCount}`,
    `- Warnings: ${warnCount}`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No layout-triggering transitions found.", "");
    return lines.join("\n");
  }

  for (const [ruleId, list] of Object.entries(byRule)) {
    lines.push(`## ${ruleId} — ${list.length} (${RULES[ruleId].severity})`, "", `_${RULES[ruleId].description}_`, "");
    for (const f of list.slice(0, 100)) {
      lines.push(`- \`${f.filePath}:${f.line}\` — ${f.message}`);
      if (f.snippet) lines.push(`  \`\`\`\n  ${f.snippet}\n  \`\`\``);
    }
    if (list.length > 100) lines.push(`- …and ${list.length - 100} more`);
    lines.push("");
  }

  return lines.join("\n");
}

export { RULES };
