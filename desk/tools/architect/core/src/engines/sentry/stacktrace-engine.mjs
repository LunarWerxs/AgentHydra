/**
 * stacktrace-engine — Sentry-inspired stack trace frame processing
 * =================================================================
 * Adapted from Sentry's stack trace processing pipeline:
 *
 *   - `src/sentry/stacktraces/processing.py` — normalize_stacktraces_for_grouping
 *   - `src/sentry/lang/javascript/processing.py` — JS-specific frame normalization
 *   - `@sentry/core` stack parsers — defaultStackParser, chromeStackLineParser
 *
 * ## What this engine does
 *
 *   1. Parse raw stack trace strings into structured frame objects
 *   2. Classify frames: in_app (user code), framework, vendor/node_modules
 *   3. Normalize paths across platforms (Windows backslash, sourcemap origins)
 *   4. Parameterize context lines (strip variable values for grouping)
 *   5. Compute frame fingerprints for deduplication
 *   6. Platform detection (node, browser, bun, deno)
 *
 * ## in_app detection (parallel to Sentry)
 *
 *   Sentry marks frames as `in_app: true/false` based on:
 *   - The frame's absolute path matches project root
 *   - The frame is NOT in node_modules, vendor/, or framework internals
 *   - Custom `inApp` patterns from config
 *
 *   This engine implements the same heuristics for JS/TS stacks:
 *   - `in_app = true`: paths under project src/, lib/, app/
 *   - `in_app = false`: paths under node_modules/, .cache/, dist/, framework internals
 *
 * ## Frame fingerprinting (parallel to Sentry's frame grouping)
 *
 *   Each frame gets a fingerprint from: (function, module, filename, context_line).
 *   This is used by the finding-grouping-engine to group similar issues.
 *
 * Codebase-agnostic: works on any JS/TS stack trace string or frame array.
 */

