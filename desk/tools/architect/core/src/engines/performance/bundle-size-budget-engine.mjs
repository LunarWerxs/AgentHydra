import fs from "node:fs/promises";
import path from "node:path";

const SEVERITY_BY_SECTION_DEFAULTS = {
  warnBytes: 500_000,
  errorBytes: 5_000_000,
  top: 25,
  extensions: [],
  perFileBudgets: {},
};

export async function runBundleSizeBudgetSection({ root, sectionId, sectionConfig }) {
  const config = { ...SEVERITY_BY_SECTION_DEFAULTS, ...sectionConfig };
  if (!config.dir) {
    throw new Error(`bundle-size-budget section "${sectionId}" requires a "dir" config.`);
  }

  const dirAbs = path.resolve(root, config.dir);
  const dirExists = await fileExists(dirAbs);

  if (!dirExists) {
    return {
      sectionId,
      skipped: true,
      reason: `Build artifacts not found at ${config.dir}. Run the build first (e.g. \`bun run build\`).`,
      report: renderSkippedReport(sectionId, config),
      failed: false,
      jsonPayload: { sectionId, skipped: true, dir: config.dir },
    };
  }

  const files = await collectFiles(dirAbs, dirAbs, config.extensions);
  const enriched = await Promise.all(
    files.map(async (relPath) => {
      const fullPath = path.join(dirAbs, relPath);
      const stat = await fs.stat(fullPath);
      const budget = resolveBudget(relPath, config);
      const severity = severityFor(stat.size, budget);
      return { path: relPath, size: stat.size, warnBytes: budget.warn, errorBytes: budget.error, severity };
    }),
  );
  enriched.sort((a, b) => b.size - a.size);

  const findings = enriched.filter((entry) => entry.severity !== "ok");
  const errors = findings.filter((entry) => entry.severity === "error");
  const warnings = findings.filter((entry) => entry.severity === "warn");

  const report = renderSectionReport({ sectionId, config, files: enriched, findings, errors, warnings });

  return {
    sectionId,
    skipped: false,
    failed: errors.length > 0,
    jsonPayload: {
      sectionId,
      dir: config.dir,
      files: enriched,
      findings,
      errors: errors.length,
      warnings: warnings.length,
    },
    report,
  };
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(absRoot, baseDir, extensions) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(absRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = path.join(absRoot, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath, baseDir, extensions);
      out.push(...nested);
    } else if (entry.isFile()) {
      if (extensions.length > 0 && !extensions.some((ext) => entry.name.toLowerCase().endsWith(ext.toLowerCase()))) {
        continue;
      }
      out.push(path.relative(baseDir, fullPath).replaceAll(path.sep, "/"));
    }
  }
  return out;
}

function resolveBudget(filePath, config) {
  // perFileBudgets maps a substring/prefix of the file path to an override budget
  // (a single number = both warn & error, or an object { warn, error }).
  for (const [pattern, override] of Object.entries(config.perFileBudgets ?? {})) {
    if (filePath.includes(pattern)) {
      if (typeof override === "number") {
        return { warn: override, error: override };
      }
      if (override && typeof override === "object") {
        return { warn: override.warn ?? config.warnBytes, error: override.error ?? config.errorBytes };
      }
    }
  }
  return { warn: config.warnBytes, error: config.errorBytes };
}

function severityFor(size, budget) {
  if (size > budget.error) return "error";
  if (size > budget.warn) return "warn";
  return "ok";
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function renderSkippedReport(sectionId, config) {
  return `# Bundle Size Budget — ${sectionId}\n\nSkipped: build artifacts not found at \`${config.dir}\`. Run the build first (e.g. \`bun run build\`).\n`;
}

function renderSectionReport({ sectionId, config, files, findings, errors, warnings }) {
  const lines = [
    `# Bundle Size Budget — ${sectionId}`,
    "",
    `- Scanned: \`${config.dir}\` (${files.length} files)`,
    `- Default budget: warn at ${formatBytes(config.warnBytes)}, error at ${formatBytes(config.errorBytes)}`,
    `- Errors: ${errors.length}`,
    `- Warnings: ${warnings.length}`,
    "",
  ];

  if (findings.length > 0) {
    lines.push("## Over Budget", "");
    lines.push("| Severity | Size | Budget (warn → error) | File |");
    lines.push("| --- | ---: | --- | --- |");
    for (const entry of findings) {
      lines.push(
        `| ${entry.severity.toUpperCase()} | ${formatBytes(entry.size)} | ${formatBytes(entry.warnBytes)} → ${formatBytes(entry.errorBytes)} | \`${entry.path}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## Largest Files", "");
  lines.push("| Size | Severity | File |");
  lines.push("| ---: | --- | --- |");
  for (const entry of files.slice(0, config.top ?? 25)) {
    lines.push(`| ${formatBytes(entry.size)} | ${entry.severity} | \`${entry.path}\` |`);
  }

  return `${lines.join("\n")}\n`;
}
