/**
 * Design Token Compliance — unified umbrella audit
 * =================================================
 * Runs all design-system token compliance checks as sections:
 *
 *   colors      — raw hex/rgb/named colors, non-token values (design-tokens)
 *   m3          — M3 surface tiers, shape, typescale, motion, state (m3-guidelines)
 *   states      — state-layer, hover, focus, pressed, disabled (interaction-states)
 *   primitives  — raw elements, bespoke surfaces, !important, hardcoded utilities (ui-drift)
 *   typography  — inline font-size, weight, line-height (design-system-typography)
 *
 * Run all:        bun audit.mjs --check design-token-compliance
 * Run one section: bun audit.mjs --check design-token-compliance --section=colors
 */

import { audit as designTokensAudit } from "./design-tokens.mjs";
import { audit as m3GuidelinesAudit } from "./m3-guidelines.mjs";
import { audit as interactionStatesAudit } from "./interaction-states.mjs";
import { audit as uiDriftAudit } from "./ui-drift.mjs";
import { runDesignSystemTypographyAudit } from "@saydeploy/architect/engines/design-system/design-system-typography-engine";

const SECTION_ALIASES = {
  colors: "colors",
  color: "colors",
  "design-tokens": "colors",
  m3: "m3",
  "m3-guidelines": "m3",
  guidelines: "m3",
  states: "states",
  "interaction-states": "states",
  "state-layers": "states",
  primitives: "primitives",
  "ui-drift": "primitives",
  drift: "primitives",
  typography: "typography",
  type: "typography",
  "design-system-typography": "typography",
};

export const audit = {
  id: "design-token-compliance",
  title: "Design Token Compliance",
  category: "design-system",
  defaultConfig: {
    sections: ["colors", "m3", "states", "primitives", "typography"],
    outputPath: "tmp/audits/DESIGN_TOKEN_COMPLIANCE.md",
    colors: {
      ...designTokensAudit.defaultConfig,
      outputPath: "tmp/audits/DESIGN_TOKENS_AUDIT.md",
    },
    m3: {
      ...m3GuidelinesAudit.defaultConfig,
      outputPath: "tmp/audits/M3_GUIDELINES_AUDIT.md",
    },
    states: {
      ...interactionStatesAudit.defaultConfig,
      outputPath: "tmp/audits/INTERACTION_STATES_AUDIT.md",
    },
    primitives: {
      ...uiDriftAudit.defaultConfig,
      outputPath: "tmp/audits/UI_DRIFT_AUDIT.md",
    },
    typography: {
      roots: ["src"],
      extensions: [".vue", ".css"],
      skipSegments: [".git", "dist", "node_modules", "tmp"],
      maxPerRule: 120,
      inlineFontSizeFileAllowlist: ["src/SharedPrimitivesLiveHarness.vue"],
      outputPath: "tmp/audits/DESIGN_SYSTEM_TYPOGRAPHY_AUDIT.md",
    },
  },
  async run(context) {
    const sections = resolveSections(context);
    const results = [];

    if (sections.includes("colors")) {
      const cfg = { ...context.checkConfig.colors, ...context.checkConfig };
      results.push({
        section: "colors",
        ...(await designTokensAudit.run({ ...context, checkConfig: cfg })),
      });
    }

    if (sections.includes("m3")) {
      const cfg = { ...context.checkConfig.m3, ...context.checkConfig };
      results.push({
        section: "m3",
        ...(await m3GuidelinesAudit.run({ ...context, checkConfig: cfg })),
      });
    }

    if (sections.includes("states")) {
      const cfg = { ...context.checkConfig.states, ...context.checkConfig };
      results.push({
        section: "states",
        ...(await interactionStatesAudit.run({ ...context, checkConfig: cfg })),
      });
    }

    if (sections.includes("primitives")) {
      const cfg = { ...context.checkConfig.primitives, ...context.checkConfig };
      results.push({
        section: "primitives",
        ...(await uiDriftAudit.run({ ...context, checkConfig: cfg })),
      });
    }

    if (sections.includes("typography")) {
      const cfg = { ...context.checkConfig.typography, ...context.checkConfig };
      const result = await runDesignSystemTypographyAudit({
        root: context.root,
        roots: cfg.roots,
        extensions: cfg.extensions,
        skipSegments: cfg.skipSegments,
        maxPerRule: cfg.maxPerRule,
        inlineFontSizeFileAllowlist: cfg.inlineFontSizeFileAllowlist,
      });
      results.push({
        section: "typography",
        failed: result.failed,
        findings: result.findings,
        report: result.report,
        jsonPayload: result.jsonPayload,
      });
    }

    return {
      failed: results.some((r) => r.failed),
      jsonPayload: {
        sections,
        results: results.map((r) => ({
          section: r.section,
          failed: r.failed,
          ...r.jsonPayload,
        })),
      },
      report: results.map((r) => r.report).filter(Boolean).join("\n\n"),
      outputPath: context.checkConfig.outputPath,
    };
  },
};

function resolveSections(context) {
  const requested = [];
  for (const arg of context.checkArgs) {
    const section = arg.startsWith("--section=") ? arg.slice("--section=".length) : arg;
    if (section.startsWith("--")) continue;
    const resolved = SECTION_ALIASES[section];
    if (resolved && !requested.includes(resolved)) requested.push(resolved);
  }
  if (requested.length === 0) return context.checkConfig.sections;
  return requested;
}
