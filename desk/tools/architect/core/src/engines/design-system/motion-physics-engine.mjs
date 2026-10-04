import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { iterateInlineStyles, parseInlineDeclarations } from "@saydeploy/architect/core/inline-styles";
import {
  LEGACY_SHARED_COMPONENTS_ROOT,
  UI_PACKAGE_COMPONENTS_ROOT,
  UI_PACKAGE_ROOT,
} from "@saydeploy/architect/core/primitive-locations";

let ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set([".css", ".ts", ".tsx", ".vue"]);
const DEFAULT_SCAN_ROOTS = Object.freeze([
  "src/styles",
  LEGACY_SHARED_COMPONENTS_ROOT,
  UI_PACKAGE_ROOT,
]);
const DEFAULT_TOKEN_FILE = "src/styles/core/tokens.css";
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];
const SKIP_SEGMENTS = new Set([".git", "coverage", "dist", "node_modules", "tmp"]);
let TOKEN_FILE = DEFAULT_TOKEN_FILE;

const RULES = {
  "missing-motion-duration-token": {
    severity: "error",
    description: "Referenced Material motion duration tokens must be declared in the central token file.",
  },
  "spring-like-bezier-outside-token-layer": {
    severity: "warning",
    description: "Overshooting cubic-bezier curves should be named tokens, not component-local literals.",
  },
  "effects-token-overshoot": {
    severity: "error",
    description: "Effects motion tokens must not overshoot.",
  },
  "expressive-motion-channel-collapse": {
    severity: "error",
    description: "Expressive spatial and effects fallback tokens must stay distinct.",
  },
  "raw-transition-time-literal": {
    severity: "warning",
    description: "Raw transition time literals should move to semantic motion tokens or approved utilities.",
  },
  "shared-primitive-tailwind-motion-utility": {
    severity: "warning",
    description: "Production shared primitives should not introduce raw Tailwind motion utilities.",
  },
  "animated-swap-raw-motion-props": {
    severity: "warning",
    description: "AppAnimatedSwapText still exposes raw duration/easing props instead of semantic motion props.",
  },
  "spring-runtime-missing": {
    severity: "warning",
    description: "The M3 Expressive motion plan calls for a first-party spring runtime.",
  },
  "inline-style-motion": {
    severity: "warning",
    description: "Inline style attributes should not declare transition or animation timing.",
  },
  "raw-keyframes-duration-literal": {
    severity: "warning",
    description: "Hardcoded ms durations in @keyframes / animation: shorthand should use named motion duration tokens.",
  },
  "expressive-motion-duration-collapse": {
    severity: "error",
    description: "Expressive spatial and effects fallback durations must stay distinct.",
  },
  "shared-surface-spring-transition-mix": {
    severity: "error",
    description:
      "Shared surface primitives must not mix useSpring-driven motion with sheet/detail-dock/overlay CSS transition ownership.",
  },
  "transition-all-shorthand": {
    severity: "warning",
    description:
      "`transition: all` ignores M3 channel discipline (spatial vs effects). List the properties you intend to animate.",
  },
  "infinite-animation-missing-reduced-motion-guard": {
    severity: "warning",
    description:
      "Files declaring infinite animations must also declare a @media (prefers-reduced-motion: reduce) override.",
  },
  "effects-property-spatial-easing": {
    severity: "warning",
    description:
      "Effects properties (opacity, color, fill, box-shadow, etc.) should not pair with a *-spatial easing token. M3 spatial channels overshoot; effects channels must not.",
  },
  "raw-cubic-bezier-in-motion-declaration": {
    severity: "warning",
    description:
      "Raw cubic-bezier literals in transition/animation declarations should be replaced with a named motion easing token (or moved into a var(--token, cubic-bezier(...)) fallback).",
  },
  "reduced-motion-token-outside-reduced-motion-block": {
    severity: "warning",
    description:
      "--gc-motion-duration-reduced must only be referenced inside @media (prefers-reduced-motion: reduce) blocks; using it elsewhere suppresses motion unconditionally.",
  },
};

const EFFECTS_PROPERTIES = new Set([
  "opacity",
  "color",
  "fill",
  "stroke",
  "background",
  "background-color",
  "border-color",
  "outline-color",
  "box-shadow",
  "filter",
  "backdrop-filter",
  "visibility",
]);

