import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SCAN_ROOTS = Object.freeze(["src", "packages"]);

let ROOT = process.cwd();
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];
const SKIP_SEGMENTS = new Set([".git", "coverage", "dist", "node_modules", "tmp", ".playwright-mcp"]);

// ── known narrower replacement classes ──────────────────────────────────
// Keys are the broad class to avoid; values are { suggestion, reason }.
const BROAD_CLASS_ALTERNATIVES = {
  "gc-sheet-transition": {
    sidebars: "gc-sidebar-docked-transition",
    workspaceShells: "gc-workspace-shell-transition",
    reason:
      "gc-sheet-transition animates width, max-width, padding-left, padding-right, opacity, transform, box-shadow. " +
      "On sidebars and workspace wrappers only a subset of these properties ever change. " +
      "The extra transitioned properties force the browser to monitor layout changes that never happen, " +
      "and the width animation fights with gc-sheet-transform-transition on inner content.",
  },
};

// ── sidebar element heuristics ──────────────────────────────────────────
const SIDEBAR_CLASS_PATTERNS = [/sidebar/i, /side-bar/i, /app-sidebar/i];
const SIDEBAR_TESTID_PATTERNS = [/sidebar/i];

function looksLikeSidebar(el) {
  const classAttr = el.classAttr || "";
  const testIdAttr = el.testIdAttr || "";
  if (SIDEBAR_CLASS_PATTERNS.some((r) => r.test(classAttr))) return true;
  if (SIDEBAR_TESTID_PATTERNS.some((r) => r.test(testIdAttr))) return true;
  return false;
}

// ── workspace shell heuristics ──────────────────────────────────────────
function looksLikeWorkspaceShell(el) {
  const testIdAttr = el.testIdAttr || "";
  if (testIdAttr === "workspace-shell") return true;
  return false;
}

// ── helpers ─────────────────────────────────────────────────────────────

function relPath(p) {
  return path.relative(ROOT, p).replaceAll(path.sep, "/");
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const info = await stat(dir);
  if (info.isFile()) return [dir];
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(child)));
    else if (entry.isFile() && entry.name.endsWith(".vue")) out.push(child);
  }
  return out;
}

/**
 * Extract the class attribute value from a tag's attribute string.
 * Handles both static `class="..."` and dynamic `:class="[...]"`.
 * For dynamic :class arrays, extracts string literals from within the array.
 */
function extractClassAttr(attrs) {
  // Static class="foo bar"
  const staticMatch = attrs.match(/\bclass\s*=\s*"([^"]*)"/);
  if (staticMatch) return staticMatch[1];

  // Dynamic :class="['foo', ...]"  — collect string literals
  const dynamicMatch = attrs.match(/(?::|v-bind:)class\s*=\s*"\[([^\]]*)\]"/);
  if (dynamicMatch) {
    const inner = dynamicMatch[1];
    const strings = [];
    const strRe = /'([^']+)'/g;
    let m;
    while ((m = strRe.exec(inner)) !== null) {
      strings.push(m[1]);
    }
    return strings.join(" ");
  }

  return "";
}

/**
 * Extract the data-testid attribute value from a tag's attribute string.
 */
function extractTestIdAttr(attrs) {
  const match = attrs.match(/data-testid\s*=\s*"([^"]+)"/);
  if (match) return match[1];
  return "";
}

/**
 * Parse a Vue SFC template and return an array of elements that use
 * any of the broad transition classes we track.
 */
function parseVueTemplateElements(source) {
  const results = [];
  // Match opening tags: <tagname ...attrs...>
  const tagRe = /<([A-Za-z][A-Za-z0-9]*)\b([^>]*?)(\/)?\s*>/g;
  let m;
  while ((m = tagRe.exec(source)) !== null) {
    const tag = m[1];
    const attrs = m[2] || "";
    const classAttr = extractClassAttr(attrs);
    const testIdAttr = extractTestIdAttr(attrs);

    if (!classAttr) continue;

    for (const [broadClass, _alternatives] of Object.entries(BROAD_CLASS_ALTERNATIVES)) {
      const classes = classAttr.split(/\s+/);
      if (!classes.includes(broadClass)) continue;

      results.push({
        tag,
        broadClass,
        classAttr,
        testIdAttr,
        line: lineNumberAt(source, m.index),
        index: m.index,
      });
    }
  }
  return results;
}

export async function runBroadTransitionClassAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];

  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    allFiles.push(...(await walk(path.join(ROOT, root))));
  }

  const findings = [];

  for (const file of allFiles) {
    const src = await readFile(file, "utf8");
    const elements = parseVueTemplateElements(src);

    for (const el of elements) {
      const isSidebar = looksLikeSidebar(el);
      const isWorkspaceShell = looksLikeWorkspaceShell(el);

      if (!isSidebar && !isWorkspaceShell) continue;

      const alternatives = BROAD_CLASS_ALTERNATIVES[el.broadClass];
      const suggestion = isSidebar ? alternatives.sidebars : isWorkspaceShell ? alternatives.workspaceShells : null;

      if (!suggestion) continue;

      findings.push({
        file: relPath(file),
        line: el.line,
        broadClass: el.broadClass,
        suggestion,
        elementType: isSidebar ? "sidebar" : "workspace-shell",
        tag: el.tag,
        reason: alternatives.reason,
      });
    }
  }

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: { findings },
    report: renderReport({ findings }),
  };
}

function renderReport({ findings }) {
  if (findings.length === 0) {
    return "✅ All good — no broad transition class misuse detected.";
  }

  const lines = [];
  lines.push(`## Broad Transition Class Audit`);
  lines.push("");
  lines.push(`Found **${findings.length}** instance(s) of broad transition class usage on narrow-purpose elements.`);
  lines.push("");

  for (const f of findings) {
    lines.push(`### \`${f.file}:${f.line}\``);
    lines.push("");
    lines.push(`- **Element**: \`<${f.tag}>\` (${f.elementType})`);
    lines.push(`- **Current class**: \`${f.broadClass}\``);
    lines.push(`- **Suggested replacement**: \`${f.suggestion}\``);
    lines.push(`- **Why**: ${f.reason}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "Replace the broad class with the suggested narrower one. If the element genuinely needs all properties from the broad class (e.g. a detail dock that animates width, max-width, AND padding), this is a false positive — add a suppression comment or refine the heuristics.",
  );

  return lines.join("\n");
}
