/**
 * Duplicate Function Detector Engine — connections-arkitect
 * ==========================================================
 * Detects identical or near-identical function bodies across
 * different files. Lightweight signature-based approach:
 *
 *   1. Extract function signatures from source files.
 *   2. Normalize whitespace and variable names.
 *   3. Compare normalized bodies for exact matches.
 *   4. Report matches across different files.
 *
 * Consumed by: src/checks/code-quality/duplicate-functions.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const SKIP_PATTERNS = [
  /[\\/]node_modules[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]\.git[\\/]/,
  /[\\/]tmp[\\/]/,
  /[\\/]todo[\\/]/,
  /\.spec\./,
  /\.test\./,
  /\.generated\./,
  /[\\/]test[\\/]fixtures[\\/]/,
  /[\\/]docs[\\/]/,
  /[\\/]archive[\\/]/,
  /[\\/]memories[\\/]/,
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

/**
 * Extract function definitions with their bodies from source text.
 * Handles: `function name(...) { ... }`, `const name = (...) => { ... }`,
 * `export function`, `export async function`.
 */
export function extractFunctions(content, filePath) {
  const funcs = [];

  // Match function declarations: function name(...) { ... }
  const funcDeclRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
  // Match arrow function consts: const name = (...) => {
  const arrowRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^{]+)?\s*=>\s*\{/g;

  for (const re of [funcDeclRe, arrowRe]) {
    let match;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      const params = match[2];
      const bodyStart = match.index + match[0].length;

      // Find matching closing brace
      let depth = 1;
      let pos = bodyStart;
      while (depth > 0 && pos < content.length) {
        if (content[pos] === "{") depth++;
        else if (content[pos] === "}") depth--;
        pos++;
      }

      const body = content.slice(bodyStart, pos - 1).trim();
      const lineNumber = content.slice(0, match.index).split("\n").length;

      funcs.push({
        name,
        params: params.trim(),
        body,
        filePath,
        line: lineNumber,
        length: body.length,
      });
    }
  }

  return funcs;
}

/**
 * Normalize a function body for comparison:
 *   - Collapse whitespace
 *   - Remove comments
 *   - Normalize string literals
 */
export function normalizeBody(body) {
  return body
    .replace(/\/\/[^\n]*/g, "") // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // multi-line comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, "``") // template literals
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();
}

/**
 * Build a signature hash for a function: name + normalized params.
 */
export function buildSignature(func) {
  return `${func.name}(${func.params.replace(/\s+/g, " ")})`;
}

/**
 * Run the duplicate function detection engine.
 */
export async function runDuplicateFunctionDetector({ root, sourceDirs }) {
  const dirs = sourceDirs || ["src", "infra/lambda/src", "packages/connections-ui/src"];
  const allFuncs = [];

  // Collect all functions
  for (const dir of dirs) {
    const absDir = path.resolve(root, dir);
    if (!existsSync(absDir)) continue;

    const files = await walkFiles(absDir, root);
    for (const relPath of files) {
      const absPath = path.resolve(root, relPath);
      let content;
      try {
        content = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      const funcs = extractFunctions(content, relPath);
      allFuncs.push(...funcs);
    }
  }

  // Cluster by normalized body — use full body for key to avoid
  // false positives from functions that share a name + first 80 chars
  // but have different implementations (e.g. loadPublicSitemapRoutes).
  const clusters = new Map();
  for (const func of allFuncs) {
    const hash = normalizeBody(func.body);
    // Only consider bodies > 3 lines / 100 chars (skip trivial getters)
    if (func.body.split("\n").length < 3 && func.body.length < 100) continue;

    const key = `${func.name}::${hash}`;
    const list = clusters.get(key) || [];
    list.push(func);
    clusters.set(key, list);
  }

  // Find duplicates (same body, different files)
  const duplicates = [];
  for (const [, funcs] of clusters) {
    const uniqueFiles = new Set(funcs.map((f) => f.filePath));
    if (uniqueFiles.size >= 2) {
      duplicates.push({
        name: funcs[0].name,
        signature: buildSignature(funcs[0]),
        locations: funcs.map((f) => ({
          filePath: f.filePath,
          line: f.line,
        })),
        bodyLength: funcs[0].length,
      });
    }
  }

  return {
    totalFunctions: allFuncs.length,
    duplicates,
    uniqueFiles: new Set(allFuncs.map((f) => f.filePath)).size,
  };
}

async function walkFiles(absDir, root) {
  const results = [];

  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(absDir, entry.name);
    const relPath = path.relative(root, fullPath).replace(/\\/g, "/");

    if (SKIP_PATTERNS.some((p) => p.test(relPath) || p.test(fullPath))) continue;

    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      const children = await walkFiles(fullPath, root);
      results.push(...children);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        results.push(relPath);
      }
    }
  }
  return results;
}

export const DEFAULT_DUP_SOURCE_DIRS = ["src", "infra/lambda/src", "packages/connections-ui/src"];