const TOKEN_LAYER_PATHS = new Set(["src/styles/core/transitions.css"]);

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function relativePath(filePath) {
  return normalizePath(path.relative(ROOT, filePath));
}

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

async function walkPath(fullPath) {
  if (!existsSync(fullPath)) {
    return [];
  }

  const info = await stat(fullPath);
  if (info.isFile()) {
    return SOURCE_EXTENSIONS.has(path.extname(fullPath)) ? [fullPath] : [];
  }

  const entries = await readdir(fullPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry.name)) {
      continue;
    }

    const childPath = path.join(fullPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkPath(childPath)));
      continue;
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(childPath);
    }
  }

  return files;
}

async function collectFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    files.push(...(await walkPath(path.join(ROOT, root))));
  }

  return Array.from(new Set(files)).sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
}

function parseCustomPropertyDefinitions(source) {
  return new Set([...source.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1]));
}

function parseCustomPropertyValues(source) {
  return new Map(
    [...source.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      cleanSnippet(match[2]),
    ]),
  );
}

// Resolve a var(...) chain to its eventual literal value (or null if it dead-ends
// in a missing token). Visited tracks cycle protection. Used for both duration
// and easing parity checks so aliased tokens don't hide drift.
function resolveTokenChain(tokenName, tokenValues, visited = new Set()) {
  if (visited.has(tokenName)) {
    return null;
  }
  visited.add(tokenName);

  const value = tokenValues.get(tokenName);
  if (!value) {
    return null;
  }

  const varMatch = value.match(/^\s*var\(\s*(--[A-Za-z0-9_-]+)/);
  if (varMatch) {
    return resolveTokenChain(varMatch[1], tokenValues, visited);
  }

  return value;
}

function parseCubicBezier(value) {
  const match = value.match(
    /cubic-bezier\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*\)/,
  );
  if (!match) {
    return null;
  }

  return {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  };
}

function isOvershootingBezier(bezier) {
  return bezier ? bezier.y1 < 0 || bezier.y1 > 1 || bezier.y2 < 0 || bezier.y2 > 1 : false;
}

