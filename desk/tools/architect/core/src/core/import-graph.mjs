/**
 * Codebase-agnostic import graph builder.
 *
 * Pure regex-based extraction of imports/re-exports/exports across JS/TS/Vue/
 * MJS/CJS/JSX/TSX. Resolves relative specifiers and user-supplied aliases. Does
 * NOT use the TypeScript compiler or any framework-specific parser — designed
 * for sub-second runs on large repos via single-pass scanning.
 *
 * Consumed by:
 *   - dep-rules-engine        (dependency-cruiser-style forbidden/allowed edges)
 *   - circular-deps-engine    (madge-style DFS cycle detection)
 *   - unused-exports-engine   (knip/ts-prune-style)
 *   - orphan-files-engine     (unimported-style reachability)
 */
import fs from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "./files.mjs";
import { normalizePath } from "./path.mjs";

const RESOLVE_DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"];

const IMPORT_FROM_RE = /(?:^|[\s;{(])import\s+(?:type\s+)?(?:[^'"`;]+?\sfrom\s+)?["']([^"'`]+)["']/g;
const EXPORT_FROM_RE = /(?:^|[\s;{(])export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"'`]+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"'`]+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"'`]+)["']\s*\)/g;

const NAMED_IMPORT_RE = /import\s*(type\s+)?\{([^}]+)\}\s*from\s*["']([^"'`]+)["']/g;
const DEFAULT_IMPORT_RE = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*["']([^"'`]+)["']/g;
const NAMESPACE_IMPORT_RE = /import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"'`]+)["']/g;

const NAMED_EXPORT_RE =
  /^[ \t]*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/gm;
const CONST_EXPORT_RE = /^[ \t]*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]+)\}(?!\s*from)/gm;
const EXPORT_DEFAULT_RE = /^[ \t]*export\s+default\b/gm;
const RE_EXPORT_NAMED_RE = /^[ \t]*export\s*\{([^}]+)\}\s*from\s*["']([^"'`]+)["']/gm;
const RE_EXPORT_STAR_RE = /^[ \t]*export\s*\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\s*["']([^"'`]+)["']/gm;

export function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

// Mask everything that is NOT live code — comment bodies and template-literal
// contents — by overwriting it with spaces (newlines preserved, so every byte
// offset and line number is unchanged). Single/double-quoted strings are LEFT
// INTACT on purpose: a real `import … from "x"` carries its specifier in such a
// string, and the import/export regexes only accept '/" specifiers — never
// backticks. So blanking backtick template bodies can never erase a real edge,
// but it DOES erase the classic false positive: an `import … from 'pkg'` written
// as EXAMPLE CODE inside a backtick doc-string (a guide, a README literal). A
// commented-out import is masked for the same reason — it is not a real edge.
function maskNonCode(text) {
  const n = text.length;
  let out = "";
  let i = 0;
  // A stack models template ⇄ interpolation nesting. The top frame's kind picks
  // the mode: "code" copies chars (and detects string/comment/template starts);
  // "tmpl" blanks chars (a template-literal body). A `${ … }` inside a template
  // pushes a brace-balanced "code" frame, so real code (even a dynamic import())
  // inside an interpolation is still seen, while the surrounding doc text is not.
  const stack = [{ kind: "code", interp: false, braces: 0 }];
  const blank = (ch) => (ch === "\n" ? "\n" : " ");

  while (i < n) {
    const frame = stack[stack.length - 1];
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    if (frame.kind === "tmpl") {
      if (ch === "\\") {
        out += blank(ch) + (next ? blank(next) : "");
        i += 2;
        continue;
      }
      if (ch === "$" && next === "{") {
        out += "  ";
        stack.push({ kind: "code", interp: true, braces: 0 });
        i += 2;
        continue;
      }
      if (ch === "`") {
        out += " ";
        stack.pop();
        i += 1;
        continue;
      }
      out += blank(ch);
      i += 1;
      continue;
    }

    // ── code context ──
    if (ch === "/" && next === "/") {
      // line comment → blank through end of line (string-aware: a `//` inside a
      // string is handled by the string branch below, so URLs never trip this).
      while (i < n && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += blank(text[i]);
        i += 1;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      // string literal → copy verbatim so its specifier survives extraction.
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          out += c + (i + 1 < n ? text[i + 1] : "");
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === quote || c === "\n") break; // close, or unterminated-line safety
      }
      continue;
    }
    if (ch === "`") {
      out += " ";
      stack.push({ kind: "tmpl" });
      i += 1;
      continue;
    }
    if (frame.interp) {
      // brace-balance to find the `}` that closes this `${ … }` interpolation.
      if (ch === "{") {
        frame.braces += 1;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "}") {
        if (frame.braces === 0) {
          out += " ";
          stack.pop();
          i += 1;
          continue;
        }
        frame.braces -= 1;
        out += ch;
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractScriptFromVue(text) {
  const blocks = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(text))) {
    blocks.push({ body: match[1], offset: match.index + match[0].indexOf(match[1]) });
  }
  if (blocks.length === 0) return { text, mapBack: (i) => i };
  const stitched = blocks.map((b) => b.body).join("\n");
  return {
    text: stitched,
    mapBack: (stitchedIndex) => {
      let cursor = 0;
      for (const block of blocks) {
        if (stitchedIndex <= cursor + block.body.length) {
          return block.offset + (stitchedIndex - cursor);
        }
        cursor += block.body.length + 1;
      }
      return blocks[blocks.length - 1].offset + blocks[blocks.length - 1].body.length;
    },
  };
}

function readableSource(filePath, raw) {
  if (filePath.endsWith(".vue")) {
    const extracted = extractScriptFromVue(raw);
    return { source: maskNonCode(extracted.text), mapBack: extracted.mapBack };
  }
  return { source: maskNonCode(raw), mapBack: (i) => i };
}

function resolveAlias(specifier, aliases) {
  // Pick the LONGEST matching prefix so specific aliases win over general ones
  // (e.g. `@lunawerx/ui/` beats a hypothetical `@lunawerx/`). Object key order
  // is not guaranteed to be longest-first once tsconfig + explicit aliases are
  // merged, so we compare lengths explicitly rather than returning first match.
  let best = null;
  for (const [prefix, target] of Object.entries(aliases ?? {})) {
    if (specifier === prefix || specifier.startsWith(prefix)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, target };
    }
  }
  if (!best) return null;
  return best.target + specifier.slice(best.prefix.length);
}

// ── tsconfig `paths` → alias map ───────────────────────────────────
// The resolver speaks prefix-aliases (`"@/": "src/"`); tsconfig speaks glob
// patterns (`"@/*": ["./src/*"]`). This converts the latter to the former so
// the import graph resolves EVERY alias the TS compiler honors — not just the
// hand-copied subset each check used to declare. Single source of truth.

function stripJsonComments(text) {
  // String-aware: never strips `//` or `/* */` that live inside a JSON string.
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonc(text) {
  // Comments first (string-aware), then trailing commas. tsconfig path values
  // are file globs and never contain a `,` immediately before `}`/`]`, so the
  // trailing-comma regex is safe here.
  return JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1"));
}

function tsconfigPatternToPrefix(pattern) {
  // "@/*" → "@/", "src/*" → "src/", "bun:test" → "bun:test"
  if (pattern.endsWith("/*")) return pattern.slice(0, -1);
  if (pattern.endsWith("*")) return pattern.slice(0, -1);
  return pattern;
}

/**
 * Read a tsconfig's `compilerOptions.paths` (following a single relative
 * `extends` chain) and return them as a resolver-ready prefix→target alias map,
 * with targets relative to `root`. Missing tsconfig → `{}` (a JS-only project
 * legitimately declares no path aliases). A MALFORMED tsconfig throws — config
 * corruption is a real error, not an absence.
 */
export async function loadTsconfigAliases(root, tsconfigPath = "tsconfig.json", seen = new Set()) {
  const absolute = path.isAbsolute(tsconfigPath) ? tsconfigPath : path.resolve(root, tsconfigPath);
  if (seen.has(absolute)) return {};
  seen.add(absolute);

  let raw;
  try {
    raw = await fs.readFile(absolute, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
  const config = parseJsonc(raw);

  let inherited = {};
  if (typeof config.extends === "string" && config.extends.startsWith(".")) {
    const parent = path.resolve(path.dirname(absolute), config.extends);
    const parentPath = parent.endsWith(".json") ? parent : `${parent}.json`;
    inherited = await loadTsconfigAliases(root, parentPath, seen);
  }

  const paths = config?.compilerOptions?.paths;
  const own = {};
  if (paths && typeof paths === "object") {
    const tsconfigDir = path.dirname(absolute);
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const target = targets[0];
      if (typeof target !== "string") continue;
      const prefix = tsconfigPatternToPrefix(pattern);
      // tsconfig path targets resolve relative to the tsconfig dir; normalize
      // to a `root`-relative POSIX prefix so it composes with the resolver.
      const absoluteTarget = path.resolve(tsconfigDir, target.replace(/\*$/, ""));
      let relativeTarget = normalizePath(path.relative(root, absoluteTarget));
      // `path.resolve` strips trailing slashes; the resolver concatenates
      // `target + specifier.slice(prefix.length)`, so a glob prefix (`@/`) must
      // keep its slash or `@/foo` resolves to `srcfoo`.
      if (prefix.endsWith("/") && relativeTarget && !relativeTarget.endsWith("/")) {
        relativeTarget += "/";
      }
      own[prefix] = relativeTarget;
    }
  }

  // Child paths override inherited ones, matching tsconfig semantics.
  return { ...inherited, ...own };
}

async function fileExists(absolutePath) {
  try {
    const stat = await fs.stat(absolutePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveCandidatePath(basePath, extensions) {
  if (await fileExists(basePath)) return basePath;
  for (const extension of extensions) {
    const candidate = `${basePath}${extension}`;
    if (await fileExists(candidate)) return candidate;
  }
  for (const extension of extensions) {
    const candidate = path.join(basePath, `index${extension}`);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

export function createSpecifierResolver({ root, aliases = {}, extensions = RESOLVE_DEFAULT_EXTENSIONS } = {}) {
  return async function resolveSpecifier(specifier, importerAbsolute) {
    if (!specifier) return null;
    if (specifier.startsWith(".")) {
      const baseAbsolute = path.resolve(path.dirname(importerAbsolute), specifier);
      return resolveCandidatePath(baseAbsolute, extensions);
    }
    const aliasTarget = resolveAlias(specifier, aliases);
    if (aliasTarget) {
      const baseAbsolute = path.resolve(root, aliasTarget);
      return resolveCandidatePath(baseAbsolute, extensions);
    }
    return null;
  };
}

function parseExportList(body) {
  return body
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m) return null;
      return m[2] ?? m[1];
    })
    .filter(Boolean);
}

// Net `{` − `}` count in `text` before `index`, used to tell a top-level
// `require()` (runs at load) from a function-scoped one (deferred). `text` must
// be brace-safe — strings/comments/templates blanked — so only real code braces
// count.
function braceDepthBefore(text, index) {
  let depth = 0;
  const end = Math.min(index, text.length);
  for (let k = 0; k < end; k += 1) {
    const code = text.charCodeAt(k);
    if (code === 123) depth += 1; // {
    else if (code === 125) depth -= 1; // }
  }
  return depth;
}

function collectImports(source, mapBack) {
  const specifiers = [];
  const namedImports = []; // { name, line, specifier }
  const seen = new Set();
  // `source` already has comments + template bodies masked; single/double
  // strings survive (their specifier is needed). For brace counting we also
  // blank those strings so a `{` inside a literal can't skew the depth.
  const braceSafe = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => " ".repeat(m.length));

  function add(specifier, originalIndex, importKind) {
    const key = `${specifier}@${originalIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    specifiers.push({ specifier, line: lineNumberAt(source, originalIndex), rawIndex: originalIndex, importKind });
  }

  // `import type {…}` / `export type {…}` edges are erased at compile time, so
  // they are not real runtime dependencies. Tag them so cycle/coupling checks
  // can exclude them. Inline `import { type A, B }` stays "value" (B is real) —
  // we only flag a whole-statement `type` keyword, which is the safe side.
  for (const re of [IMPORT_FROM_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      const head = source.slice(match.index, match.index + 32);
      add(match[1], match.index, /(?:import|export)\s+type[\s{]/.test(head) ? "type" : "value");
    }
  }
  // Dynamic `import()` is deferred (code-split): tag it distinctly so cycle
  // detection can exclude it. A cycle that only closes through a dynamic import
  // is NOT a load-time cycle — it's the lazy-loading pattern that BREAKS one.
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  let dynamicMatch;
  while ((dynamicMatch = DYNAMIC_IMPORT_RE.exec(source))) {
    add(dynamicMatch[1], dynamicMatch.index, "dynamic");
  }
  // A top-level `require()` runs synchronously at load → a real load-time edge
  // ("value"). A require() nested inside a function/method body is deferred
  // exactly like a dynamic `import()` — it is the deliberate lazy-require used to
  // BREAK an import cycle (e.g. `const { x } = require("../extension")` inside a
  // method). Tag the nested case "dynamic" so cycle detection ignores it, while
  // reachability/hygiene (which don't filter dynamic edges) still count it. Brace
  // depth > 0 ⇒ nested; this keeps real top-level CJS cycles detectable in any repo.
  REQUIRE_RE.lastIndex = 0;
  let requireMatch;
  while ((requireMatch = REQUIRE_RE.exec(source))) {
    const nested = braceDepthBefore(braceSafe, requireMatch.index) > 0;
    add(requireMatch[1], requireMatch.index, nested ? "dynamic" : "value");
  }

  for (const re of [NAMED_IMPORT_RE, RE_EXPORT_NAMED_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      const body = match[2] ?? match[1];
      const specifier = match[3] ?? match[2];
      if (!body || !specifier) continue;
      const names = parseExportList(body);
      for (const name of names) {
        namedImports.push({ name, specifier, line: lineNumberAt(source, match.index) });
      }
    }
  }

  DEFAULT_IMPORT_RE.lastIndex = 0;
  let defaultMatch;
  while ((defaultMatch = DEFAULT_IMPORT_RE.exec(source))) {
    namedImports.push({
      name: "default",
      specifier: defaultMatch[2],
      line: lineNumberAt(source, defaultMatch.index),
    });
  }

  NAMESPACE_IMPORT_RE.lastIndex = 0;
  let nsMatch;
  while ((nsMatch = NAMESPACE_IMPORT_RE.exec(source))) {
    namedImports.push({
      name: "*",
      specifier: nsMatch[2],
      line: lineNumberAt(source, nsMatch.index),
    });
  }

  return {
    specifiers: specifiers.map((entry) => ({
      ...entry,
      line: lineNumberAt(source, entry.rawIndex),
      rawIndex: mapBack(entry.rawIndex),
    })),
    namedImports,
  };
}

function collectExports(source) {
  const exportsList = [];

  for (const re of [NAMED_EXPORT_RE, CONST_EXPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      exportsList.push({ name: match[1], line: lineNumberAt(source, match.index) });
    }
  }

  EXPORT_LIST_RE.lastIndex = 0;
  let listMatch;
  while ((listMatch = EXPORT_LIST_RE.exec(source))) {
    const names = parseExportList(listMatch[1]);
    for (const name of names) {
      exportsList.push({ name, line: lineNumberAt(source, listMatch.index) });
    }
  }

  EXPORT_DEFAULT_RE.lastIndex = 0;
  let defaultMatch;
  while ((defaultMatch = EXPORT_DEFAULT_RE.exec(source))) {
    exportsList.push({ name: "default", line: lineNumberAt(source, defaultMatch.index) });
  }

  RE_EXPORT_NAMED_RE.lastIndex = 0;
  let reExport;
  while ((reExport = RE_EXPORT_NAMED_RE.exec(source))) {
    const names = parseExportList(reExport[1]);
    for (const name of names) {
      exportsList.push({ name, line: lineNumberAt(source, reExport.index), reExportedFrom: reExport[2] });
    }
  }

  RE_EXPORT_STAR_RE.lastIndex = 0;
  let starMatch;
  while ((starMatch = RE_EXPORT_STAR_RE.exec(source))) {
    if (starMatch[1]) {
      exportsList.push({
        name: starMatch[1],
        line: lineNumberAt(source, starMatch.index),
        reExportedFrom: starMatch[2],
      });
    } else {
      exportsList.push({ name: "*", line: lineNumberAt(source, starMatch.index), reExportedFrom: starMatch[2] });
    }
  }

  return exportsList;
}

export async function buildImportGraph({
  root,
  roots,
  extensions = RESOLVE_DEFAULT_EXTENSIONS,
  aliases = {},
  skipSegments,
  tsconfigPath = "tsconfig.json",
} = {}) {
  if (!root) throw new Error("buildImportGraph: root is required");
  if (!Array.isArray(roots) || roots.length === 0) throw new Error("buildImportGraph: roots is required");

  // Resolve through the project's real tsconfig `paths` (every alias the TS
  // compiler honors) merged UNDER any explicit aliases the caller passed, so a
  // caller can still override. Pass `tsconfigPath: null` to opt out entirely.
  const tsconfigAliases = tsconfigPath ? await loadTsconfigAliases(root, tsconfigPath) : {};
  const effectiveAliases = { ...tsconfigAliases, ...aliases };

  const files = await walkFiles({ root, roots, extensions, skipSegments });
  const resolveSpecifier = createSpecifierResolver({ root, aliases: effectiveAliases, extensions });
  const nodes = new Map();

  for (const relPath of files) {
    const absolutePath = path.resolve(root, relPath);
    let raw;
    try {
      raw = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const { source, mapBack } = readableSource(relPath, raw);
    const { specifiers, namedImports } = collectImports(source, mapBack);
    const exportsList = collectExports(source);

    const importEdges = [];
    for (const entry of specifiers) {
      const resolvedAbsolute = await resolveSpecifier(entry.specifier, absolutePath);
      const resolvedRelative = resolvedAbsolute ? normalizePath(path.relative(root, resolvedAbsolute)) : null;
      importEdges.push({
        specifier: entry.specifier,
        line: entry.line,
        resolved: resolvedRelative,
        external: resolvedRelative === null && !entry.specifier.startsWith("."),
        importKind: entry.importKind ?? "value",
      });
    }

    const namedEdges = [];
    for (const entry of namedImports) {
      const resolvedAbsolute = await resolveSpecifier(entry.specifier, absolutePath);
      const resolvedRelative = resolvedAbsolute ? normalizePath(path.relative(root, resolvedAbsolute)) : null;
      namedEdges.push({
        name: entry.name,
        specifier: entry.specifier,
        line: entry.line,
        resolved: resolvedRelative,
      });
    }

    nodes.set(relPath, {
      filePath: relPath,
      imports: importEdges,
      namedImports: namedEdges,
      exports: exportsList,
    });
  }

  return { files, nodes, resolveSpecifier };
}
