/**
 * Mode-Driven v-model Binding Audit — connections-arkitect
 * ==========================================================
 * Detects Vue template inputs where `type` / `inputmode` switches on a
 * mode enum (e.g. `mode === "phone"` vs `mode === "email"`) but the bound
 * model (`:model-value` / `v-model`) is statically tied to a single ref
 * that does not also switch on the same mode.
 *
 * This is a silent data bug: when the mode changes the input renders
 * differently but still reads/writes the wrong ref.
 *
 * Detection works in two passes over each .vue SFC:
 *   1. Script pass — find computed properties whose body switches on a
 *      mode variable with contact-method comparisons (phone/email/tel/text).
 *   2. Template pass — find elements using those computed props for
 *      type/inputmode, then check whether their model binding also
 *      references the same mode variable.
 *
 * Example — bug:
 *   const type = computed(() => mode.value === "phone" ? "tel" : "text");
 *   <input :type="type" :model-value="emailRef" />
 *   //                                   ^^^^^^^^ never switches
 *
 * Example — correct:
 *   const model = computed(() => mode.value === "phone" ? phoneRef.value : emailRef.value);
 *   <input :type="type" :model-value="model" />
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS = {
  roots: ["src"],
  extensions: [".vue"],
  skipSegments: ["__tests__", ".spec.", "node_modules", "dist", "tmp", "infra"],
};

// ── Phase 1: script analysis ─────────────────────────────────────────────

/** Contact-method values that indicate a mode-switching type/inputmode computed. */
const CONTACT_METHOD_VALUES = new Set(["phone", "email", "tel", "text"]);

/**
 * Match `const NAME = computed(() => ...)`.
 * Captures group 1 = name, group 2 = arrow body.
 */
const COMPUTED_ARROW_PATTERN =
  /const\s+(\w+)\s*=\s*computed\s*\(\s*\([^)]*\)\s*=>\s*([\s\S]*?)\s*\)\s*(?:;|$)/gm;

/** Returns the PascalCase mode variable from a computed body, or null. */
function extractModeVariable(body) {
  const match = body.match(/\b(\w*Mode)\b/);
  return match ? match[1] : null;
}

/** True when body compares 2+ contact-method values ("phone"/"email"/"tel"/"text"). */
function switchesOnContactMethod(body) {
  let count = 0;
  for (const value of CONTACT_METHOD_VALUES) {
    if (body.includes(`"${value}"`) || body.includes(`'${value}'`)) count++;
  }
  return count >= 2;
}

/**
 * Scan the <script> section and return:
 *   typeComputeds    — Map<name, modeVar>  computeds that switch between contact-method output values
 *   allModeComputeds — Map<name, modeVar>  ALL computeds that reference a mode variable
 *
 * allModeComputeds is broader: it captures model computeds like
 * `friendInviteContactModelValue` that also switch on the mode but output
 * a ref value rather than "tel"/"email". These are valid model bindings.
 */
function analyzeScript(scriptContent) {
  /** @type {Map<string, string>} */
  const typeComputeds = new Map();
  /** @type {Map<string, string>} */
  const allModeComputeds = new Map();

  let match;
  COMPUTED_ARROW_PATTERN.lastIndex = 0;
  while ((match = COMPUTED_ARROW_PATTERN.exec(scriptContent)) !== null) {
    const name = match[1];
    const body = match[2];
    const modeVar = extractModeVariable(body);
    if (!modeVar) continue;

    allModeComputeds.set(name, modeVar);

    if (switchesOnContactMethod(body)) {
      typeComputeds.set(name, modeVar);
    }
  }

  return { typeComputeds, allModeComputeds };
}

// ── Phase 2: template analysis ───────────────────────────────────────────

/** Returns the first name from `names` found in `attrValue`, or null. */
function findReferencedComputed(attrValue, names) {
  for (const n of names) {
    if (attrValue.includes(n)) return n;
  }
  return null;
}

/**
 * Scan the <template> section and return findings for mismatched model bindings.
 *
 * @param {string} templateContent
 * @param {string} filePath
 * @param {{ typeComputeds: Map<string,string>, allModeComputeds: Map<string,string> }} computedData
 */
