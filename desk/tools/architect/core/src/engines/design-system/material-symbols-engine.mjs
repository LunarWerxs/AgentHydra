import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_CODEPOINTS_URL =
  "https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsRounded%5BFILL,GRAD,opsz,wght%5D.codepoints";
const DEFAULT_CACHE_PATH = "tmp/material-symbols-rounded.codepoints";
const DEFAULT_SCAN_ROOTS = Object.freeze(["src"]);
const DEFAULT_SCAN_EXTENSIONS = Object.freeze([".vue", ".ts", ".css"]);
const DEFAULT_SKIP_SEGMENTS = Object.freeze(["node_modules", "dist", "tmp", ".git"]);
const DEFAULT_SKIP_FILE_PATTERNS = Object.freeze(["\\.spec\\.ts$", "\\.test\\.ts$", "[\\\\/]__tests__[\\\\/]"]);
const DEFAULT_DYNAMIC_SAFELIST_PATH = "src/lib/icons/material-symbols-safelist.ts";

let ROOT = process.cwd();
let CODEPOINTS_URL = DEFAULT_CODEPOINTS_URL;
let CACHE_PATH = path.join(ROOT, DEFAULT_CACHE_PATH);
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];
let SCAN_EXTENSIONS = new Set(DEFAULT_SCAN_EXTENSIONS);
let SKIP_SEGMENTS = new Set(DEFAULT_SKIP_SEGMENTS);
let SKIP_FILE_PATTERNS = DEFAULT_SKIP_FILE_PATTERNS.map((pattern) => new RegExp(pattern));
let DYNAMIC_SAFELIST_PATH = path.join(ROOT, DEFAULT_DYNAMIC_SAFELIST_PATH);
let SUBSET_FONT_PATH = "";
let SUBSET_MANIFEST_PATH = "";
let SUBSET_CSS_PATH = "";
let SUBSET_MAX_BYTES = 0;
let SUBSET_SOURCE_FONT_URL = "";
let ROOT_DOCUMENT_PATHS = [];
const SAFELIST_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MATERIAL_SYMBOLS_GOOGLE_STYLESHEET_PATTERN =
  /fonts\.googleapis\.com\/css2\?[^"')\s>]*family=Material\+Symbols\+Rounded/i;

let ALLOWED_NON_MATERIAL_KEYS = new Set();
let INLINE_SVG_EXCEPTIONS = new Map();
let ALLOWED_MAPPED_ICON_CONSTS = new Set();

const ATTRIBUTE_ICON_NAMES =
  "(?:icon|leadingIcon|trailingIcon|emptyIcon|desktopBackIcon|actionIcon|customIcon|activeIcon)";
const KEBAB_ATTRIBUTE_ICON_NAMES =
  "(?:icon|leading-icon|trailing-icon|empty-icon|desktop-back-icon|action-icon|custom-icon|active-icon)";

const EXTRACTORS = [
  new RegExp(`(?:^|[^A-Za-z0-9_])${ATTRIBUTE_ICON_NAMES}\\s*:\\s*["']([A-Za-z0-9_]+)["']`, "g"),
  new RegExp(`(?<![:@A-Za-z0-9_-])${KEBAB_ATTRIBUTE_ICON_NAMES}=["']([A-Za-z0-9_]+)["']`, "g"),
  /<span(?=[^>]*\bms-icon\b)[^>]*>\s*([a-z0-9_]+)\s*<\/span>/g,
];
const ICON_CONTEXT_PATTERN = new RegExp(`\\b(?:${ATTRIBUTE_ICON_NAMES}|${KEBAB_ATTRIBUTE_ICON_NAMES}|ms-icon)\\b`);
const QUOTED_LOWER_NAME_PATTERN = /["']([a-z][a-z0-9_]*)["']/g;
const BARE_LOWER_NAME_PATTERN = /\b([a-z][a-z0-9_]*)\b/g;
const ICON_FLAGGED_GLYPH_PATTERN =
  /(?:\bglyph\s*:\s*["']([a-z][a-z0-9_]*)["'][\s\S]{0,400}?\bicon\s*:\s*true\b|\bicon\s*:\s*true\b[\s\S]{0,400}?\bglyph\s*:\s*["']([a-z][a-z0-9_]*)["'])/g;
const MS_ICON_SPAN_PATTERN = /<span(?=[^>]*\bms-icon\b)[^>]*>[\s\S]*?<\/span>/g;
const MS_ICON_FORBIDDEN_CLASS_PATTERN =
  /(?:^|\s)(?:text-\[[^\]]+\]|text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)|size-(?:\[[^\]]+\]|\d+(?:\.\d+)?)|inline-flex|items-center|justify-center|leading-none|shrink-0)(?=\s|$)/;
const MS_ICON_TAG_PATTERN = /<[^>]*\bms-icon\b[^>]*>/g;
const MS_ICON_FORBIDDEN_STYLE_PATTERN = /\bstyle\s*=\s*(["'])(?:(?!\1)[\s\S])*?\bfont-size\s*:/;
const MS_ICON_CSS_RULE_PATTERN = /([^{}]*\.ms-icon[^{}]*)\{([^{}]*)\}/g;
const ICON_CONTEXT_LOOKAHEAD_LINES = 12;

// "Hidden icon map" guard. A const named like *icon* whose object values are
// official Material Symbol names — e.g. `const bumpIcon = { sensors: "sensors" }`
// rendered as `<span class="ms-icon">{{ bumpIcon.sensors }}</span>`. That
// indirection hides the literal from every extractor above: mustaches are
// stripped from ms-icon span bodies, and the const sits far from any icon
// context. We collect these as candidates here; runMaterialSymbolsAudit then
// flags only the ones whose name is ALSO missing from the computed subset —
// i.e. the glyph is reachable no other way and will render as ligature text.
// (Maps whose names are inlined elsewhere or safelisted are already covered.)
// The fix is to inline the name into the span, or add it to the dynamic safelist.
const MAPPED_ICON_CONST_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\{/g;
const MAPPED_ICON_CONST_NAME_PATTERN = /icon/i;
const MAPPED_ICON_TOP_LEVEL_VALUE_PATTERN = /^\s*["']([a-z][a-z0-9_]*)["']/;

function hasFlag(name) {
  return process.argv.includes(name);
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function loadCodepoints() {
  if (existsSync(CACHE_PATH) && !hasFlag("--refresh")) {
    return readFile(CACHE_PATH, "utf8");
  }

  const text = await fetchText(CODEPOINTS_URL);
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, text);
  return text;
}

function parseCodepoints(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
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

    if (!entry.isFile() || !SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }

    if (SKIP_FILE_PATTERNS.some((pattern) => pattern.test(fullPath))) {
      continue;
    }

    files.push(fullPath);
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

function addCandidate(candidates, name, filePath) {
  if (!name) {
    return;
  }

  if (!candidates.has(name)) {
    candidates.set(name, new Set());
  }

  candidates.get(name).add(path.relative(ROOT, filePath).replaceAll(path.sep, "/"));
}

function extractOfficialQuotedNamesFromIconContexts(text, filePath, candidates, officialNames) {
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!ICON_CONTEXT_PATTERN.test(lines[lineIndex])) {
      continue;
    }

    const block = lines.slice(lineIndex, lineIndex + ICON_CONTEXT_LOOKAHEAD_LINES + 1).join("\n");
    QUOTED_LOWER_NAME_PATTERN.lastIndex = 0;
    for (const match of block.matchAll(QUOTED_LOWER_NAME_PATTERN)) {
      const name = match[1];
      if (officialNames.has(name)) {
        addCandidate(candidates, name, filePath);
      }
    }
  }
}

function extractBareMsIconSpanBodies(text, filePath, candidates, officialNames) {
  MS_ICON_SPAN_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MS_ICON_SPAN_PATTERN)) {
    const span = match[0];
    const bodyStart = span.indexOf(">");
    const bodyEnd = span.lastIndexOf("</span>");
    if (bodyStart === -1 || bodyEnd === -1 || bodyEnd <= bodyStart) {
      continue;
    }

    const body = span.slice(bodyStart + 1, bodyEnd).replace(/\{\{[\s\S]*?\}\}/g, " ");
    BARE_LOWER_NAME_PATTERN.lastIndex = 0;
    for (const literal of body.matchAll(BARE_LOWER_NAME_PATTERN)) {
      const name = literal[1];
      if (officialNames.has(name)) {
        addCandidate(candidates, name, filePath);
      }
    }
  }
}

function extractIconFlaggedGlyphObjects(text, filePath, candidates, officialNames) {
  ICON_FLAGGED_GLYPH_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(ICON_FLAGGED_GLYPH_PATTERN)) {
    const name = match[1] ?? match[2];
    if (officialNames.has(name)) {
      addCandidate(candidates, name, filePath);
    }
  }
}

function findMatchingBraceEnd(text, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

// Collect `key: "officialIconName"` pairs at the OBJECT's top level only. Strings
// nested inside arrays/sub-objects (e.g. `{ tag: "polyline" }` inside an inline
// SVG-shape registry) are skipped — those aren't Material Symbol references and
// would be false positives. Tracks brace/bracket depth and skips string bodies
// so braces inside strings never shift the depth.
function collectTopLevelIconValues(body, officialNames) {
  const found = [];
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < body.length && body[index] !== char) {
        if (body[index] === "\\") {
          index += 1;
        }
        index += 1;
      }
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }
    if (depth === 0 && char === ":") {
      const valueMatch = MAPPED_ICON_TOP_LEVEL_VALUE_PATTERN.exec(body.slice(index + 1));
      if (valueMatch && officialNames.has(valueMatch[1])) {
        found.push({ name: valueMatch[1], index: index + 1 + valueMatch[0].lastIndexOf(valueMatch[1]) });
      }
    }
  }
  return found;
}