import { createHash } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants (parallel to Sentry's platform constants)
// ---------------------------------------------------------------------------

/** Patterns that indicate a frame is NOT in user application code. */
const VENDOR_PATTERNS = [
  /[\\/]node_modules[\\/]/,
  /[\\/]\.cache[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]\.next[\\/]/,
  /[\\/]\.nuxt[\\/]/,
  /[\\/]vendor[\\/]/,
  /[\\/]__pypackages__[\\/]/,
  /\.venv[\\/]/,
  /[\\/]site-packages[\\/]/,
];

/** Framework internals that should NOT be marked as in_app. */
const FRAMEWORK_PATTERNS = [
  /[\\/]node_modules[\\/](?:react|react-dom|vue|@vue|svelte|solid-js|angular|preact)[\\/]/,
  /[\\/]node_modules[\\/](?:next|nuxt|remix|astro|sveltekit|solid-start)[\\/]/,
  /[\\/]node_modules[\\/](?:express|koa|fastify|hono|elysia)[\\/]/,
  /[\\/]node_modules[\\/](?:vite|webpack|rollup|esbuild|rspack|turbo)[\\/]/,
  /[\\/]node_modules[\\/](?:@sentry|sentry)[\\/]/,
];

/** Patterns that are clearly user application code. */
const USER_CODE_PATTERNS = [
  /[\\/]src[\\/]/,
  /[\\/]app[\\/]/,
  /[\\/]lib[\\/]/,
  /[\\/]components[\\/]/,
  /[\\/]composables[\\/]/,
  /[\\/]pages[\\/]/,
  /[\\/]products[\\/]/,
  /[\\/]utils[\\/]/,
  /[\\/]infra[\\/]/,
];

/** Platforms we can detect from frame content. */
const PLATFORM_PATTERNS = {
  node: /node:|node_modules|internal[\\/]modules|node:internal/,
  browser: /https?:\/\/|chrome-extension:|moz-extension:|safari-web-extension:/,
  bun: /bun:|node_modules[\\/]bun/,
  deno: /https:\/\/deno\.land|file:\/\/.*\.deno/,
  electron: /electron:|node_modules[\\/]electron/,
};

/** Known anonymous function names. */
const ANONYMOUS_NAMES = new Set([
  "",
  "?",
  "<anonymous>",
  "<unknown>",
  "anonymous",
  "Anonymous function",
  "Global code",
  "(anonymous)",
  "[anonymous]",
]);

/** Sentry's context line parameterization regex (strips variable values).
 *  Used inline in parameterizeContextLine(). */

// ---------------------------------------------------------------------------
// Frame parsing (parallel to Sentry's defaultStackParser)
// ---------------------------------------------------------------------------

/**
 * Parse a raw stack trace string into structured frame objects.
 *
 * Supports Chrome V8, Firefox SpiderMonkey, Safari JSC, and Node.js formats.
 *
 * @param {string} stacktrace — the raw stack trace string
 * @param {Object} [options]
 * @param {string} [options.platform="auto"] — "auto" | "node" | "browser"
 * @returns {Array<{filename: string, function: string, lineno: number, colno: number, in_app: string, abs_path: string, module: string, platform: string}>}
 */
export function parseStackTrace(stacktrace, options = {}) {
  const { platform = "auto" } = options;
  const lines = stacktrace.split(/\r?\n/);
  const frames = [];

  // Detect platform from first few lines
  const detectedPlatform = platform === "auto" ? detectPlatform(stacktrace) : platform;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try Chrome V8 format: "    at functionName (file:line:col)"
    const chromeMatch = CHROME_FRAME_REGEX.exec(trimmed);
    if (chromeMatch) {
      const [, func, file, lineNum, colNum] = chromeMatch;
      if (file && lineNum) {
        frames.push(buildFrame({
          func: func || "<anonymous>",
          file,
          line: parseInt(lineNum, 10),
          col: colNum ? parseInt(colNum, 10) : 0,
          platform: detectedPlatform,
        }));
        continue;
      }
    }

    // Try Firefox SpiderMonkey format: "functionName@file:line:col"
    const firefoxMatch = FIREFOX_FRAME_REGEX.exec(trimmed);
    if (firefoxMatch) {
      const [, func, file, lineNum, colNum] = firefoxMatch;
      if (file && lineNum) {
        frames.push(buildFrame({
          func: func || "<anonymous>",
          file,
          line: parseInt(lineNum, 10),
          col: colNum ? parseInt(colNum, 10) : 0,
          platform: detectedPlatform,
        }));
        continue;
      }
    }

    // Try Node.js format: "    at file:line:col"
    const nodeMatch = NODE_FRAME_REGEX.exec(trimmed);
    if (nodeMatch) {
      const [, file, lineNum, colNum] = nodeMatch;
      if (file && lineNum) {
        frames.push(buildFrame({
          func: "<anonymous>",
          file,
          line: parseInt(lineNum, 10),
          col: colNum ? parseInt(colNum, 10) : 0,
          platform: detectedPlatform,
        }));
      }
    }
  }

  return frames;
}

// Frame regexes (parallel to Sentry's chromeStackLineParser, geckoStackLineParser, etc.)
const CHROME_FRAME_REGEX = /^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?)\)?\s*$/;
const FIREFOX_FRAME_REGEX = /^\s*(.+?)@(.+?):(\d+)(?::(\d+))?\s*$/;
const NODE_FRAME_REGEX = /^\s*at\s+(.+?):(\d+)(?::(\d+))?\s*$/;

// ---------------------------------------------------------------------------
// Frame normalization (parallel to Sentry's normalize_stacktraces_for_grouping)
// ---------------------------------------------------------------------------

/**
 * Build a normalized frame object from raw parts.
 *
 * @param {Object} raw
 * @returns {Object} normalized frame
 */
