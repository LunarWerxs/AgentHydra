/**
 * spl-playground-integrity — connections-arkitect check
 * ======================================================
 * Validates the SPL26 Dynamic Primitive Playground so it doesn't silently
 * break when components change. Catches the failure modes that have
 * historically caused SPL26 items to disappear or render incorrectly:
 *
 * Rules:
 *   1. spl-demo-hint-missing — a connections-ui App/Public component has no
 *      corresponding entry in primitiveDemoHints. Its demo will render
 *      with only fallback prop values, which can cause misleading output
 *      (e.g. `href="Demo"` turning buttons into anchor tags).
 *   2. spl-demo-hint-stale — an entry in primitiveDemoHints references a
 *      component that no longer exists on disk (renamed or deleted).
 *   3. spl-demo-prop-drift — a demo hint sets a prop that no longer exists
 *      on the component (the component's API changed but the hint wasn't
 *      updated).
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check spl-playground-integrity
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";

const TITLE = "SPL Playground Integrity";
const COMPONENTS_DIR = "packages/connections-ui/src/components";
const DEMO_HINTS_FILE = "packages/connections-ui/playground/primitiveDemoHints.ts";

/**
 * Recursively collect all Vue component files matching App* or Public*.
 * @param {string} dir
 * @returns {Array<{ name: string, relPath: string }>}
 */
function collectComponentFiles(dir) {
  /** @type {Array<{ name: string, relPath: string }>} */
  const results = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectComponentFiles(fullPath));
    } else if (/^(?:App|Public).*\.vue$/.test(entry.name)) {
      const name = path.basename(entry.name, ".vue");
      const relPath = path.relative(path.dirname(COMPONENTS_DIR), fullPath).replace(/\\/g, "/");
      results.push({ name, relPath });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract demo hint component names from primitiveDemoHints.ts.
 * Look for top-level keys in the `primitiveDemoHints` record.
 * @param {string} filePath
 * @returns {Set<string>}
 */
function extractDemoHintNames(filePath) {
  const names = new Set();
  if (!existsSync(filePath)) return names;

  try {
    const source = readFileSync(filePath, "utf8");
    // Match top-level keys in the primitiveDemoHints record:
    //   AppFoo: {
    //   PublicBar: {
    const matches = source.matchAll(/^\s{2}(\w+):\s*\{/gm);
    for (const m of matches) {
      names.add(m[1]);
    }
  } catch {
    // parse error → empty set, we'll report gaps
  }
  return names;
}

/**
 * Extract prop names set by each demo hint entry.
 * Returns a Map of component name → Set of prop names.
 * @param {string} filePath
 * @returns {Map<string, Set<string>>}
 */
function extractDemoHintProps(filePath) {
  /** @type {Map<string, Set<string>>} */
  const hintProps = new Map();
  if (!existsSync(filePath)) return hintProps;

  try {
    const source = readFileSync(filePath, "utf8");
    // Match hint entries and their props blocks:
    //   AppFoo: {
    //     ...
    //     props: { leadingIcon: "check", tone: "primary" },
    //   }
    const entryRegex = /^\s{2}(\w+):\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gm;
    let match;
    while ((match = entryRegex.exec(source)) !== null) {
      const name = match[1];
      const body = match[2];
      const propsMatch = body.match(/props:\s*\{([^}]*)\}/);
      if (propsMatch) {
        const propNames = new Set();
        const propPairs = propsMatch[1].matchAll(/(\w+):/g);
        for (const p of propPairs) {
          propNames.add(p[1]);
        }
        hintProps.set(name, propNames);
      }
    }
  } catch {
    // parse error → skip prop drift check
  }
  return hintProps;
}

/**
 * Extract prop names from a Vue SFC's defineProps.
 * @param {string} filePath
 * @returns {Set<string>}
 */
function extractComponentPropNames(filePath) {
  const names = new Set();
  if (!existsSync(filePath)) return names;

  try {
    const source = readFileSync(filePath, "utf8");
    // Match defineProps<{ ... }>() or withDefaults(defineProps<{ ... }>(), ...)
    const propsBlock = source.match(/defineProps<\{([^}]+(?:\{[^}]*\}[^}]*)*)\}>/s);
    if (propsBlock) {
      const body = propsBlock[1];
      // Match prop declarations:   propName?: type;   or   propName: type;
      const propMatches = body.matchAll(/(\w+)\??\s*:/g);
      for (const m of propMatches) {
        const propName = m[1];
        // Skip TypeScript keywords
        if (!["string", "number", "boolean", "void", "never", "any", "unknown"].includes(propName)) {
          names.add(propName);
        }
      }
    }
  } catch {
    // parse error → skip
  }
  return names;
}