function collectMappedIconLiteralCandidates(text, filePath, officialNames) {
  const relativePath = path.relative(ROOT, filePath).replaceAll(path.sep, "/");
  if (ALLOWED_MAPPED_ICON_CONSTS.has(relativePath)) {
    return [];
  }

  const candidates = [];
  MAPPED_ICON_CONST_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MAPPED_ICON_CONST_PATTERN)) {
    const constName = match[1];
    if (!MAPPED_ICON_CONST_NAME_PATTERN.test(constName) || ALLOWED_MAPPED_ICON_CONSTS.has(constName)) {
      continue;
    }

    const openBraceIndex = match.index + match[0].lastIndexOf("{");
    const endIndex = findMatchingBraceEnd(text, openBraceIndex);
    if (endIndex === -1) {
      continue;
    }

    const body = text.slice(openBraceIndex + 1, endIndex);
    const seen = new Set();
    for (const value of collectTopLevelIconValues(body, officialNames)) {
      if (seen.has(value.name)) {
        continue;
      }
      seen.add(value.name);
      candidates.push({
        file: relativePath,
        line: lineForIndex(text, openBraceIndex + 1 + value.index),
        constName,
        name: value.name,
      });
    }
  }

  return candidates;
}

function extractCandidates(text, filePath, candidates, officialNames) {
  for (const extractor of EXTRACTORS) {
    extractor.lastIndex = 0;
    for (const match of text.matchAll(extractor)) {
      addCandidate(candidates, match[1], filePath);
    }
  }

  extractOfficialQuotedNamesFromIconContexts(text, filePath, candidates, officialNames);
  extractBareMsIconSpanBodies(text, filePath, candidates, officialNames);
  extractIconFlaggedGlyphObjects(text, filePath, candidates, officialNames);
}

