import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { iterateInlineStyles, parseInlineDeclarations } from "@saydeploy/architect/core/inline-styles";

const DEFAULT_SCAN_ROOTS = Object.freeze(["src"]);
const DEFAULT_SCAN_EXTENSIONS = Object.freeze([".vue", ".css"]);
const DEFAULT_SKIP_SEGMENTS = Object.freeze([".git", "dist", "node_modules", "tmp"]);
const DEFAULT_INLINE_FONT_SIZE_FILE_ALLOWLIST = Object.freeze([]);
const DEFAULT_MAX_PER_RULE_VALUE = 120;

let ROOT = process.cwd();
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];
let SCAN_EXTENSIONS = new Set(DEFAULT_SCAN_EXTENSIONS);
let SKIP_SEGMENTS = new Set(DEFAULT_SKIP_SEGMENTS);
let DEFAULT_MAX_PER_RULE = DEFAULT_MAX_PER_RULE_VALUE;

const RULES = {
  "sub-10px-font-size": {
    severity: "error",
    description: "Readable text must not render below 10px.",
  },
  "unsafe-form-control-font-size": {
    severity: "error",
    description: "Editable form controls should render at 16px or larger to avoid mobile focus zoom.",
  },
  "cramped-heading-leading": {
    severity: "error",
    description: "Headings should not use leading-none, leading-[1], or line-height near 1.",
  },
  "inline-font-size": {
    severity: "error",
    description: "Inline font-size overrides bypass typography roles and tokens.",
  },
  "inline-line-height": {
    severity: "error",
    description: "Inline line-height overrides bypass typography rhythm tokens.",
  },
  "raw-font-size-literal": {
    severity: "review",
    description:
      "Raw font-size literals should migrate to M3 type tokens, gc text recipes, or local display variables.",
  },
  "raw-text-size-utility": {
    severity: "review",
    description: "Raw Tailwind text-size utilities should migrate to gc text recipes or primitive props.",
  },
  "raw-leading-utility": {
    severity: "review",
    description: "Raw Tailwind leading utilities should migrate to type roles or primitive-owned rhythm.",
  },
};

const TOKEN_FONT_SIZE_PATTERN =
  /var\(\s*--(?:md-sys-typescale-[^)]+-(?:size|line-height)|gc-[^)]+(?:font-size|text-size|title-size|body-size|label-size|icon-size|row-font-size|button-font-size|pill-font-size|header-title-size|header-description-size))/;
