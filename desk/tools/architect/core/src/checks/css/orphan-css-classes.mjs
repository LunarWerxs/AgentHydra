/**
 * orphan-css-classes — connections-arkitect check
 * ================================================
 * Flags route-CSS class selectors that no template/component/script ever
 * applies — dead selectors that linger after a rename/delete/refactor.
 *
 * The /explore/browse filter sidebar regression (a dead
 * `discover-command-bar__text-filters` class sharing a `display:none` rule with
 * a live structural container) is the motivating false-negative: css-dedupe and
 * public-css-cascade cannot see a class that matches nothing in the DOM.
 *
 * Opt-in (`includeInAll: false`) for now: there is a known backlog of dead
 * `.discover-*` families (see docs/todo/EXPLORE.md T1) still awaiting removal,
 * so wiring this into the `--all --fail-on-drift` gate today would be noisy.
 * Run it explicitly, clear the backlog, then flip `includeInAll: true`.
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check orphan-css-classes
 */

import { runOrphanCssClassesAudit } from "@saydeploy/architect/engines/css/orphan-css-classes-engine";

const ORPHAN_CSS_CLASSES_DEFAULTS = {
  // Where the route stylesheets live.
  styleRoots: ["src/styles"],
  // Where a class could legitimately be applied.
  usageRoots: ["src", "packages/connections-ui/src"],
  usageExtensions: [".vue", ".ts", ".tsx", ".mts", ".js", ".mjs", ".html"],
  // Route-owned BEM families this check is responsible for. Library / utility /
  // design-system prefixes (gc-*, public-*, app-*, ms-icon*, Tailwind) are
  // intentionally excluded — route CSS targets those as descendants it does not
  // own. Expand this list to widen coverage as families are confirmed static.
  managedPrefixes: ["discover-", "explore-"],
  outputPath: "tmp/audits/ORPHAN_CSS_CLASSES_AUDIT.md",
};

export const audit = {
  id: "orphan-css-classes",
  title: "Orphan CSS Classes",
  category: "maintainability",
  defaultConfig: {
    ...ORPHAN_CSS_CLASSES_DEFAULTS,
    includeInAll: false,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = await runOrphanCssClassesAudit({
      root: context.root,
      styleRoots: cfg.styleRoots,
      usageRoots: cfg.usageRoots,
      usageExtensions: cfg.usageExtensions,
      managedPrefixes: cfg.managedPrefixes,
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
