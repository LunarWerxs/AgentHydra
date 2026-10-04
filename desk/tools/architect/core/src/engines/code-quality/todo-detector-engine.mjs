/**
 * TODO Detector Engine — connections-arkitect
 * ============================================
 * Scans source files for TODO/FIXME/HACK markers and categorizes
 * them by tag, age, and file type. Surfaces stale TODOs that have
 * been sitting in production code without resolution.
 *
 * Rules for staleness:
 *   - TODOs in production source (not spec files, not docs)
 *   - TODOs with a migration/feature tag that appears in multiple files
 *   - TODOs without a tag (uncategorized, likely forgotten)
 *
 * Consumed by: src/checks/code-quality/stale-todos.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Regex for TODO/FIXME/HACK markers with optional tag.
 * Captures: full match, tag (optional), message
 *
 * Supported forms:
 *   // TODO: message
 *   // TODO(tag): message
 *   // FIXME: message
 *   // HACK: message
 *   // XXX: message
 */
const TODO_RE = /\/\/\s*(TODO|FIXME|HACK|XXX)\s*(?:\(([^)]+)\))?\s*:?\s*(.*)$/i;

/**
 * Files/directories to skip — test fixtures, docs, generated code.
 */
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

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".css", ".scss", ".html"]);

/**
 * Walk a directory recursively for source files.
 */
async function walkSourceFiles(root, dir) {
  const results = [];
  const absDir = path.resolve(root, dir);
  if (!existsSync(absDir)) return results;

  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(absDir, entry.name);
    const relPath = path.relative(root, fullPath).replace(/\\/g, "/");

    if (SKIP_PATTERNS.some((p) => p.test(relPath) || p.test(fullPath))) continue;

    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      const children = await walkSourceFiles(root, path.join(dir, entry.name));
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

/**
 * Extract TODOs from a single file.
 */
export function extractTodos(content, filePath) {
  const lines = content.split("\n");
  const todos = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(TODO_RE);
    if (!match) continue;

    todos.push({
      type: match[1].toUpperCase(),
      tag: match[2]?.trim() || null,
      message: match[3].trim() || "(no message)",
      filePath,
      line: i + 1,
      rawLine: line.trim(),
    });
  }

  return todos;
}

/**
 * Determine if a TODO is "stale" — in production code, tagged with
 * a migration/refactor marker, or lacking any tag.
 */
export function classifyTodo(todo) {
  const categories = [];

  // Tagged migration/refactor TODOs are intentional but should be tracked
  if (todo.tag) {
    categories.push("tagged");
    if (
      todo.tag.includes("migration") ||
      todo.tag.includes("migrate") ||
      todo.tag.includes("shell") ||
      todo.tag.includes("billing")
    ) {
      categories.push("migration-todo");
    }
  } else {
    // Untagged TODOs are often forgotten
    categories.push("untagged");
  }

  // FIXME and HACK are stronger signals
  if (todo.type === "FIXME" || todo.type === "HACK") {
    categories.push("fixme-hack");
  }

  return categories;
}

/**
 * Run the full TODO detection engine.
 */
export async function runTodoDetector({ root, sourceDirs }) {
  const dirs = sourceDirs || ["src", "infra/lambda/src", "packages/connections-ui/src", "infra/aws"];
  const allTodos = [];

  for (const dir of dirs) {
    const files = await walkSourceFiles(root, dir);
    for (const relPath of files) {
      const absPath = path.resolve(root, relPath);
      let content;
      try {
        content = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      const todos = extractTodos(content, relPath);
      for (const todo of todos) {
        todo.categories = classifyTodo(todo);
        todo.sourceDir = dir;
      }
      allTodos.push(...todos);
    }
  }

  // Group by tag for reporting
  const byTag = new Map();
  const untagged = [];
  const fixmeHacks = [];

  for (const todo of allTodos) {
    if (todo.tag) {
      const list = byTag.get(todo.tag) || [];
      list.push(todo);
      byTag.set(todo.tag, list);
    } else {
      untagged.push(todo);
    }
    if (todo.type === "FIXME" || todo.type === "HACK") {
      fixmeHacks.push(todo);
    }
  }

  return {
    total: allTodos.length,
    byTag: Object.fromEntries(byTag),
    untagged,
    fixmeHacks,
    allTodos,
  };
}

/**
 * Default source directories for the Connections project.
 */
export const DEFAULT_TODO_SOURCE_DIRS = ["src", "infra/lambda/src", "packages/connections-ui/src", "infra/aws"];
