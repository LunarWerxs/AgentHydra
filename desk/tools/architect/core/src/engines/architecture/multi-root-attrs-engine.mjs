/**
 * multi-root-attrs-engine — detect Vue SFCs with multiple root elements
 * that don't bind $attrs, causing silently dropped parent attributes.
 *
 * Vue 3 components with multiple root nodes (fragments) do NOT automatically
 * inherit attributes from the parent. The `class`, `style`, `data-testid`,
 * and other attributes passed by the parent are silently discarded unless
 * the component explicitly binds `v-bind="$attrs"` to one of its elements.
 *
 * This engine flags any .vue SFC whose <template> has more than one root
 * element AND no single wrapper element with v-bind="$attrs".
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Strip HTML comments from source.
 */
function stripComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Extract the <template> block content from a Vue SFC.
 * Returns { content, startLine } or null if no template found.
 */
function extractTemplateBlock(src) {
  // Find outermost <template> using balanced matching
  const openRe = /<template\b[^>]*>/gi;
  const closeRe = /<\/template\s*>/gi;

  const events = [];
  let m;
  openRe.lastIndex = 0;
  while ((m = openRe.exec(src))) {
    events.push({ kind: "open", idx: m.index, end: m.index + m[0].length });
  }
  closeRe.lastIndex = 0;
  while ((m = closeRe.exec(src))) {
    events.push({ kind: "close", idx: m.index, end: m.index + m[0].length });
  }
  events.sort((a, b) => a.idx - b.idx);

  let depth = 0;
  let firstOpenEnd = -1;
  let closeIdx = -1;

  for (const ev of events) {
    if (ev.kind === "open") {
      if (depth === 0) {
        firstOpenEnd = ev.end;
      }
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        closeIdx = ev.idx;
        break;
      }
    }
  }

  if (firstOpenEnd === -1 || closeIdx === -1) return null;

  const templateSrc = src.slice(firstOpenEnd, closeIdx).trim();
  const startLine = src.slice(0, firstOpenEnd).split("\n").length;

  return { content: templateSrc, startLine };
}

/**
 * Check if a string looks like a self-closing or void HTML element.
 */
function isVoidOrSelfClosing(tag) {
  const voidElements = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const name = tag.replace(/^<\s*/, "").replace(/\s.*$/, "").replace(/\/$/, "").toLowerCase();
  return voidElements.has(name) || tag.trimEnd().endsWith("/>");
}

/**
 * Find root-level elements in template content.
 * Root elements are those not nested inside any other element.
 * Ignores text-only nodes, HTML comments, and structural <template> wrappers
 * (like <template v-if> used for conditional rendering at root level).
 *
 * Returns an array of { tag, hasAttrsBind } for each root element found.
 */
