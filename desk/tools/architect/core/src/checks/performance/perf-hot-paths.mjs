/**
 * Perf Hot Paths — connections-arkitect check
 * =============================================
 * Surfaces patterns that cause input lag / per-frame jank in Vue components.
 * Rules:
 *   1. perf-deep-watcher
 *      `watch(..., { deep: true })`. Each fire walks the watched tree; on a
 *      typing/scroll hot path this is a frame budget sink. Prefer a shallow
 *      watcher on a fingerprint (id, length, joined keys) or an explicit
 *      handler from the input itself.
 *
 *   2. perf-layout-read-in-handler
 *      `getBoundingClientRect()` or `getComputedStyle()` called inside an
 *      event-handler-shaped function (handle*, on*, *Down, *Move, *Scroll, …).
 *      Forces a layout/style flush per event — kills rapid taps and 60fps
 *      scroll. Cache the rect once, or read it lazily on first need.
 *
 *   3. perf-dom-query-in-component
 *      `document.querySelector*` / `getElementById` inside src/components/**.
 *      Components should use template refs (`ref()` + `:ref=`) so Vue tracks
 *      the binding; raw DOM queries break on teardown/Suspense and force a
 *      live tree walk on every call.
 *
 *   4. perf-animate-no-cancel
 *      `element.animate(` appears in a file that never calls `.cancel(`. Each
 *      call stacks a new WAAPI animation on the element; on rapid input the
 *      compositor churns through overlapping animations. Cancel the prior
 *      animation before spawning a new one (see useRipple for the pattern).
 *
 *   5. perf-virtual-list-spread-items
 *      `<AppVirtualList :items="[...rows]">` clones the whole item array during
 *      render. With large tables this turns normal reactive refreshes into
 *      thousands of object reads before virtualization can help.
 *
 *   6. perf-active-view-heavy-computed
 *      A computed that reads `activeView.value` and rebuilds high-volume
 *      contact/event collections will rerun when leaving/entering unrelated
 *      tabs. Gate tab state through a narrower ref so inactive surfaces do not
 *      rederive thousands of rows on every tab switch.
 *
 *   7. perf-virtualized-table-state-motion-guard
 *      AppTable must disable body state motion when virtualization is enabled.
 *      Virtualized tables are usually high-volume surfaces; wrapping them in
 *      content transitions can force expensive style/layout work during rapid
 *      tab switches.
 *
 * Scope: src/** and packages/connections-ui/src/** by default. Skips tests,
 * fixtures, and *.spec.* / *.test.* files.
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check perf-hot-paths
 */
import fs from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "@saydeploy/architect/core/files";

const RULES = {
  "perf-deep-watcher": {
    severity: "warning",
    description:
      "`watch(..., { deep: true })` — re-walks the watched tree on every reactive write. On input/scroll hot paths this is a frame-budget sink.",
  },
  "perf-layout-read-in-handler": {
    severity: "warning",
    description:
      "`getBoundingClientRect()` or `getComputedStyle()` inside an event handler. Forces a layout/style flush per event — kills rapid input and 60fps scroll.",
  },
  "perf-dom-query-in-component": {
    severity: "warning",
    description:
      "`document.querySelector*` / `getElementById` inside a Vue component. Use a template ref so Vue tracks the binding.",
  },
  "perf-animate-no-cancel": {
    severity: "warning",
    description:
      "File calls `element.animate(...)` but never `.cancel()`. Rapid retriggers stack overlapping WAAPI animations.",
  },
  "perf-virtual-list-spread-items": {
    severity: "warning",
    description:
      "`<AppVirtualList :items=\"[...rows]\">` clones the full row array during render. Pass a stable computed/ref instead.",
  },
  "perf-active-view-heavy-computed": {
    severity: "warning",
    description:
      "Heavy list/map derivation is directly coupled to `activeView.value`, so unrelated tab switches can rebuild large inactive surfaces.",
  },
  "perf-virtualized-table-state-motion-guard": {
    severity: "warning",
    description:
      "AppTable must gate `stateMotion` behind `!renderingVirtualized.value` so virtualized tables do not pay content-transition layout costs.",
  },
};

const DEFAULT_ROOTS = ["src", "packages/connections-ui/src"];
const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".vue", ".mjs"];

