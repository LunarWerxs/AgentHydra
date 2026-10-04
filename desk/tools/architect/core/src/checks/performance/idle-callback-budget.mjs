/**
 * Idle Callback Budget — connections-arkitect check
 * ===================================================
 * Flags `requestIdleCallback` / `scheduleIdleSearchTask` callbacks whose body
 * contains non-trivial synchronous work that risks exceeding Chrome's 50 ms
 * idle-deadline, triggering `[Violation] 'requestIdleCallback' handler took
 * <N>ms` console warnings.
 *
 * Rules:
 *   1. idle-callback-heavy-body
 *      The callback body exceeds ~15 lines of synchronous code. Long idle
 *      callbacks are the single strongest static signal that the handler may
 *      overrun the 50 ms budget. Prefer moving expensive setup work (plan
 *      building, state construction, index preparation) *before* the idle
 *      callback, keeping the callback itself to a short slicing loop with
 *      `deadline.timeRemaining()` checks.
 *
 *   2. idle-callback-build-pattern
 *      The callback calls a function named `build*`, `ensure*`, `construct*`,
 *      `create*`, or `prepare*` that likely does heavy synchronous work.
 *      These plan-building / state-construction calls are the #1 cause of
 *      idle-deadline violations and should run before the idle callback is
 *      scheduled.
 *
 *   3. idle-callback-loop-without-slicing
 *      The callback body contains a `for` / `while` loop but no
 *      `deadline.timeRemaining()` or `timeRemaining()` guard. Loops without
 *      time-slicing can run unbounded inside an idle callback — always slice.
 *
 * Because this is a static heuristic, findings are `warning` severity and
 * require human judgment. A callback flagged here may be perfectly fine if
 * the data set is always small; conversely, a short callback calling a very
 * expensive external function will be missed.
 *
 * Scope: src/** and infra/lambda/src/** by default. Skips tests, fixtures,
 * and *.spec.* / *.test.* files.
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check idle-callback-budget
 */
import fs from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "@saydeploy/architect/core/files";

const RULES = {
  "idle-callback-heavy-body": {
    severity: "warning",
    description:
      "Idle callback body exceeds ~15 lines of synchronous code — risks exceeding the 50 ms idle deadline. Move expensive setup work before the idle callback.",
  },
  "idle-callback-build-pattern": {
    severity: "warning",
    description:
      "Idle callback calls a `build*` / `ensure*` / `construct*` / `create*` / `prepare*` function. Plan-building work should run *before* scheduling the idle callback.",
  },
  "idle-callback-loop-without-slicing": {
    severity: "warning",
    description:
      "Idle callback contains a `for` / `while` loop with no `timeRemaining()` guard. Loops inside idle callbacks must be time-sliced to avoid overrunning the 50 ms budget.",
  },
};

const DEFAULT_ROOTS = ["src", "infra/lambda/src"];
const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".vue", ".mjs"];

