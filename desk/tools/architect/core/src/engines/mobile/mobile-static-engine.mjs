import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "@saydeploy/architect/core/files";

function addFinding(findings, rule, file, line, severity, message, excerpt = "") {
  findings.push({ rule, file, line, severity, message, excerpt });
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function isAllowlisted(file, allowlist = []) {
  return allowlist.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

function isSkipped(file, skipFilePatterns = []) {
  return skipFilePatterns.some((pattern) => new RegExp(pattern).test(file));
}

function scanText({ findings, file, text, config }) {
  const viewportMatches = text.matchAll(/<meta\s+[^>]*name=["']viewport["'][^>]*>/gi);
  for (const match of viewportMatches) {
    const tag = match[0];
    if (/user-scalable\s*=\s*no/i.test(tag) || /maximum-scale\s*=\s*1(?:\.0)?/i.test(tag)) {
      addFinding(
        findings,
        "mobile-viewport-zoom-disabled",
        file,
        lineNumberForIndex(text, match.index ?? 0),
        "error",
        "Viewport meta disables or restricts pinch zoom.",
        tag.trim(),
      );
    }
  }

  for (const match of text.matchAll(/\b(?:input|textarea|select)[^{;]*\{[^}]*font-size\s*:\s*([0-9.]+)px[^}]*}/gis)) {
    const fontSize = Number(match[1]);
    if (Number.isFinite(fontSize) && fontSize < config.minFormControlFontPx) {
      addFinding(
        findings,
        "mobile-form-control-font-size",
        file,
        lineNumberForIndex(text, match.index ?? 0),
        "warning",
        `Editable form controls below ${config.minFormControlFontPx}px can trigger iOS focus zoom.`,
        match[0].trim().slice(0, 180),
      );
    }
  }

  for (const match of text.matchAll(/(?:^|[\s{;])width\s*:\s*([4-9][0-9]{2,}|[1-9][0-9]{3,})px\b/gi)) {
    const width = Number(match[1]);
    if (width >= config.fixedWidthWarnPx) {
      addFinding(
        findings,
        "mobile-fixed-width",
        file,
        lineNumberForIndex(text, match.index ?? 0),
        "warning",
        `Fixed ${width}px width may overflow narrow mobile viewports.`,
        match[0],
      );
    }
  }

  for (const match of text.matchAll(/\b(?:width|min-width|max-width)\s*:\s*100vw\b/gi)) {
    addFinding(
      findings,
      "mobile-100vw-overflow-risk",
      file,
      lineNumberForIndex(text, match.index ?? 0),
      "warning",
      "100vw can include scrollbar width and create horizontal overflow on mobile.",
      match[0],
    );
  }
}

function scanWorkspaceViewportContract({ findings, file, text }) {
  if (!/\bshowWorkspace\b/.test(text)) {
    return;
  }

  const workspaceScreenHeightPatterns = [
    /\bshowWorkspace\.value\s*\?\s*["'][^"']*\bh-screen\b[^"']*["']/g,
    /\bshowWorkspace\s*\?\s*["'][^"']*\bh-screen\b[^"']*["']/g,
    /:class="[^"]*\bisTallTopLevelPage\b[^"]*\bh-screen\b[^"]*"/g,
    /:class='[^']*\bisTallTopLevelPage\b[^']*\bh-screen\b[^']*'/g,
  ];

  for (const pattern of workspaceScreenHeightPatterns) {
    for (const match of text.matchAll(pattern)) {
      addFinding(
        findings,
        "mobile-workspace-route-shell-100vh",
        file,
        lineNumberForIndex(text, match.index ?? 0),
        "error",
        "Workspace route shells must inherit the workspace 100dvh body lock instead of adding a 100vh/h-screen wrapper.",
        match[0].trim().slice(0, 180),
      );
    }
  }
}

function countFindingsByRuleAndFile(findings) {
  const rules = {};
  for (const finding of findings) {
    rules[finding.rule] ??= {
      severity: finding.severity,
      files: {},
    };
    rules[finding.rule].files[finding.file] = (rules[finding.rule].files[finding.file] ?? 0) + 1;
  }
  return rules;
}

function buildBaselineDocument(findings) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rules: countFindingsByRuleAndFile(findings),
  };
}

function findRegressions(currentRules, baseline = {}) {
  if (!baseline?.rules) {
    return [];
  }

  const regressions = [];
  const baselineRules = baseline.rules ?? {};
  for (const [rule, ruleData] of Object.entries(currentRules)) {
    const baselineFiles = baselineRules[rule]?.files ?? {};
    for (const [file, count] of Object.entries(ruleData.files ?? {})) {
      const baselineCount = baselineFiles[file] ?? 0;
      if (count > baselineCount) {
        regressions.push({
          rule,
          file,
          severity: ruleData.severity,
          current: count,
          baseline: baselineCount,
        });
      }
    }
  }
  return regressions;
}

async function scanViewportDocument({ findings, root, config }) {
  for (const file of config.viewportDocuments) {
    const absolutePath = path.resolve(root, file);
    let text;
    try {
      text = await fs.readFile(absolutePath, "utf8");
    } catch {
      addFinding(
        findings,
        "mobile-viewport-document-missing",
        file,
        1,
        "warning",
        "Configured viewport document is missing.",
      );
      continue;
    }

    const viewport = text.match(/<meta\s+[^>]*name=["']viewport["'][^>]*>/i);
    if (!viewport) {
      addFinding(
        findings,
        "mobile-viewport-missing",
        file,
        1,
        "error",
        "Document is missing a viewport meta tag for mobile layout.",
      );
    }
  }
}

function renderMarkdown({ findings, scannedFiles, config, regressions }) {
  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const lines = [];
  lines.push("# Static Mobile Audit");
  lines.push("");
  lines.push(`- Files scanned: ${scannedFiles}`);
  lines.push(`- Errors: ${errors.length}`);
  lines.push(`- Warnings: ${warnings.length}`);
  lines.push(`- Regressions: ${regressions.length}`);
  lines.push(`- Full browser/device audit: ${config.fullAuditCommand}`);
  lines.push("");
  lines.push(
    "This is the no-browser mobile contract used by `--all`. Run the full browser/device audit when mobile behavior itself is the task.",
  );
  lines.push("");

  if (!findings.length) {
    lines.push("No static mobile drift found.");
    return `${lines.join("\n")}\n`;
  }

  if (regressions.length) {
    lines.push("## Regressions");
    lines.push("");
    for (const regression of regressions.slice(0, config.maxFindings)) {
      lines.push(
        `- ${regression.file}: ${regression.rule} ${regression.current} current, ${regression.baseline} baseline`,
      );
    }
    lines.push("");
  }

  lines.push("## Findings");
  lines.push("");
  lines.push("| Severity | Rule | Location | Finding |");
  lines.push("| --- | --- | --- | --- |");
  for (const finding of findings.slice(0, config.maxFindings)) {
    const location = `${finding.file}:${finding.line}`;
    lines.push(`| ${finding.severity} | \`${finding.rule}\` | \`${location}\` | ${finding.message} |`);
  }

  if (findings.length > config.maxFindings) {
    lines.push("");
    lines.push(`_Showing first ${config.maxFindings} of ${findings.length} findings._`);
  }

  return `${lines.join("\n")}\n`;
}

export async function runStaticMobileAudit(options = {}) {
  const config = {
    roots: options.roots ?? ["src/components", "src/styles", "src/shared-primitives-live", "index.html"],
    extensions: options.extensions ?? [".vue", ".css", ".html", ".ts", ".tsx"],
    skipSegments: options.skipSegments ?? [".git", "dist", "node_modules", "tmp"],
    skipFilePatterns: options.skipFilePatterns ?? [
      "\\.spec\\.[cm]?[tj]sx?$",
      "\\.test\\.[cm]?[tj]sx?$",
      "(?:^|/)__tests__/",
    ],
    allowlist: options.allowlist ?? [],
    viewportDocuments: options.viewportDocuments ?? ["index.html"],
    workspaceViewportContractFiles: options.workspaceViewportContractFiles ?? ["src/components/AppRouteShell.vue"],
    minFormControlFontPx: options.minFormControlFontPx ?? 16,
    fixedWidthWarnPx: options.fixedWidthWarnPx ?? 390,
    maxFindings: options.maxFindings ?? 120,
    fullAuditCommand: options.fullAuditCommand ?? "bun run audit:mobile",
  };

  const files = await walkFiles({
    root: options.root,
    roots: config.roots,
    extensions: config.extensions,
    skipSegments: config.skipSegments,
  });
  const findings = [];

  await scanViewportDocument({ findings, root: options.root, config });

  for (const file of files) {
    if (isAllowlisted(file, config.allowlist) || isSkipped(file, config.skipFilePatterns)) {
      continue;
    }

    const text = await fs.readFile(path.resolve(options.root, file), "utf8");
    scanText({ findings, file, text, config });
    if (config.workspaceViewportContractFiles.includes(file)) {
      scanWorkspaceViewportContract({ findings, file, text });
    }
  }

  const errors = findings.filter((finding) => finding.severity === "error");
  const baselineDocument = buildBaselineDocument(findings);
  const regressions = findRegressions(baselineDocument.rules, options.baseline);
  return {
    baselineDocument,
    failed: errors.length > 0 || regressions.length > 0,
    findings,
    jsonPayload: {
      scannedFiles: files.length,
      errors: errors.length,
      warnings: findings.length - errors.length,
      regressions,
      findings,
    },
    report: renderMarkdown({ findings, scannedFiles: files.length, config, regressions }),
  };
}