function collectInlineSvgReferences(text, filePath) {
  const refs = [];
  const relativePath = path.relative(ROOT, filePath).replaceAll(path.sep, "/");

  for (const match of text.matchAll(/<svg\b/g)) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    refs.push({
      file: relativePath,
      line,
      allowedReason: INLINE_SVG_EXCEPTIONS.get(relativePath) ?? "",
    });
  }

  return refs;
}

function findQuotedRangeAround(text, index) {
  for (let start = index - 1; start >= 0; start -= 1) {
    const quote = text[start];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      if (quote === "\n" && index - start > 400) {
        return null;
      }
      continue;
    }

    for (let end = start + 1; end < text.length; end += 1) {
      if (text[end] === "\\") {
        end += 1;
        continue;
      }
      if (text[end] === quote) {
        return end > index ? { start, end } : null;
      }
    }

    return null;
  }

  return null;
}

function collectMsIconSizeTokenViolations(text, filePath) {
  const refs = [];
  const seenRanges = new Set();
  const relativePath = path.relative(ROOT, filePath).replaceAll(path.sep, "/");
  let searchIndex = -1;

  while ((searchIndex = text.indexOf("ms-icon", searchIndex + 1)) !== -1) {
    const range = findQuotedRangeAround(text, searchIndex);
    if (!range) {
      continue;
    }

    const rangeKey = `${range.start}:${range.end}`;
    if (seenRanges.has(rangeKey)) {
      continue;
    }
    seenRanges.add(rangeKey);

    const content = text.slice(range.start + 1, range.end);
    if (!content.split(/\s+/).includes("ms-icon") || !MS_ICON_FORBIDDEN_CLASS_PATTERN.test(content)) {
      continue;
    }

    refs.push({
      file: relativePath,
      line: text.slice(0, range.start).split(/\r?\n/).length,
      snippet: content.replace(/\s+/g, " ").trim(),
    });
  }

  for (const match of text.matchAll(MS_ICON_TAG_PATTERN)) {
    const tag = match[0];
    if (!MS_ICON_FORBIDDEN_STYLE_PATTERN.test(tag)) {
      continue;
    }

    refs.push({
      file: relativePath,
      line: text.slice(0, match.index).split(/\r?\n/).length,
      snippet: tag.replace(/\s+/g, " ").trim(),
    });
  }

  for (const match of text.matchAll(MS_ICON_CSS_RULE_PATTERN)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    const selectorWithoutNotClauses = selector.replace(/:not\([^)]*\.ms-icon[^)]*\)/g, "");
    if (!selectorWithoutNotClauses.includes(".ms-icon")) {
      continue;
    }

    const body = match[2];
    const directFontSize = body.match(/\bfont-size\s*:\s*([^;]+);?/);
    if (!directFontSize || directFontSize[1].trim().startsWith("var(--gc-ms-icon-size")) {
      continue;
    }

    refs.push({
      file: relativePath,
      line: text.slice(0, match.index).split(/\r?\n/).length,
      snippet: `${selector} { font-size: ${directFontSize[1].trim()} }`,
    });
  }

  return refs;
}