function scanTemplate(templateContent, filePath, computedData) {
  const { typeComputeds, allModeComputeds } = computedData;
  const findings = [];
  if (typeComputeds.size === 0) return findings;

  const typeNames = [...typeComputeds.keys()];
  const lines = templateContent.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Only inspect AppTextField / input / textarea elements
    if (!/<(?:AppTextField|input|textarea)\b/i.test(line)) continue;

    // Look for :type / type / :inputmode / inputmode / :control bindings
    const typeMatch = line.match(/[:\w]*(?:type|inputmode)\s*=\s*"([^"]*)"/i);
    const controlMatch = line.match(/:control\s*=\s*"([^"]*)"/);

    let matchedComputed = null;
    if (typeMatch) matchedComputed = findReferencedComputed(typeMatch[1], typeNames);
    if (!matchedComputed && controlMatch) matchedComputed = findReferencedComputed(controlMatch[1], typeNames);
    if (!matchedComputed) continue;

    const modeVar = typeComputeds.get(matchedComputed);
    if (!modeVar) continue;

    // Find nearest :model-value / v-model binding (within 3 lines)
    let modelExpr = null;
    for (let offset = 0; offset <= 3; offset++) {
      for (const delta of [offset, -offset]) {
        const idx = i + delta;
        if (idx < 0 || idx >= lines.length) continue;
        const m = lines[idx].match(/(?:v-model|:model-value)\s*=\s*"([^"]*)"/);
        if (m) { modelExpr = m[1]; break; }
      }
      if (modelExpr) break;
    }
    if (!modelExpr) continue;

    // Check if modelExpr is itself a computed that uses the same mode variable.
    // `allModeComputeds` includes model computeds like friendInviteContactModelValue.
    const modelModeVar = allModeComputeds.get(modelExpr);
    if (modelModeVar === modeVar) continue;

    // Also allow if modelExpr directly references the mode variable inline.
    if (modelExpr.includes(modeVar)) continue;

    // Model does NOT reference the mode — flag.
    findings.push(
      createFinding({
        ruleId: "mode-driven-vmodel-binding",
        severity: "error",
        filePath,
        line: i + 1,
        message:
          `Type/inputmode switches on "${modeVar}" (via "${matchedComputed}"), ` +
          `but :model-value / v-model is bound to "${modelExpr}" without ` +
          `referencing "${modeVar}". The model must also switch on the mode ` +
          `so the correct ref (email vs phone) is used for each mode.`,
        snippet: line.trim(),
        metadata: { modeVariable: modeVar, computedName: matchedComputed, modelExpr },
      }),
    );
  }

  return findings;
}

// ── Audit export ──────────────────────────────────────────────────────────

export const audit = {
  id: "mode-driven-vmodel-binding",
  title: "Mode-Driven v-model Binding",
  category: "architecture",
  requires: { frameworks: ["vue", "vue3"] },
  defaultConfig: {
    ...DEFAULTS,
    outputPath: "tmp/audits/MODE_DRIVEN_VMODEL_BINDING.md",
  },
  async run(context) {
    const config = { ...DEFAULTS, ...context.checkConfig };
    const allFiles = await walkFiles({
      root: context.root,
      roots: config.roots,
      extensions: config.extensions,
      skipSegments: config.skipSegments,
    });

    const allFindings = [];
    const scannedFiles = [];

    for (const filePath of allFiles) {
      const absolutePath = path.resolve(context.root, filePath);
      let content;
      try { content = readFileSync(absolutePath, "utf-8"); } catch { continue; }

      // Extract <script setup> (preferred) or <script>
      const scriptMatch =
        content.match(/<script[^>]*setup[^>]*>([\s\S]*?)<\/script>/i) ??
        content.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (!scriptMatch) continue;

      // Extract <template>
      const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
      if (!templateMatch) continue;

      const computedData = analyzeScript(scriptMatch[1]);
      if (computedData.typeComputeds.size === 0) continue;

      const findings = scanTemplate(templateMatch[1], filePath, computedData);
      if (findings.length > 0) {
        scannedFiles.push(filePath);
        allFindings.push(...findings);
      }
    }

    return {
      findings: allFindings,
      summary: {
        filesScanned: scannedFiles.length,
        totalFindings: allFindings.length,
        errorCount: allFindings.filter((f) => f.severity === "error").length,
        warningCount: allFindings.filter((f) => f.severity === "warn").length,
        affectedFiles: [...new Set(allFindings.map((f) => f.filePath))],
      },
      scannedFiles,
    };
  },
};
