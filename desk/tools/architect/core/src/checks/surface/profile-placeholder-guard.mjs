/**
 * Profile Placeholder Guard Audit — connections-arkitect
 * =======================================================
 * Detects profile-ID extractions from `myProfile` that lack a
 * `"profile-placeholder"` sentinel guard. The workspace root state
 * initializes `myProfile` with `id: "profile-placeholder"` — a truthy
 * sentinel that passes through falsy guards, causing API errors.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";

const DEFAULTS = {
  roots: ["src"],
  extensions: [".ts", ".vue"],
  skipSegments: ["__tests__", ".spec.", "node_modules", "dist", "tmp"],
};

const PROFILE_ID_EXTRACTION_RE = /(?:state\.value\.)?(?:ctx\.)?myProfile(?:\.value)?\??\.id/;
const PLACEHOLDER_GUARD_RE = /["']profile-placeholder["']|emptyProfile\.id/;
const FALSY_GUARD_ON_PROFILE_ID_RE = /if\s*\(\s*!\s*(\w*(?:[pP]rofile|[oO]wner)\w*(?:\.value)?)\s*\)/;

// Helper functions that internally apply the placeholder check before
// returning the resolved profile ID. Passing myProfile.value.id as an
// argument to one of these is SAFE — the helper sanitises it.
//
// Keep this in sync with src/composables/workspace/workspace-profile-helpers.ts.
const SAFE_PROFILE_ID_HELPER_RE = /\b(?:getWorkspaceProfileId|_getWpid|resolveWorkspaceProfileId|getOwnerProfileId|safeProfileId)\s*\(/;

export const audit = {
  id: "profile-placeholder-guard",
  title: "Profile Placeholder Guard Audit",
  category: "architecture",
  requires: { projectNames: ["connections"], frameworks: ["vue", "vue3"] },
  defaultConfig: {
    ...DEFAULTS,
    outputPath: "tmp/audits/PROFILE_PLACEHOLDER_GUARD.md",
  },
  async run(context) {
    const config = { ...DEFAULTS, ...context.checkConfig };
    const root = context.root;

    const files = await walkFiles({
      root,
      roots: config.roots,
      extensions: config.extensions,
      skipSegments: config.skipSegments,
    });

    const allFindings = [];
    const scannedFiles = [];

    for (const relativePath of files) {
      const absolutePath = path.resolve(root, relativePath);
      try {
        const findings = scanFile(absolutePath, root);
        if (findings.length > 0) allFindings.push(...findings);
        scannedFiles.push(relativePath);
      } catch {
        /* skip unreadable */
      }
    }

    const inSources = files.length;
    const scanned = scannedFiles.length;

    const reportLines = [
      "# Profile Placeholder Guard Audit",
      "",
      `Scanned ${scanned} / ${inSources} source files for profile-ID extractions from \`myProfile\` that lack a \`"profile-placeholder"\` sentinel guard.`,
      "",
      "## Summary",
      "",
      `- **Files with findings:** ${new Set(allFindings.map((f) => f.filePath)).size}`,
      `- **Total findings:** ${allFindings.length}`,
      `- **Errors (falsy guard present, no placeholder check):** ${allFindings.filter((f) => f.severity === "error").length}`,
      `- **Warnings (no guard at all):** ${allFindings.filter((f) => f.severity === "warn").length}`,
      "",
    ];

    if (allFindings.length > 0) {
      reportLines.push("## Findings", "");
      const byFile = new Map();
      for (const f of allFindings) {
        const list = byFile.get(f.filePath) ?? [];
        list.push(f);
        byFile.set(f.filePath, list);
      }
      for (const [fp, findings] of byFile) {
        reportLines.push(`### \`${fp}\``, "");
        for (const f of findings) {
          reportLines.push(`- ${f.severity === "error" ? "❌" : "⚠️"} **Line ${f.line}:** ${f.message}`);
          reportLines.push(`  \`\`\`\n  ${f.metadata?.extractionText ?? "(see source)"}\n  \`\`\``);
        }
        reportLines.push("");
      }
    } else {
      reportLines.push(
        "## Result",
        "",
        '✅ All files that reference `myProfile.id` have proper `"profile-placeholder"` sentinel guards.',
        "",
      );
    }

    reportLines.push(
      "## Background",
      "",
      'The workspace root state initializes `myProfile` as `emptyProfile` which has `id: "profile-placeholder"`.',
      "This sentinel string is **truthy**, so falsy guards like `if (!profileId) return;` do **not** catch it.",
      "",
      "### Correct pattern",
      "",
      "```ts",
      "const ownerProfileId = computed(() => {",
      '  const id = state.value.myProfile?.id ?? "";',
      '  return id === "profile-placeholder" ? "" : id;',
      "});",
      "```",
      "",
      // Trailing summary lines in canonical (un-bolded) format so the
      // runner's FIX_QUEUE counter sees them regardless of regex version.
      `Errors: ${allFindings.filter((f) => f.severity === "error").length}`,
      `Warnings: ${allFindings.filter((f) => f.severity === "warn").length}`,
      "",
    );

    return {
      failed: allFindings.length > 0,
      findings: allFindings,
      report: reportLines.join("\n"),
      jsonPayload: { scanned, inSources, findings: allFindings },
      outputPath: config.outputPath,
    };
  },
};