const DEEP_WATCHER_RE = /\bdeep\s*:\s*true\b/g;
const LAYOUT_READ_RE = /\b(getBoundingClientRect|getComputedStyle)\s*\(/g;
const DOM_QUERY_RE = /\bdocument\.(querySelector(?:All)?|getElementById)\s*\(/g;
const ANIMATE_CALL_RE = /\.animate\s*\(/g;
const ANIMATION_CANCEL_RE = /\.cancel\s*\(/;
const VIRTUAL_LIST_SPREAD_ITEMS_RE = /<AppVirtualList\b[\s\S]{0,1200}:items\s*=\s*["']\s*\[\s*\.\.\./g;
const COMPUTED_DECL_RE = /\bconst\s+(\w+)\s*=\s*computed\s*\(/g;
const HEAVY_COLLECTION_DERIVATION_RE =
  /(?:\.(?:filter|map|sort)\s*\(|\bfor\s*\(\s*(?:const|let)\s+|Array\.from\s*\()/;
const HIGH_VOLUME_WORKSPACE_SOURCE_RE =
  /\b(?:allContacts|directoryContactIndex|displayedContacts|displayedDirectoryContacts|eventScheduleEvents|mapFilteredEvents|myContacts|sortedDirectoryContactIds|sortedScheduleEventIds)\.value\b/;
const APP_TABLE_STATE_MOTION_GUARD_RE =
  /const\s+tableStateMotion\s*=\s*computed\s*\(\s*\(\)\s*=>\s*Boolean\s*\(\s*renderingConfig\.value\.stateMotion\s*\)\s*&&\s*!renderingVirtualized\.value\s*\)/;

// Function declaration / arrow / method definition whose name marks it as a
// handler. We look at the nearest preceding line; cheap and precise enough.
const HANDLER_NAME_RE =
  /(?:function\s+|const\s+|let\s+|var\s+|^[ \t]*(?:async\s+)?)?(handle[A-Z]\w*|on[A-Z]\w*|\w*(?:Down|Move|Up|Scroll|Wheel|Resize|Drag|Drop|Press|Tap|Touch|Click|Input|KeyDown|KeyUp)\b)/;

// Names that LOOK like handlers but are clearly readers/computers/converters.
// These pull state synchronously; finding `getBoundingClientRect()` inside them
// is expected behavior, not a hot-path hazard. The enclosing-function walker
// is approximate (it can grab the wrong scope across 200 lines); excluding
// reader-shaped names keeps the false-positive rate low.
const NON_HANDLER_PREFIX_RE =
  /^(get|read|compute|resolve|parse|format|to|is|has|build|create|make|derive|select|lookup|find)[A-Z]/;
// Names that end in a unit suffix (Ms, Px, Sec) are almost always pure
// conversions, not handlers.
const NON_HANDLER_UNIT_SUFFIX_RE = /(Ms|Px|Sec|Seconds|Pixels|Rem|Em)$/;

function isExcluded(rel) {
  const p = rel.replace(/\\/g, "/");
  if (/\.(spec|test|stories)\.[cm]?[tj]sx?$/.test(p)) return true;
  if (p.includes("/__tests__/")) return true;
  if (p.includes("/__fixtures__/")) return true;
  if (p.includes("/test-helpers/")) return true;
  return false;
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Precompute [start, end) ranges of backtick-delimited template literals so we
// can skip matches that fall inside code samples / embed snippets / docstrings.
// Naive but precise enough for our scanner: pairs unescaped backticks at the
// top level. Doesn't model nested ${} expressions, but those rarely contain
// the patterns we're matching anyway, and being inclusive here is the safer
// failure mode (a few extra skips beats false positives in user-facing rules).
function computeTemplateStringRanges(text) {
  const ranges = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const start = i;
      i += 1;
      while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "`") {
          ranges.push([start, i + 1]);
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // Skip plain string literals too — they can contain code samples in tests
    // and translation keys, and we don't want to lint patterns inside them.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === quote || c === "\n") {
          ranges.push([start, i + 1]);
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return ranges;
}

function isInsideRange(ranges, index) {
  // ranges is sorted by start; small-N linear scan is fine.
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
    if (start > index) return false;
  }
  return false;
}

// Return the enclosing function-shaped span containing `index`, by walking
// backward to a likely declaration and matching braces forward. Cheap and
// approximate — good enough to decide "is this inside a handler-named fn".
function enclosingFunctionName(text, index) {
  const head = text.slice(0, index);
  // Scan back across at most 200 lines for the nearest function/arrow declaration.
  const tail = head.split("\n").slice(-200).join("\n");
  const matches = [
    ...tail.matchAll(
      /\b(function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|(\w+)\s*\([^)]*\)\s*\{)/g,
    ),
  ];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const name = last[2] ?? last[3] ?? last[4];
  return name ?? null;
}

function isHandlerName(name) {
  if (!name) return false;
  if (NON_HANDLER_PREFIX_RE.test(name)) return false;
  if (NON_HANDLER_UNIT_SUFFIX_RE.test(name)) return false;
  return HANDLER_NAME_RE.test(name);
}

function isComponentFile(rel) {
  const p = rel.replace(/\\/g, "/");
  return p.startsWith("src/components/") || p.endsWith(".vue");
}

function extractTemplateBlock(text) {
  const match = /<template(?:\s[^>]*)?>([\s\S]*?)<\/template>/i.exec(text);
  if (!match) return null;
  return { text: match[1], offset: match.index + match[0].indexOf(match[1]) };
}

function findMatchingParen(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      const newlineIndex = text.indexOf("\n", i + 2);
      if (newlineIndex === -1) return -1;
      i = newlineIndex;
      continue;
    }

    if (ch === "/" && next === "*") {
      const commentEndIndex = text.indexOf("*/", i + 2);
      if (commentEndIndex === -1) return -1;
      i = commentEndIndex + 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "(") {
      depth += 1;
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findComputedBlocks(text) {
  const matches = [...text.matchAll(COMPUTED_DECL_RE)];
  const blocks = [];
  for (const match of matches) {
    const start = match.index ?? 0;
    const openParenIndex = start + match[0].lastIndexOf("(");
    const end = findMatchingParen(text, openParenIndex);
    if (end === -1) continue;
    blocks.push({
      name: match[1],
      start,
      text: text.slice(start, end + 1),
    });
  }
  return blocks;
}

function isAllowlisted(rel, allowlist) {
  if (!allowlist) return false;
  const p = rel.replace(/\\/g, "/");
  for (const entry of allowlist) {
    if (p === entry || p.startsWith(`${entry}/`)) return true;
  }
  return false;
}

function countByRuleKey(findings) {
  const out = {};
  for (const f of findings) {
    const key = f.metadata?.baselineKey ?? f.filePath;
    out[f.ruleId] ??= {};
    out[f.ruleId][key] = (out[f.ruleId][key] ?? 0) + 1;
  }
  return out;
}

function renderReport({ findings, drift, hasBaseline, filesScanned }) {
  const byRule = {};
  for (const f of findings) (byRule[f.ruleId] ??= []).push(f);

  // Compute per-severity counts for machine-readable metadata.
  let errorCount = 0;
  let warnCount = 0;
  for (const [ruleId, list] of Object.entries(byRule)) {
    if (RULES[ruleId]?.severity === "error") {
      errorCount += list.length;
    } else {
      warnCount += list.length;
    }
  }

  const lines = [
    "# Perf Hot Paths Audit",
    "",
    "_Surfaces patterns that cost frame budget on input/scroll hot paths._",
    "",
    `- Files scanned: ${filesScanned}`,
    `- Findings: ${findings.length}`,
    `- Errors: ${errorCount}`,
    `- Warnings: ${warnCount}`,
    `- Drift tracking: ${hasBaseline ? `${drift.length} new hotspots` : "disabled"}`,
    "",
  ];

  if (drift.length > 0) {
    lines.push("## ⚠️ Drift — NEW perf hotspots since baseline", "");
    for (const d of drift) {
      lines.push(`- \`${d.ruleId}\` · \`${d.key}\` (${d.base} → ${d.count})`);
    }
    lines.push("");
  }

  for (const [ruleId, list] of Object.entries(byRule)) {
    lines.push(`## ${ruleId} — ${list.length} (${RULES[ruleId].severity})`, "", `_${RULES[ruleId].description}_`, "");
    for (const f of list.slice(0, 80)) {
      const loc = f.line ? `${f.filePath}:${f.line}` : f.filePath;
      lines.push(`- \`${loc}\` — ${f.message}`);
    }
    if (list.length > 80) lines.push(`- …and ${list.length - 80} more`);
    lines.push("");
  }

  if (findings.length === 0) lines.push("No perf-hot-path findings.", "");
  return `${lines.join("\n")}\n`;
}

async function loadAllowlist(root, allowlistPath) {
  if (!allowlistPath) return {};
  try {
    const abs = path.resolve(root, allowlistPath);
    const raw = await fs.readFile(abs, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export const audit = {
  id: "perf-hot-paths",
  title: "Perf Hot Paths",
  category: "architecture",
  defaultConfig: {
    includeInAll: true,
    roots: DEFAULT_ROOTS,
    extensions: DEFAULT_EXTENSIONS,
    allowlistPath: "packages/connections-arkitect/policies/connections/allowlists/perf-hot-paths-allowlists.json",
    outputPath: "tmp/audits/PERF_HOT_PATHS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;

    const allowlist = await loadAllowlist(root, cfg.allowlistPath);
    const allowDeepWatcher = allowlist.deepWatcher ?? [];
    const allowLayoutReadInHandler = allowlist.layoutReadInHandler ?? [];
    const allowDomQueryInComponent = allowlist.domQueryInComponent ?? [];
    const allowAnimateNoCancel = allowlist.animateNoCancel ?? [];
    const allowVirtualListSpreadItems = allowlist.virtualListSpreadItems ?? [];
    const allowActiveViewHeavyComputed = allowlist.activeViewHeavyComputed ?? [];

    const files = await walkFiles({ root, roots: cfg.roots, extensions: cfg.extensions });
    const findings = [];

    for (const rel of files) {
      if (isExcluded(rel)) continue;
      const abs = path.resolve(root, rel);
      let text;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }

      const stringRanges = computeTemplateStringRanges(text);
      const inString = (index) => isInsideRange(stringRanges, index);

      // --- perf-virtualized-table-state-motion-guard ---
      if (
        rel.replace(/\\/g, "/") === "src/components/shared/table/AppTable.vue" &&
        !APP_TABLE_STATE_MOTION_GUARD_RE.test(text)
      ) {
        findings.push({
          ruleId: "perf-virtualized-table-state-motion-guard",
          severity: RULES["perf-virtualized-table-state-motion-guard"].severity,
          filePath: rel,
          line: 1,
          message: "`tableStateMotion` must be disabled when `renderingVirtualized.value` is true",
          metadata: { baselineKey: rel },
        });
      }

      // --- perf-deep-watcher ---
      if (!isAllowlisted(rel, allowDeepWatcher)) {
        DEEP_WATCHER_RE.lastIndex = 0;
        let dm;
        while ((dm = DEEP_WATCHER_RE.exec(text))) {
          if (inString(dm.index)) continue;
          // Confirm it's inside a watch(...) call — check the preceding ~400 chars
          // for a `watch(` opening that hasn't been closed before our match.
          const window = text.slice(Math.max(0, dm.index - 400), dm.index);
          if (!/\bwatch(?:Effect|PostEffect)?\s*\(/.test(window)) continue;
          const line = lineAt(text, dm.index);
          findings.push({
            ruleId: "perf-deep-watcher",
            severity: RULES["perf-deep-watcher"].severity,
            filePath: rel,
            line,
            message: "`watch(..., { deep: true })`",
            metadata: { baselineKey: `${rel}:${line}` },
          });
        }
      }

      // --- perf-layout-read-in-handler ---
      if (!isAllowlisted(rel, allowLayoutReadInHandler)) {
        LAYOUT_READ_RE.lastIndex = 0;
        let lm;
        while ((lm = LAYOUT_READ_RE.exec(text))) {
          if (inString(lm.index)) continue;
          const name = enclosingFunctionName(text, lm.index);
          if (!isHandlerName(name)) continue;
          const line = lineAt(text, lm.index);
          findings.push({
            ruleId: "perf-layout-read-in-handler",
            severity: RULES["perf-layout-read-in-handler"].severity,
            filePath: rel,
            line,
            message: `\`${lm[1]}()\` inside handler \`${name}\``,
            metadata: { baselineKey: `${rel}:${line}:${lm[1]}`, fn: name },
          });
        }
      }

      // --- perf-dom-query-in-component ---
      if (isComponentFile(rel) && !isAllowlisted(rel, allowDomQueryInComponent)) {
        DOM_QUERY_RE.lastIndex = 0;
        let qm;
        while ((qm = DOM_QUERY_RE.exec(text))) {
          if (inString(qm.index)) continue;
          const line = lineAt(text, qm.index);
          findings.push({
            ruleId: "perf-dom-query-in-component",
            severity: RULES["perf-dom-query-in-component"].severity,
            filePath: rel,
            line,
            message: `\`document.${qm[1]}\` — prefer template ref`,
            metadata: { baselineKey: `${rel}:${line}:${qm[1]}` },
          });
        }
      }

      // --- perf-virtual-list-spread-items ---
      if (rel.endsWith(".vue") && !isAllowlisted(rel, allowVirtualListSpreadItems)) {
        const template = extractTemplateBlock(text);
        if (template) {
          VIRTUAL_LIST_SPREAD_ITEMS_RE.lastIndex = 0;
          let vm;
          while ((vm = VIRTUAL_LIST_SPREAD_ITEMS_RE.exec(template.text))) {
            const line = lineAt(text, template.offset + vm.index);
            findings.push({
              ruleId: "perf-virtual-list-spread-items",
              severity: RULES["perf-virtual-list-spread-items"].severity,
              filePath: rel,
              line,
              message: "`AppVirtualList` receives a spread array in `:items`; pass a stable computed/ref instead",
              metadata: { baselineKey: `${rel}:${line}` },
            });
          }
        }
      }

      // --- perf-active-view-heavy-computed ---
      if (!isAllowlisted(rel, allowActiveViewHeavyComputed)) {
        for (const block of findComputedBlocks(text)) {
          if (!block.text.includes("activeView.value")) continue;
          if (!HEAVY_COLLECTION_DERIVATION_RE.test(block.text)) continue;
          if (!HIGH_VOLUME_WORKSPACE_SOURCE_RE.test(block.text)) continue;

          const line = lineAt(text, block.start);
          findings.push({
            ruleId: "perf-active-view-heavy-computed",
            severity: RULES["perf-active-view-heavy-computed"].severity,
            filePath: rel,
            line,
            message: `computed \`${block.name}\` couples \`activeView.value\` to high-volume list derivation`,
            metadata: { baselineKey: `${rel}:${line}:${block.name}`, computed: block.name },
          });
        }
      }

      // --- perf-animate-no-cancel ---
      if (!isAllowlisted(rel, allowAnimateNoCancel)) {
        ANIMATE_CALL_RE.lastIndex = 0;
        let firstNonString = null;
        let am;
        while ((am = ANIMATE_CALL_RE.exec(text))) {
          if (inString(am.index)) continue;
          firstNonString = am;
          break;
        }
        if (firstNonString && !ANIMATION_CANCEL_RE.test(text)) {
          const line = lineAt(text, firstNonString.index);
          findings.push({
            ruleId: "perf-animate-no-cancel",
            severity: RULES["perf-animate-no-cancel"].severity,
            filePath: rel,
            line,
            message: "uses `element.animate(...)` but file has no `.cancel(` — rapid retriggers stack animations",
            metadata: { baselineKey: rel },
          });
        }
      }
    }

    // --- drift vs baseline ---
    const current = countByRuleKey(findings);
    const baselineRules = (context.baseline && context.baseline.rules) || {};
    const hasBaseline = Object.keys(baselineRules).length > 0;
    const drift = [];
    if (hasBaseline) {
      for (const [ruleId, keys] of Object.entries(current)) {
        for (const [key, count] of Object.entries(keys)) {
          const base = baselineRules[ruleId]?.[key] ?? 0;
          if (count > base) drift.push({ ruleId, key, count, base });
        }
      }
    }

    const summary = findings.reduce(
      (acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1;
        return acc;
      },
      { error: 0, warning: 0 },
    );

    return {
      failed: hasBaseline && drift.length > 0,
      findings,
      drift,
      jsonPayload: { findings, drift, summary, filesScanned: files.length },
      baselineDocument: { version: 1, generatedAt: new Date().toISOString(), rules: current },
      outputPath: cfg.outputPath,
      report: renderReport({ findings, drift, hasBaseline, filesScanned: files.length }),
    };
  },
};