// The global `@media (prefers-reduced-motion: reduce)` reset MUST hardcode a
// near-zero duration (the canonical 0.01ms) — routing it through a motion token
// would defeat the accessibility kill-switch. Any timing literal inside such a
// block is therefore correct by construction, never drift.
function isInsideReducedMotionBlock(source, matchIndex) {
  const blockPattern = /@media[^{]*prefers-reduced-motion\s*:\s*reduce[^{]*\{/g;
  let match;
  while ((match = blockPattern.exec(source)) !== null) {
    if (match.index > matchIndex) break;
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    if (matchIndex >= match.index && matchIndex < i) return true;
  }
  return false;
}

function shouldSkipRawTransitionLiteral(relPath, source, matchIndex) {
  if (relPath === TOKEN_FILE || relPath === "src/styles/core/transitions.css") {
    return true;
  }

  // Public/demo CSS files use intentionally custom animation timing for
  // marketing and branding. These are not part of the product design system.
  if (isPublicDemoCss(relPath)) {
    return true;
  }

  if (isInsideReducedMotionBlock(source, matchIndex)) {
    return true;
  }

  const before = source.slice(Math.max(0, matchIndex - 120), matchIndex);
  return /audit-motion-ignore:\s*raw-transition/.test(before);
}

const PUBLIC_DEMO_CSS_PATTERN = /^src\/styles\/routes\/public\//;

function isPublicDemoCss(relPath) {
  return PUBLIC_DEMO_CSS_PATTERN.test(relPath);
}

function shouldSkipTailwindMotionUtility(relPath) {
  return /\.spec\.[cm]?[tj]sx?$|\.test\.[cm]?[tj]sx?$/.test(relPath);
}

function auditMissingDurationTokens(findings, files, tokenSource) {
  const definitions = parseCustomPropertyDefinitions(tokenSource);
  const referencePattern = /var\(\s*(--md-sys-motion-duration-[A-Za-z0-9_-]+)/g;
  const missing = new Map();

  for (const { rel, source } of files) {
    referencePattern.lastIndex = 0;
    for (const match of source.matchAll(referencePattern)) {
      const token = match[1];
      if (definitions.has(token)) {
        continue;
      }

      const key = `${rel}:${token}:${lineNumberAt(source, match.index ?? 0)}`;
      if (!missing.has(key)) {
        missing.set(key, { rel, token, index: match.index ?? 0 });
      }
    }
  }

  for (const { rel, token, index } of missing.values()) {
    const source = files.find((file) => file.rel === rel)?.source ?? "";
    addFinding(
      findings,
      "missing-motion-duration-token",
      rel,
      lineNumberAt(source, index),
      `Referenced duration token ${token} is not declared in ${TOKEN_FILE}.`,
      token,
    );
  }
}

function auditBezierOvershoot(findings, files) {
  const cubicPattern = /cubic-bezier\([^)]+\)/g;
  const tokenDeclarationPattern = /(--[A-Za-z0-9_-]+)\s*:\s*(cubic-bezier\([^)]+\))/g;

  for (const { rel, source } of files) {
    tokenDeclarationPattern.lastIndex = 0;
    for (const match of source.matchAll(tokenDeclarationPattern)) {
      const tokenName = match[1];
      const bezier = parseCubicBezier(match[2]);
      if (/effects/i.test(tokenName) && isOvershootingBezier(bezier)) {
        addFinding(
          findings,
          "effects-token-overshoot",
          rel,
          lineNumberAt(source, match.index ?? 0),
          `Effects token ${tokenName} uses an overshooting curve.`,
          match[0],
        );
      }
    }

    cubicPattern.lastIndex = 0;
    for (const match of source.matchAll(cubicPattern)) {
      const bezier = parseCubicBezier(match[0]);
      if (!isOvershootingBezier(bezier)) {
        continue;
      }

      if (rel === TOKEN_FILE) {
        continue;
      }

      addFinding(
        findings,
        "spring-like-bezier-outside-token-layer",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Spring-like bezier literals should be promoted to named motion tokens.",
        match[0],
      );
    }
  }
}

function auditRawTransitionTimes(findings, files) {
  const transitionPattern = /\btransition(?:-[a-z-]+)?\s*:\s*[^;{}]*(?:\b\d+(?:\.\d+)?m?s\b)[^;{}]*;/g;

  for (const { rel, source } of files) {
    transitionPattern.lastIndex = 0;
    for (const match of source.matchAll(transitionPattern)) {
      if (shouldSkipRawTransitionLiteral(rel, source, match.index ?? 0)) {
        continue;
      }

      if (/var\(--/.test(match[0])) {
        continue;
      }

      addFinding(
        findings,
        "raw-transition-time-literal",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Raw transition timing literal found outside the core motion token layer.",
        match[0],
      );
    }
  }
}

function auditExpressiveChannelSeparation(findings, tokenSource) {
  const tokenValues = parseCustomPropertyValues(tokenSource);
  for (const speed of ["fast", "default", "slow"]) {
    const spatialEasing = resolveTokenChain(`--gc-motion-css-expressive-${speed}-spatial-easing`, tokenValues);
    const effectsEasing = resolveTokenChain(`--gc-motion-css-expressive-${speed}-effects-easing`, tokenValues);
    if (spatialEasing && effectsEasing && spatialEasing === effectsEasing) {
      addFinding(
        findings,
        "expressive-motion-channel-collapse",
        TOKEN_FILE,
        lineNumberAt(tokenSource, tokenSource.indexOf(`--gc-motion-css-expressive-${speed}-spatial-easing`)),
        `Expressive ${speed} spatial and effects easing tokens are identical.`,
        spatialEasing,
      );
    }

    const spatialDuration = resolveTokenChain(`--gc-motion-css-expressive-${speed}-spatial-duration`, tokenValues);
    const effectsDuration = resolveTokenChain(`--gc-motion-css-expressive-${speed}-effects-duration`, tokenValues);
    if (spatialDuration && effectsDuration && spatialDuration === effectsDuration) {
      addFinding(
        findings,
        "expressive-motion-duration-collapse",
        TOKEN_FILE,
        lineNumberAt(tokenSource, tokenSource.indexOf(`--gc-motion-css-expressive-${speed}-spatial-duration`)),
        `Expressive ${speed} spatial and effects duration tokens are identical (${spatialDuration}).`,
        spatialDuration,
      );
    }
  }
}

function auditTailwindMotionUtilities(findings, files) {
  const utilityPattern =
    /(?<![\w-])(?:duration-(?:\[[^\]]+\]|\d+)|ease-(?:\[[^\]]+\]|linear|in|out|in-out)|transition-(?:\[[^\]]+\]|all|colors|opacity|shadow|transform|none)|animate-(?:\[[^\]]+\]|[A-Za-z0-9_-]+))(?![\w-])/g;

  for (const { rel, source } of files) {
    if (
      !(rel.startsWith(`${LEGACY_SHARED_COMPONENTS_ROOT}/`) || rel.startsWith(`${UI_PACKAGE_COMPONENTS_ROOT}/`)) ||
      shouldSkipTailwindMotionUtility(rel)
    ) {
      continue;
    }

    utilityPattern.lastIndex = 0;
    for (const match of source.matchAll(utilityPattern)) {
      addFinding(
        findings,
        "shared-primitive-tailwind-motion-utility",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Use shared motion utilities or semantic tokens instead of raw Tailwind motion utilities.",
        match[0],
      );
    }
  }
}

