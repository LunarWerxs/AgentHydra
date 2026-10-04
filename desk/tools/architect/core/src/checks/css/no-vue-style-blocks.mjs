/**
 * no-vue-style-blocks — connections-arkitect check
 * =================================================
 * Flags <style> blocks inside .vue and .ts files. All component
 * styles must live in the global CSS architecture:
 *   - Primitives: packages/connections-ui/src/styles/primitives/
 *   - Routes:     src/styles/routes/<area>/
 *   - Shared:     src/styles/shared-declarations.css
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check no-vue-style-blocks
 */

import { runNoVueStyleBlocksAudit } from "@saydeploy/architect/engines/css/no-vue-style-blocks-engine";

const NO_VUE_STYLE_BLOCKS_DEFAULTS = {
  roots: ["src", "packages/connections-ui/src"],
  extensions: [".vue"],
  outputPath: "tmp/audits/NO_VUE_STYLE_BLOCKS_AUDIT.md",
};

export const audit = {
  id: "no-vue-style-blocks",
  title: "No Vue Style Blocks",
  category: "codeRisk",
  defaultConfig: {
    ...NO_VUE_STYLE_BLOCKS_DEFAULTS,
    includeInAll: true,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = await runNoVueStyleBlocksAudit({
      root: context.root,
      roots: cfg.roots,
      extensions: cfg.extensions,
    });

    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      report: result.report,
      outputPath: cfg.outputPath,
    };
  },
};
