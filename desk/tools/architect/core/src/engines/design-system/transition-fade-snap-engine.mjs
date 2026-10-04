import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_TRANSITION_CSS = "src/styles/core/transitions.css";
const DEFAULT_SCAN_ROOTS = Object.freeze(["src"]);

let ROOT = process.cwd();
let TRANSITION_CSS = DEFAULT_TRANSITION_CSS;
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];
const SKIP_SEGMENTS = new Set([".git", "coverage", "dist", "node_modules", "tmp"]);
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const FAIL_FLAG = "--fail-on-drift";
const SUPPRESS_DIRECTIVE = "audit-transition-snap-ignore";

function relPath(p) {
  return path.relative(ROOT, p).replaceAll(path.sep, "/");
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const info = await stat(dir);
  if (info.isFile()) return [dir];
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(child)));
    else if (entry.isFile() && entry.name.endsWith(".vue")) out.push(child);
  }
  return out;
}

/**
 * Parse transitions.css and return Map<transitionName, { leaveToOpacity, enterFromOpacity }>.
 * Only transitions whose leave-to / enter-from sets opacity to a non-zero value are "swap" transitions.
 */
function parseTransitionStates(cssSource) {
  // Split into rules of form `selector { body }`. Naive but fine for this stylesheet.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const states = new Map();

  function ensure(name) {
    if (!states.has(name)) states.set(name, {});
    return states.get(name);
  }

  for (const m of cssSource.matchAll(ruleRe)) {
    const selectors = m[1];
    const body = m[2];
    const opacityMatch = body.match(/(?:^|[;\s])opacity\s*:\s*([0-9.]+)\s*(?:!important)?\s*(?:;|$)/);
    if (!opacityMatch) continue;
    const opacity = Number(opacityMatch[1]);

    // Each selector in the comma list (e.g. ".gc-swap-scale-leave-to, .gc-swap-scale-enter-from")
    for (const rawSelector of selectors.split(",")) {
      const s = rawSelector.trim();
      const leaveTo = s.match(/^\.([\w-]+)-leave-to$/);
      const enterFrom = s.match(/^\.([\w-]+)-enter-from$/);
      if (leaveTo) ensure(leaveTo[1]).leaveToOpacity = opacity;
      if (enterFrom) ensure(enterFrom[1]).enterFromOpacity = opacity;
    }
  }

  return states;
}

function classifySwap(states) {
  const swap = new Set();
  for (const [name, s] of states) {
    const leave = s.leaveToOpacity ?? 0;
    const enter = s.enterFromOpacity ?? 0;
    if (leave > 0 || enter > 0) swap.add(name);
  }
  return swap;
}

/**
 * Walk a Vue template snippet starting at offset (just past the opening <Transition ...> tag).
 * Return { children: Array<{ tag, attrs, openIdx }>, endIdx } where endIdx is the position
 * of the closing </Transition>. children are the *direct* element children of the Transition.
 */
