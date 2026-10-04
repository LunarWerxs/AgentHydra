/**
 * Boot-graph engine — walks the STATIC import graph from configured entry
 * points (default: src/main.ts) and flags files in that graph that statically
 * import known-heavy dependencies. Heavy deps belong behind a dynamic
 * `import(...)` (lazy route, defineAsyncComponent, per-callsite loader)
 * rather than nailed onto every page's boot path.
 *
 * Key distinction from a bundle-size check: this is preventive. It tells you
 * BEFORE you ship that a static import chain now reaches libphonenumber-js /
 * tiptap / luxon / etc. Bundle-size checks tell you only after the chunk
 * arrives.
 *
 * Implementation notes:
 *  - Static reachability: walks `import x from`, `import "side-effect"`, and
 *    `export ... from "..."` (re-exports). Does NOT follow `import("...")` —
 *    those are dynamic and intentionally off the boot graph.
 *  - Vue SFCs: parses `<script>` blocks only, not template (template-level
 *    component refs are resolved by Vue at render time, not by static import).
 *  - Heavy-dep patterns: prefix matching ("libphonenumber-js" matches the
 *    package and ALL sub-paths like libphonenumber-js/min/...).
 *  - Chain hint: each finding includes the shortest import chain from an
 *    entry point to the offending file — derived from BFS parent pointers.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { createSpecifierResolver, loadTsconfigAliases } from "@saydeploy/architect/core/import-graph";
import { normalizePath } from "@saydeploy/architect/core/path";

// Runtime imports only — `import type {...}` and `export type {...} from`
// are erased by TypeScript and never contribute to the runtime boot graph.
// The negative-lookahead skips the `type` keyword variant; mixed-form
// `import { type X, foo } from "..."` is still treated as runtime because
// `foo` is a runtime binding.
const STATIC_IMPORT_RE = /(?:^|[\s;{(])import\s+(?!type\s)(?:[^'"`;]+?\sfrom\s+)?["']([^"'`]+)["']/g;
const EXPORT_FROM_RE =
  /(?:^|[\s;{(])export\s+(?!type\s)(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+["']([^"'`]+)["']/g;

function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

function stripLineComments(text) {
  return text.replace(/^[ \t]*\/\/.*$/gm, (match) => match.replace(/\S/g, " "));
}

function extractVueScript(text) {
  const blocks = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(text))) {
    blocks.push({ body: match[1], offset: match.index + match[0].indexOf(match[1]) });
  }
  if (blocks.length === 0) return { text: "", offsets: [] };
  // Stitch with newlines so line numbers in the stitched text map close to source.
  const stitched = blocks.map((b) => b.body).join("\n");
  // Build a mapping from stitched index → original index.
  return {
    text: stitched,
    mapBack(stitchedIndex) {
      let cursor = 0;
      for (const block of blocks) {
        if (stitchedIndex <= cursor + block.body.length) {
          return block.offset + (stitchedIndex - cursor);
        }
        cursor += block.body.length + 1;
      }
      const last = blocks[blocks.length - 1];
      return last.offset + last.body.length;
    },
  };
}

function readableSource(filePath, raw) {
  if (filePath.endsWith(".vue")) {
    const { text, mapBack } = extractVueScript(raw);
    const cleaned = stripLineComments(stripBlockComments(text));
    return { source: cleaned, mapBack: mapBack ?? ((i) => i) };
  }
  const cleaned = stripLineComments(stripBlockComments(raw));
  return { source: cleaned, mapBack: (i) => i };
}

function collectStaticImports(source) {
  const out = [];
  for (const re of [STATIC_IMPORT_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      out.push({ specifier: match[1], index: match.index });
    }
  }
  return out;
}

function matchesHeavyDep(specifier, heavyDeps) {
  for (const dep of heavyDeps) {
    if (specifier === dep.name) return dep;
    if (specifier.startsWith(`${dep.name}/`)) return dep;
  }
  return null;
}

async function readSafe(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function defaultHeavyDeps() {
  // sizeGz is an approximate gzipped contribution when the dep ends up on
  // the prod boot chunk; used only for prioritization in the report.
  return [
    {
      name: "libphonenumber-js",
      sizeGz: 30,
      reason: "phone metadata bundle (~710 KB raw); only sign-in/save-profile/vCard touch it",
    },
    { name: "luxon", sizeGz: 22, reason: "date math; only event/recurrence/timezone flows use it" },
    { name: "@tiptap", sizeGz: 90, reason: "rich-text editor schema; only forms/editor surfaces need it" },
    { name: "prosemirror-model", sizeGz: 25, reason: "tiptap dep — same constraint" },
    { name: "prosemirror-state", sizeGz: 25, reason: "tiptap dep — same constraint" },
    { name: "prosemirror-view", sizeGz: 40, reason: "tiptap dep — same constraint" },
    { name: "prosemirror-transform", sizeGz: 18, reason: "tiptap dep — same constraint" },
    { name: "dompurify", sizeGz: 22, reason: "HTML sanitization; only render-time sanitize needs it" },
    { name: "minisearch", sizeGz: 18, reason: "client search index; only the workspace search surface needs it" },
    { name: "@aws-sdk", sizeGz: 66, reason: "AWS SDK; only auth refresh/cognito calls touch it" },
    { name: "@smithy", sizeGz: 20, reason: "AWS SDK shared core; same constraint" },
    { name: "@ionic/vue", sizeGz: 80, reason: "Ionic web components; only native shell uses them" },
    { name: "@ionic/vue-router", sizeGz: 5, reason: "native router; web doesn't use it" },
    { name: "@ionic/core", sizeGz: 80, reason: "Ionic components; only native shell uses them" },
    { name: "ionicons", sizeGz: 50, reason: "Ionicons icon set; only the native tab bar uses it" },
    { name: "maplibre-gl", sizeGz: 200, reason: "MapLibre vector renderer; only map surfaces need it" },
    { name: "@maplibre", sizeGz: 20, reason: "MapLibre plugins; same constraint" },
    { name: "papaparse", sizeGz: 14, reason: "CSV parser; only import/export flows need it" },
    { name: "qrcode", sizeGz: 14, reason: "QR generation; only share-card flows need it" },
    { name: "rrule", sizeGz: 12, reason: "recurrence parser; only event recurrence touches it" },
    { name: "tz-lookup", sizeGz: 30, reason: "tz lookup table; only event timezone resolution needs it" },
  ];
}

export async function runBootGraphSection({ root, sectionConfig }) {
  const entryPoints = (sectionConfig.entryPoints ?? ["src/main.ts"]).map(normalizePath);
  const heavyDeps = sectionConfig.heavyDeps ?? defaultHeavyDeps();
  // Resolve through the real tsconfig `paths`, with any section-config aliases
  // layered on top. Keeps boot-graph's view of the import graph in sync with
  // the same single source of truth the other graph checks use.
  const tsconfigAliases = await loadTsconfigAliases(root);
  const aliases = { ...tsconfigAliases, ...(sectionConfig.aliases ?? {}) };
  const allowlist = await loadAllowlist(root, sectionConfig.allowlistPath);

  const resolveSpecifier = createSpecifierResolver({ root, aliases });

  // BFS from entry points across STATIC imports.
  // parent[file] = file that pulled it in. Entries map to null.
  const parent = new Map();
  const queue = [];
  for (const entry of entryPoints) {
    parent.set(entry, null);
    queue.push(entry);
  }

  const fileImports = new Map(); // file → [{ specifier, line }]

  while (queue.length > 0) {
    const rel = queue.shift();
    const abs = path.resolve(root, rel);
    const raw = await readSafe(abs);
    if (raw == null) continue;

    const { source, mapBack } = readableSource(rel, raw);
    const statics = collectStaticImports(source);
    const edgesForFile = [];

    for (const entry of statics) {
      const line = lineAt(raw, mapBack(entry.index));
      edgesForFile.push({ specifier: entry.specifier, line });
      const resolved = await resolveSpecifier(entry.specifier, abs);
      if (!resolved) continue;
      const resolvedRel = normalizePath(path.relative(root, resolved));
      if (!parent.has(resolvedRel)) {
        parent.set(resolvedRel, rel);
        queue.push(resolvedRel);
      }
    }
    fileImports.set(rel, edgesForFile);
  }

  // Now scan every file in the boot graph for heavy-dep static imports.
  const findings = [];
  for (const [file, edges] of fileImports) {
    const fileAllow = matchAllowlist(file, allowlist);
    for (const edge of edges) {
      const heavy = matchesHeavyDep(edge.specifier, heavyDeps);
      if (!heavy) continue;
      if (fileAllow && fileAllow.includes(heavy.name)) continue;
      findings.push({
        ruleId: "boot-graph-heavy-static-import",
        severity: "warning",
        filePath: file,
        line: edge.line,
        message: `static import of \`${edge.specifier}\` — ${heavy.reason}`,
        metadata: {
          baselineKey: `${file}:${edge.specifier}`,
          heavyDep: heavy.name,
          sizeGzKb: heavy.sizeGz,
          chain: tracebackChain(parent, file),
        },
      });
    }
  }

  // Boot-time prefetch storms: lazy `preload*()` / `prefetch*()` chains
  // scheduled to fire within the first few seconds of mount blow up the
  // post-paint request count even when the static graph is clean —
  // each preload is a whole route's worth of chunks + per-resource API
  // and image fetches. Flag any file in the boot graph that schedules
  // a preload/prefetch call with a `delayMs` literal below the configured
  // threshold (default 3000 ms).
  const prefetchStormThresholdMs = sectionConfig.prefetchStormThresholdMs ?? 3000;
  const PREFETCH_DELAY_RE = /\bdelayMs\s*:\s*(\d[\d_]*)/g;
  const PREFETCH_CALL_RE = /\b(?:preload|prefetch)[A-Z]\w*\s*\(/;
  for (const [file] of fileImports) {
    const abs = path.resolve(root, file);
    const raw = await readSafe(abs);
    if (!raw) continue;
    if (!PREFETCH_CALL_RE.test(raw)) continue;
    const fileAllow = matchAllowlist(file, allowlist);
    if (fileAllow && fileAllow.includes("prefetch-storm")) continue;
    PREFETCH_DELAY_RE.lastIndex = 0;
    let match;
    while ((match = PREFETCH_DELAY_RE.exec(raw))) {
      const ms = Number(match[1].replace(/_/g, ""));
      if (!Number.isFinite(ms) || ms >= prefetchStormThresholdMs) continue;
      const line = lineAt(raw, match.index);
      findings.push({
        ruleId: "boot-graph-prefetch-storm",
        severity: "warning",
        filePath: file,
        line,
        message: `\`delayMs: ${ms}\` schedules a preload/prefetch within ${prefetchStormThresholdMs} ms of mount — moves the request storm onto the user's first paint window. Push past ${prefetchStormThresholdMs} ms or gate on a user gesture (hover, focus).`,
        metadata: {
          baselineKey: `${file}:prefetch-storm:${ms}`,
          delayMs: ms,
          chain: tracebackChain(parent, file),
        },
      });
    }
  }

  // Sort findings by gz-size impact descending, then by file path.
  findings.sort((a, b) => {
    const bySize = (b.metadata.sizeGzKb ?? 0) - (a.metadata.sizeGzKb ?? 0);
    if (bySize !== 0) return bySize;
    return a.filePath.localeCompare(b.filePath);
  });

  // Group by heavy-dep for the report. Prefetch-storm findings don't
  // belong to a heavy dep — the report renderer handles them in its own
  // section.
  const byHeavyDep = {};
  for (const f of findings) {
    if (!f.metadata.heavyDep) continue;
    (byHeavyDep[f.metadata.heavyDep] ??= []).push(f);
  }

  return {
    filesInBootGraph: fileImports.size,
    entryPoints,
    findings,
    byHeavyDep,
  };
}

function tracebackChain(parent, file) {
  const chain = [];
  let current = file;
  while (current != null) {
    chain.unshift(current);
    current = parent.get(current);
    if (chain.length > 12) break; // cap absurd chains
  }
  return chain;
}

function matchAllowlist(file, allowlist) {
  if (!allowlist) return null;
  // allowlist is { file: [depName, ...] }
  if (allowlist[file]) return allowlist[file];
  // Also try with trailing slash prefix for directories.
  for (const [key, deps] of Object.entries(allowlist)) {
    if (key.endsWith("/") && file.startsWith(key)) return deps;
  }
  return null;
}

async function loadAllowlist(root, allowlistPath) {
  if (!allowlistPath) return null;
  try {
    const abs = path.resolve(root, allowlistPath);
    const raw = await fs.readFile(abs, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.files ?? parsed;
  } catch {
    return null;
  }
}