function renderReport({
  officialNames,
  candidates,
  unknown,
  inlineSvgRefs,
  safelistNames,
  msIconSizeTokenViolations,
  mappedIconLiteralViolations = [],
  subsetAssetChecks,
}) {
  const officialCount = [...candidates.keys()].filter((name) => officialNames.has(name)).length;
  const allowedUnknownCount = unknown.filter((item) => item.allowed).length;
  const unapprovedUnknown = unknown.filter((item) => !item.allowed);
  const allowedInlineSvgRefs = inlineSvgRefs.filter((item) => item.allowedReason);
  const unapprovedInlineSvgRefs = inlineSvgRefs.filter((item) => !item.allowedReason);
  const literalSet = new Set([...candidates.keys()].filter((name) => officialNames.has(name)));
  const safelistOnly = [...safelistNames].filter((name) => !literalSet.has(name)).sort();
  const subsetSize = new Set([...literalSet, ...safelistNames]).size;

  const lines = [];
  lines.push("# Material Symbols Rounded Audit");
  lines.push("");
  lines.push(`Official codepoints: ${officialNames.size}`);
  lines.push(`Unique literal candidates: ${candidates.size}`);
  lines.push(`Official candidates: ${officialCount}`);
  lines.push(`Dynamic safelist entries: ${safelistNames.size}`);
  lines.push(`Safelist-only entries (not present as a literal): ${safelistOnly.length}`);
  lines.push(`Potential subset size (literals union safelist): ${subsetSize}`);
  const errorTotal =
    unapprovedUnknown.length +
    unapprovedInlineSvgRefs.length +
    msIconSizeTokenViolations.length +
    mappedIconLiteralViolations.length;
  lines.push(`- Errors: ${errorTotal}`);
  lines.push(`- Warnings: 0`);
  lines.push(`- Findings: ${errorTotal}`);
  lines.push(`Non-Material candidates: ${unknown.length}`);
  lines.push(`Allowed non-Material candidates: ${allowedUnknownCount}`);
  lines.push(`Unapproved non-Material candidates: ${unapprovedUnknown.length}`);
  lines.push(`Inline SVG references: ${inlineSvgRefs.length}`);
  lines.push(`Allowed inline SVG references: ${allowedInlineSvgRefs.length}`);
  lines.push(`Unapproved inline SVG references: ${unapprovedInlineSvgRefs.length}`);
  lines.push(`Material Symbols size-token violations: ${msIconSizeTokenViolations.length}`);
  lines.push(`Mapped icon-literal violations (hidden from subset): ${mappedIconLiteralViolations.length}`);
  if (subsetAssetChecks) {
    lines.push(`Subset font asset: ${subsetAssetChecks.assetLabel}`);
    lines.push(`Subset font bytes: ${subsetAssetChecks.fontSizeBytes ?? "missing"}`);
    lines.push(`Subset asset violations: ${subsetAssetChecks.violations.length}`);
  }

  if (unknown.length) {
    lines.push("");
    lines.push("| Name | Status | References |");
    lines.push("| --- | --- | --- |");
    for (const item of unknown) {
      const status = item.allowed ? "allowed exception" : "needs review";
      lines.push(`| \`${item.name}\` | ${status} | ${item.refs.join("<br>")} |`);
    }
  }

  if (inlineSvgRefs.length) {
    lines.push("");
    lines.push("| Inline SVG | Status | Reason |");
    lines.push("| --- | --- | --- |");
    for (const item of inlineSvgRefs) {
      const status = item.allowedReason ? "allowed exception" : "needs review";
      lines.push(
        `| \`${item.file}:${item.line}\` | ${status} | ${item.allowedReason || "replace with Material Symbols"} |`,
      );
    }
  }

  if (msIconSizeTokenViolations.length) {
    lines.push("");
    lines.push("| Material Symbols size-token violation | Class literal |");
    lines.push("| --- | --- |");
    for (const item of msIconSizeTokenViolations) {
      lines.push(`| \`${item.file}:${item.line}\` | \`${item.snippet}\` |`);
    }
  }

  if (mappedIconLiteralViolations.length) {
    lines.push("");
    lines.push("| Hidden icon map | Icon | Fix |");
    lines.push("| --- | --- | --- |");
    for (const item of mappedIconLiteralViolations) {
      lines.push(
        `| \`${item.file}:${item.line}\` (\`${item.constName}\`) | \`${item.name}\` | ` +
          `Inline \`${item.name}\` into the \`ms-icon\` span, or add it to the dynamic safelist |`,
      );
    }
  }

  if (subsetAssetChecks?.violations.length) {
    lines.push("");
    lines.push("| Subset asset violation | Detail |");
    lines.push("| --- | --- |");
    for (const violation of subsetAssetChecks.violations) {
      lines.push(`| ${violation.rule} | ${violation.detail} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function loadDynamicSafelist(officialNames) {
  if (!existsSync(DYNAMIC_SAFELIST_PATH)) {
    throw new Error(
      `Material Symbols dynamic safelist not found at ${path.relative(ROOT, DYNAMIC_SAFELIST_PATH)}. ` +
        `This file is the single source of truth for runtime-rendered icon names ` +
        `and is required for subset-coverage proofs.`,
    );
  }

  const text = await readFile(DYNAMIC_SAFELIST_PATH, "utf8");
  const names = new Set();

  for (const match of text.matchAll(/"([^"\n]+)"/g)) {
    const value = match[1];
    if (SAFELIST_NAME_PATTERN.test(value)) {
      names.add(value);
    }
  }

  const unknown = [...names].filter((name) => !officialNames.has(name)).sort();
  if (unknown.length) {
    throw new Error(
      `Material Symbols dynamic safelist contains names that are not in the official ` +
        `Material Symbols Rounded codepoints: ${unknown.join(", ")}. ` +
        `Remove or correct them in ${path.relative(ROOT, DYNAMIC_SAFELIST_PATH)}.`,
    );
  }

  return names;
}

function buildSubsetList(candidates, officialNames, safelistNames) {
  const subset = new Set([...[...candidates.keys()].filter((name) => officialNames.has(name)), ...safelistNames]);
  return [...subset].sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativeAssetPath(filePath) {
  return path.relative(ROOT, filePath).replaceAll(path.sep, "/");
}

async function readUtf8IfExists(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  return readFile(filePath, "utf8");
}

async function validateSubsetAsset(subset) {
  if (!SUBSET_FONT_PATH && !SUBSET_MANIFEST_PATH && !SUBSET_CSS_PATH && ROOT_DOCUMENT_PATHS.length === 0) {
    return null;
  }

  const violations = [];
  const inventoryText = `${subset.join("\n")}\n`;
  const expectedInventorySha256 = sha256(inventoryText);
  let fontBuffer = null;
  let manifest = null;

  if (!SUBSET_FONT_PATH) {
    violations.push({
      rule: "font path",
      detail: "`subsetFontPath` must be configured when subset asset checks are enabled.",
    });
  } else if (!existsSync(SUBSET_FONT_PATH)) {
    violations.push({
      rule: "font exists",
      detail: `Missing subset font at \`${relativeAssetPath(SUBSET_FONT_PATH)}\`.`,
    });
  } else {
    fontBuffer = await readFile(SUBSET_FONT_PATH);
    if (SUBSET_MAX_BYTES > 0 && fontBuffer.length > SUBSET_MAX_BYTES) {
      violations.push({
        rule: "font size",
        detail: `\`${relativeAssetPath(SUBSET_FONT_PATH)}\` is ${fontBuffer.length} bytes; max is ${SUBSET_MAX_BYTES}.`,
      });
    }
  }

  if (!SUBSET_MANIFEST_PATH) {
    violations.push({
      rule: "manifest path",
      detail: "`subsetManifestPath` must be configured when subset asset checks are enabled.",
    });
  } else if (!existsSync(SUBSET_MANIFEST_PATH)) {
    violations.push({
      rule: "manifest exists",
      detail: `Missing subset manifest at \`${relativeAssetPath(SUBSET_MANIFEST_PATH)}\`.`,
    });
  } else {
    try {
      manifest = JSON.parse(await readFile(SUBSET_MANIFEST_PATH, "utf8"));
    } catch (error) {
      violations.push({
        rule: "manifest JSON",
        detail: `Unable to parse \`${relativeAssetPath(SUBSET_MANIFEST_PATH)}\`: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      });
    }
  }

  if (manifest) {
    if (manifest.schemaVersion !== 1) {
      violations.push({
        rule: "manifest schema",
        detail: `Expected schemaVersion 1, got \`${String(manifest.schemaVersion)}\`.`,
      });
    }
    if (manifest.iconCount !== subset.length) {
      violations.push({
        rule: "icon count",
        detail: `Manifest has ${String(manifest.iconCount)} icons; current audit inventory has ${subset.length}.`,
      });
    }
    if (manifest.inventorySha256 !== expectedInventorySha256) {
      violations.push({
        rule: "icon inventory hash",
        detail:
          `Manifest inventorySha256 is \`${String(manifest.inventorySha256)}\`; ` +
          `current audited inventory is \`${expectedInventorySha256}\`. Regenerate the subset font and manifest.`,
      });
    }
    if (fontBuffer && manifest.fontSha256 !== sha256(fontBuffer)) {
      violations.push({
        rule: "font hash",
        detail:
          `Manifest fontSha256 is \`${String(manifest.fontSha256)}\`; ` +
          `actual font hash is \`${sha256(fontBuffer)}\`.`,
      });
    }
    if (fontBuffer && manifest.fontSizeBytes !== fontBuffer.length) {
      violations.push({
        rule: "font byte count",
        detail: `Manifest fontSizeBytes is ${String(manifest.fontSizeBytes)}; actual size is ${fontBuffer.length}.`,
      });
    }
    if (SUBSET_FONT_PATH && manifest.fontPath !== relativeAssetPath(SUBSET_FONT_PATH)) {
      violations.push({
        rule: "font manifest path",
        detail: `Manifest fontPath is \`${String(manifest.fontPath)}\`; expected \`${relativeAssetPath(SUBSET_FONT_PATH)}\`.`,
      });
    }
    if (manifest.sourceCodepointsUrl !== CODEPOINTS_URL) {
      violations.push({
        rule: "codepoints source",
        detail: `Manifest sourceCodepointsUrl does not match the audit source \`${CODEPOINTS_URL}\`.`,
      });
    }
    if (SUBSET_SOURCE_FONT_URL && manifest.sourceFontUrl !== SUBSET_SOURCE_FONT_URL) {
      violations.push({
        rule: "font source",
        detail: `Manifest sourceFontUrl does not match the configured source \`${SUBSET_SOURCE_FONT_URL}\`.`,
      });
    }
  }

  if (SUBSET_CSS_PATH) {
    const cssText = await readUtf8IfExists(SUBSET_CSS_PATH);
    const fontUrl = SUBSET_FONT_PATH ? `/${relativeAssetPath(SUBSET_FONT_PATH).replace(/^public\//, "")}` : "";
    if (cssText === null) {
      violations.push({
        rule: "CSS font-face",
        detail: `Missing CSS file at \`${relativeAssetPath(SUBSET_CSS_PATH)}\`.`,
      });
    } else if (!cssText.includes(fontUrl)) {
      violations.push({
        rule: "CSS font-face",
        detail: `\`${relativeAssetPath(SUBSET_CSS_PATH)}\` does not reference \`${fontUrl}\`.`,
      });
    }
    if (cssText && MATERIAL_SYMBOLS_GOOGLE_STYLESHEET_PATTERN.test(cssText)) {
      violations.push({
        rule: "Google stylesheet",
        detail: `\`${relativeAssetPath(SUBSET_CSS_PATH)}\` still references Google-hosted Material Symbols.`,
      });
    }
  }

  for (const documentPath of ROOT_DOCUMENT_PATHS) {
    const documentText = await readUtf8IfExists(documentPath);
    if (documentText && MATERIAL_SYMBOLS_GOOGLE_STYLESHEET_PATTERN.test(documentText)) {
      violations.push({
        rule: "Google stylesheet",
        detail: `\`${relativeAssetPath(documentPath)}\` still loads Google-hosted Material Symbols.`,
      });
    }
  }

  return {
    assetLabel: SUBSET_FONT_PATH ? relativeAssetPath(SUBSET_FONT_PATH) : "(not configured)",
    fontSizeBytes: fontBuffer?.length ?? null,
    inventorySha256: expectedInventorySha256,
    violations,
  };
}

