/**
 * Host Header Chip Wiring — connections-arkitect
 * ===============================================
 * The host-console event header renders a rail of "meta chips" (format,
 * repeats, approval, visibility, capacity, calendar, explore, category/tags).
 * Each chip id is declared in the `TitleCardMetaItem` id union inside
 * `useWorkspaceHostEditorSummaryHeader.ts`, and EACH must have a matching
 * flyout editor branch (`activeMetaEditorItem?.id === '<id>'`) in the shell
 * `WorkspaceHostConsoleEditorShellV2.vue`. If a chip id has no editor branch,
 * clicking that chip opens an EMPTY popover — a silent dead chip.
 *
 * Adding a chip means registering it in ~6 places; forgetting the editor
 * branch is the silent failure this check guards. Born from the 2026-05-31
 * "Repeats" chip work, where the chip id and its editor branch had to move in
 * lock-step (and a grouped-layout experiment was added, then fully removed —
 * each step risked a dangling chip id or a dangling branch).
 *
 * The overflow-menu handler (`handleHeaderOverflowMenuSelect`) is deliberately
 * NOT checked here: it `throw`s on an unknown id, so a missing overflow case
 * fails LOUDLY at runtime and needs no static guard. This check targets only
 * the SILENT failure mode (chip with no editor → empty popover).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";

const DEFAULTS = {
  root: ".",
  // Declares the chip-id union (`interface <chipInterfaceName>`).
  sourceFile: "src/components/workspace/views/host/useWorkspaceHostEditorSummaryHeader.ts",
  // Renders one flyout editor branch per chip, keyed `activeMetaEditorItem?.id === '<id>'`.
  shellFile: "src/components/workspace/views/host/WorkspaceHostConsoleEditorShellV2.vue",
  chipInterfaceName: "TitleCardMetaItem",
};

// ── Pure parsers (exported for unit/fixture tests) ─────────────────────────

/** Collect the string-literal members of the `id:` union in `interface <name>`. */
export function extractChipIds(sourceText, chipInterfaceName) {
  const ids = new Set();
  const interfaceIdx = sourceText.indexOf(`interface ${chipInterfaceName}`);
  if (interfaceIdx === -1) {
    return ids;
  }
  // Capture from the interface's first `id:` field up to its terminating `;`.
  const idFieldMatch = /\bid\s*:\s*([\s\S]*?);/.exec(sourceText.slice(interfaceIdx));
  if (!idFieldMatch) {
    return ids;
  }
  const literalRe = /["']([a-z][a-z0-9-]*)["']/gi;
  let match;
  while ((match = literalRe.exec(idFieldMatch[1])) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

/** Collect every id referenced as `activeMetaEditorItem?.id === '<id>'` in the shell template. */
export function extractEditorBranchIds(shellText) {
  const ids = new Set();
  const branchRe = /activeMetaEditorItem\?\.id\s*===\s*["']([a-z][a-z0-9-]*)["']/gi;
  let match;
  while ((match = branchRe.exec(shellText)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

/** Compare the chip-id union against the shell's editor branches. */
export function analyzeHostHeaderChipWiring({ sourceText, shellText, chipInterfaceName }) {
  const chipIds = extractChipIds(sourceText, chipInterfaceName);
  const branchIds = extractEditorBranchIds(shellText);
  const missingEditors = [...chipIds].filter((id) => !branchIds.has(id));
  const orphanEditors = [...branchIds].filter((id) => !chipIds.has(id));
  return {
    chipIds: [...chipIds],
    branchIds: [...branchIds],
    missingEditors,
    orphanEditors,
  };
}

function lineOf(text, needle) {
  const idx = text.indexOf(needle);
  return idx === -1 ? 1 : text.slice(0, idx).split("\n").length;
}

// ── Audit export ───────────────────────────────────────────────────────────

export const audit = {
  id: "host-header-chip-wiring",
  title: "Host Header Chip Wiring",
  category: "surface",
  requires: { projectNames: ["connections"], frameworks: ["vue", "vue3"] },
  defaultConfig: { ...DEFAULTS, outputPath: "tmp/audits/HOST_HEADER_CHIP_WIRING_AUDIT.md" },
  async run(context) {
    const config = { ...DEFAULTS, ...(context.checkConfig ?? {}) };
    const root = context.root ?? config.root ?? ".";
    const findings = [];

    const read = (relativePath) => {
      try {
        return readFileSync(path.resolve(root, relativePath), "utf-8");
      } catch {
        return null;
      }
    };

    const sourceText = read(config.sourceFile);
    const shellText = read(config.shellFile);

    // If either wiring file moved/renamed, the invariant is unguarded — say so loudly.
    if (sourceText === null) {
      findings.push(
        createFinding({
          ruleId: "host-header-chip-wiring/source-missing",
          severity: "error",
          filePath: config.sourceFile,
          line: 1,
          message: `Cannot read header chip source '${config.sourceFile}'. If it moved or was renamed, update this check's config — the chip-wiring invariant is currently unguarded.`,
        }),
      );
    }
    if (shellText === null) {
      findings.push(
        createFinding({
          ruleId: "host-header-chip-wiring/shell-missing",
          severity: "error",
          filePath: config.shellFile,
          line: 1,
          message: `Cannot read header shell '${config.shellFile}'. If it moved or was renamed, update this check's config — the chip-wiring invariant is currently unguarded.`,
        }),
      );
    }

    let analysis = { chipIds: [], branchIds: [], missingEditors: [], orphanEditors: [] };

    if (sourceText !== null && shellText !== null) {
      analysis = analyzeHostHeaderChipWiring({
        sourceText,
        shellText,
        chipInterfaceName: config.chipInterfaceName,
      });

      if (analysis.chipIds.length === 0) {
        findings.push(
          createFinding({
            ruleId: "host-header-chip-wiring/union-unparsed",
            severity: "error",
            filePath: config.sourceFile,
            line: lineOf(sourceText, `interface ${config.chipInterfaceName}`),
            message: `Could not parse the '${config.chipInterfaceName}' id union — the chip-wiring invariant cannot be verified. The interface shape likely changed; update this check.`,
          }),
        );
      }

      for (const id of analysis.missingEditors) {
        findings.push(
          createFinding({
            ruleId: "host-header-chip-wiring/chip-without-editor",
            severity: "error",
            filePath: config.shellFile,
            line: 1,
            message: `Header chip '${id}' has no flyout editor branch (\`activeMetaEditorItem?.id === '${id}'\`) in ${path.basename(config.shellFile)}. Clicking the chip opens an empty popover. Add the editor branch (or remove '${id}' from the ${config.chipInterfaceName} union).`,
            metadata: { id },
          }),
        );
      }

      for (const id of analysis.orphanEditors) {
        findings.push(
          createFinding({
            ruleId: "host-header-chip-wiring/orphan-editor",
            severity: "warning",
            filePath: config.shellFile,
            line: 1,
            message: `Flyout editor branch for '${id}' has no matching id in the '${config.chipInterfaceName}' union — a dead branch, likely left after a chip was renamed or removed.`,
            metadata: { id },
          }),
        );
      }
    }

    const failed = findings.some((finding) => finding.severity === "error");

    const reportLines = [
      `# Host Header Chip Wiring`,
      ``,
      `_Every \`${config.chipInterfaceName}\` chip id must have a flyout editor branch in the shell, or clicking the chip opens an empty popover._`,
      ``,
      `- Source: \`${config.sourceFile}\``,
      `- Shell: \`${config.shellFile}\``,
      `- Chip ids (${analysis.chipIds.length}): ${analysis.chipIds.join(", ") || "—"}`,
      `- Editor branches (${analysis.branchIds.length}): ${analysis.branchIds.join(", ") || "—"}`,
      ``,
    ];
    if (findings.length === 0) {
      reportLines.push(`## ✅ Every header chip is wired to an editor branch.`);
    } else {
      reportLines.push(`## Findings`, ``);
      for (const finding of findings) {
        reportLines.push(`- **${finding.severity.toUpperCase()}** \`${finding.ruleId}\` — ${finding.message}`);
      }
    }
    reportLines.push(``);

    return {
      failed,
      findings,
      report: reportLines.join("\n"),
      jsonPayload: { ...analysis },
      outputPath: config.outputPath,
    };
  },
};