function findRootElements(templateSrc) {
  const cleaned = stripComments(templateSrc);
  const roots = [];

  let depth = 0;
  let i = 0;

  while (i < cleaned.length) {
    // Skip whitespace
    if (cleaned[i] === " " || cleaned[i] === "\n" || cleaned[i] === "\r" || cleaned[i] === "\t") {
      i++;
      continue;
    }

    // Check for tag opening
    if (cleaned[i] === "<") {
      // Check if it's a closing tag
      if (cleaned[i + 1] === "/") {
        const closeEnd = cleaned.indexOf(">", i);
        if (closeEnd === -1) break;
        depth--;
        i = closeEnd + 1;
        continue;
      }

      // Skip comments (should already be stripped, but be safe)
      if (cleaned.slice(i, i + 4) === "<!--") {
        const commentEnd = cleaned.indexOf("-->", i);
        if (commentEnd === -1) break;
        i = commentEnd + 3;
        continue;
      }

      // Find the end of this opening tag
      let tagEnd = i;
      let inQuote = false;
      let quoteChar = "";
      while (tagEnd < cleaned.length) {
        const ch = cleaned[tagEnd];
        if (inQuote) {
          if (ch === quoteChar && cleaned[tagEnd - 1] !== "\\") {
            inQuote = false;
          }
        } else if (ch === '"' || ch === "'") {
          inQuote = true;
          quoteChar = ch;
        } else if (ch === ">") {
          break;
        }
        tagEnd++;
      }

      if (tagEnd >= cleaned.length) break;

      const tagStr = cleaned.slice(i, tagEnd + 1);
      const isSelfClosing = tagStr.endsWith("/>") || isVoidOrSelfClosing(tagStr);

      // Extract just the tag name
      const tagNameMatch = tagStr.match(/^<\s*(\w[\w-]*)/);
      const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : "";

      // Check for v-bind="$attrs"
      const hasAttrsBind = /\bv-bind\s*=\s*["']\$attrs["']/.test(tagStr);

      if (depth === 0) {
        // This is a root-level element
        // Skip structural <template> wrappers (they're transparent)
        if (tagName !== "template") {
          roots.push({ tag: tagName, hasAttrsBind });
        }
      }

      if (!isSelfClosing) {
        depth++;
      }

      i = tagEnd + 1;
      continue;
    }

    // Non-tag content (text) at root level — if it's not just whitespace, it's a root node
    // But we only care about element roots, so skip text content
    // Find next "<" or end of string
    const nextTag = cleaned.indexOf("<", i);
    if (nextTag === -1) break;
    const textContent = cleaned.slice(i, nextTag).trim();
    if (textContent && depth === 0) {
      // Text node at root level — this counts as a root node (fragment)
      // Record it as a non-element root
      roots.push({ tag: "#text", hasAttrsBind: false });
    }
    i = nextTag;
  }

  return roots;
}

/**
 * Walk a directory recursively, finding all .vue files.
 */
async function walkVueFiles(dir, out = [], skipDirs = new Set(["node_modules", "__tests__", "dist", ".git"])) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkVueFiles(full, out, skipDirs);
    } else if (entry.isFile() && entry.name.endsWith(".vue")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Main audit function.
 */
export async function runMultiRootAttrsAudit({ root, roots = ["src"], skipDirs: extraSkipDirs = [] } = {}) {
  const repoRoot = root || process.cwd();
  const skipDirs = new Set(["node_modules", "__tests__", "dist", ".git", ...extraSkipDirs]);

  const findings = [];

  for (const rootDir of roots) {
    const dirPath = path.resolve(repoRoot, rootDir);
    const vueFiles = await walkVueFiles(dirPath, [], skipDirs);

    for (const filePath of vueFiles) {
      let src;
      try {
        src = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      // Skip if the component explicitly opts out via inheritAttrs: false
      // (including via defineOptions macro in <script setup>).
      if (/\binheritAttrs\s*:\s*false\b/.test(src)) continue;

      const template = extractTemplateBlock(src);
      if (!template) continue;

      const roots = findRootElements(template.content);

      // Only flag if there are multiple root elements
      if (roots.length <= 1) continue;

      // Check if all root elements are inside a single wrapper with v-bind="$attrs"
      const hasAttrsWrapper = roots.length === 1 && roots[0].hasAttrsBind;

      // If there's a single root with $attrs binding, it's fine
      if (hasAttrsWrapper) continue;

      const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, "/");
      const rootTags = roots.map((r) => `<${r.tag}>`).join(", ");

      findings.push({
        file: relativePath,
        line: template.startLine,
        rootCount: roots.length,
        rootTags,
        hasAnyAttrsBind: roots.some((r) => r.hasAttrsBind),
      });
    }
  }

  const passed = findings.length === 0;

  let report = "# Multi-Root Vue SFCs Missing `$attrs` Binding\n\n";
  if (passed) {
    report += "✅ All Vue SFCs with multiple root elements properly bind `$attrs`.\n";
  } else {
    report += `## multi-root-attrs — ${findings.length} (warning)\n\n`;
    report += `Found **${findings.length}** Vue SFC(s)** with multiple root elements that do not bind \`v-bind="$attrs"\`.\n\n`;
    report +=
      "Multi-root components (fragments) do **not** automatically inherit attributes from parent components. " +
      "The `class`, `style`, `data-testid`, and other attributes passed by the parent are silently discarded.\n\n";
    report += 'Wrap the roots in a single element with `v-bind="$attrs"`:\n\n';
    report +=
      '```html\n<template>\n  <div v-bind="$attrs">\n    <ChildA v-if="..." />\n    <ChildB v-else />\n  </div>\n</template>\n```\n\n';
    report += "## Findings\n\n";
    for (const f of findings) {
      report += `- **\`${f.file}\`** (line ${f.line}): ${f.rootCount} root elements (${f.rootTags})\n`;
    }
  }

  return {
    passed,
    findings,
    jsonPayload: { findings },
    report,
  };
}
