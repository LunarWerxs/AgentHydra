import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// View Transition API audit.
//
// `document.startViewTransition()` animates by snapshotting the WHOLE document
// twice (old + new state) and cross-fading the two bitmaps. That double
// full-page raster is a synchronous main-thread hit that janks on large DOMs —
// it is exactly what made the light/dark theme toggle laggy. The fix was to
// flip state directly and let a scoped CSS color/opacity transition do the
// fade. This engine keeps that footgun from creeping back in, anywhere.
//
// Detected signals:
//   - `*.startViewTransition(`            → the JS API call           (error)
//   - `::view-transition*` pseudo-elements / `view-transition-name` /
//     `view-transition-class` properties  → the CSS that styles it     (warn)
//
// Genuinely scoped, intentional usage can opt out with an inline
// `audit-motion-ignore: view-transition` comment within ~200 chars before the
// match (same convention as motion-physics' `audit-motion-ignore: raw-transition`).

const DEFAULT_SCAN_ROOTS = Object.freeze(["src", "packages/connections-ui/src"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".vue", ".css"]);
// connections-arkitect is skipped so the tool never scans its own source (this
// file names the very patterns it hunts for).
const SKIP_SEGMENTS = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
  ".playwright-mcp",
  "connections-arkitect",
]);

const SUPPRESS_DIRECTIVE = "audit-motion-ignore: view-transition";

let ROOT = process.cwd();
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];

const RULES = {
  "view-transition-js": {
    severity: "error",
    title: "View Transition API call",
    reason:
      "startViewTransition() cross-fades by snapshotting the entire document twice (old + new) and blending the " +
      "bitmaps — a synchronous, full-page raster that janks on large DOMs. This is what made the light/dark theme " +
      "toggle laggy. Flip the state directly and animate with a scoped CSS color/opacity transition instead.",
  },
  "view-transition-css": {
    severity: "warn",
    title: "View Transition CSS",
    reason:
      "::view-transition* pseudo-elements and the view-transition-name / view-transition-class properties only " +
      "exist to drive the View Transition API, whose full-page snapshot is a known jank source. Prefer a scoped " +
      "CSS transition on the elements that actually change.",
  },
};

// `*.startViewTransition(` or `startViewTransition?.(` — NOT the type annotation
// `startViewTransition?: (` (no `(` immediately follows the identifier there).
const JS_CALL_PATTERN = /\bstartViewTransition\s*(?:\?\.\s*)?\(/g;
const CSS_PATTERN = /::view-transition[\w-]*|\bview-transition-(?:name|class)\s*:/g;

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

function lineTextAt(source, index) {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  let end = source.indexOf("\n", index);
  if (end === -1) end = source.length;
  return source.slice(start, end).trim().slice(0, 180);
}

// Blank out comment bodies (preserving newlines + length so indices and line
// numbers stay accurate) so documentation that *mentions* the anti-pattern —
// including the comments that explain why it was removed — does not trip the
// scanner. Only real code is matched.
function maskComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")); // /* block */
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")); // <!-- html -->
  // // line comments — the `[^:]` guard keeps protocol-relative URLs (https://) intact.
  out = out.replace(/(^|[^:])(\/\/[^\n]*)/g, (_m, p1, p2) => p1 + p2.replace(/[^\n]/g, " "));
  return out;
}

function isSuppressed(source, index) {
  return source.slice(Math.max(0, index - 200), index).includes(SUPPRESS_DIRECTIVE);
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
    else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) out.push(child);
  }
  return out;
}

function collectMatches(scanSource, originalSource, file, pattern, ruleId, findings) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(scanSource)) !== null) {
    const index = match.index;
    if (isSuppressed(scanSource, index)) continue;
    findings.push({
      file: relPath(file),
      line: lineNumberAt(scanSource, index),
      ruleId,
      severity: RULES[ruleId].severity,
      snippet: lineTextAt(originalSource, index),
    });
  }
}

export async function runViewTransitionAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];

  const seen = new Set();
  const files = [];
  for (const root of SCAN_ROOTS) {
    for (const file of await walk(path.join(ROOT, root))) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }

  const findings = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // Cheap pre-filter: skip files that mention neither signal at all.
    if (!source.includes("ViewTransition") && !source.includes("view-transition")) continue;
    const scanSource = maskComments(source);
    collectMatches(scanSource, source, file, JS_CALL_PATTERN, "view-transition-js", findings);
    collectMatches(scanSource, source, file, CSS_PATTERN, "view-transition-css", findings);
  }

  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.file.localeCompare(b.file) || a.line - b.line);

  return {
    // Only the JS call (error) gates the suite; bare CSS is inert without it.
    failed: findings.some((finding) => finding.severity === "error"),
    findings,
    jsonPayload: { findings, rules: RULES },
    report: renderReport({ findings }),
  };
}

function renderReport({ findings }) {
  if (findings.length === 0) {
    return "✅ All good — no View Transition API usage detected.";
  }

  // Section headings use the `— N (severity)` encoding the arkitect runner sums
  // (HEADING_SEVERITY_RE). The severity word must be `error` / `warning`.
  const SEVERITY_WORD = { error: "error", warn: "warning" };

  const lines = [];
  lines.push("## View Transition Audit");
  lines.push("");
  lines.push(
    "The View Transition API animates by snapshotting the whole document twice and blending the bitmaps — a " +
      "full-page raster that janks on large DOMs (it caused the laggy theme toggle).",
  );
  lines.push("");

  for (const ruleId of Object.keys(RULES)) {
    const ruleFindings = findings.filter((finding) => finding.ruleId === ruleId);
    if (ruleFindings.length === 0) continue;
    const rule = RULES[ruleId];
    lines.push(`### ${rule.title} — ${ruleFindings.length} (${SEVERITY_WORD[rule.severity]})`);
    lines.push("");
    lines.push(`\`${ruleId}\` — ${rule.reason}`);
    lines.push("");
    for (const finding of ruleFindings) {
      lines.push(`- \`${finding.file}:${finding.line}\` — \`${finding.snippet}\``);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "Replace it with a direct state flip + a scoped CSS transition. If a usage is genuinely scoped and " +
      "intentional, add `audit-motion-ignore: view-transition` in a comment immediately before it.",
  );

  return lines.join("\n");
}
