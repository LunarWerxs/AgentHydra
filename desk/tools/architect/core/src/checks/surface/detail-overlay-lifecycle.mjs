/**
 * Detail Overlay Lifecycle Audit — connections-arkitect
 * ======================================================
 * Detects Vue component lifecycle anti-patterns in detail overlay usage:
 * 1. View-switching in detail-open handlers (should use sidebar overlay)
 * 2. Premature unmount of overlay components before CSS transitions complete
 * 3. Revealing a mounted detail dock with nextTick instead of a painted frame
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";

const DEFAULTS = {
  root: ".",
  roots: ["src"],
  extensions: [".vue", ".ts"],
  skipSegments: ["__tests__", ".spec.", "node_modules", "dist", "tmp"],
};

const VIEW_SWITCH_IN_DETAIL_OPEN_RE = /\b(?:openHostConsoleView|selectView)\s*\(\s*(['"]host_console['"])\s*\)/;
const PREMATURE_OVERLAY_UNMOUNT_RE = /(\w+(?:Detail)?(?:Overlay)?Mounted)\s*\.\s*value\s*=\s*false/;
const NEXT_TICK_RE = /\bnextTick\s*\(/;
const DETAIL_VISIBLE_TRUE_RE = /\b\w*DetailVisible\s*\.\s*value\s*=\s*true\b/;

export const audit = {
  id: "detail-overlay-lifecycle",
  title: "Detail Overlay Lifecycle Audit",
  category: "surface",
  requires: { frameworks: ["vue", "vue3"] },
  defaultConfig: {
    ...DEFAULTS,
    outputPath: "tmp/audits/DETAIL_OVERLAY_LIFECYCLE.md",
  },
  async run(context) {
    const config = { ...DEFAULTS, ...context.checkConfig };
    const allFiles = await walkFiles({
      root: config.root,
      roots: config.roots,
      extensions: config.extensions,
      skipSegments: config.skipSegments,
    });

    const findings = [];
    const scannedFiles = [];
    let totalFiles = 0;

    for (const filePath of allFiles) {
      totalFiles++;
      const absolutePath = path.resolve(config.root, filePath);
      let content;
      try {
        content = readFileSync(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      let fileHasFindings = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isSkippableLine(line)) continue;

        if (VIEW_SWITCH_IN_DETAIL_OPEN_RE.test(line)) {
          // Skip calls inside intentional navigation functions —
          // `openHostConsoleView()`, `selectView()`, `goToHostConsole()`,
          // etc. are by definition the right place to switch views.
          if (!isInsideNavigationFunction(lines, i)) {
            findings.push(
              createFinding({
                filePath,
                line: i + 1,
                severity: "warning",
                ruleId: "detail-overlay/view-switch-in-open-handler",
                message:
                  "View-switching function (openHostConsoleView/selectView) called in a context where a detail-overlay sidebar should be used instead. This causes a full page change rather than a sidebar animation.",
                snippet: line.trim(),
              }),
            );
            fileHasFindings = true;
          }
        }

        const unmountMatch = line.match(PREMATURE_OVERLAY_UNMOUNT_RE);
        if (unmountMatch) {
          const flagName = unmountMatch[1];
          if (isInsideCloseHandler(lines, i)) {
            findings.push(
              createFinding({
                filePath,
                line: i + 1,
                severity: "warning",
                ruleId: "detail-overlay/premature-unmount-in-close-handler",
                message: `Setting \`${flagName}.value = false\` in a close handler destroys the component (via v-if) before its CSS leave transition can play. Defer unmount until the @after-close animation-complete event.`,
                snippet: line.trim(),
              }),
            );
            fileHasFindings = true;
          }
        }

        if (
          NEXT_TICK_RE.test(line) &&
          fileUsesDetailOverlaySurface(content) &&
          nextTickDirectlyRevealsDetailVisible(lines, i) &&
          isInsideDetailOpenHandler(lines, i)
        ) {
          findings.push(
            createFinding({
              filePath,
              line: i + 1,
              severity: "warning",
              ruleId: "detail-overlay/next-tick-visible-reveal",
              message:
                "`nextTick()` is not a browser paint boundary. Detail overlays that mount hidden and then reveal must wait for requestAnimationFrame so the closed width/transform paints before the open transition starts.",
              snippet: line.trim(),
            }),
          );
          fileHasFindings = true;
        }
      }
      if (fileHasFindings) scannedFiles.push(filePath);
    }

    const failed = findings.length > 0;
    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warnCount = findings.filter((f) => f.severity === "warning" || f.severity === "warn").length;
    const reportLines = [
      "# Detail Overlay Lifecycle Audit",
      "",
      `Scanned ${scannedFiles.length}/${totalFiles} files with findings.`,
      `- Errors: ${errorCount}`,
      `- Warnings: ${warnCount}`,
      "",
      "## Rules",
      "",
      "### detail-overlay/view-switch-in-open-handler",
      "Functions that open a detail view should use the existing sidebar overlay surface instead of switching the entire active view.",
      "",
      "### detail-overlay/premature-unmount-in-close-handler",
      "Close handlers must not destroy overlay components before the CSS leave animation completes.",
      "",
      "### detail-overlay/next-tick-visible-reveal",
      "Detail overlays must not use nextTick as a stand-in for a painted frame before setting their visible ref true.",
      "",
      findings.length > 0 ? "## Findings" : "## No findings",
      "",
    ];
    for (const f of findings) {
      const relPath = path.relative(process.cwd(), f.filePath).replace(/\\/g, "/");
      reportLines.push(`- **${relPath}:${f.line}** — ${f.message}`);
      reportLines.push(`  \`\`\`\n  ${f.snippet}\n  \`\`\``, "");
    }
    reportLines.push(`Errors: ${errorCount}`, `Warnings: ${warnCount}`, "");

    return {
      failed,
      findings,
      report: reportLines.join("\n"),
      jsonPayload: { scannedFiles: scannedFiles.length, totalFiles, totalFindings: findings.length, findings },
      outputPath: config.outputPath,
    };
  },
};

function isSkippableLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  if (/^(import|export)\s/.test(trimmed)) return true;
  if (/^(interface|type)\s/.test(trimmed)) return true;
  return false;
}

function fileUsesDetailOverlaySurface(content) {
  return (
    content.includes('surface="detail-overlay"') ||
    content.includes("surface: \"detail-overlay\"") ||
    content.includes("surface: 'detail-overlay'") ||
    content.includes("isDetailOverlay")
  );
}

function nextTickDirectlyRevealsDetailVisible(contextLines, lineIndex) {
  const end = Math.min(contextLines.length, lineIndex + 10);
  for (let i = lineIndex + 1; i < end; i++) {
    const line = contextLines[i];
    if (/(?:async\s+)?function\s+\w+\s*\(/.test(line)) return false;
    if (/\brequestAnimationFrame\s*\(/.test(line)) return false;
    if (DETAIL_VISIBLE_TRUE_RE.test(contextLines[i])) return true;
  }
  return false;
}

function isInsideCloseHandler(contextLines, lineIndex) {
  for (let i = lineIndex; i >= 0; i--) {
    const line = contextLines[i].trim();
    const funcMatch = line.match(
      /(?:function|const|let|var)\s+(\w*(?:close|cleanup|destroy|remove|dismiss|hide|reset)\w*)\s*[=(]/,
    );
    if (funcMatch) return true;
    const otherFunc = line.match(/(?:function|const|let|var)\s+(\w+)\s*[=(]/);
    if (otherFunc && !/close|cleanup|destroy|remove|dismiss|hide|reset/i.test(otherFunc[1])) return false;
    if (line.startsWith("export ") || line.startsWith("</script>") || line.startsWith("<script")) return false;
  }
  return false;
}

function isInsideDetailOpenHandler(contextLines, lineIndex) {
  for (let i = lineIndex; i >= 0; i--) {
    const line = contextLines[i].trim();
    const funcMatch = line.match(
      /(?:async\s+)?function\s+(\w+)\s*\(|(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\(/,
    );
    if (funcMatch) {
      const name = funcMatch[1] || funcMatch[2] || "";
      return /(?:open|reveal|show|select|activate).*(?:detail|event|row|editor)|(?:detail|event|row|editor).*(?:open|reveal|show|select|activate)/i.test(
        name,
      );
    }
    if (line.startsWith("export ") || line.startsWith("</script>") || line.startsWith("<script")) return false;
  }
  return false;
}

// Walk upward from a view-switch call to find the enclosing function name.
// If the enclosing function is itself a view-navigation function (`open*View`,
// `goTo*`, `switchTo*`, `select*View`), the call is intentional and should
// not be flagged.
const NAV_FUNCTION_NAME_RE = /^(open|switchTo|goTo|navigateTo|select)[A-Z]\w*(?:View|Console|Tab|Section)?$/;

function isInsideNavigationFunction(contextLines, lineIndex) {
  for (let i = lineIndex; i >= 0; i--) {
    const line = contextLines[i].trim();
    // Match function declarations and arrow-function const/let/var assignments.
    // Avoid matching plain variable assignments like `const foo = bar`.
    const funcMatch = line.match(
      /(?:async\s+)?function\s+(\w+)\s*\(|(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\(/,
    );
    if (funcMatch) {
      const name = funcMatch[1] || funcMatch[2];
      if (name && NAV_FUNCTION_NAME_RE.test(name)) return true;
      // First enclosing function found that is NOT a nav function — stop.
      return false;
    }
    if (line.startsWith("export ") || line.startsWith("</script>") || line.startsWith("<script")) return false;
  }
  return false;
}
