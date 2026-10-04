/**
 * no-scoped-css-pseudos — connections-arkitect check
 * ==================================================
 * Fails loudly when `:deep(...)` or `:global(...)` appears in a global
 * `.css` file. Those are Vue scoped-CSS constructs; in plain global CSS
 * they are invalid selectors and the browser drops the whole rule, so the
 * styling silently never applies.
 *
 * Guards against re-introducing the scoped→global extraction landmine
 * (the one-shot extraction/strip migrators that created and then cleared it
 * have since been deleted; this check is now the sole guardrail).
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check no-scoped-css-pseudos
 */

import { runNoScopedCssPseudosAudit } from "@saydeploy/architect/engines/css/no-scoped-css-pseudos-engine";

const NO_SCOPED_CSS_PSEUDOS_DEFAULTS = {
  // Scan ALL global `.css` — not just the style dirs. Component-co-located
  // sheets (a `*.css` sitting next to a `.vue`) are equally global; a standalone
  // `.css` file is never SFC-scoped, so any `:deep()`/`:global()` in one is
  // always dead. No `.module.css` exists in the repo, so there is no legitimate
  // `:global()` to exempt.
  roots: ["src", "packages/connections-ui/src"],
  extensions: [".css"],
  outputPath: "tmp/audits/NO_SCOPED_CSS_PSEUDOS_AUDIT.md",
};

export const audit = {
  id: "no-scoped-css-pseudos",
  title: "No Scoped CSS Pseudos In Global CSS",
  category: "codeRisk",
  defaultConfig: {
    ...NO_SCOPED_CSS_PSEUDOS_DEFAULTS,
    includeInAll: true,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = await runNoScopedCssPseudosAudit({
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