// Match `requestIdleCallback(` or `scheduleIdleSearchTask(`
const IDLE_SCHEDULER_RE = /\b(?:requestIdleCallback|scheduleIdleSearchTask)\s*\(/g;

// "Heavy" setup function names whose presence inside an idle callback signals
// that plan-building / state construction is being deferred into idle time.
const BUILD_FN_RE = /\b(build|ensure|construct|create|prepare)[A-Z]\w*\s*\(/g;

// Loop keyword check
const LOOP_RE = /\b(for|while)\s*\(/g;

// Time-remaining guard — presence means the loop is properly sliced
const TIME_REMAINING_RE = /\btimeRemaining\s*\(/g;

// Threshold: flag callbacks with > HEAVY_BODY_LINE_COUNT lines of synchronous code
const HEAVY_BODY_LINE_COUNT = 15;

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

/**
 * Given the full file text and the position just after the opening `(` of
 * `requestIdleCallback(`, find the matching closing `)` that terminates the
 * call. Handles nested parens and avoids string/template contents naively.
 * Returns the index of the closing `)` or -1 on failure.
 */
function findCallCloseParen(text, openParenIndex) {
  let depth = 1;
  let i = openParenIndex + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  return depth === 0 ? i - 1 : -1;
}

/**
 * Given the position of the callback argument inside the idle-scheduler call,
 * find the end of the callback body. The callback is either:
 *   - An arrow: `(deadline) => { ... }`  → find matching `}`
 *   - A function expression: `function(deadline) { ... }` → find matching `}`
 *   - A reference: `someFn` → no body to inspect
 *
 * Returns `{ bodyStart, bodyEnd }` or null if it's a bare reference.
 */
function findCallbackBody(text, callbackStart) {
  // Skip whitespace
  let i = callbackStart;
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) {
    i += 1;
  }

  // Arrow function: `(deadline) => {` or `deadline => {`
  if (text.startsWith("(", i)) {
    // Find closing paren of params
    let pd = 1;
    i += 1;
    while (i < text.length && pd > 0) {
      if (text[i] === "(") pd += 1;
      else if (text[i] === ")") pd -= 1;
      i += 1;
    }
    // Now skip `=>` and whitespace to find `{`
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) {
      i += 1;
    }
    if (text.startsWith("=>", i)) {
      i += 2;
      while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) {
        i += 1;
      }
    }
  } else if (text.startsWith("function", i)) {
    // function(deadline) { ... }
    i = text.indexOf("{", i);
    if (i === -1) return null;
  } else if (/^[a-zA-Z_$]/.test(text[i])) {
    // Bare function reference — no inline body to inspect
    return null;
  } else {
    return null;
  }

  // Now `i` should be at `{`
  if (text[i] !== "{") return null;

  const bodyStart = i + 1;
  let depth = 1;
  i = bodyStart;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return depth === 0 ? { bodyStart, bodyEnd: i - 1 } : null;
}

/**
 * Count the number of lines in a substring, excluding blank lines and
 * lines that are only comments or scheduling calls (setTimeout, etc.).
 */
function countEffectiveLines(textSlice) {
  let count = 0;
  for (const raw of textSlice.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("//")) continue;
    if (/^\s*setTimeout\s*\(/.test(line)) continue;
    if (/^\s*setInterval\s*\(/.test(line)) continue;
    if (/^\s*queueMicrotask\s*\(/.test(line)) continue;
    if (/^\s*requestAnimationFrame\s*\(/.test(line)) continue;
    if (/^\s*return\s*;?\s*$/.test(line)) continue;
    count += 1;
  }
  return count;
}

function renderReport({ findings, filesScanned }) {
  const byRule = {};
  for (const f of findings) {
    (byRule[f.ruleId] ??= []).push(f);
  }

  const lines = [
    "# Idle Callback Budget Audit",
    "",
    "_Flags `requestIdleCallback` / `scheduleIdleSearchTask` callbacks that risk exceeding Chrome's 50 ms idle deadline._",
    "",
    `- Files scanned: ${filesScanned}`,
    `- Findings: ${findings.length}`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No idle-callback-budget findings.", "");
    return `${lines.join("\n")}\n`;
  }

  for (const [ruleId, list] of Object.entries(byRule)) {
    lines.push(
      `## ${ruleId} — ${list.length} (${RULES[ruleId]?.severity ?? "warning"})`,
      "",
      `_${RULES[ruleId]?.description ?? ""}_`,
      "",
    );
    for (const f of list.slice(0, 80)) {
      const loc = f.line ? `${f.filePath}:${f.line}` : f.filePath;
      lines.push(`- \`${loc}\` — ${f.message}`);
    }
    if (list.length > 80) lines.push(`- …and ${list.length - 80} more`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export const audit = {
  id: "idle-callback-budget",
  title: "Idle Callback Budget",
  category: "architecture",
  defaultConfig: {
    includeInAll: true,
    roots: DEFAULT_ROOTS,
    extensions: DEFAULT_EXTENSIONS,
    outputPath: "tmp/audits/IDLE_CALLBACK_BUDGET_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;

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

      // Find all idle-scheduler call sites
      IDLE_SCHEDULER_RE.lastIndex = 0;
      let match;
      while ((match = IDLE_SCHEDULER_RE.exec(text))) {
        const schedulerName = match[0].endsWith("k(") ? "scheduleIdleSearchTask" : "requestIdleCallback";
        const openParenIndex = match.index + match[0].length - 1; // index of `(`
        const closeParenIndex = findCallCloseParen(text, openParenIndex);
        if (closeParenIndex === -1) continue;

        // The callback is the first argument inside the parens.
        // Naive: find the first non-whitespace after `(` that starts the callback.
        // This works for `requestIdleCallback(callback, ...)` and
        // `scheduleIdleSearchTask(callback, config)`.
        const argsText = text.slice(openParenIndex + 1, closeParenIndex);
        // Find where the first argument starts (skip leading whitespace)
        let argStart = 0;
        while (
          argStart < argsText.length &&
          (argsText[argStart] === " " ||
            argsText[argStart] === "\t" ||
            argsText[argStart] === "\n" ||
            argsText[argStart] === "\r")
        ) {
          argStart += 1;
        }
        if (argStart >= argsText.length) continue;
        const callbackStartAbs = openParenIndex + 1 + argStart;

        const body = findCallbackBody(text, callbackStartAbs);
        if (!body) {
          // Bare function reference — flag if the name looks like a builder
          const refName = argsText.slice(argStart).split(/[,\s)]/)[0];
          if (refName && BUILD_FN_RE.test(refName)) {
            const line = lineAt(text, match.index);
            findings.push({
              ruleId: "idle-callback-build-pattern",
              severity: RULES["idle-callback-build-pattern"].severity,
              filePath: rel,
              line,
              message: `\`${schedulerName}\` delegates to \`${refName}\` — verify it does not exceed the 50 ms idle deadline`,
              metadata: { baselineKey: `${rel}:${line}`, scheduler: schedulerName },
            });
          }
          continue;
        }

        const bodyText = text.slice(body.bodyStart, body.bodyEnd);
        const startLine = lineAt(text, match.index);

        // Rule: heavy body (only when the callback is NOT properly time-sliced —
        // a long callback with `timeRemaining()` checks is the correct pattern).
        const effectiveLines = countEffectiveLines(bodyText);
        const hasTimeRemaining = TIME_REMAINING_RE.test(bodyText);
        if (effectiveLines > HEAVY_BODY_LINE_COUNT && !hasTimeRemaining) {
          findings.push({
            ruleId: "idle-callback-heavy-body",
            severity: RULES["idle-callback-heavy-body"].severity,
            filePath: rel,
            line: startLine,
            message: `\`${schedulerName}\` callback is ~${effectiveLines} lines of synchronous code with no \`timeRemaining()\` guard — risks exceeding the 50 ms idle deadline. Either add time-slicing or move expensive setup work before scheduling.`,
            metadata: { baselineKey: `${rel}:${startLine}`, effectiveLines },
          });
        }

        // Rule: build-pattern function calls inside the callback body
        BUILD_FN_RE.lastIndex = 0;
        let bm;
        while ((bm = BUILD_FN_RE.exec(bodyText))) {
          const fnName = bm[1];
          const bodyLine = bodyText.slice(0, bm.index).split("\n").length;
          findings.push({
            ruleId: "idle-callback-build-pattern",
            severity: RULES["idle-callback-build-pattern"].severity,
            filePath: rel,
            line: startLine + bodyLine,
            message: `\`${schedulerName}\` callback calls \`${bm[0].slice(0, -1)}\` — plan-building / state construction should run *before* scheduling the idle callback`,
            metadata: { baselineKey: `${rel}:${startLine}:${fnName}`, fnName, scheduler: schedulerName },
          });
        }

        // Rule: loop without time-remaining guard
        const hasLoop = LOOP_RE.test(bodyText);
        if (hasLoop && !hasTimeRemaining) {
          findings.push({
            ruleId: "idle-callback-loop-without-slicing",
            severity: RULES["idle-callback-loop-without-slicing"].severity,
            filePath: rel,
            line: startLine,
            message: `\`${schedulerName}\` callback contains a loop with no \`timeRemaining()\` guard — loops inside idle callbacks must be time-sliced`,
            metadata: { baselineKey: `${rel}:${startLine}`, scheduler: schedulerName },
          });
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
      failed: false,
      findings,
      jsonPayload: { findings, summary, filesScanned: files.length },
      outputPath: cfg.outputPath,
      report: renderReport({ findings, filesScanned: files.length }),
    };
  },
};