const RAW_TEXT_SIZE_UTILITY_PATTERN =
  /(?<![\w-])(?:[\w-]+:)*text-(?:xs|sm|base|lg|xl|[2-9]xl|\[[^\]]+\])(?=\s|["'`}\]])/g;
const RAW_LEADING_UTILITY_PATTERN =
  /(?<![\w-])(?:[\w-]+:)*leading-(?:none|tight|snug|normal|relaxed|loose|\[[^\]]+\]|[3-9]|10)(?=\s|["'`}\]])/g;
const HEADING_TAG_PATTERN = /<h([1-6])\b[^>]*>/gi;
const CLASS_ATTR_PATTERN = /(?:^|\s)(?:class|:class|v-bind:class)\s*=\s*(["'])([\s\S]*?)\1/;
const CSS_RULE_PATTERN = /([^{}]+)\{([^{}]*)\}/g;
const CSS_FONT_SIZE_DECL_PATTERN = /(?<![-\w])font-size\s*:\s*([^;]+);?/gi;
const CSS_LINE_HEIGHT_DECL_PATTERN = /(?<![-\w])line-height\s*:\s*([^;]+);?/gi;
const FORM_SELECTOR_PATTERN = /\b(?:input|select|textarea|\.gc-(?:input|select|field)|field|combobox|search)\b/i;
const FORM_CONTROL_SELECTOR_PATTERN =
  /\b(?:input|select|textarea|:deep\((?:input|select|textarea)\)|__input|__textarea|input-field|text-field)\b/i;
const NON_CONTROL_FORM_TEXT_SELECTOR_PATTERN = /\b(?:label|helper|hint|heading|desc|description|toggle|category)\b/i;
const DECORATIVE_SELECTOR_PATTERN = /\b(?:ms-icon|icon|avatar|logo|mark|skeleton|spark|barcode|qr|decor|ornament)\b/i;
const HEADING_SELECTOR_PATTERN = /\bh[1-6]\b|__title\b|__heading\b|\.title\b|\.heading\b/i;
const M3_TOKEN_FILE_PATTERN = /src\/styles\/core\/tokens\.css$/;
const BASE_TYPE_FILE_PATTERN = /src\/styles\/core\/base\.css$/;
const LEGACY_CSS_PATTERN = /src\/styles\/legacy\//;
let INLINE_FONT_SIZE_FILE_ALLOWLIST = new Set(DEFAULT_INLINE_FONT_SIZE_FILE_ALLOWLIST);

function getArgValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }

  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalizePath(filePath) {
  return path.relative(ROOT, filePath).replaceAll(path.sep, "/");
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
      continue;
    }

    if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

async function collectFiles() {
  const files = [];

  for (const root of SCAN_ROOTS) {
    const fullPath = path.join(ROOT, root);
    if (existsSync(fullPath) && (await stat(fullPath)).isDirectory()) {
      files.push(...(await walk(fullPath)));
    }
  }

  return files;
}

function getLineNumber(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }

  return line;
}

function cleanSnippet(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function addFinding(findings, ruleId, filePath, line, snippet, note) {
  findings.push({
    ruleId,
    severity: RULES[ruleId].severity,
    filePath,
    line,
    snippet: cleanSnippet(snippet),
    note,
  });
}

function numericCssSizeToPx(value) {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(-?\d*\.?\d+)(px|rem|em)$/);
  if (!match) {
    return null;
  }

  const numberValue = Number.parseFloat(match[1]);
  const unit = match[2];

  if (!Number.isFinite(numberValue)) {
    return null;
  }

  if (unit === "px") {
    return numberValue;
  }

  return numberValue * 16;
}

function extractNumericCandidates(value) {
  // A length preceded by an arithmetic operator inside a calc()/clamp() is an
  // offset, not a candidate font-size (e.g. `calc(var(--big) - 2px)`). Skipping
  // them avoids false positives where the audit thinks a 2px subtraction is
  // the smallest declared size.
  const arithmeticContext = /[-+*/]\s*$/;
  return [...value.matchAll(/-?\d*\.?\d+(?:px|rem|em)/gi)]
    .filter((match) => !arithmeticContext.test(value.slice(0, match.index)))
    .map((match) => ({
      text: match[0],
      px: numericCssSizeToPx(match[0]),
    }));
}

function isTokenizedFontSize(value) {
  return (
    TOKEN_FONT_SIZE_PATTERN.test(value) ||
    /\b(?:inherit|unset|initial|revert|revert-layer)\b/.test(value) ||
    /^\s*var\(/.test(value)
  );
}

function shouldSkipRawFontSize(filePath, selector, value) {
  if (M3_TOKEN_FILE_PATTERN.test(filePath) || BASE_TYPE_FILE_PATTERN.test(filePath)) {
    return true;
  }

  if (DECORATIVE_SELECTOR_PATTERN.test(selector)) {
    return true;
  }

  return isTokenizedFontSize(value);
}

function getSourceLineNumber(source, localIndex, fullSource, offset) {
  return getLineNumber(fullSource ?? source, (offset ?? 0) + localIndex);
}

function scanCssBlocks(source, filePath, findings, offset = 0, fullSource = source) {
  CSS_RULE_PATTERN.lastIndex = 0;

  for (const ruleMatch of source.matchAll(CSS_RULE_PATTERN)) {
    const selector = ruleMatch[1];
    const body = ruleMatch[2];
    CSS_FONT_SIZE_DECL_PATTERN.lastIndex = 0;
    for (const declMatch of body.matchAll(CSS_FONT_SIZE_DECL_PATTERN)) {
      const value = declMatch[1].trim();
      const line = getSourceLineNumber(
        source,
        ruleMatch.index + selector.length + 1 + declMatch.index,
        fullSource,
        offset,
      );
      const numericCandidates = extractNumericCandidates(value);
      const smallestPx = numericCandidates
        .map((candidate) => candidate.px)
        .filter((candidate) => typeof candidate === "number")
        .sort((a, b) => a - b)[0];

      if (typeof smallestPx === "number" && smallestPx < 10 && !DECORATIVE_SELECTOR_PATTERN.test(selector)) {
        addFinding(
          findings,
          "sub-10px-font-size",
          filePath,
          line,
          `${selector} { font-size: ${value}; }`,
          `Smallest parsed size is ${smallestPx.toFixed(2)}px.`,
        );
      }

      if (
        typeof smallestPx === "number" &&
        smallestPx < 16 &&
        FORM_SELECTOR_PATTERN.test(selector) &&
        FORM_CONTROL_SELECTOR_PATTERN.test(selector) &&
        !NON_CONTROL_FORM_TEXT_SELECTOR_PATTERN.test(selector) &&
        !DECORATIVE_SELECTOR_PATTERN.test(selector)
      ) {
        addFinding(
          findings,
          "unsafe-form-control-font-size",
          filePath,
          line,
          `${selector} { font-size: ${value}; }`,
          `Editable-looking control text parses to ${smallestPx.toFixed(2)}px.`,
        );
      }

      if (!shouldSkipRawFontSize(filePath, selector, value)) {
        const note = LEGACY_CSS_PATTERN.test(filePath)
          ? "Legacy CSS: review when migrating this rule."
          : "Prefer M3 typescale variables, gc text recipes, or a named local display variable.";
        addFinding(findings, "raw-font-size-literal", filePath, line, `${selector} { font-size: ${value}; }`, note);
      }
    }

    CSS_LINE_HEIGHT_DECL_PATTERN.lastIndex = 0;
    for (const declMatch of body.matchAll(CSS_LINE_HEIGHT_DECL_PATTERN)) {
      const value = declMatch[1].trim();
      const line = getSourceLineNumber(
        source,
        ruleMatch.index + selector.length + 1 + declMatch.index,
        fullSource,
        offset,
      );
      const numeric = Number.parseFloat(value);

      if (
        Number.isFinite(numeric) &&
        numeric <= 1.1 &&
        HEADING_SELECTOR_PATTERN.test(selector) &&
        !DECORATIVE_SELECTOR_PATTERN.test(selector)
      ) {
        addFinding(
          findings,
          "cramped-heading-leading",
          filePath,
          line,
          `${selector} { line-height: ${value}; }`,
          "Heading selectors should use a readable line-height, generally 1.15 or higher.",
        );
      }
    }
  }
}

function scanTextUtilities(source, filePath, findings) {
  RAW_TEXT_SIZE_UTILITY_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(RAW_TEXT_SIZE_UTILITY_PATTERN)) {
    const line = getLineNumber(source, match.index);
    addFinding(
      findings,
      "raw-text-size-utility",
      filePath,
      line,
      match[0],
      "Prefer gc text recipes or a typography prop on the shared primitive.",
    );
  }

  RAW_LEADING_UTILITY_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(RAW_LEADING_UTILITY_PATTERN)) {
    const line = getLineNumber(source, match.index);
    addFinding(
      findings,
      "raw-leading-utility",
      filePath,
      line,
      match[0],
      "Prefer the line-height paired with the chosen type role.",
    );
  }
}

function scanHeadingTags(source, filePath, findings) {
  HEADING_TAG_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(HEADING_TAG_PATTERN)) {
    const tag = match[0];
    const classMatch = tag.match(CLASS_ATTR_PATTERN);
    if (!classMatch) {
      continue;
    }

    const classValue = classMatch[2];
    if (/\bleading-(?:none|\[1(?:\.0+)?\])\b/.test(classValue)) {
      addFinding(
        findings,
        "cramped-heading-leading",
        filePath,
        getLineNumber(source, match.index),
        tag,
        "Heading tag uses an explicitly cramped Tailwind leading utility.",
      );
    }
  }
}

function scanInlineStyles(source, filePath, findings) {
  if (INLINE_FONT_SIZE_FILE_ALLOWLIST.has(filePath)) {
    return;
  }

  for (const inline of iterateInlineStyles(source)) {
    if (inline.kind !== "static") {
      continue;
    }

    if (/\bms-icon\b/.test(inline.tag)) {
      continue;
    }

    for (const decl of parseInlineDeclarations(inline.value)) {
      if (decl.property === "font-size") {
        addFinding(
          findings,
          "inline-font-size",
          filePath,
          getLineNumber(source, inline.valueIndex + decl.index),
          `style="...${decl.property}: ${decl.value}..."`,
          "Move text sizing into a type role, CSS token, or primitive prop.",
        );
      } else if (decl.property === "line-height") {
        addFinding(
          findings,
          "inline-line-height",
          filePath,
          getLineNumber(source, inline.valueIndex + decl.index),
          `style="...${decl.property}: ${decl.value}..."`,
          "Move line-height onto the type role or recipe paired with the font-size.",
        );
      }
    }
  }
}

function extractVueStyleBlocks(source) {
  return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => ({
    source: match[1],
    offset: match.index + match[0].indexOf(match[1]),
  }));
}

