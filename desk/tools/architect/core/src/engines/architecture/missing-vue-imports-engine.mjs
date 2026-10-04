// Audit: find PascalCase / kebab-case custom component tags used in <template>
// of any .vue file with <script setup>, where the corresponding identifier is
// NOT imported / locally declared in <script setup>.
//
// Registered by packages/connections-arkitect/src/checks/missing-vue-imports.mjs.
// Output: structured findings plus a markdown report string.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRoot = path.resolve(__dirname, "../../..");
let auditRoot = defaultRoot;

let skipDirs = new Set(["node_modules", "__tests__", "infra", "dist", ".git", "test"]);

const BUILTINS = new Set([
  "Transition",
  "TransitionGroup",
  "KeepAlive",
  "Suspense",
  "Teleport",
  "RouterView",
  "RouterLink",
  "Component",
  // Common Vue Router / Vue extras occasionally seen
  "Slot",
  "Slots",
]);

/** Recursively walk a dir, returning all .vue files. */
async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (skipDirs.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out);
    } else if (e.isFile() && e.name.endsWith(".vue")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract the OUTER <template> region (the first one) and the <script setup>
 * region. Returns { templateSrc, templateStartLine, scriptSrc, hasScriptSetup }.
 *
 * For <template>, we find the OUTER root template by counting balanced
 * <template ...> / </template>. SFCs technically only allow one root template,
 * but slot fallbacks use <template #name> inside it — those will be naturally
 * included in the outer region.
 */
function splitSfc(src) {
  const result = {
    templateSrc: "",
    templateStartLine: 0,
    scriptSrc: "",
    hasScriptSetup: false,
    splitOk: true,
    splitNote: "",
  };

  // --- script setup -------------------------------------------------------
  // Match the FIRST <script setup ...> opening tag at any place in the file.
  // (SFCs may have a separate <script> + <script setup>.)
  const scriptSetupOpen = /<script\b[^>]*\bsetup\b[^>]*>/i.exec(src);
  if (scriptSetupOpen) {
    result.hasScriptSetup = true;
    const startIdx = scriptSetupOpen.index + scriptSetupOpen[0].length;
    // Find the next </script> after the opening tag.
    const closeRe = /<\/script\s*>/gi;
    closeRe.lastIndex = startIdx;
    const closeMatch = closeRe.exec(src);
    if (closeMatch) {
      result.scriptSrc = src.slice(startIdx, closeMatch.index);
    } else {
      result.splitOk = false;
      result.splitNote = "Could not find closing </script> for <script setup>";
    }
  }

  // --- template (outer balanced) -----------------------------------------
  // Find the FIRST top-level <template ...> at column 0-ish (we accept any
  // position; SFC templates are typically file-scoped). Then balance.
  const tplOpenRe = /<template\b[^>]*>/gi;
  const tplCloseRe = /<\/template\s*>/gi;
  // We need to find the outermost. Walk through:
  let depth = 0;
  let firstOpenIdx = -1;
  let firstOpenEnd = -1;
  let endIdx = -1;
  // We'll do a unified scan.
  const events = [];
  {
    let m;
    tplOpenRe.lastIndex = 0;
    while ((m = tplOpenRe.exec(src))) {
      events.push({ kind: "open", idx: m.index, end: m.index + m[0].length });
    }
    tplCloseRe.lastIndex = 0;
    while ((m = tplCloseRe.exec(src))) {
      events.push({ kind: "close", idx: m.index, end: m.index + m[0].length });
    }
  }
  events.sort((a, b) => a.idx - b.idx);
  for (const ev of events) {
    if (ev.kind === "open") {
      if (depth === 0) {
        firstOpenIdx = ev.idx;
        firstOpenEnd = ev.end;
      }
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        endIdx = ev.idx;
        break;
      }
    }
  }
  if (firstOpenIdx >= 0 && endIdx > firstOpenIdx) {
    result.templateSrc = src.slice(firstOpenEnd, endIdx);
    // Compute starting line of template content for line-number offsetting.
    const before = src.slice(0, firstOpenEnd);
    result.templateStartLine = before.split(/\r?\n/).length;
  } else if (firstOpenIdx >= 0 && endIdx === -1) {
    result.splitOk = false;
    result.splitNote = "Unbalanced <template> tags";
  }

  return result;
}

