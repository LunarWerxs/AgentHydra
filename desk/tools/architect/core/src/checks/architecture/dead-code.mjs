/**
 * dead-code — unified orphan file + unused export detection
 * ==========================================================
 * Runs both analyses from a single check. Orphan files are source files
 * that nothing imports (dead at the file level). Unused exports are named
 * exports that nothing imports (dead at the symbol level).
 *
 * Both are opt-in (includeInAll: false) and support baseline drift tracking.
 */
import fs from "node:fs";
import path from "node:path";

import { applySuppressions } from "@saydeploy/architect/core/suppressions";
import {
  ORPHAN_FILES_DEFAULTS,
  runOrphanFilesAudit,
} from "@saydeploy/architect/engines/architecture/orphan-files-engine";
import {
  UNUSED_EXPORTS_DEFAULTS,
  runUnusedExportsAudit,
} from "@saydeploy/architect/engines/architecture/unused-exports-engine";

function loadPolicy(root, policyPath) {
  if (!policyPath) return null;
  const absolute = path.resolve(root, policyPath);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function loadFileTexts(root, filePaths) {
  const map = new Map();
  for (const filePath of filePaths) {
    try {
      map.set(filePath, fs.readFileSync(path.resolve(root, filePath), "utf8"));
    } catch {
      // skip
    }
  }
  return map;
}

export const audit = {
  id: "dead-code",
  title: "Dead Code (orphan files + unused exports)",
  category: "intelligence",
  defaultConfig: {
    enabled: false,
    includeInAll: false,
    outputPath: "tmp/audits/DEAD_CODE_AUDIT.md",
    orphanFiles: {
      ...ORPHAN_FILES_DEFAULTS,
      policyPath: "",
    },
    unusedExports: {
      ...UNUSED_EXPORTS_DEFAULTS,
      policyPath: "",
    },
  },
  async run(context) {
    const cfg = context.checkConfig;

    // --- Orphan files ---
    const orphanPolicy = loadPolicy(context.root, cfg.orphanFiles?.policyPath);
    const orphanMerged = {
      ...ORPHAN_FILES_DEFAULTS,
      ...cfg.orphanFiles,
      roots: orphanPolicy?.roots ?? cfg.orphanFiles?.roots,
      extensions: orphanPolicy?.extensions ?? cfg.orphanFiles?.extensions,
      aliases: orphanPolicy?.aliases ?? cfg.orphanFiles?.aliases,
      entryPatterns: orphanPolicy?.entryPatterns ?? cfg.orphanFiles?.entryPatterns,
      ignorePatterns: orphanPolicy?.ignorePatterns ?? cfg.orphanFiles?.ignorePatterns,
    };

    const orphanResult = await runOrphanFilesAudit({ root: context.root, checkConfig: orphanMerged });
    const orphanFilePaths = [...new Set(orphanResult.findings.map((f) => f.filePath))];
    const orphanFiltered = applySuppressions(orphanResult.findings, loadFileTexts(context.root, orphanFilePaths));

    const orphanBaselineKeys = new Set(context.baseline?.orphans ?? []);
    const orphanDrift = orphanFiltered.filter((f) => !orphanBaselineKeys.has(f.metadata.baselineKey));
    const orphanHasBaseline = orphanBaselineKeys.size > 0;

    // --- Unused exports ---
    const exportPolicy = loadPolicy(context.root, cfg.unusedExports?.policyPath);
    const exportMerged = {
      ...UNUSED_EXPORTS_DEFAULTS,
      ...cfg.unusedExports,
      roots: exportPolicy?.roots ?? cfg.unusedExports?.roots,
      extensions: exportPolicy?.extensions ?? cfg.unusedExports?.extensions,
      aliases: exportPolicy?.aliases ?? cfg.unusedExports?.aliases,
      entryPatterns: exportPolicy?.entryPatterns ?? cfg.unusedExports?.entryPatterns,
      ignorePatterns: exportPolicy?.ignorePatterns ?? cfg.unusedExports?.ignorePatterns,
      ignoreNames: exportPolicy?.ignoreNames ?? cfg.unusedExports?.ignoreNames,
    };

    const exportResult = await runUnusedExportsAudit({ root: context.root, checkConfig: exportMerged });
    const exportFilePaths = [...new Set(exportResult.findings.map((f) => f.filePath))];
    const exportFiltered = applySuppressions(exportResult.findings, loadFileTexts(context.root, exportFilePaths));

    const exportBaselineKeys = new Set(context.baseline?.unused ?? []);
    const exportDrift = exportFiltered.filter((f) => !exportBaselineKeys.has(f.metadata.baselineKey));
    const exportHasBaseline = exportBaselineKeys.size > 0;

    // --- Combined ---
    const orphanFailed = orphanHasBaseline ? orphanDrift.length > 0 : orphanFiltered.length > 0;
    const exportFailed = exportHasBaseline ? exportDrift.length > 0 : exportFiltered.length > 0;

    return {
      failed: orphanFailed || exportFailed,
      jsonPayload: {
        orphanFiles: {
          findings: orphanFiltered,
          driftCount: orphanDrift.length,
        },
        unusedExports: {
          findings: exportFiltered,
          driftCount: exportDrift.length,
        },
      },
      baselineDocument: {
        version: 1,
        generatedAt: new Date().toISOString(),
        orphans: orphanFiltered.map((f) => f.metadata.baselineKey),
        unused: exportFiltered.map((f) => f.metadata.baselineKey),
      },
      report:
        [orphanResult.report, exportResult.report].filter(Boolean).join("\n\n") ||
        "# Dead Code Audit\n\nNo orphan files or unused exports detected.",
      outputPath: cfg.outputPath,
    };
  },
};
