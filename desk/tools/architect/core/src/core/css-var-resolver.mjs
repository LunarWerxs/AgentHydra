/**
 * CSS Custom Property Resolver
 * =============================
 * Parses CSS files to build a map of `--name` → expanded value, then resolves
 * `var(--name)` and `var(--name, fallback)` references in any CSS value string.
 *
 * Handles:
 *   - Simple var() references:   var(--foo)
 *   - Fallback values:           var(--foo, 16px)
 *   - Nested var() in fallback:  var(--foo, var(--bar))
 *   - Multi-line property values (reads until the terminating `;`)
 *   - Recursive resolution up to a configurable depth (default 8)
 *
 * Does NOT handle:
 *   - @property registered custom properties with computed values
 *   - Cyclic references (will hit depth limit)
 *   - env() or calc() expansion
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Parse raw CSS text into a Map of `--name` → `value`.
 * Reads `--name: value;` declarations. Multi-line values are collected
 * until the first unescaped `;` outside of a `var()` call.
 *
 * @param {string} css - Raw CSS source text
 * @returns {Map<string, string>}
 */
export function parseCustomProperties(css) {
  const props = new Map();

  // Match `--name:` followed by the value up to the terminating `;`.
  // We use a manual scanner to handle multi-line values correctly.
  const PROP_RE = /(^|[{;\s\n])(--[\w-]+)\s*:\s*/gm;
  let match;
  while ((match = PROP_RE.exec(css)) !== null) {
    const name = match[2];
    const valueStart = match.index + match[0].length;
    const value = readPropertyValue(css, valueStart);
    if (value !== null) {
      props.set(name, value);
    }
  }

  return props;
}

/**
 * Read a CSS property value from `start` until the first unescaped `;`
 * that is not inside a function call (like var(...)).
 *
 * @param {string} source
 * @param {number} start
 * @returns {string | null}
 */
function readPropertyValue(source, start) {
  let depth = 0; // parenthesis depth
  let i = start;

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\\") {
      i += 2; // skip escaped character
      continue;
    }

    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      if (depth < 0) depth = 0;
      i += 1;
      continue;
    }

    if (ch === ";" && depth === 0) {
      // Found the terminator.
      return source.slice(start, i).trim();
    }

    // Stop at a closing brace — we've gone too far (malformed CSS, no semicolon).
    if (ch === "}" && depth === 0) {
      return source.slice(start, i).trim();
    }

    i += 1;
  }

  // Reached end of file without a semicolon.
  return source.slice(start).trim();
}

/**
 * VAR_REGEX matches `var(--name)` or `var(--name, fallback)`.
 * The fallback can contain nested var() calls or commas.
 *
 * Captures:
 *   [1] = full match (e.g. "var(--foo, 16px)")
 *   [2] = property name (e.g. "--foo")
 *   [3] = fallback value, if present (e.g. " 16px")
 */
const VAR_REGEX = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*(?:\([^)]*\)[^)]*)*?)\s*)?\)/g;

/**
 * Resolve all `var()` references in a CSS value string.
 *
 * @param {string} value - The CSS value to resolve
 * @param {Map<string, string>} varMap - Map of --name → value
 * @param {object} [options]
 * @param {number} [options.maxDepth=8] - Max recursion depth
 * @param {Set<string>} [options.visited] - For cycle detection (internal)
 * @returns {string} The resolved value
 */
export function resolveVar(value, varMap, { maxDepth = 8, visited = new Set() } = {}) {
  if (maxDepth <= 0) return value;

  let resolved = value;
  let changed = true;

  // Iterate until no more var() references or max iterations.
  // VAR_REGEX has state, so we need to recreate or reset it each pass.
  let iterations = 0;
  while (changed && iterations < maxDepth) {
    changed = false;
    iterations += 1;

    const regex = new RegExp(VAR_REGEX.source, VAR_REGEX.flags);
    resolved = resolved.replace(regex, (_full, varName, fallback) => {
      if (visited.has(varName)) {
        // Cycle detected — return the fallback or empty.
        return fallback ? fallback.trim() : "";
      }

      const replacement = varMap.get(varName);
      if (replacement !== undefined) {
        changed = true;
        const nestedVisited = new Set(visited);
        nestedVisited.add(varName);
        // Recursively resolve the replacement value.
        return resolveVar(replacement, varMap, { maxDepth: maxDepth - 1, visited: nestedVisited });
      }

      if (fallback) {
        changed = true;
        // Resolve nested vars in the fallback.
        return resolveVar(fallback.trim(), varMap, { maxDepth: maxDepth - 1, visited: new Set(visited) });
      }

      // Unknown variable with no fallback — keep the var() reference as-is.
      return _full;
    });
  }

  return resolved;
}

/**
 * Load CSS files from the given roots and build a combined variable map.
 *
 * @param {string} root - Project root
 * @param {string[]} tokenFiles - Relative paths to CSS files containing tokens
 * @returns {Promise<Map<string, string>>}
 */
export async function loadTokenMap(root, tokenFiles) {
  const varMap = new Map();

  for (const rel of tokenFiles) {
    const abs = path.resolve(root, rel);
    if (!existsSync(abs)) continue;

    let css;
    try {
      css = await readFile(abs, "utf8");
    } catch {
      continue;
    }

    const fileProps = parseCustomProperties(css);
    for (const [name, value] of fileProps) {
      // Later files override earlier ones (cascade order).
      varMap.set(name, value);
    }
  }

  return varMap;
}

/**
 * Resolve var() references in a transition value string and return the
 * expanded property names (first word of each comma-separated segment).
 *
 * Handles:
 *   `var(--token)` → resolves to `width 300ms ease, opacity 200ms` → ["width", "opacity"]
 *   `width 300ms, opacity 200ms` → ["width", "opacity"]
 *   `var(--token), height 200ms` → resolves and checks all
 *
 * @param {string} transitionValue - The raw transition value (after `transition:`)
 * @param {Map<string, string>} varMap
 * @returns {string[]} - List of CSS property names being transitioned
 */
export function expandTransitionProperties(transitionValue, varMap) {
  // First, resolve all var() references in the value.
  const resolved = resolveVar(transitionValue, varMap);

  // Split by commas to get individual property segments.
  const segments = resolved.split(/\s*,\s*/);

  const props = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // The first word is the CSS property name.
    const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
    if (firstWord && firstWord !== "all") {
      props.push(firstWord);
    }
  }

  return props;
}