function scanFile(source, filePath) {
  const findings = [];

  scanTextUtilities(source, filePath, findings);
  scanHeadingTags(source, filePath, findings);
  scanInlineStyles(source, filePath, findings);

  if (filePath.endsWith(".vue")) {
    for (const block of extractVueStyleBlocks(source)) {
      scanCssBlocks(block.source, filePath, findings, block.offset, source);
    }
  } else {
    scanCssBlocks(source, filePath, findings);
  }

  return findings;
}

function summarize(findings) {
  const byRule = new Map();
  const bySeverity = new Map();

  for (const finding of findings) {
    byRule.set(finding.ruleId, (byRule.get(finding.ruleId) ?? 0) + 1);
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  }

  return { byRule, bySeverity };
}

function formatMarkdown(findings, maxPerRule) {
  const { byRule, bySeverity } = summarize(findings);
  const now = new Date().toISOString();
  const lines = [
    "# Design System Typography Audit",
    "",
    `Generated: ${now}`,
    "",
    "Source of truth: [`docs/reference/DESIGN_SYSTEM.md#typography`](../../docs/reference/DESIGN_SYSTEM.md#typography)",
    "",
    "## Summary",
    "",
    `- Total findings: ${findings.length}`,
    `- Errors: ${bySeverity.get("error") ?? 0}`,
    `- Warnings: ${(bySeverity.get("warning") ?? 0) + (bySeverity.get("warn") ?? 0) + (bySeverity.get("review") ?? 0)}`,
    `- Review items: ${bySeverity.get("review") ?? 0}`,
    "",
    "## Rule Counts",
    "",
  ];

  for (const [ruleId, rule] of Object.entries(RULES)) {
    lines.push(`- ${rule.severity}: \`${ruleId}\` - ${byRule.get(ruleId) ?? 0} - ${rule.description}`);
  }

  for (const [ruleId, rule] of Object.entries(RULES)) {
    const ruleFindings = findings.filter((finding) => finding.ruleId === ruleId);
    if (ruleFindings.length === 0) {
      continue;
    }

    lines.push("", `## ${ruleId}`, "", `${rule.severity.toUpperCase()}: ${rule.description}`, "");

    for (const finding of ruleFindings.slice(0, maxPerRule)) {
      const note = finding.note ? ` - ${finding.note}` : "";
      lines.push(`- \`${finding.filePath}:${finding.line}\` - \`${finding.snippet}\`${note}`);
    }

    if (ruleFindings.length > maxPerRule) {
      lines.push(`- ... ${ruleFindings.length - maxPerRule} more findings omitted from this section.`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runDesignSystemTypographyAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];
  SCAN_EXTENSIONS = new Set(options.extensions ?? DEFAULT_SCAN_EXTENSIONS);
  SKIP_SEGMENTS = new Set(options.skipSegments ?? DEFAULT_SKIP_SEGMENTS);
  DEFAULT_MAX_PER_RULE = Number.parseInt(String(options.maxPerRule ?? DEFAULT_MAX_PER_RULE_VALUE), 10);
  INLINE_FONT_SIZE_FILE_ALLOWLIST = new Set(
    options.inlineFontSizeFileAllowlist ?? DEFAULT_INLINE_FONT_SIZE_FILE_ALLOWLIST,
  );

  const files = await collectFiles();
  const findings = [];

  for (const absolutePath of files) {
    const filePath = normalizePath(absolutePath);
    const source = await readFile(absolutePath, "utf8");
    findings.push(...scanFile(source, filePath));
  }

  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath) || a.line - b.line);

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  return {
    failed: errorCount > 0,
    findings,
    jsonPayload: { rules: RULES, findings },
    report: formatMarkdown(findings, DEFAULT_MAX_PER_RULE),
  };
}

async function main() {
  const maxPerRule = Number.parseInt(getArgValue("--max-per-rule", String(DEFAULT_MAX_PER_RULE)), 10);
  const result = await runDesignSystemTypographyAudit({ maxPerRule });
  const format = getArgValue("--format", "markdown");

  if (format === "json") {
    console.log(JSON.stringify(result.jsonPayload, null, 2));
  } else {
    console.log(result.report.trimEnd());
  }

  const errorCount = result.findings.filter((finding) => finding.severity === "error").length;

  if (hasFlag("--fail-on-drift") && errorCount > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
