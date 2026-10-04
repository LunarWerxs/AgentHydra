import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "@saydeploy/architect/core/files";

const COLOR_PROPS = new Set([
  "accent-color",
  "background",
  "background-color",
  "border",
  "border-block",
  "border-block-color",
  "border-block-end",
  "border-block-end-color",
  "border-block-start",
  "border-block-start-color",
  "border-bottom",
  "border-bottom-color",
  "border-color",
  "border-inline",
  "border-inline-color",
  "border-inline-end",
  "border-inline-end-color",
  "border-inline-start",
  "border-inline-start-color",
  "border-left",
  "border-left-color",
  "border-right",
  "border-right-color",
  "border-top",
  "border-top-color",
  "box-shadow",
  "caret-color",
  "color",
  "column-rule",
  "column-rule-color",
  "decoration-color",
  "fill",
  "outline",
  "outline-color",
  "scrollbar-color",
  "stop-color",
  "stroke",
  "text-decoration-color",
  "text-shadow",
]);

const CSS_NAMED_COLORS = new Set([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
]);

const SAFE_COLOR_KEYWORDS = new Set([
  "currentcolor",
  "currentColor",
  "inherit",
  "initial",
  "none",
  "transparent",
  "unset",
]);
const TAILWIND_COLOR_PREFIXES = [
  "accent",
  "bg",
  "border",
  "caret",
  "decoration",
  "divide",
  "fill",
  "from",
  "outline",
  "placeholder",
  "ring",
  "stroke",
  "text",
  "to",
  "via",
];
const TAILWIND_COLOR_NAMES = [
  "amber",
  "black",
  "blue",
  "cyan",
  "emerald",
  "fuchsia",
  "gray",
  "green",
  "indigo",
  "lime",
  "neutral",
  "orange",
  "pink",
  "purple",
  "red",
  "rose",
  "sky",
  "slate",
  "stone",
  "teal",
  "violet",
  "white",
  "yellow",
  "zinc",
];

const RULES = {
  "raw-css-color-literal": {
    severity: "warn",
    description: "CSS color-bearing declarations should use semantic tokens instead of raw hex/rgb/hsl literals.",
  },
  "raw-css-named-color": {
    severity: "warn",
    description: "CSS color-bearing declarations should avoid named colors except currentColor/transparent/inherit.",
  },
  "raw-tailwind-color-utility": {
    severity: "warn",
    description:
      "Vue class strings should use semantic token utilities or shared primitive props instead of raw Tailwind color utilities.",
  },
  "deprecated-surface-tint-usage": {
    severity: "warn",
    description:
      "M3 deprecates surface-tint color in favor of elevation-level tokens; consumers outside the token layer should reference --md-sys-elevation-level0..5 instead of --md-sys-color-surface-tint.",
  },
};

const COLOR_LITERAL_PATTERN =
  /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*[^)]+\)|hsla?\(\s*[^)]+\)|oklch\(\s*[^)]+\)|lab\(\s*[^)]+\)|lch\(\s*[^)]+\)|color\(\s*[^)]+\)/g;