export async function runMaterialSymbolsAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  CODEPOINTS_URL = options.codepointsUrl ?? DEFAULT_CODEPOINTS_URL;
  CACHE_PATH = path.resolve(ROOT, options.cachePath ?? DEFAULT_CACHE_PATH);
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];
  SCAN_EXTENSIONS = new Set(options.extensions ?? DEFAULT_SCAN_EXTENSIONS);
  SKIP_SEGMENTS = new Set(options.skipSegments ?? DEFAULT_SKIP_SEGMENTS);
  SKIP_FILE_PATTERNS = (options.skipFilePatterns ?? DEFAULT_SKIP_FILE_PATTERNS).map((pattern) => new RegExp(pattern));
  DYNAMIC_SAFELIST_PATH = path.resolve(ROOT, options.dynamicSafelistPath ?? DEFAULT_DYNAMIC_SAFELIST_PATH);
  SUBSET_FONT_PATH = options.subsetFontPath ? path.resolve(ROOT, options.subsetFontPath) : "";
  SUBSET_MANIFEST_PATH = options.subsetManifestPath ? path.resolve(ROOT, options.subsetManifestPath) : "";
  SUBSET_CSS_PATH = options.subsetCssPath ? path.resolve(ROOT, options.subsetCssPath) : "";
  SUBSET_MAX_BYTES =
    typeof options.subsetMaxBytes === "number" && Number.isFinite(options.subsetMaxBytes)
      ? Math.max(0, Math.floor(options.subsetMaxBytes))
      : 0;
  SUBSET_SOURCE_FONT_URL = typeof options.subsetSourceFontUrl === "string" ? options.subsetSourceFontUrl.trim() : "";
  ROOT_DOCUMENT_PATHS = (options.rootDocumentPaths ?? []).map((documentPath) => path.resolve(ROOT, documentPath));
  ALLOWED_NON_MATERIAL_KEYS = new Set(options.allowedNonMaterialKeys ?? []);
  INLINE_SVG_EXCEPTIONS = new Map(Object.entries(options.inlineSvgExceptions ?? {}));
  ALLOWED_MAPPED_ICON_CONSTS = new Set(options.allowedMappedIconConsts ?? []);

  const officialNames = parseCodepoints(await loadCodepoints());
  const safelistNames = await loadDynamicSafelist(officialNames);
  const candidates = new Map();
  const inlineSvgRefs = [];
  const msIconSizeTokenViolations = [];
  const mappedIconLiteralCandidates = [];
  const files = await collectFiles();

  for (const file of files) {
    const text = await readFile(file, "utf8");
    extractCandidates(text, file, candidates, officialNames);
    inlineSvgRefs.push(...collectInlineSvgReferences(text, file));
    msIconSizeTokenViolations.push(...collectMsIconSizeTokenViolations(text, file));
    mappedIconLiteralCandidates.push(...collectMappedIconLiteralCandidates(text, file, officialNames));
  }

  const unknown = [...candidates.entries()]
    .filter(([name]) => !officialNames.has(name))
    .map(([name, refs]) => ({
      name,
      refs: [...refs].slice(0, 8),
      allowed: ALLOWED_NON_MATERIAL_KEYS.has(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const subset = buildSubsetList(candidates, officialNames, safelistNames);
  // A mapped icon literal is only a real problem when its glyph is reachable no
  // other way — i.e. it is absent from the computed subset. Icon-name maps whose
  // names are also inlined elsewhere (or safelisted) are already covered, so
  // filtering by subset membership turns a noisy stylistic flag into a precise
  // "this glyph will render as ligature text" signal.
  const subsetSet = new Set(subset);
  const mappedIconLiteralViolations = mappedIconLiteralCandidates.filter((item) => !subsetSet.has(item.name));
  const subsetAssetChecks = await validateSubsetAsset(subset);

  const failed =
    unknown.some((item) => !item.allowed) ||
    inlineSvgRefs.some((item) => !item.allowedReason) ||
    msIconSizeTokenViolations.length > 0 ||
    mappedIconLiteralViolations.length > 0 ||
    Boolean(subsetAssetChecks?.violations.length);

  return {
    failed,
    subset,
    jsonPayload: {
      officialCount: officialNames.size,
      uniqueLiteralCandidates: candidates.size,
      subset,
      unapprovedUnknown: unknown.filter((item) => !item.allowed),
      unapprovedInlineSvgRefs: inlineSvgRefs.filter((item) => !item.allowedReason),
      safelistNames: [...safelistNames].sort(),
      msIconSizeTokenViolations,
      mappedIconLiteralViolations,
      subsetAssetChecks,
    },
    report: renderReport({
      officialNames,
      candidates,
      unknown,
      inlineSvgRefs,
      safelistNames,
      msIconSizeTokenViolations,
      mappedIconLiteralViolations,
      subsetAssetChecks,
    }),
  };
}

async function main() {
  const result = await runMaterialSymbolsAudit();
  if (hasFlag("--icon-names")) {
    console.log(result.subset.join(","));
    return;
  }

  console.log(result.report.trimEnd());

  if (hasFlag("--fail-on-drift") && result.failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