function auditInlineStyleMotion(findings, files) {
  for (const { rel, source } of files) {
    if (!rel.endsWith(".vue")) {
      continue;
    }

    for (const inline of iterateInlineStyles(source)) {
      if (inline.kind === "static") {
        for (const decl of parseInlineDeclarations(inline.value)) {
          if (
            decl.property === "transition" ||
            decl.property === "animation" ||
            decl.property.startsWith("transition-") ||
            decl.property.startsWith("animation-")
          ) {
            addFinding(
              findings,
              "inline-style-motion",
              rel,
              lineNumberAt(source, inline.valueIndex + decl.index),
              `Inline ${decl.property} should move to a CSS token / utility class.`,
              `style="...${decl.property}: ${decl.value}..."`,
            );
          }
        }
      } else if (/\b(?:transition|animation)\s*:/.test(inline.value)) {
        addFinding(
          findings,
          "inline-style-motion",
          rel,
          lineNumberAt(source, inline.valueIndex),
          "Bound :style declares motion timing; move to CSS class with semantic motion tokens.",
          inline.raw.slice(0, 120),
        );
      }
    }
  }
}

function auditKeyframesAndAnimationDurations(findings, files) {
  // animation: <name> 240ms ease ...
  // animation: 240ms <name> ...
  // animation-duration: 240ms;
  // We only want findings outside the canonical token / transition layer files.
  const animationShorthandPattern = /\banimation\s*:\s*([^;]+);/g;
  const animationDurationPattern = /\banimation-duration\s*:\s*([^;]+);/g;
  const numericTimePattern = /(?:^|[^\w-])(\d+(?:\.\d+)?m?s)\b/g;

  for (const { rel, source } of files) {
    if (rel === TOKEN_FILE || rel === "src/styles/core/transitions.css") {
      continue;
    }
    if (isPublicDemoCss(rel)) {
      continue;
    }

    animationShorthandPattern.lastIndex = 0;
    for (const match of source.matchAll(animationShorthandPattern)) {
      const value = match[1];
      if (/var\(--/.test(value)) {
        continue;
      }
      if (isInsideReducedMotionBlock(source, match.index ?? 0)) {
        continue;
      }
      numericTimePattern.lastIndex = 0;
      let hasLiteral = false;
      for (const numMatch of value.matchAll(numericTimePattern)) {
        if (numMatch[1] !== "0s" && numMatch[1] !== "0ms") {
          hasLiteral = true;
          break;
        }
      }
      if (!hasLiteral) continue;
      addFinding(
        findings,
        "raw-keyframes-duration-literal",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "animation: shorthand uses a hardcoded duration literal; reference --gc-motion-duration-* or --md-sys-motion-duration-* instead.",
        match[0],
      );
    }

    animationDurationPattern.lastIndex = 0;
    for (const match of source.matchAll(animationDurationPattern)) {
      const value = match[1];
      if (/var\(--/.test(value)) {
        continue;
      }
      if (isInsideReducedMotionBlock(source, match.index ?? 0)) {
        continue;
      }
      addFinding(
        findings,
        "raw-keyframes-duration-literal",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "animation-duration uses a hardcoded literal; reference a named motion duration token instead.",
        match[0].trim(),
      );
    }
  }
}

function isTokenLayerPath(rel) {
  return rel === TOKEN_FILE || TOKEN_LAYER_PATHS.has(rel);
}

// `transition: all <...>` is an anti-pattern under M3's spatial/effects channel
// discipline because it animates every property with the same easing, which
// guarantees a mismatch on at least one channel. Exempt the canonical token
// and transition CSS files, plus any line opting out via the existing
// audit-motion-ignore: raw-transition directive.
function auditTransitionAllShorthand(findings, files) {
  const allPattern = /\btransition\s*:\s*all\b[^;{}]*;/g;
  for (const { rel, source } of files) {
    if (isTokenLayerPath(rel)) continue;
    allPattern.lastIndex = 0;
    for (const match of source.matchAll(allPattern)) {
      if (shouldSkipRawTransitionLiteral(rel, source, match.index ?? 0)) continue;
      addFinding(
        findings,
        "transition-all-shorthand",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Replace `transition: all` with an explicit property list so spatial and effects easings can be assigned per channel.",
        match[0],
      );
    }
  }
}

// Any file that declares an infinite animation must also declare a
// prefers-reduced-motion: reduce block so motion-sensitive users get a fallback.
// We only check at file granularity — pairing a specific selector with the right
// override is left to reviewers since selector-level static matching is brittle.
function auditInfiniteAnimationReducedMotionGuard(findings, files) {
  const infinitePattern = /\banimation(?:-iteration-count)?\s*:[^;{}]*\binfinite\b/g;
  for (const { rel, source } of files) {
    if (!/\.css$/.test(rel)) continue;
    if (isTokenLayerPath(rel)) continue;
    infinitePattern.lastIndex = 0;
    const first = infinitePattern.exec(source);
    if (!first) continue;
    // Accept either a reduce-override fallback or a no-preference gate: both
    // satisfy the accessibility contract for infinite animations.
    if (/@media[^{]*prefers-reduced-motion\b/.test(source)) continue;
    addFinding(
      findings,
      "infinite-animation-missing-reduced-motion-guard",
      rel,
      lineNumberAt(source, first.index ?? 0),
      "This file uses an infinite animation but has no @media (prefers-reduced-motion: reduce) override.",
      first[0],
    );
  }
}

// M3 spatial channels overshoot; effects channels (color/opacity/etc.) must not.
// Flag transition declarations where an effects property is paired with a
// *-spatial easing token. Iterates rules of the form
// `<property> <duration> <easing>[, ...]` inside a `transition:` declaration.
function auditEffectsPropertySpatialEasing(findings, files) {
  const transitionPattern = /\btransition(?:-property)?\s*:\s*([^;{}]+);/g;
  // Each segment is `<property> <duration-token-or-literal> <easing-token-or-literal>`.
  // We only care when the easing position references a var() whose name carries -spatial.
  const segmentPattern = /(?:^|,)\s*([a-zA-Z-]+)\s+([^,]*?)\bvar\((--[A-Za-z0-9_-]*spatial[A-Za-z0-9_-]*)\s*\)/g;

  for (const { rel, source } of files) {
    if (isTokenLayerPath(rel)) continue;
    transitionPattern.lastIndex = 0;
    for (const match of source.matchAll(transitionPattern)) {
      const body = match[1];
      segmentPattern.lastIndex = 0;
      for (const seg of body.matchAll(segmentPattern)) {
        const property = seg[1].toLowerCase();
        const easingToken = seg[3];
        if (!EFFECTS_PROPERTIES.has(property)) continue;
        if (!/easing/i.test(easingToken)) continue;
        addFinding(
          findings,
          "effects-property-spatial-easing",
          rel,
          lineNumberAt(source, (match.index ?? 0) + (seg.index ?? 0)),
          `${property} should pair with an effects-channel easing token, not ${easingToken}.`,
          `${property} ... var(${easingToken})`,
        );
      }
    }
  }
}

// Raw cubic-bezier(...) inside a transition/animation/timing-function declaration
// is drift unless it lives inside a `var(--token, cubic-bezier(...))` fallback
// slot. Token files are exempt. We strip out var(...) fallback occurrences before
// checking for remaining literals so the defensive fallback pattern stays legal.
function auditRawCubicBezierInDeclarations(findings, files) {
  const declarationPattern =
    /\b(transition|animation|transition-timing-function|animation-timing-function)\s*:\s*([^;{}]+);/g;
  const varFallbackPattern = /var\(\s*--[A-Za-z0-9_-]+\s*,\s*cubic-bezier\([^)]+\)\s*\)/g;
  const bareBezierPattern = /cubic-bezier\([^)]+\)/g;

  for (const { rel, source } of files) {
    if (isTokenLayerPath(rel)) continue;
    if (isPublicDemoCss(rel)) continue;
    declarationPattern.lastIndex = 0;
    for (const match of source.matchAll(declarationPattern)) {
      const body = match[2];
      const masked = body.replace(varFallbackPattern, "");
      bareBezierPattern.lastIndex = 0;
      const bezier = bareBezierPattern.exec(masked);
      if (!bezier) continue;
      addFinding(
        findings,
        "raw-cubic-bezier-in-motion-declaration",
        rel,
        lineNumberAt(source, match.index ?? 0),
        `${match[1]}: declaration contains a raw cubic-bezier literal. Promote it to a named motion easing token.`,
        match[0].replace(/\s+/g, " ").trim(),
      );
    }
  }
}

// Returns the set of [start, end) source ranges covered by
// `@media ... prefers-reduced-motion ... { ... }` rules. Used to verify that
// the reduced-motion duration token is only consumed inside such a block.
function collectReducedMotionMediaRanges(source) {
  const ranges = [];
  const mediaPattern = /@media[^{]*prefers-reduced-motion[^{]*\{/g;
  let match;
  while ((match = mediaPattern.exec(source)) !== null) {
    const blockStart = match.index + match[0].length;
    // Walk forward counting braces to find the matching closing brace for this
    // @media rule. CSS nesting is shallow inside reduced-motion blocks but we
    // still account for nested rule braces.
    let depth = 1;
    let cursor = blockStart;
    while (cursor < source.length && depth > 0) {
      const ch = source.charCodeAt(cursor);
      if (ch === 123)
        depth += 1; // {
      else if (ch === 125) depth -= 1; // }
      cursor += 1;
    }
    if (depth === 0) {
      ranges.push([match.index, cursor]);
    }
  }
  return ranges;
}

function isIndexInsideAnyRange(index, ranges) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

function auditReducedMotionTokenScope(findings, files) {
  const tokenName = "--gc-motion-duration-reduced";
  const usagePattern = new RegExp(`var\\(\\s*${tokenName}\\b`, "g");

  for (const { rel, source } of files) {
    // Token files are allowed to define / forward this token.
    if (isTokenLayerPath(rel)) continue;
    usagePattern.lastIndex = 0;
    const ranges = collectReducedMotionMediaRanges(source);
    for (const match of source.matchAll(usagePattern)) {
      const idx = match.index ?? 0;
      if (isIndexInsideAnyRange(idx, ranges)) continue;
      addFinding(
        findings,
        "reduced-motion-token-outside-reduced-motion-block",
        rel,
        lineNumberAt(source, idx),
        `var(${tokenName}) referenced outside a @media (prefers-reduced-motion: reduce) block; this suppresses motion unconditionally.`,
        match[0],
      );
    }
  }
}

function auditSharedSurfaceSpringTransitionMix(findings, files) {
  const sharedSurfacePathPattern = /^src\/components\/shared\/(?:layout|overlays|feedback)\//;
  const surfaceTransitionPattern =
    /\btransition(?:-[a-z-]+)?\s*:\s*[^;{}]*(?:--gc-motion-duration-(?:sheet|detail-dock|overlay)|--gc-motion-transition-(?:sheet|detail-dock|overlay)|--gc-(?:sheet|detail-dock|overlay)[a-z-]*transition-motion)[^;{}]*;/g;

  for (const { rel, source } of files) {
    if (!sharedSurfacePathPattern.test(rel) || !/\buseSpring\s*\(/.test(source)) {
      continue;
    }

    surfaceTransitionPattern.lastIndex = 0;
    for (const match of source.matchAll(surfaceTransitionPattern)) {
      addFinding(
        findings,
        "shared-surface-spring-transition-mix",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "This shared surface primitive uses useSpring while also owning sheet/detail-dock/overlay CSS transition timing. Choose one shared motion primitive for the surface.",
        match[0],
      );
    }
  }
}

function auditAnimatedSwapProps(findings, files) {
  const target = files.find((file) => file.rel === `${UI_PACKAGE_COMPONENTS_ROOT}/display/AppAnimatedSwapText.vue`);
  if (!target) {
    return;
  }

  for (const propName of ["widthDurationMs", "fadeDurationMs", "widthEasing"]) {
    const index = target.source.indexOf(propName);
    if (index === -1) {
      continue;
    }

    addFinding(
      findings,
      "animated-swap-raw-motion-props",
      target.rel,
      lineNumberAt(target.source, index),
      `${propName} is a raw motion customization prop; prefer semantic motion props when this component is upgraded.`,
      propName,
    );
  }
}

function auditSpringRuntime(findings) {
  const springRuntimePath = "src/lib/motion/spring.ts";
  const springComposablePath = "src/composables/shared/useSpring.ts";
  if (existsSync(path.join(ROOT, springRuntimePath)) || existsSync(path.join(ROOT, springComposablePath))) {
    return;
  }

  addFinding(
    findings,
    "spring-runtime-missing",
    springRuntimePath,
    1,
    "No first-party spring runtime or shared useSpring composable exists yet.",
  );
}

function renderMarkdown(findings) {
  const counts = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});

  const lines = [];
  lines.push("# Motion Physics Audit");
  lines.push("");
  lines.push(`- Total findings: ${findings.length}`);
  lines.push(`- Errors: ${counts.error ?? 0}`);
  lines.push(`- Warnings: ${counts.warning ?? 0}`);
  lines.push("");

  if (!findings.length) {
    lines.push("No motion physics drift found.");
    return `${lines.join("\n")}\n`;
  }

  for (const finding of findings) {
    const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
    lines.push(`- ${finding.severity.toUpperCase()}: \`${finding.ruleId}\` - ${location} - ${finding.message}`);
    if (finding.snippet) {
      lines.push(`  - ${finding.snippet}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runMotionPhysicsAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];
  TOKEN_FILE = options.tokenFile ?? DEFAULT_TOKEN_FILE;

  const filePaths = await collectFiles();
  const files = [];
  for (const filePath of filePaths) {
    files.push({
      rel: relativePath(filePath),
      source: await readFile(filePath, "utf8"),
    });
  }

  const tokenSource = await readFile(path.join(ROOT, TOKEN_FILE), "utf8");
  const findings = [];

  auditMissingDurationTokens(findings, files, tokenSource);
  auditBezierOvershoot(findings, files);
  auditRawTransitionTimes(findings, files);
  auditTailwindMotionUtilities(findings, files);
  auditInlineStyleMotion(findings, files);
  auditKeyframesAndAnimationDurations(findings, files);
  auditSharedSurfaceSpringTransitionMix(findings, files);
  auditAnimatedSwapProps(findings, files);
  auditExpressiveChannelSeparation(findings, tokenSource);
  auditSpringRuntime(findings);
  auditTransitionAllShorthand(findings, files);
  auditInfiniteAnimationReducedMotionGuard(findings, files);
  auditEffectsPropertySpatialEasing(findings, files);
  auditRawCubicBezierInDeclarations(findings, files);
  auditReducedMotionTokenScope(findings, files);

  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath) || a.line - b.line);

  return {
    failed: findings.some((finding) => finding.severity === "error"),
    findings,
    rules: RULES,
    jsonPayload: { findings, rules: RULES },
    report: renderMarkdown(findings),
  };
}

async function main() {
  const result = await runMotionPhysicsAudit();
  if (hasFlag("--json")) {
    console.log(JSON.stringify(result.jsonPayload, null, 2));
  } else if (!hasFlag("--quiet") || result.findings.length > 0) {
    console.log(result.report.trimEnd());
  }

  if (hasFlag("--fail-on-drift") && result.failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[motion-physics-engine] failed:", error);
    process.exitCode = 1;
  });
}
