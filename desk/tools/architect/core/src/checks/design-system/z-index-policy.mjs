// Audit: catch broken or off-token z-index usage that has caused real
// "menu/popover appears underneath things" bugs.
//
// Two rule families:
//
// 1. invalid-tailwind-z-class: numeric z-* utilities that DO NOT exist as
//    Tailwind v4 defaults (z-55, z-60, z-150, z-500, z-999, etc.). These
//    silently compile to nothing — the element ends up at z-index: auto and
//    stacks purely by DOM order. Allow only the documented Tailwind scale
//    (0, 10, 20, 30, 40, 50) plus arbitrary `z-[n]` and CSS var `z-(--name)`
//    forms.
//
// 2. hardcoded-z-index: large magic z-index values (>= 100) outside the
//    --gc-z-* token scale, whether written as `z-1100`, `z-[1100]`,
//    `style="z-index: 1100"`, or `z-index: 1100;` in CSS. These create
//    arms-race situations (one component picks 10001, another must pick
//    10002, etc.) and bypass the stacking ladder in tokens.css.
//
// Skipped intentionally:
//  - z-1, z-2, z-3, z-5 etc. inside scoped <style> blocks for local
//    sibling stacking — those are usually fine and not stacking-context
//    coordinated. We only flag values >= 100 in CSS.
//  - z-index: -1, 0 — fine.
//  - Leaflet panes (z-index: 6xx) inside src/styles/routes/workspace/shell.css
//    — Leaflet owns its own stacking context.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRoot = path.resolve(__dirname, "../../../..");

// Tailwind v4 default numeric z-index scale.
const ALLOWED_TAILWIND_Z_NUMBERS = new Set(["0", "10", "20", "30", "40", "50"]);

// Files whose z-index numbers are managed and not subject to the policy:
//  - tokens.css: defines the --gc-z-* ladder
//  - shell.css: hosts Leaflet pane overrides (650/675/690) inside the map's
//    own stacking context
//  - the arkitect engines/policies themselves
const PATH_ALLOWLIST_PATTERNS = [
  /[\\/]styles[\\/]core[\\/]tokens\.css$/,
  /[\\/]styles[\\/]routes[\\/]workspace[\\/]shell\.css$/,
  /[\\/]connections-arkitect[\\/]/,
  /[\\/]node_modules[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]playground[\\/]/,
  /[\\/]__tests__[\\/]/,
  /\.spec\.ts$/,
  /\.test\.ts$/,
];

// Skip standalone demo pages — their large z-indexes are self-contained.
const PATH_DEMO_ALLOWLIST = [/[\\/]components[\\/]public[\\/](?:NetworkDemoPage|IntelligenceHomePage)\.vue$/];