// ── Engine helpers ────────────────────────────────────────────────────────

function isSkippableLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  if (/^(import|export)\s/.test(trimmed)) return true;
  if (/^(interface|type)\s/.test(trimmed)) return true;
  if (/^console\./.test(trimmed)) return true;
  if (/\b(describe|it|test|expect|vi\.)\b/.test(trimmed)) return true;
  return false;
}

function scanFile(filePath, root) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const relativePath = path.relative(root, filePath).replace(/\\/g, "/");

  if (!content.includes("myProfile")) return [];
  if (PLACEHOLDER_GUARD_RE.test(content)) return [];

  const findings = [];
  const profileIdExtractions = [];
  const falsyGuardLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippableLine(line)) continue;
    if (PROFILE_ID_EXTRACTION_RE.test(line)) {
      // Skip extractions that are arguments to a known safe helper that
      // applies the placeholder check itself. Without this guard the
      // engine flags every workspace-profile-helpers caller as unsafe.
      if (SAFE_PROFILE_ID_HELPER_RE.test(line)) continue;
      profileIdExtractions.push({ line: i + 1, text: line.trim() });
    }
    const guardMatch = line.match(FALSY_GUARD_ON_PROFILE_ID_RE);
    if (guardMatch) {
      falsyGuardLines.push({ line: i + 1, variable: guardMatch[1], text: line.trim() });
    }
  }

  if (profileIdExtractions.length === 0) return [];

  if (falsyGuardLines.length > 0) {
    for (const extraction of profileIdExtractions) {
      findings.push(
        createFinding({
          ruleId: "profile-placeholder-guard-missing",
          severity: "error",
          filePath: relativePath,
          line: extraction.line,
          message: `Profile ID extracted from myProfile but the file has no "profile-placeholder" sentinel guard. Falsy checks like \`if (!profileId)\` will pass through the placeholder string. Add \`=== "profile-placeholder"\` check.`,
          metadata: { extractionText: extraction.text, falsyGuardCount: falsyGuardLines.length },
        }),
      );
    }
  } else if (profileIdExtractions.length > 0) {
    for (const extraction of profileIdExtractions) {
      findings.push(
        createFinding({
          ruleId: "profile-placeholder-guard-missing",
          severity: "warn",
          filePath: relativePath,
          line: extraction.line,
          message: `Profile ID extracted from myProfile without a "profile-placeholder" sentinel check. Consider adding a guard.`,
          metadata: { extractionText: extraction.text },
        }),
      );
    }
  }

  return findings;
}