const NAMED_COLOR_PATTERN = /\b[a-zA-Z]+\b/g;
const DECLARATION_PATTERN = /([-\w]+)\s*:\s*([^;{}]+);?/g;
const STYLE_BLOCK_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const TEMPLATE_BLOCK_PATTERN = /<template\b[^>]*>([\s\S]*?)<\/template>/gi;
const CLASS_ATTR_PATTERN = /(?:^|\s)(?:class|:class|v-bind:class)\s*=\s*(["'`])([\s\S]*?)\1/g;

export const audit = {
  id: "design-tokens",
  title: "Design Tokens",
  category: "design-system",
  defaultConfig: {
    roots: ["src"],
    extensions: [".css", ".vue", ".ts", ".tsx"],
    tokenOwnerFiles: [],
  },
  async run(context) {
    const checkConfig = context.checkConfig;
    const tokenOwnerFiles = new Set(checkConfig.tokenOwnerFiles ?? []);
    const files = await Promise.all(
      (
        await walkFiles({
          root: context.root,
          roots: checkConfig.roots,
          extensions: checkConfig.extensions,
          skipSegments: checkConfig.skipSegments,
        })
      ).map(async (filePath) => ({
        rel: filePath,
        source: await fs.readFile(path.resolve(context.root, filePath), "utf8"),
      })),
    );
    const findings = [];

    for (const file of files) {
      if (isPublicDemoOrDevFile(file.rel)) continue;
      auditCssColorDeclarations(findings, file.rel, file.source, tokenOwnerFiles);
      auditTailwindColorUtilities(findings, file.rel, file.source);
      auditDeprecatedSurfaceTint(findings, file.rel, file.source, tokenOwnerFiles);
    }

    findings.sort(
      (a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath) || a.line - b.line,
    );
    const counts = countFindingsByRuleAndFile(findings);
    const regressions = findRegressions(counts, context.baseline);
    const baselineDocument = buildBaselineDocument(counts);
    const report = renderReport({
      findings,
      counts,
      regressions,
      format: context.options.format,
    });

    return {
      baselineDocument,
      failed: regressions.length > 0,
      jsonPayload: { findings, rules: RULES, regressions },
      outputPath: checkConfig.outputPath,
      report,
    };
  },
};

function lineNumberAt(source, index) {
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

function addFinding(findings, ruleId, filePath, line, message, snippet = "") {
  findings.push({
    ruleId,
    severity: RULES[ruleId].severity,
    filePath,
    line,
    message,
    snippet: cleanSnippet(snippet),
  });
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));
}

function cssSourcesForFile(rel, source) {
  if (rel.endsWith(".css")) {
    return [{ css: source, offset: 0 }];
  }

  if (!rel.endsWith(".vue")) {
    return [];
  }

  const blocks = [];
  for (const match of source.matchAll(STYLE_BLOCK_PATTERN)) {
    blocks.push({
      css: match[1],
      offset: (match.index ?? 0) + match[0].indexOf(match[1]),
    });
  }
  return blocks;
}

function shouldSkipCssDeclaration(rel, prop, value, tokenOwnerFiles) {
  const trimmed = value.trim();
  if (tokenOwnerFiles.has(rel)) {
    return true;
  }

  // Public/demo CSS and dev-only pages use intentional brand colors
  // outside the design token system.
  if (isPublicDemoOrDevFile(rel)) {
    return true;
  }

  if (/var\(\s*--/.test(trimmed)) {
    return true;
  }

  if (/url\(|image-set\(|linear-gradient\(|radial-gradient\(|conic-gradient\(/i.test(trimmed)) {
    return true;
  }

  return !COLOR_PROPS.has(prop);
}

const PUBLIC_DEMO_DEV_PATTERN = /^(?:src\/styles\/routes\/public\/|src\/components\/dev\/|src\/components\/public\/|src\/__tests__\/|src\/app\/app-config\.ts$)/;

function isPublicDemoOrDevFile(rel) {
  return PUBLIC_DEMO_DEV_PATTERN.test(rel);
}

function auditCssColorDeclarations(findings, rel, source, tokenOwnerFiles) {
  for (const block of cssSourcesForFile(rel, source)) {
    const css = stripCssComments(block.css);
    for (const match of css.matchAll(DECLARATION_PATTERN)) {
      const prop = match[1].trim().toLowerCase();
      const value = match[2].trim();
      const declaration = `${prop}: ${value}`;
      const index = block.offset + (match.index ?? 0);

      if (shouldSkipCssDeclaration(rel, prop, value, tokenOwnerFiles)) {
        continue;
      }

      const literalMatches = [...value.matchAll(COLOR_LITERAL_PATTERN)];
      for (const literalMatch of literalMatches) {
        addFinding(
          findings,
          "raw-css-color-literal",
          rel,
          lineNumberAt(source, index + (literalMatch.index ?? 0)),
          `${prop} uses raw color literal ${literalMatch[0]}; prefer a semantic token.`,
          declaration,
        );
      }

      if (literalMatches.length > 0) {
        continue;
      }

      for (const wordMatch of value.matchAll(NAMED_COLOR_PATTERN)) {
        const word = wordMatch[0];
        const lowerWord = word.toLowerCase();
        if (SAFE_COLOR_KEYWORDS.has(word) || SAFE_COLOR_KEYWORDS.has(lowerWord) || !CSS_NAMED_COLORS.has(lowerWord)) {
          continue;
        }

        addFinding(
          findings,
          "raw-css-named-color",
          rel,
          lineNumberAt(source, index + (wordMatch.index ?? 0)),
          `${prop} uses named color ${word}; prefer a semantic token.`,
          declaration,
        );
      }
    }
  }
}

function splitClassTokens(value) {
  return value
    .replace(/[{}[\](),]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function stripTailwindVariant(token) {
  let cursor = token.length - 1;
  while (cursor >= 0) {
    const colon = token.lastIndexOf(":", cursor);
    if (colon === -1) {
      return token;
    }

    const before = token.slice(0, colon);
    const openBrackets = (before.match(/\[/g) ?? []).length;
    const closeBrackets = (before.match(/\]/g) ?? []).length;
    if (openBrackets === closeBrackets) {
      return token.slice(colon + 1);
    }

    cursor = colon - 1;
  }

  return token;
}

function isRawTailwindColorUtility(token) {
  const bare = stripTailwindVariant(token).replace(/^!/, "");
  const prefixPattern = `(?:${TAILWIND_COLOR_PREFIXES.join("|")})`;
  const colorPattern = `(?:${TAILWIND_COLOR_NAMES.join("|")})`;

  if (new RegExp(`^${prefixPattern}-\\[#?[0-9a-fA-F]{3,8}\\](?:\\/\\d{1,3})?$`).test(bare)) {
    return true;
  }

  return new RegExp(`^${prefixPattern}-(?:${colorPattern})(?:-\\d{2,3})?(?:\\/\\d{1,3})?$`).test(bare);
}

function shouldSkipTailwindToken(token) {
  const bare = stripTailwindVariant(token).replace(/^!/, "");
  if (/^(?:bg|text|border|stroke|fill|ring|outline|decoration|divide|from|via|to)-\(--/.test(bare)) {
    return true;
  }

  return /^(?:bg|text|border|stroke|fill|ring|outline|decoration|divide|from|via|to)-(?:current|transparent|inherit|none)$/.test(
    bare,
  );
}

function scanStringLiterals(source) {
  const literals = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }

    if (char !== '"' && char !== "'" && char !== "`") {
      index += 1;
      continue;
    }

    const quote = char;
    const start = index;
    index += 1;
    let text = "";

    while (index < source.length) {
      const current = source[index];
      if (current === "\\") {
        text += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (current === quote) {
        literals.push({ index: start + 1, text });
        index += 1;
        break;
      }
      text += current;
      index += 1;
    }
  }

  return literals;
}

function auditTailwindColorUtilities(findings, rel, source) {
  // Only scan Vue SFCs and CSS files for Tailwind color utilities.
  // Plain .ts/.tsx files are data/business logic — string constants like
  // "bg-blue-500" there are data model defaults, not CSS authoring decisions.
  if (!rel.endsWith(".vue") && !rel.endsWith(".css")) {
    return;
  }

  if (/\.(?:spec|test)\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) {
    return;
  }

  // Guided camera capture renders fixed white framing + black scrim directly over
  // a live <video> feed. These are viewfinder-universal, theme-independent colors
  // (a themed token over uncontrolled camera pixels would be wrong), so the raw
  // white/scrim utilities here are correct by construction — not design drift.
  if (rel.endsWith("WorkspaceGuidedCameraCapture.vue")) {
    return;
  }

  const ranges = [];
  if (rel.endsWith(".vue")) {
    for (const match of source.matchAll(TEMPLATE_BLOCK_PATTERN)) {
      ranges.push({
        text: match[1],
        offset: (match.index ?? 0) + match[0].indexOf(match[1]),
      });
    }
  } else {
    ranges.push({ text: source, offset: 0 });
  }

  for (const range of ranges) {
    const classMatches = rel.endsWith(".vue")
      ? [...range.text.matchAll(CLASS_ATTR_PATTERN)].map((match) => ({
          text: match[2],
          index: range.offset + (match.index ?? 0) + match[0].indexOf(match[2]),
        }))
      : scanStringLiterals(range.text).map((match) => ({
          text: match.text,
          index: range.offset + match.index,
        }));
    for (const match of classMatches) {
      const classValue = match.text;
      const classOffset = match.index;
      const tokens = splitClassTokens(classValue);
      for (const token of tokens) {
        if (shouldSkipTailwindToken(token) || !isRawTailwindColorUtility(token)) {
          continue;
        }

        addFinding(
          findings,
          "raw-tailwind-color-utility",
          rel,
          lineNumberAt(source, classOffset + Math.max(classValue.indexOf(token), 0)),
          `Class token ${token} uses a raw Tailwind color utility; prefer semantic token utilities or primitive props.`,
          token,
        );
      }
    }
  }
}

// Per M3 (docs/m3/styles/elevation): surface-tint color was the M2-style way
// to express elevation and is explicitly deprecated. Consumers should reference
// the elevation-level shadow tokens instead. We allow the token file itself to
// keep declaring the legacy variable for back-compat shims, but flag every
// downstream call site so the deprecation can be paid down.
const SURFACE_TINT_TOKEN_PATTERN = /var\(\s*--md-sys-color-surface-tint\b[^)]*\)/g;
const SURFACE_TINT_TAILWIND_PATTERN =
  /(?<![\w-])(?:[\w-]+:)*(?:bg|text|border|fill|stroke|ring|outline|decoration|from|via|to)-surface-tint(?:-[\w-]+)?(?:\/\d{1,3})?\b/g;

function auditDeprecatedSurfaceTint(findings, rel, source, tokenOwnerFiles) {
  if (tokenOwnerFiles.has(rel)) {
    return;
  }
  if (/src\/styles\/core\/tokens\.css$/.test(rel)) {
    return;
  }

  SURFACE_TINT_TOKEN_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(SURFACE_TINT_TOKEN_PATTERN)) {
    addFinding(
      findings,
      "deprecated-surface-tint-usage",
      rel,
      lineNumberAt(source, match.index ?? 0),
      "var(--md-sys-color-surface-tint) is deprecated by M3; reference --md-sys-elevation-level0..5 (or --gc-elevation-*) for depth, or a semantic surface color for fills.",
      match[0],
    );
  }

  SURFACE_TINT_TAILWIND_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(SURFACE_TINT_TAILWIND_PATTERN)) {
    addFinding(
      findings,
      "deprecated-surface-tint-usage",
      rel,
      lineNumberAt(source, match.index ?? 0),
      `${match[0]} references the deprecated surface-tint role; pair an elevation token with a semantic surface color instead.`,
      match[0],
    );
  }
}

function countFindingsByRuleAndFile(findings) {
  const counts = Object.fromEntries(Object.keys(RULES).map((ruleId) => [ruleId, {}]));
  for (const finding of findings) {
    counts[finding.ruleId][finding.filePath] = (counts[finding.ruleId][finding.filePath] ?? 0) + 1;
  }
  return counts;
}

function buildBaselineDocument(counts) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rules: Object.fromEntries(
      Object.entries(RULES).map(([ruleId, definition]) => [
        ruleId,
        {
          ...definition,
          files: counts[ruleId] ?? {},
        },
      ]),
    ),
  };
}

function findRegressions(currentCounts, baseline) {
  if (!baseline?.rules) {
    return [];
  }

  const regressions = [];
  for (const [ruleId, definition] of Object.entries(RULES)) {
    const baselineFiles = baseline.rules?.[ruleId]?.files ?? {};
    const currentFiles = currentCounts[ruleId] ?? {};

    for (const [filePath, currentCount] of Object.entries(currentFiles)) {
      const baselineCount = baselineFiles[filePath] ?? 0;
      if (currentCount <= baselineCount) {
        continue;
      }

      regressions.push({
        ruleId,
        filePath,
        baselineCount,
        currentCount,
        severity: definition.severity,
      });
    }
  }
  return regressions;
}

function renderCounts(counts) {
  const lines = [];
  for (const [ruleId, definition] of Object.entries(RULES)) {
    const fileCounts = counts[ruleId] ?? {};
    const total = Object.values(fileCounts).reduce((sum, count) => sum + count, 0);
    lines.push(`${ruleId} [${definition.severity}] total=${total} files=${Object.keys(fileCounts).length}`);
    for (const [filePath, count] of Object.entries(fileCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${filePath}: ${count}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(findings, regressions = []) {
  const counts = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});

  const lines = [
    "# Design Token Color Audit",
    "",
    `- Total findings: ${findings.length}`,
    `- Errors: ${counts.error ?? 0}`,
    `- Warnings: ${counts.warn ?? 0}`,
    `- Regressions: ${regressions.length}`,
    "",
  ];

  if (regressions.length) {
    lines.push("## Regressions", "");
    for (const regression of regressions) {
      lines.push(
        `- ${regression.severity.toUpperCase()}: \`${regression.ruleId}\` - ${regression.filePath} (${regression.baselineCount} -> ${regression.currentCount})`,
      );
    }
    lines.push("");
  }

  if (!findings.length) {
    lines.push("No design token color drift found.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Findings", "");
  for (const finding of findings) {
    const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
    lines.push(`- ${finding.severity.toUpperCase()}: \`${finding.ruleId}\` - ${location} - ${finding.message}`);
    if (finding.snippet) {
      lines.push(`  - ${finding.snippet}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderReport({ findings, counts, regressions, format }) {
  if (format === "counts") {
    return renderCounts(counts);
  }
  return renderMarkdown(findings, regressions);
}