function buildFrame(raw) {
  const absPath = resolveAbsolutePath(raw.file);
  const module = extractModule(absPath);
  const inApp = classifyInApp(absPath, raw.platform);
  const platform = raw.platform || "javascript";

  return {
    filename: path.basename(absPath),
    function: normalizeFunctionName(raw.func),
    lineno: raw.line,
    colno: raw.col,
    in_app: inApp ? "true" : "false",
    abs_path: absPath,
    module,
    platform,
    context_line: "",
    pre_context: [],
    post_context: [],
  };
}

/**
 * Resolve an absolute path from a frame file reference.
 * Normalizes webpack:// and other protocol prefixes.
 */
function resolveAbsolutePath(file) {
  // Strip protocol prefixes
  let resolved = file
    .replace(/^webpack:\/{2}\./, "")
    .replace(/^webpack:\/{2}/, "")
    .replace(/^file:\/{2,3}/, "")
    .replace(/^https?:\/\/[^/]+\//, "/")
    .replace(/\\/g, "/");

  // Remove query strings and fragments
  resolved = resolved.split("?")[0].split("#")[0];

  return resolved.startsWith("/") ? resolved : `/${resolved}`;
}

/**
 * Extract module name from an absolute path.
 * Parallel to Sentry's module component extraction.
 */
function extractModule(absPath) {
  // For webpack bundles: path/to/module/index.js → module
  const parts = absPath.split("/").filter(Boolean);

  // Find the last "meaningful" segment before node_modules or src
  let moduleStart = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "node_modules" || parts[i] === "src") {
      moduleStart = i + 1;
      break;
    }
  }

  if (moduleStart < parts.length) {
    return parts.slice(moduleStart).join(".").replace(/\.(js|ts|jsx|tsx|mjs|cjs|vue)$/, "");
  }

  return "";
}

/**
 * Classify a frame as in_app or not.
 * Parallel to Sentry's in-app detection.
 */
function classifyInApp(absPath, _platform) {
  // Framework internals → NOT in_app
  for (const pattern of FRAMEWORK_PATTERNS) {
    if (pattern.test(absPath)) return false;
  }

  // Vendor / node_modules → NOT in_app
  for (const pattern of VENDOR_PATTERNS) {
    if (pattern.test(absPath)) return false;
  }

  // Clearly user code → in_app
  for (const pattern of USER_CODE_PATTERNS) {
    if (pattern.test(absPath)) return true;
  }

  // Default: if not vendor, assume in_app
  return true;
}

/**
 * Normalize a function name.
 * Strips webpack/closure compiler annotations.
 */