function parseDirectChildren(source, startIdx) {
  const tagRe = /<\s*(\/)?\s*([A-Za-z][A-Za-z0-9_-]*)([^>]*?)(\/)?\s*>/g;
  tagRe.lastIndex = startIdx;
  const stack = []; // { tag, openIdx } for ancestors *within* the Transition (depth >= 1)
  const children = [];
  let m;
  while ((m = tagRe.exec(source)) !== null) {
    const isClose = Boolean(m[1]);
    const tag = m[2];
    const attrs = m[3] || "";
    const selfClose = Boolean(m[4]) || VOID_TAGS.has(tag.toLowerCase());

    if (isClose) {
      if (tag === "Transition" || tag === "transition") {
        if (stack.length === 0) return { children, endIdx: m.index };
      }
      // pop matching open
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    // opening tag
    if (stack.length === 0) {
      children.push({ tag, attrs, openIdx: m.index });
    }
    if (!selfClose) stack.push({ tag, openIdx: m.index });
  }
  return { children, endIdx: -1 };
}

const TRANSITION_OPEN_RE = /<\s*Transition\b([^>]*?)>/g;

function getNameFromAttrs(attrs) {
  const m = attrs.match(/\bname\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function getModeFromAttrs(attrs) {
  const m = attrs.match(/\bmode\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function hasUnconditionalVElse(children) {
  // A *true* swap pattern requires one element to always be rendered. That is only
  // guaranteed by a `v-else` with no condition (not `v-else-if`, which can also be false).
  if (children.length < 2) return false;
  const unconditionalElse = /(?:^|\s)v-else(?!-if)(?:\s|>|$)/;
  return children.slice(1).some((c) => unconditionalElse.test(c.attrs) || / v-else\s*$/.test(c.attrs));
}

function hasDynamicKey(child) {
  // `:key="..."` or `v-bind:key="..."` indicates the child re-keys → keyed swap.
  return /(?:^|\s)(?::|v-bind:)key\s*=/.test(child.attrs);
}

function hasVIf(child) {
  return /(?:^|\s)v-if\s*=/.test(child.attrs);
}

function hasVShow(child) {
  return /(?:^|\s)v-show\s*=/.test(child.attrs);
}

function isSuppressed(source, idx) {
  // Look for a comment within the previous ~200 chars containing the suppress directive.
  const window = source.slice(Math.max(0, idx - 200), idx);
  return window.includes(SUPPRESS_DIRECTIVE);
}

export async function runTransitionFadeSnapAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  TRANSITION_CSS = options.transitionCss ?? DEFAULT_TRANSITION_CSS;
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];

  const cssPath = path.join(ROOT, TRANSITION_CSS);
  if (!existsSync(cssPath)) {
    const findings = [
      {
        file: TRANSITION_CSS,
        line: 1,
        name: "(missing transition css)",
        message: `Cannot find ${TRANSITION_CSS}`,
      },
    ];
    return {
      failed: true,
      findings,
      jsonPayload: { findings, checkedTransitions: [] },
      report: renderReport({ findings, checkedTransitions: [] }),
    };
  }
  const cssSource = await readFile(cssPath, "utf8");
  const states = parseTransitionStates(cssSource);
  const swapTransitions = classifySwap(states);

  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    allFiles.push(...(await walk(path.join(ROOT, root))));
  }

  const findings = [];

  for (const file of allFiles) {
    const src = await readFile(file, "utf8");
    let m;
    TRANSITION_OPEN_RE.lastIndex = 0;
    while ((m = TRANSITION_OPEN_RE.exec(src)) !== null) {
      const name = getNameFromAttrs(m[1]);
      if (!name || !swapTransitions.has(name)) continue;
      if (isSuppressed(src, m.index)) continue;

      const mode = getModeFromAttrs(m[1]);
      const after = m.index + m[0].length;
      const { children } = parseDirectChildren(src, after);

      if (children.length === 0) continue; // empty transition (defensive)
      if (hasUnconditionalVElse(children)) continue; // guaranteed swap, transition is appropriate

      // A single child with a dynamic :key but no v-if/v-show is a pure keyed swap
      // (Vue replaces the element when the key changes; it can never become absent).
      // Mode "out-in" / "in-out" with a static single child is also a keyed-swap demo
      // (e.g. via re-render trigger), but only safe when v-if isn't gating presence.
      const onlyChild = children.length === 1 ? children[0] : null;
      if (onlyChild && !hasVIf(onlyChild) && !hasVShow(onlyChild) && hasDynamicKey(onlyChild)) continue;
      if (onlyChild && !hasVIf(onlyChild) && !hasVShow(onlyChild) && (mode === "out-in" || mode === "in-out")) continue;

      // Single-child v-if / single show-hide → snap risk
      const line = lineNumberAt(src, m.index);
      const leaveTo = states.get(name)?.leaveToOpacity ?? 0;
      const enterFrom = states.get(name)?.enterFromOpacity ?? 0;
      findings.push({
        file: relPath(file),
        line,
        name,
        leaveTo,
        enterFrom,
        child: children[0].tag,
        childAttrs: children[0].attrs.replace(/\s+/g, " ").trim().slice(0, 80),
      });
    }
  }

  const checkedTransitions = [...swapTransitions].sort();
  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: { findings, checkedTransitions },
    report: renderReport({ findings, checkedTransitions }),
  };
}

function renderReport({ findings, checkedTransitions }) {
  const lines = [];
  lines.push("# Transition Fade Snap Audit");
  lines.push("");
  lines.push(`- Findings: ${findings.length}`);
  lines.push(`- Checked swap transitions: ${checkedTransitions.length}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No transition fade snap drift found.");
    if (checkedTransitions.length > 0) {
      lines.push(`Checked transitions: ${checkedTransitions.join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "Transitions whose *-leave-to or *-enter-from set opacity above 0 are designed for swaps where another element is guaranteed to stay on screen.",
  );
  lines.push("");

  for (const f of findings) {
    lines.push(
      `- ${f.file}:${f.line} name="${f.name}" leave-to opacity=${f.leaveTo ?? "?"} enter-from opacity=${f.enterFrom ?? "?"}`,
    );
    if (f.child) {
      lines.push(`  - child: <${f.child}${f.childAttrs ? ` ${f.childAttrs}` : ""}>`);
    }
    if (f.message) {
      lines.push(`  - ${f.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const result = await runTransitionFadeSnapAudit();
  console.log(result.report.trimEnd());
  if (process.argv.includes(FAIL_FLAG) && result.failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 2;
  });
}
