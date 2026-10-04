/**
 * Layout Transitions — connections-arkitect check
 * ================================================
 * Flags CSS `transition` declarations that animate layout-triggering properties
 * (width, height, padding, margin, etc.). These cause per-frame layout
 * recalculation, leading to jank/stutter — especially painful when the
 * transitioning element is a flex/grid sibling.
 *
 * Fix: remove the layout property from the transition (let it snap instantly)
 * and use compositor-only properties (transform, opacity) for the visual
 * animation. If smooth layout resizing is required, add `contain: layout style`
 * on sibling elements to isolate the layout impact.
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check layout-transitions
 */

import {
  runLayoutTransitionsAudit,
  renderReport,
} from "@saydeploy/architect/engines/design-system/layout-transitions-engine";

const DEFAULT_ROOTS = ["src", "packages/connections-ui/src"];

const DEFAULT_TOKEN_FILES = ["src/styles/core/tokens.css", "src/styles/core/transitions.css"];

export const audit = {
  id: "layout-transitions",
  title: "Layout Transitions",
  category: "design-system",
  defaultConfig: {
    roots: DEFAULT_ROOTS,
    tokenFiles: DEFAULT_TOKEN_FILES,
    outputPath: "tmp/audits/LAYOUT_TRANSITIONS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;

    const { findings, filesScanned } = await runLayoutTransitionsAudit({
      root,
      roots: cfg.roots ?? DEFAULT_ROOTS,
      allowlist: cfg.allowlist ?? [],
      tokenFiles: cfg.tokenFiles ?? DEFAULT_TOKEN_FILES,
    });

    const report = renderReport({ findings, filesScanned });

    return {
      failed: findings.some((f) => f.severity === "error"),
      findings,
      jsonPayload: { findings, filesScanned },
      outputPath: cfg.outputPath,
      report,
    };
  },
};