function normalizeFunctionName(name) {
  return name
    .replace(/^__WEBPACK_IMPORTED_MODULE_\d+_/, "")
    .replace(/^__\$/, "")
    .replace(/\$\d+$/, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Detect the platform from a stack trace string.
 *
 * @param {string} stacktrace
 * @returns {string} "node" | "browser" | "bun" | "deno" | "unknown"
 */
export function detectPlatform(stacktrace) {
  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
    if (pattern.test(stacktrace)) return platform;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Frame filtering & utility (parallel to Sentry)
// ---------------------------------------------------------------------------

/**
 * Filter frames to only those marked as in_app.
 *
 * @param {Object[]} frames
 * @returns {Object[]}
 */
export function filterInAppFrames(frames) {
  return frames.filter((f) => f.in_app === "true");
}

/**
 * Get the "culprit" frame — the topmost in_app frame.
 * Parallel to Sentry's culprit detection.
 *
 * @param {Object[]} frames
 * @returns {Object | null}
 */
export function getCulpritFrame(frames) {
  const inApp = filterInAppFrames(frames);
  if (inApp.length > 0) return inApp[0];

  // Fallback to first frame
  return frames[0] ?? null;
}

/**
 * Format a frame as a human-readable string.
 * Parallel to Sentry's frame rendering.
 *
 * @param {Object} frame
 * @returns {string}
 */
export function formatFrame(frame) {
  const func = frame.function && !ANONYMOUS_NAMES.has(frame.function)
    ? frame.function
    : "<anonymous>";
  return `${func} at ${frame.filename}:${frame.lineno}:${frame.colno}`;
}

/**
 * Check if a function name is anonymous.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isAnonymousFunction(name) {
  return ANONYMOUS_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Parameterize context lines (parallel to Sentry)
// ---------------------------------------------------------------------------

/**
 * Parameterize a context line — strip variable values for stable grouping.
 * Converts:
 *   `const x = 42;` → `const x = <NUM>;`
 *   `fetch("https://api.example.com/users/123")` → `fetch("<STR>")`
 *
 * @param {string} line
 * @returns {string}
 */
export function parameterizeContextLine(line) {
  if (!line) return "";

  return line
    .replace(/(?:"[^"]*")/g, '"<STR>"')
    .replace(/(?:'[^']*')/g, "'<STR>'")
    .replace(/(?:`[^`]*`)/g, "`<STR>`")
    .replace(/\b(?:0x[0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?)\b/g, "<NUM>")
    .replace(/\b(?:true|false|null|undefined)\b/g, "<BOOL>");
}

// ---------------------------------------------------------------------------
// Frame fingerprinting (for grouping engine integration)
// ---------------------------------------------------------------------------

/**
 * Generate a fingerprint for a single frame.
 * Used by the finding-grouping-engine to group similar findings.
 *
 * @param {Object} frame
 * @returns {string}
 */
export function frameFingerprint(frame) {
  const values = [
    frame.module || "",
    frame.function || "<anonymous>",
    frame.filename || "",
  ];
  return createHash("sha256").update(values.join("\x00")).digest("hex").substring(0, 12);
}

/**
 * Generate a stack trace fingerprint from multiple frames.
 * Only uses in_app frames (parallel to Sentry's stacktrace grouping).
 *
 * @param {Object[]} frames
 * @param {number} [maxFrames=5] — max frames to include in fingerprint
 * @returns {string}
 */
export function stacktraceFingerprint(frames, maxFrames = 5) {
  const inApp = filterInAppFrames(frames).slice(0, maxFrames);
  if (inApp.length === 0) {
    // Fallback: use all frames
    const allFrames = frames.slice(0, maxFrames);
    const values = allFrames.map((f) => frameFingerprint(f));
    return createHash("sha256").update(values.join("\x00")).digest("hex").substring(0, 16);
  }

  const values = inApp.map((f) => frameFingerprint(f));
  return createHash("sha256").update(values.join("\x00")).digest("hex").substring(0, 16);
}

// ---------------------------------------------------------------------------
// Stack trace → findings conversion
// For feeding stack traces into the arkitect finding pipeline
// ---------------------------------------------------------------------------

/**
 * Convert a stack trace into arkitect findings.
 * Each frame becomes a finding that can be grouped, filtered, and tracked.
 *
 * @param {string} stacktrace — raw stack trace
 * @param {Object} [options]
 * @param {string} [options.ruleId="stacktrace-frame"] — rule ID for findings
 * @param {string} [options.severity="info"] — default severity
 * @param {Object} [options.metadata] — additional metadata
 * @returns {Object[]} array of arkitect findings
 */
export function stacktraceToFindings(stacktrace, options = {}) {
  const {
    ruleId = "stacktrace-frame",
    severity = "info",
    metadata = {},
  } = options;

  const frames = parseStackTrace(stacktrace);

  return frames.map((frame, index) => ({
    ruleId,
    severity: frame.in_app === "true" ? severity : "info",
    filePath: frame.abs_path,
    line: frame.lineno,
    message: formatFrame(frame),
    snippet: frame.context_line || "",
    metadata: {
      ...metadata,
      _stacktrace: {
        frameIndex: index,
        totalFrames: frames.length,
        inApp: frame.in_app === "true",
        frameFingerprint: frameFingerprint(frame),
        stacktraceFingerprint: stacktraceFingerprint(frames),
        frame,
      },
    },
  }));
}
