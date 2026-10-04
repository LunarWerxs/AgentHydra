/**
 * autosave-failure-test-coverage — connections-arkitect check
 * ===========================================================
 * Every user-edit persistence surface that can enter a save "error" state
 * (a `*SaveState.value = "error"` transition) MUST have a test that injects a
 * save failure and exercises that path. Without one, a transient "Failed to
 * fetch" can dead-end the editor or silently drop in-progress edits and no test
 * notices — exactly the class of bug that shipped in the MyConnect builder, the
 * contact editor, and the hosted-event console.
 *
 * This is the *structural* half of the guard: it forces the *behavioral*
 * failure-path test to exist. Line coverage can never catch these on its own —
 * the happy path runs the same lines; only a rejected save reveals the bug.
 *
 * Rule:
 *   autosave-failure-test-coverage
 *     A non-spec module sets a save-state ref to "error" but no spec that
 *     transitively imports it asserts that same save-state reaches "error".
 *     Add a failure-path test (inject a rejected save) that drives the state
 *     into "error" and asserts the draft retries / is preserved — it must not
 *     silently lose edits.
 *
 * Coverage is matched on the EXACT save-state variable name (e.g. `saveState`
 * vs `profileSaveState`) plus an import-graph reachability check, so a failure
 * test for one surface can't be mistaken as coverage for an unrelated one (a
 * `loadHostedEvents` reject is not a save-path test).
 *
 * Escape hatch (rare — a save-error state that genuinely cannot lose work):
 *   // arkitect-ignore-next-line autosave-failure-test-coverage — <reason>
 *   on the transition line or the line directly above it.
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check autosave-failure-test-coverage
 */

import fs from "node:fs";
import path from "node:path";

import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

// A user-edit persistence surface advertises itself by driving a save-state ref
// into the "error" branch — e.g. `saveState.value = "error"` or
// `profileSaveState.value = "error"`. The captured group is the exact ref name,
// used to tie coverage back to THIS surface.
const SAVE_ERROR_ASSIGN_RE = /\b([A-Za-z]*[Ss]aveState)\.value\s*=\s*["']error["']/;

// A spec that asserts SOME save-state reaches "error" — the cheap pre-filter
// that narrows the set of specs we bother computing reachability for.
const ANY_SAVE_ERROR_ASSERT_RE = /\b[A-Za-z]*[Ss]aveState\.value[^\n]*["']error["']/;

const IGNORE_RE = /arkitect-ignore-next-line\s+autosave-failure-test-coverage\b/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A spec covers surface `V` when it asserts `<V>.value … "error"` on one line —
// the signature of a test that drives that exact save-state into its failure
// branch (e.g. `expect(hostEvents.saveState.value).toBe("error")`).
function buildCoverageRe(stateVar) {
  return new RegExp(`\\b${escapeRegExp(stateVar)}\\.value[^\\n]*["']error["']`);
}

const RULES = {
  "autosave-failure-test-coverage": {
    severity: "error",
    description: "A save-error surface has no failure-path test that reaches it.",
  },
};

function isSpec(relPath) {
  return relPath.endsWith(".spec.ts") || relPath.endsWith(".spec.tsx") || relPath.endsWith(".test.ts");
}

function readMaybe(absPath) {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

// All modules reachable from `startRel` by following value/type import edges.
function reachableModules(startRel, nodes) {
  const seen = new Set([startRel]);
  const queue = [startRel];
  while (queue.length > 0) {
    const current = queue.shift();
    const node = nodes.get(current);
    if (!node) continue;
    for (const edge of node.imports) {
      if (!edge.resolved || seen.has(edge.resolved)) continue;
      seen.add(edge.resolved);
      queue.push(edge.resolved);
    }
  }
  return seen;
}

export const audit = {
  id: "autosave-failure-test-coverage",
  title: "Autosave Failure-Path Test Coverage",
  category: "codeRisk",
  rules: RULES,
  defaultConfig: {
    includeInAll: true,
    roots: ["src"],
    outputPath: "tmp/audits/AUTOSAVE_FAILURE_TEST_COVERAGE.md",
  },
  async run(context) {
    const root = context.root;
    const cfg = context.checkConfig ?? {};
    const roots = cfg.roots || ["src"];

    const { nodes } = await buildImportGraph({ root, roots });

    // 1. Detect persistence surfaces (capturing the exact save-state var name).
    const surfaces = [];
    for (const [relPath] of nodes) {
      if (isSpec(relPath)) continue;
      const sourceText = readMaybe(path.resolve(root, relPath));
      if (sourceText === null || !SAVE_ERROR_ASSIGN_RE.test(sourceText)) continue;

      const lines = sourceText.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const match = SAVE_ERROR_ASSIGN_RE.exec(lines[i]);
        if (!match) continue;
        const ignored = IGNORE_RE.test(lines[i]) || (i > 0 && IGNORE_RE.test(lines[i - 1]));
        if (ignored) continue;
        surfaces.push({ filePath: relPath, line: i + 1, stateVar: match[1], snippet: lines[i].trim() });
        break; // one finding per surface module is enough
      }
    }

    // 2. Pre-filter to specs that assert SOME save-state reaches "error", and
    //    cache each one's transitively-reachable module set.
    const errorAssertSpecs = [];
    for (const [relPath] of nodes) {
      if (!isSpec(relPath)) continue;
      const sourceText = readMaybe(path.resolve(root, relPath));
      if (sourceText === null || !ANY_SAVE_ERROR_ASSERT_RE.test(sourceText)) continue;
      errorAssertSpecs.push({ text: sourceText, reachable: reachableModules(relPath, nodes) });
    }

    // 3. A surface is covered when a spec that (a) reaches it AND (b) asserts
    //    THIS surface's exact save-state reaches "error".
    const isCovered = (surface) => {
      const coverageRe = buildCoverageRe(surface.stateVar);
      return errorAssertSpecs.some((spec) => spec.reachable.has(surface.filePath) && coverageRe.test(spec.text));
    };

    const findings = surfaces
      .filter((surface) => !isCovered(surface))
      .map((surface) => ({
        ruleId: "autosave-failure-test-coverage",
        severity: RULES["autosave-failure-test-coverage"].severity,
        message:
          `${surface.filePath} can enter a save "error" state but no spec injects a save failure that reaches it. ` +
          "Add a failure-path test (inject a rejected save; assert it retries or preserves the draft — never silently loses edits).",
        filePath: surface.filePath,
        line: surface.line,
        snippet: surface.snippet,
      }));

    const failed = findings.length > 0;
    const report = failed
      ? `# Autosave Failure-Path Test Coverage\n\n` +
        `## autosave-failure-test-coverage — ${findings.length} (error)\n\n` +
        findings.map((f) => `- \`${f.filePath}:${f.line}\` — ${f.message}\n  \`${f.snippet}\`\n`).join("")
      : `# Autosave Failure-Path Test Coverage\n\n` +
        `All ${surfaces.length} save-error surface(s) have a failure-path test reaching them.\n`;

    return {
      failed,
      findings,
      report,
      outputPath: cfg.outputPath,
      jsonPayload: {
        surfaces: surfaces.map((s) => s.filePath),
        uncovered: findings.map((f) => f.filePath),
      },
      metadata: {
        surfacesScanned: surfaces.length,
        covered: surfaces.length - findings.length,
      },
    };
  },
};
