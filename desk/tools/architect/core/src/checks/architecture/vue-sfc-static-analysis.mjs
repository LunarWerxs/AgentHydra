/**
 * vue-sfc-static-analysis — unified Vue SFC correctness checks
 * =============================================================
 * Runs multiple static analysis rules over Vue Single File Components
 * in a single pass:
 *
 * - missing-vue-imports: flags usage of Vue APIs (ref, computed, watch, etc.)
 *   without the corresponding `import { ... } from 'vue'`
 * - vue-immediate-watch-tdz: flags `watch(foo, ..., { immediate: true })`
 *   where `foo` is a ref that may be in the temporal dead zone
 */
import { runMissingVueImportsAudit } from "@saydeploy/architect/engines/architecture/missing-vue-imports-engine";
import { runVueImmediateWatchTdzAudit } from "@saydeploy/architect/engines/architecture/vue-immediate-watch-tdz-engine";

export const audit = {
  id: "vue-sfc-static-analysis",
  title: "Vue SFC Static Analysis",
  category: "correctness",
  requires: { frameworks: ["vue", "vue3"] },
  defaultConfig: {
    includeInAll: true,
    roots: ["src"],
    outputPath: "tmp/audits/VUE_SFC_STATIC_ANALYSIS_AUDIT.md",
    missingVueImports: {
      skipDirs: ["node_modules", "__tests__", "infra", "dist", ".git", "test"],
    },
    vueImmediateWatchTdz: {
      extensions: [".vue", ".ts"],
    },
  },
  async run(context) {
    const cfg = context.checkConfig;
    const targetRoots = context.checkArgs.filter((arg) => !arg.startsWith("--"));
    const roots = targetRoots.length ? targetRoots : cfg.roots;

    // --- Missing Vue imports ---
    const importsResult = await runMissingVueImportsAudit({
      root: context.root,
      roots,
      skipDirs: cfg.missingVueImports?.skipDirs,
    });

    // --- Immediate watch TDZ ---
    const tdzResult = await runVueImmediateWatchTdzAudit({
      root: context.root,
      roots,
      extensions: cfg.vueImmediateWatchTdz?.extensions,
    });

    const findings = [
      ...mapMissingVueImportFindings(importsResult.jsonPayload),
      ...mapVueImmediateWatchTdzFindings(tdzResult.jsonPayload),
    ];

    return {
      failed: importsResult.failed || tdzResult.failed,
      findings,
      jsonPayload: {
        findings,
        missingVueImports: importsResult.jsonPayload,
        vueImmediateWatchTdz: tdzResult.jsonPayload,
      },
      report:
        [importsResult.report, tdzResult.report].filter(Boolean).join("\n\n") ||
        "# Vue SFC Static Analysis\n\nNo issues detected.",
      outputPath: cfg.outputPath,
    };
  },
};

function mapMissingVueImportFindings(payload = {}) {
  return (payload.bugs ?? []).map((bug) => {
    const firstMissing = bug.missing?.[0];
    return {
      ruleId: "missing-vue-imports",
      severity: "error",
      filePath: bug.file,
      line: firstMissing?.lines?.[0] ?? 1,
      message: `Missing local import for template component ${firstMissing?.name ? `<${firstMissing.name}>` : "tag"}.`,
    };
  });
}

function mapVueImmediateWatchTdzFindings(payload = {}) {
  return (payload.findings ?? []).map((finding) => ({
    ruleId: "vue-immediate-watch-tdz",
    severity: "error",
    filePath: finding.file,
    line: finding.watchLine ?? 1,
    message: `Immediate ${finding.watchKind ?? "watch"} references ${finding.identifier} before declaration.`,
  }));
}