const SCAN_EXTENSIONS = new Set([".vue", ".css", ".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "tmp", ".git", "build"]);

const TAILWIND_Z_CLASS_PATTERN = /\bz-(?!\[)(?!\()((?:[a-z]+:)*)(\d+)\b/g;
const TAILWIND_Z_ARBITRARY_PATTERN = /\bz-\[(-?\d+)\]/g;
const STYLE_ATTR_Z_INDEX_PATTERN = /\bz-index\s*:\s*(-?\d+)/gi;
const HARDCODED_NUMBER_THRESHOLD = 100;

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      if (SCAN_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
    }
  }
  return out;
}

function isPathAllowlisted(absolutePath) {
  return PATH_ALLOWLIST_PATTERNS.some((pattern) => pattern.test(absolutePath));
}

function isDemoPath(absolutePath) {
  return PATH_DEMO_ALLOWLIST.some((pattern) => pattern.test(absolutePath));
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function lineSnippet(source, index) {
  const before = source.lastIndexOf("\n", index - 1);
  const after = source.indexOf("\n", index);
  const start = before === -1 ? 0 : before + 1;
  const end = after === -1 ? source.length : after;
  return source.slice(start, end).trim();
}

function scanInvalidTailwindClasses(source, findings, relPath) {
  TAILWIND_Z_CLASS_PATTERN.lastIndex = 0;
  let match;
  while ((match = TAILWIND_Z_CLASS_PATTERN.exec(source))) {
    const value = match[2];
    if (ALLOWED_TAILWIND_Z_NUMBERS.has(value)) continue;
    findings.push({
      ruleId: "invalid-tailwind-z-class",
      severity: "error",
      filePath: relPath,
      line: lineNumberAt(source, match.index),
      message: `\`z-${value}\` is not a Tailwind v4 default class — the element will have z-index: auto. Use \`z-(--gc-z-…)\` token or one of: z-0, z-10, z-20, z-30, z-40, z-50.`,
      snippet: lineSnippet(source, match.index),
    });
  }
}

function scanHardcodedTailwindArbitrary(source, findings, relPath) {
  TAILWIND_Z_ARBITRARY_PATTERN.lastIndex = 0;
  let match;
  while ((match = TAILWIND_Z_ARBITRARY_PATTERN.exec(source))) {
    const value = parseInt(match[1], 10);
    if (Math.abs(value) < HARDCODED_NUMBER_THRESHOLD) continue;
    findings.push({
      ruleId: "hardcoded-z-index",
      severity: "warn",
      filePath: relPath,
      line: lineNumberAt(source, match.index),
      message: `Hardcoded z-index \`z-[${value}]\` bypasses the --gc-z-* ladder. Reference a token via z-(--gc-z-…).`,
      snippet: lineSnippet(source, match.index),
    });
  }
}

function scanHardcodedZIndexDeclarations(source, findings, relPath) {
  STYLE_ATTR_Z_INDEX_PATTERN.lastIndex = 0;
  let match;
  while ((match = STYLE_ATTR_Z_INDEX_PATTERN.exec(source))) {
    const value = parseInt(match[1], 10);
    if (Math.abs(value) < HARDCODED_NUMBER_THRESHOLD) continue;
    findings.push({
      ruleId: "hardcoded-z-index",
      severity: "warn",
      filePath: relPath,
      line: lineNumberAt(source, match.index),
      message: `Hardcoded \`z-index: ${value}\` bypasses the --gc-z-* ladder. Reference a token via var(--gc-z-…).`,
      snippet: lineSnippet(source, match.index),
    });
  }
}

async function runZIndexPolicyAudit(options = {}) {
  const auditRoot = path.resolve(options.root ?? defaultRoot);
  const roots = options.roots ?? ["src", "packages/connections-ui/src"];
  const fileSet = new Set();
  for (const rootPath of roots) {
    const absolute = path.resolve(auditRoot, rootPath);
    const found = await walk(absolute);
    for (const file of found) fileSet.add(file);
  }
  const files = [...fileSet].sort();

  const findings = [];
  for (const absolutePath of files) {
    if (isPathAllowlisted(absolutePath)) continue;
    const relPath = path.relative(auditRoot, absolutePath).replace(/\\/g, "/");
    const source = await fs.readFile(absolutePath, "utf8");

    scanInvalidTailwindClasses(source, findings, relPath);

    if (isDemoPath(absolutePath)) continue;

    scanHardcodedTailwindArbitrary(source, findings, relPath);
    scanHardcodedZIndexDeclarations(source, findings, relPath);
  }

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warn");

  const report = renderMarkdown(findings, errors, warnings, files.length);
  const jsonPayload = {
    scannedFiles: files.length,
    totalFindings: findings.length,
    errors: errors.length,
    warnings: warnings.length,
    findings,
  };

  return {
    failed: errors.length > 0,
    jsonPayload,
    report,
  };
}

function renderMarkdown(findings, errors, warnings, scannedCount) {
  const lines = [
    "# Z-Index Policy Audit",
    "",
    `- Scanned files: ${scannedCount}`,
    `- Total findings: ${findings.length}`,
    `- Errors: ${errors.length}`,
    `- Warnings: ${warnings.length}`,
    "",
    "_Rules_:",
    "",
    "- **invalid-tailwind-z-class** (error): `z-N` numeric utilities outside Tailwind v4's default scale (0/10/20/30/40/50) silently compile to nothing, leaving the element at `z-index: auto`. Use a token via `z-(--gc-z-…)` or an allowed Tailwind step.",
    '- **hardcoded-z-index** (warn): Numeric z-index values >= 100 written as `z-[n]`, inline `style="z-index: n"`, or CSS `z-index: n` bypass the `--gc-z-*` ladder in `src/styles/core/tokens.css`. Reference a token instead.',
    "",
  ];

  if (findings.length === 0) {
    lines.push("## ✅ No z-index policy violations detected.");
    return `${lines.join("\n")}\n`;
  }

  const byRule = new Map();
  for (const finding of findings) {
    if (!byRule.has(finding.ruleId)) byRule.set(finding.ruleId, []);
    byRule.get(finding.ruleId).push(finding);
  }

  for (const [ruleId, ruleFindings] of [...byRule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${ruleId} (${ruleFindings.length})`);
    lines.push("");
    lines.push("| File | Line | Snippet | Message |");
    lines.push("| --- | --- | --- | --- |");
    for (const finding of ruleFindings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line)) {
      const snippet = finding.snippet.replace(/\|/g, "\\|").slice(0, 100);
      const message = finding.message.replace(/\|/g, "\\|");
      lines.push(`| \`${finding.filePath}\` | ${finding.line} | \`${snippet}\` | ${message} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export const audit = {
  id: "z-index-policy",
  title: "Z-Index Policy",
  category: "design-system",
  defaultConfig: {
    roots: ["src", "packages/connections-ui/src"],
    outputPath: "tmp/audits/Z_INDEX_POLICY_AUDIT.md",
  },
  async run(context) {
    const result = await runZIndexPolicyAudit({
      root: context.root,
      roots: context.checkConfig.roots,
    });

    return {
      failed: result.failed,
      jsonPayload: result.jsonPayload,
      outputPath: context.checkConfig.outputPath,
      report: result.report,
    };
  },
};

export { runZIndexPolicyAudit };
