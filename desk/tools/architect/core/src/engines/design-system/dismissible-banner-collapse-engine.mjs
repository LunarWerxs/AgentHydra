import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCAN_ROOTS = Object.freeze(["src/components", "packages/connections-ui/src/components"]);

let ROOT = process.cwd();
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];
const SKIP_SEGMENTS = new Set([".git", "coverage", "dist", "node_modules", "tmp"]);

const FAIL_FLAG = "--fail-on-drift";
const SUPPRESS_DIRECTIVE = "audit-dismissible-collapse-ignore";

// Tags that, when ancestors of a dismissible banner, satisfy the policy
// by providing the smooth height/grid collapse. AppCollapse is the
// default; AppExpandTransition is the legacy alternative (JS-height
// based, slightly chunkier but acceptable).
const COLLAPSE_WRAPPERS = new Set(["AppCollapse", "AppExpandTransition"]);

// Banner-shaped primitives that should collapse on dismiss instead of
// snapping. AppInlineAlert is the v1 surface; extend this set as new
// banner primitives land.
const DISMISSIBLE_TAGS = new Set(["AppInlineAlert"]);

// Files exempt from the rule — typically the primitive itself, its
// playground / showcase sections, and tests.
const EXEMPT_PATH_FRAGMENTS = [
  "AppInlineAlert.vue",
  "AppInlineAlert.spec.ts",
  "/shared-primitives-live/",
  "/playground/",
  "/__tests__/",
  ".spec.",
];

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

function isExempt(relPathStr) {
  return EXEMPT_PATH_FRAGMENTS.some((frag) => relPathStr.includes(frag));
}

function isSuppressed(source, idx) {
  const window = source.slice(Math.max(0, idx - 200), idx);
  return window.includes(SUPPRESS_DIRECTIVE);
}

/**
 * Find the opening tag at `openIdx` and return its full attribute blob
 * plus the index just past `>`. Handles multi-line tags.
 */
function readOpenTag(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "<") depth += 1;
    if (ch === ">") {
      depth -= 1;
      if (depth === 0) {
        return { endIdx: i + 1, attrs: source.slice(openIdx, i + 1) };
      }
    }
  }
  return null;
}

/**
 * Walk the template ancestor chain at `openIdx` and return the set of
 * open ancestor tag names that have not yet been closed before openIdx.
 * Cheap-enough since templates here are tens of KB at most.
 */
function ancestorsAt(source, targetIdx) {
  const tagRe = /<\s*(\/)?\s*([A-Za-z][A-Za-z0-9_-]*)([^>]*?)(\/)?\s*>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(source)) !== null) {
    if (m.index >= targetIdx) break;
    const isClose = Boolean(m[1]);
    const tag = m[2];
    const selfClose = Boolean(m[4]);
    if (isClose) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i] === tag) {
          stack.splice(i, 1);
          break;
        }
      }
    } else if (!selfClose) {
      stack.push(tag);
    }
  }
  return new Set(stack);
}

function attrHasFlag(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}(?:\\s|=|>|$)`);
  return re.test(attrs);
}

function attrHasDismissHandler(attrs) {
  // Match @dismiss=..., v-on:dismiss=..., or @dismiss without args.
  return /(?:^|\s)(?:@|v-on:)dismiss(?:\.[a-zA-Z]+)?\s*=/.test(attrs);
}

export async function runDismissibleBannerCollapseAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];

  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    allFiles.push(...(await walk(path.join(ROOT, root))));
  }

  const findings = [];
  const tagOpenRe = new RegExp(`<\\s*(${[...DISMISSIBLE_TAGS].join("|")})\\b`, "g");

  for (const file of allFiles) {
    const rel = relPath(file);
    if (isExempt(rel)) continue;
    const src = await readFile(file, "utf8");

    tagOpenRe.lastIndex = 0;
    let m;
    while ((m = tagOpenRe.exec(src)) !== null) {
      const openIdx = m.index;
      if (isSuppressed(src, openIdx)) continue;
      const open = readOpenTag(src, openIdx);
      if (!open) continue;
      const attrs = open.attrs;

      const isDismissible = attrHasFlag(attrs, "dismissible") || attrHasDismissHandler(attrs);
      if (!isDismissible) continue;

      const ancestors = ancestorsAt(src, openIdx);
      const wrapped = [...ancestors].some((tag) => COLLAPSE_WRAPPERS.has(tag));
      if (wrapped) continue;

      findings.push({
        file: rel,
        line: lineNumberAt(src, openIdx),
        tag: m[1],
        attrs: attrs.replace(/\s+/g, " ").trim().slice(0, 100),
      });
    }
  }

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: { findings, wrappers: [...COLLAPSE_WRAPPERS] },
    report: renderReport({ findings }),
  };
}

function renderReport({ findings }) {
  const lines = [];
  lines.push("# Dismissible Banner Collapse Audit");
  lines.push("");
  lines.push(`- Findings: ${findings.length}`);
  lines.push(`- Required wrapper: <AppCollapse> (or <AppExpandTransition>)`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("All dismissible banners collapse smoothly.");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    'Dismissible banners that v-if or @dismiss off the page without a collapse wrapper snap shut and yank surrounding content. Wrap with <AppCollapse :open="..."> so the row animates from 1fr → 0fr (defined in index.html + shared with the cookie banner).',
  );
  lines.push("");
  lines.push("Suppress an individual instance with an HTML comment containing");
  lines.push(`\`${SUPPRESS_DIRECTIVE}\` within ~200 chars before the tag.`);
  lines.push("");

  for (const f of findings) {
    lines.push(`- ${f.file}:${f.line} <${f.tag}> — ${f.attrs}`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const result = await runDismissibleBannerCollapseAudit();
  console.log(result.report.trimEnd());
  if (process.argv.includes(FAIL_FLAG) && result.failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 2;
  });
}
