import fs from "node:fs";
import path from "node:path";

import { applySuppressions } from "@saydeploy/architect/core/suppressions";
import {
  CIRCULAR_DEPS_DEFAULTS,
  runCircularDepsAudit,
} from "@saydeploy/architect/engines/architecture/circular-deps-engine";

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
  id: "circular-deps",
  title: "Circular Dependencies",
  category: "intelligence",
  defaultConfig: {
    ...CIRCULAR_DEPS_DEFAULTS,
    enabled: false,
    includeInAll: false,
    policyPath: "",
    outputPath: "tmp/audits/CIRCULAR_DEPS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const policy = loadPolicy(context.root, cfg.policyPath);
    const merged = {
      ...CIRCULAR_DEPS_DEFAULTS,
      ...cfg,
      roots: policy?.roots ?? cfg.roots,
      extensions: policy?.extensions ?? cfg.extensions,
      aliases: policy?.aliases ?? cfg.aliases,
      ignorePatterns: policy?.ignorePatterns ?? cfg.ignorePatterns,
    };

    const result = await runCircularDepsAudit({ root: context.root, checkConfig: merged });
    const filePaths = [...new Set(result.findings.map((finding) => finding.filePath))];
    const filtered = applySuppressions(result.findings, loadFileTexts(context.root, filePaths));

    // No baselines: every cycle is an actionable finding. Report them all.
    const failed = filtered.length > 0;

    return {
      failed,
      findings: filtered,
      jsonPayload: {
        ...result.jsonPayload,
        cycleCount: filtered.length,
        findings: filtered,
      },
      report: renderReport({ findings: filtered, fileCount: result.jsonPayload.fileCount }),
      outputPath: cfg.outputPath,
    };
  },
};

// Plain report. Emits a parseable `Errors: N` line so the strict-gate summary
// reflects reality (the engine's stock report only prints `Cycles: N`, which the
// summarizer reads as 0 findings — a gate can then exit non-zero while the
// summary claims it passed). Lists every cycle to break.
function renderReport({ findings, fileCount }) {
  const lines = ["# Circular Dependencies", "", `Scanned ${fileCount} files.`, "", `Errors: ${findings.length}`, ""];

  if (findings.length === 0) {
    lines.push("No circular dependencies.", "");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Circular dependencies — break one edge in each cycle", "");
  for (const finding of findings) appendCycle(lines, finding.metadata.cycle);
  return `${lines.join("\n")}\n`;
}

function appendCycle(lines, cycle) {
  lines.push(`### Cycle (${cycle.length} files)`, "");
  for (let step = 0; step < cycle.length; step += 1) {
    lines.push(`- \`${cycle[step]}\` → \`${cycle[(step + 1) % cycle.length]}\``);
  }
  lines.push("");
}
