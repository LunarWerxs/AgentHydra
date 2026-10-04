/**
 * multi-root-attrs — ensure Vue SFCs with multiple root elements bind $attrs
 * =========================================================================
 *
 * Vue 3 components with multiple root nodes (fragments) do NOT automatically
 * inherit parent attributes. Any `class`, `style`, `data-testid`, or other
 * attribute passed by the parent is silently discarded unless the component
 * wraps its roots in a single element with `v-bind="$attrs"`.
 *
 * This was the root cause of a blank connections table bug (2026-05-27):
 * WorkspaceContactDirectoryView had two root elements (v-if/v-else for
 * mobile/desktop shells) and the layout classes passed by the parent were
 * silently dropped, collapsing the component to zero height.
 */
import { runMultiRootAttrsAudit } from "@saydeploy/architect/engines/architecture/multi-root-attrs-engine";

export const audit = {
  id: "multi-root-attrs",
  title: "Multi-Root Vue SFCs Missing $attrs Binding",
  category: "correctness",
  requires: { frameworks: ["vue", "vue3"] },
  defaultConfig: {
    includeInAll: true,
    roots: ["src"],
    outputPath: "tmp/audits/MULTI_ROOT_ATTRS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const targetRoots = context.checkArgs.filter((arg) => !arg.startsWith("--"));
    const roots = targetRoots.length ? targetRoots : cfg.roots;

    const result = await runMultiRootAttrsAudit({
      root: context.root,
      roots,
    });

    return {
      // Warnings only — multi-root SFCs without $attrs are a code smell but
      // many are intentional (dialogs, modals, shells). The check documents
      // the pattern without blocking CI.
      failed: false,
      jsonPayload: result.jsonPayload,
      report: result.report,
      outputPath: cfg.outputPath,
    };
  },
};