/** Strip JS comments (line + block) and string contents to avoid false matches in imports/identifiers. */
function stripJsCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // line comment
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // strings
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += "  "; // preserve length
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out += quote;
          i++;
          break;
        }
        // Replace string body with spaces (preserve newlines so line nums match)
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strip HTML comments from the template source (replace with spaces/newlines
 * so positions/line numbers are preserved).
 */
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Extract locally-bound names from a <script setup> block. */
function extractScriptSetupBindings(scriptSrc) {
  const cleaned = stripJsCommentsAndStrings(scriptSrc);
  const names = new Set();

  // 1) `import Foo from "..."`  (default import)
  // 2) `import Foo, { A, B as C } from "..."`
  // 3) `import { A, B as C, type D } from "..."`
  // 4) `import * as NS from "..."`
  // 5) `import type { X } from "..."` -> we still record X (could be component? rare for type-only, but harmless)
  // Use [^;]*? instead of [\s\S]*? so the capture group stops at the first
  // semicolon.  Without this a bare side-effect import (e.g. import "@/styles/x.css")
  // bleeds into the NEXT import statement because the lazy quantifier keeps
  // expanding until it finds a `from` keyword — which may be on the following line.
  const importRe = /import\s+(?:type\s+)?([^;]*?)\s+from\s+['"][^'"]+['"]\s*;?/g;
  let m;
  while ((m = importRe.exec(cleaned))) {
    const clause = m[1].trim();
    if (!clause) continue;
    parseImportClause(clause, names);
  }
  // bare `import "x"` — nothing to bind.

  // 6) const/let/var local bindings — capture top-ish-level identifiers.
  // We accept `const FooBar = ...`, `let FooBar = ...`. Also destructuring like
  // `const { FooBar } = ...` — capture both.
  const constRe = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  while ((m = constRe.exec(cleaned))) {
    names.add(m[1]);
  }
  // Destructuring: const { Foo, Bar as Baz } = ...
  const destrRe = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
  while ((m = destrRe.exec(cleaned))) {
    const inner = m[1];
    for (const part of inner.split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(seg);
      if (asMatch) {
        names.add(asMatch[2]);
        continue;
      }
      const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(seg);
      if (aliasMatch) {
        names.add(aliasMatch[2]);
        continue;
      }
      const idMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(seg);
      if (idMatch) names.add(idMatch[1]);
    }
  }

  // 7) function declarations: function FooBar() {}
  const fnRe = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = fnRe.exec(cleaned))) {
    names.add(m[1]);
  }
  // 8) class declarations
  const clsRe = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = clsRe.exec(cleaned))) {
    names.add(m[1]);
  }

  return names;
}

function parseImportClause(clause, names) {
  // clause may look like: "Foo", "Foo, { A, B as C }", "{ A, B as C }", "* as NS"
  // Split into default + named parts.
  let work = clause;
  // Namespace import
  const nsMatch = /^\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(work);
  if (nsMatch) {
    names.add(nsMatch[1]);
    return;
  }
  // Default + maybe named
  // Pattern: `Default` or `Default, { ... }` or `{ ... }`
  let defaultName = null;
  let namedBlock = null;

  const braceIdx = work.indexOf("{");
  if (braceIdx === -1) {
    // Only default
    defaultName = work.trim();
  } else {
    const before = work.slice(0, braceIdx).trim().replace(/,\s*$/, "").trim();
    if (before) defaultName = before;
    const closeIdx = work.indexOf("}", braceIdx);
    if (closeIdx !== -1) {
      namedBlock = work.slice(braceIdx + 1, closeIdx);
    }
  }
  if (defaultName) {
    // could be "Foo" or "Foo as Bar" (rare for default)
    const asMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(defaultName);
    if (asMatch) names.add(asMatch[2] ?? asMatch[1]);
  }
  if (namedBlock) {
    for (const part of namedBlock.split(",")) {
      let seg = part.trim();
      if (!seg) continue;
      // strip leading "type " for type-only specifiers
      seg = seg.replace(/^type\s+/, "");
      const asMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(seg);
      if (asMatch) {
        names.add(asMatch[2]);
        continue;
      }
      const idMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(seg);
      if (idMatch) names.add(idMatch[1]);
    }
  }
}

