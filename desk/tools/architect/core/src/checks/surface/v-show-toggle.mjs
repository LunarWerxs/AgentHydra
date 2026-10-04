/**
 * v-show Toggle Audit — connections-arkitect
 * ==============================================
 * Detects Vue templates where multiple sibling elements use `v-show` with
 * mutually-exclusive conditions. This is a memory anti-pattern: all views
 * stay mounted in DOM even though only one is ever visible at a time.
 *
 * Preferred pattern: `v-if` + `<KeepAlive>` with unique keys, so hidden
 * views are unmounted from DOM while KeepAlive caches component state for
 * fast reactivation.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS = {
  root: ".",
  roots: ["src"],
  extensions: [".vue"],
  skipSegments: ["__tests__", ".spec.", "node_modules", "dist", "tmp", "infra"],
  minSiblingCount: 3,
};

// ── Audit export ─────────────────────────────────────────────────────────

export const audit = {
  id: "v-show-toggle",
  title: "v-show Toggle Audit",
  category: "surface",
  requires: { frameworks: ["vue", "vue3"] },
  defaultConfig: {
    ...DEFAULTS,
    outputPath: "tmp/audits/V_SHOW_TOGGLE_AUDIT.md",
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
    let totalVShowFiles = 0;
    let totalVShowElements = 0;

    for (const filePath of allFiles) {
      const absolutePath = path.resolve(config.root, filePath);
      let content;
      try {
        content = readFileSync(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      const groups = findVShowSiblingGroups(lines, 0);

      let fileVShowCount = 0;
      for (const line of lines) {
        if (/v-show\s*=/.test(line)) fileVShowCount++;
      }
      if (fileVShowCount === 0) continue;

      totalVShowElements += fileVShowCount;
      totalVShowFiles++;
      scannedFiles.push(filePath);

      if (groups.length === 0) continue;

      for (const group of groups) {
        if (group.length < config.minSiblingCount) continue;

        const conditions = group.map((el) => el.condition);
        const mutuallyExclusive = looksMutuallyExclusive(conditions);

        findings.push(
          createFinding({
            filePath,
            line: group[0].line,
            severity: "warning",
            ruleId: "v-show-toggle/mutually-exclusive-views",
            message: [
              `${group.length} sibling elements use \`v-show\` with complementary conditions ` +
                `(${conditions.map((c) => `\`${c}\``).join(", ")}). ` +
                `This keeps all view subtrees in the DOM when only one is visible — ` +
                `a memory anti-pattern.`,
              mutuallyExclusive
                ? `Detected mutually-exclusive view toggling. Replace with \`v-if\` + \`<KeepAlive>\` ` +
                  `and unique \`key\` props so hidden views are unmounted from DOM while ` +
                  `KeepAlive caches component state for instant reactivation.`
                : `If these views are mutually exclusive, replace with \`v-if\` + \`<KeepAlive>\` ` +
                  `and unique \`key\` props.`,
            ].join(" "),
            meta: {
              siblingCount: group.length,
              conditions,
              mutuallyExclusive,
              lines: group.map((el) => el.line),
            },
          }),
        );
      }
    }

    const failed = findings.length > 0;

    const reportLines = [
      `# v-show Toggle Audit`,
      ``,
      `_Detects \`v-show\` used for mutually-exclusive view toggling — ` +
        `a memory anti-pattern. Prefer \`v-if\` + \`<KeepAlive>\`.`,
      ``,
      `- Files scanned: ${allFiles.length}`,
      `- Files with \`v-show\`: ${totalVShowFiles}`,
      `- Total \`v-show\` elements: ${totalVShowElements}`,
      `- Sibling groups found: ${findings.length}`,
      `- Minimum sibling threshold: ${config.minSiblingCount}`,
      ``,
    ];

    if (findings.length > 0) {
      reportLines.push(`## Findings`);
      reportLines.push(``);
      for (const finding of findings) {
        reportLines.push(
          `- **${finding.filePath}** line ${finding.line} — ` +
            `${finding.meta.siblingCount} sibling \`v-show\` elements ` +
            `(${finding.meta.conditions.map((c) => `\`${c}\``).join(", ")}). ` +
            `${finding.meta.mutuallyExclusive ? "Appear mutually exclusive." : "May be mutually exclusive."}`,
        );
      }
      reportLines.push(``);
    } else {
      reportLines.push(`## ✅ No sibling v-show groups detected.`);
      reportLines.push(``);
    }

    return {
      failed,
      findings,
      report: reportLines.join("\n"),
      jsonPayload: { findings, scannedFiles, totalVShowFiles, totalVShowElements },
      outputPath: config.outputPath,
    };
  },
};

// ── Engine helpers ────────────────────────────────────────────────────────

function isInsideComment(lines, lineIndex) {
  let inComment = false;
  for (let i = 0; i <= lineIndex; i++) {
    const line = lines[i];
    if (/<!--/.test(line) && !/-->/.test(line)) inComment = true;
    if (/-->/.test(line)) inComment = false;
  }
  return inComment;
}

function findVShowSiblingGroups(lines, baseLineOffset) {
  const vShowElements = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isInsideComment(lines, i)) continue;

    const vShowMatch = line.match(/v-show\s*=\s*"([^"]*)"|v-show\s*=\s*'([^']*)'/);
    if (!vShowMatch) continue;

    const condition = (vShowMatch[1] || vShowMatch[2] || "").trim();
    if (!condition) continue;

    const indent = line.match(/^(\s*)/)[1].length;
    vShowElements.push({ line: baseLineOffset + i + 1, condition, indent });
  }

  const groups = [];
  let currentGroup = [];

  for (const el of vShowElements) {
    if (currentGroup.length === 0) {
      currentGroup.push(el);
      continue;
    }

    const last = currentGroup[currentGroup.length - 1];
    if (el.indent === last.indent && el.line - last.line <= 10) {
      currentGroup.push(el);
    } else {
      if (currentGroup.length >= 2) groups.push(currentGroup);
      currentGroup = [el];
    }
  }
  if (currentGroup.length >= 2) groups.push(currentGroup);

  return groups;
}

function looksMutuallyExclusive(conditions) {
  if (conditions.length < 2) return false;

  const patterns = conditions.map((c) => {
    const m = c.match(/^(\w+)\((['"])([^'"]*)\2\)$/);
    return m ? { fn: m[1], arg: m[3] } : null;
  });

  if (patterns.some((p) => !p)) return false;
  const fnName = patterns[0].fn;
  if (!patterns.every((p) => p.fn === fnName)) return false;

  const args = new Set(patterns.map((p) => p.arg));
  return args.size === patterns.length;
}