export const audit = {
  id: "spl-playground-integrity",
  title: TITLE,
  category: "meta",
  requires: { projectNames: ["connections"] },
  outputContract: "parsed-findings",
  defaultConfig: {
    includeInAll: true,
  },
  async run(context) {
    const root = context.root;
    const findings = [];

    const componentsDir = path.resolve(root, COMPONENTS_DIR);
    const demoHintsPath = path.resolve(root, DEMO_HINTS_FILE);

    const componentFiles = collectComponentFiles(componentsDir);
    const demoHintNames = extractDemoHintNames(demoHintsPath);
    const demoHintProps = extractDemoHintProps(demoHintsPath);

    const componentNameSet = new Set(componentFiles.map((c) => c.name));

    // ── Rule 1: components missing demo hints ──
    for (const comp of componentFiles) {
      if (!demoHintNames.has(comp.name)) {
        findings.push(
          createFinding({
            ruleId: "spl-demo-hint-missing",
            severity: "warn",
            file: comp.relPath,
            message: `${comp.name} has no demo hint entry in primitiveDemoHints.ts`,
            detail: `Add a "${comp.name}" entry to ${DEMO_HINTS_FILE} with representative props so the playground card renders correctly. Without it, all string props default to "Demo" (e.g. \`href="Demo"\` turns buttons into anchor tags).`,
          }),
        );
      }
    }

    // ── Rule 2: stale demo hints (hint references deleted component) ──
    for (const hintName of demoHintNames) {
      if (!componentNameSet.has(hintName)) {
        findings.push(
          createFinding({
            ruleId: "spl-demo-hint-stale",
            severity: "warn",
            file: DEMO_HINTS_FILE,
            message: `Demo hint "${hintName}" references a component that does not exist in ${COMPONENTS_DIR}`,
            detail: `The component "${hintName}" has a demo hint but no corresponding .vue file. It may have been renamed or deleted. Remove the stale hint entry from ${DEMO_HINTS_FILE}.`,
          }),
        );
      }
    }

    // ── Rule 3: demo hint prop drift ──
    for (const comp of componentFiles) {
      const hintProps = demoHintProps.get(comp.name);
      if (!hintProps || hintProps.size === 0) continue;

      const compPath = path.resolve(componentsDir, comp.relPath);
      const compProps = extractComponentPropNames(compPath);

      for (const hintProp of hintProps) {
        if (!compProps.has(hintProp)) {
          findings.push(
            createFinding({
              ruleId: "spl-demo-prop-drift",
              severity: "error",
              file: DEMO_HINTS_FILE,
              message: `${comp.name}: demo hint sets prop "${hintProp}" but the component does not declare it`,
              detail: `The demo hint for ${comp.name} sets prop "${hintProp}" which no longer exists on the component. Update or remove the stale prop from the hint in ${DEMO_HINTS_FILE}.`,
            }),
          );
        }
      }
    }

    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warnCount = findings.filter((f) => f.severity === "warn").length;

    return {
      failed: errorCount > 0,
      findings,
      jsonPayload: {
        componentCount: componentFiles.length,
        hintCount: demoHintNames.size,
        errorCount,
        warnCount,
      },
      report: [
        `# ${TITLE}`,
        "",
        `- **Components found:** ${componentFiles.length}`,
        `- **Demo hints found:** ${demoHintNames.size}`,
        `- **Errors:** ${errorCount}`,
        `- **Warnings:** ${warnCount}`,
        "",
        findings.length === 0 ? "✅ All checks pass — every component has a demo hint and no props have drifted." : "",
      ].join("\n"),
    };
  },
};