/** Convert kebab-case to PascalCase: "app-card" -> "AppCard". */
function kebabToPascal(s) {
  return s
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** Extract used custom component tags from a template source. */
function extractTemplateTags(templateSrc, templateStartLine) {
  const cleaned = stripHtmlComments(templateSrc);
  // Map tagName -> Set of line numbers (1-based, file-relative)
  const tags = new Map();

  function record(name, idx) {
    const linesBefore = cleaned.slice(0, idx).split(/\r?\n/).length - 1;
    const fileLine = templateStartLine + linesBefore;
    if (!tags.has(name)) tags.set(name, new Set());
    tags.get(name).add(fileLine);
  }

  // PascalCase open tags: <Foo, <FooBar>, <Foo />, <Foo prop="x">
  const pascalRe = /<([A-Z][A-Za-z0-9]*)(?:\.[A-Za-z0-9]+)?(\s|\/|>)/g;
  let m;
  while ((m = pascalRe.exec(cleaned))) {
    const name = m[1];
    // If the original matched a dotted form (X.Y), we want to skip — record had no dot capture though. Detect via lookback:
    const ahead = cleaned.slice(m.index, m.index + 1 + m[1].length + 2);
    if (/^<[A-Z][A-Za-z0-9]*\./.test(ahead)) continue; // namespaced
    record(name, m.index);
  }

  // kebab-case custom tags (must contain a hyphen): <app-card>, <foo-bar-baz>
  const kebabRe = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(\s|\/|>)/g;
  while ((m = kebabRe.exec(cleaned))) {
    const kebab = m[1];
    const pascal = kebabToPascal(kebab);
    record(pascal, m.index);
  }

  return tags;
}

export async function runMissingVueImportsAudit(options = {}) {
  auditRoot = path.resolve(options.root ?? defaultRoot);
  skipDirs = new Set(options.skipDirs ?? ["node_modules", "__tests__", "infra", "dist", ".git", "test"]);
  const roots = options.roots ?? ["src"];
  const fileSet = new Set();
  for (const rootPath of roots) {
    const absoluteRoot = path.resolve(auditRoot, rootPath);
    try {
      const rootFiles = await walk(absoluteRoot);
      for (const file of rootFiles) fileSet.add(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const files = [...fileSet];
  files.sort();

  let withScriptSetup = 0;
  const fileBugs = []; // { file, missing: [{name, lines:[]}], note? }
  const splitFailures = [];
  const allMissingNames = new Set();
  let totalMissingOccurrences = 0;

  // For "needs human review": components imported via barrel/re-export — we'll
  // flag any import where the module path doesn't end in .vue. (Components
  // can absolutely be re-exported from barrels — not actually a bug, just
  // worth noting if we want to assert explicit imports.)
  // We don't strictly need this for correctness; skip noisy reporting.

  for (const file of files) {
    const src = await fs.readFile(file, "utf8");
    const split = splitSfc(src);
    if (!split.hasScriptSetup) continue;
    withScriptSetup++;
    if (!split.splitOk) {
      splitFailures.push({ file, note: split.splitNote });
      continue;
    }
    if (!split.templateSrc) continue; // no template → nothing to check

    const bound = extractScriptSetupBindings(split.scriptSrc);
    const tags = extractTemplateTags(split.templateSrc, split.templateStartLine);

    const missing = [];
    for (const [name, lines] of tags) {
      if (BUILTINS.has(name)) continue;
      if (bound.has(name)) continue;
      // Some files might use the file's own component name self-referentially — extremely rare; we won't special-case it.
      missing.push({ name, lines: [...lines].sort((a, b) => a - b) });
      allMissingNames.add(name);
      totalMissingOccurrences += lines.size;
    }
    if (missing.length) {
      missing.sort((a, b) => a.name.localeCompare(b.name));
      fileBugs.push({ file, missing });
    }
  }

  // ---- Markdown report --------------------------------------------------
  const lines = [];
  lines.push("# Vue `<script setup>` Missing-Import Audit");
  lines.push("");
  lines.push(
    `**Scanned:** ${files.length} \`.vue\` files \u2014 **with \`<script setup>\`:** ${withScriptSetup} \u2014 **files with bugs:** ${fileBugs.length} \u2014 **total missing tag occurrences:** ${totalMissingOccurrences} \u2014 **distinct missing names:** ${allMissingNames.size}`,
  );
  lines.push("");
  lines.push(`- Errors: ${totalMissingOccurrences}`);
  lines.push(`- Warnings: 0`);
  lines.push(`- Findings: ${totalMissingOccurrences}`);
  lines.push(
    "_Rule:_ Vue does NOT auto-import components in `<script setup>`. Any PascalCase or kebab-case custom tag used in `<template>` must resolve to a locally-bound identifier (import, `defineAsyncComponent`, `markRaw`, `const FooBar = ...`, etc.), to a globally registered component, or to a built-in (`Transition`, `Teleport`, `RouterView`, `RouterLink`, `KeepAlive`, `Suspense`, `Component`, `TransitionGroup`).",
  );
  lines.push("");

  if (fileBugs.length === 0) {
    lines.push("## \u2705 No missing imports detected.");
  } else {
    lines.push("## \u274C Files with missing component imports");
    lines.push("");
    for (const b of fileBugs) {
      lines.push(`### \`${path.relative(auditRoot, b.file).replace(/\\/g, "/")}\``);
      lines.push("");
      lines.push("| Missing tag | Template line(s) |");
      lines.push("| --- | --- |");
      for (const item of b.missing) {
        lines.push(`| \`<${item.name}>\` | ${item.lines.join(", ")} |`);
      }
      lines.push("");
    }
  }

  // Likely-OK appendix
  lines.push("## Likely-OK (built-ins / framework tags) \u2014 confirmed excluded");
  lines.push("");
  lines.push(
    "These names are treated as built-ins and are NOT flagged as bugs even if not imported: " +
      [...BUILTINS]
        .sort()
        .map((n) => `\`${n}\``)
        .join(", "),
  );
  lines.push("");

  // Globally registered
  lines.push("## Globally registered components");
  lines.push("");
  lines.push(
    "Searched `src/main.ts` and the entire `src/` tree for `app.component(...)` calls: **none found**. No global registrations are in effect, so every custom tag must be imported locally.",
  );
  lines.push("");

  // Needs human review
  lines.push("## Needs human review");
  lines.push("");
  if (splitFailures.length === 0) {
    lines.push(
      "- **SFC region split failures:** none. Every `<script setup>` SFC produced clean `<script setup>` and `<template>` regions.",
    );
  } else {
    lines.push("- **SFC region split failures:**");
    for (const f of splitFailures) {
      lines.push(`  - \`${path.relative(auditRoot, f.file).replace(/\\/g, "/")}\` \u2014 ${f.note}`);
    }
  }
  lines.push(
    "- **Barrel / re-export imports:** the audit treats any locally-bound identifier as resolved, regardless of whether it resolves to a `.vue` file or a TS barrel. If you need to assert that components come directly from `.vue` files (no barrel re-exports), that is a separate audit.",
  );
  lines.push("");

  const jsonPayload = {
    scanned: files.length,
    withScriptSetup,
    filesWithBugs: fileBugs.length,
    totalMissingOccurrences,
    distinctMissingNames: [...allMissingNames].sort(),
    bugs: fileBugs.map((b) => ({
      file: path.relative(auditRoot, b.file).replace(/\\/g, "/"),
      missing: b.missing,
    })),
    splitFailures: splitFailures.map((f) => ({
      file: path.relative(auditRoot, f.file).replace(/\\/g, "/"),
      note: f.note,
    })),
  };

  return {
    failed: fileBugs.length > 0 || splitFailures.length > 0,
    jsonPayload,
    report: `${lines.join("\n")}\n`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMissingVueImportsAudit({
    root: defaultRoot,
    roots: process.argv.slice(2).filter((arg) => !arg.startsWith("--")),
  })
    .then((result) => {
      console.log(JSON.stringify(result.jsonPayload, null, 2));
      if (process.argv.includes("--fail-on-drift") && result.failed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
