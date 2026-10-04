/**
 * spl-visual-integrity — connections-arkitect check
 * ==================================================
 * Runtime companion to `spl-playground-integrity`. That check is static — it
 * verifies every component has a demo hint and that hint prop *names* exist.
 * It cannot see what the playground actually renders, so visually-broken
 * cards (collapsed layouts, name leaks, wrong array-item shapes, missing
 * content) pass it silently. This check closes that gap by consuming the
 * rendered-DOM scan produced by `packages/connections-arkitect/runners/spl-visual-audit.mjs`.
 *
 * Rules (all derived from the live render of the SPL26 page):
 *   - spl-render-error      (error) the card's component threw / failed to render.
 *   - spl-name-leak         (error) the preview shows its own component name
 *                                   (a slot/prop fell back to the identifier).
 *   - spl-zero-size         (error) the rendered box collapsed in one axis
 *                                   (wrong item shape, empty list, missing prop).
 *   - spl-collapsed-sliver  (error) tall ultra-narrow box — a layout collapsed.
 *   - spl-placeholder-leak  (warn)  the "Demo" fallback string is visible.
 *
 * Because it requires a running dev server + a browser, it is NOT part of the
 * CI `--all` sweep (includeInAll:false). Run it locally:
 *
 *   bun run dev                  # in another terminal
 *   bun run audit:spl-visual     # capture + check
 *
 * If the collector could not run (no browser / dev server down) it writes a
 * "skipped" artifact and this check reports an info finding instead of failing.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";

const TITLE = "SPL Visual Integrity";
const DEFAULT_ARTIFACT = "tmp/spl-visual-audit/scan.json";
const ARTIFACT_FILE = "packages/connections-arkitect/runners/spl-visual-audit.mjs";

const RULE_SEVERITY = {
  "spl-render-error": "error",
  "spl-name-leak": "error",
  "spl-zero-size": "error",
  "spl-collapsed-sliver": "error",
  "spl-placeholder-leak": "warn",
};

export const audit = {
  id: "spl-visual-integrity",
  title: TITLE,
  category: "meta",
  outputContract: "parsed-findings",
  defaultConfig: {
    // Browser + dev server required — keep it out of the static CI sweep.
    includeInAll: false,
    artifactPath: DEFAULT_ARTIFACT,
    outputPath: "tmp/audits/SPL_VISUAL_INTEGRITY_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig ?? {};
    const artifactPath = path.resolve(context.root, cfg.artifactPath || DEFAULT_ARTIFACT);

    if (!existsSync(artifactPath)) {
      const message = `No visual-scan artifact at ${cfg.artifactPath || DEFAULT_ARTIFACT}. Run \`bun run audit:spl-visual\` (with the dev server running) first.`;
      return skipResult(message, { artifactPath });
    }

    let artifact;
    try {
      artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    } catch {
      return skipResult(
        `Failed to parse ${cfg.artifactPath || DEFAULT_ARTIFACT}. Delete it and re-run \`bun run audit:spl-visual\`.`,
        {
          artifactPath,
        },
      );
    }

    if (artifact.skipped) {
      return skipResult(`Visual scan skipped: ${artifact.skipReason || "unknown reason"}`, { artifactPath });
    }

    const findings = [];
    for (const f of artifact.findings ?? []) {
      const severity = RULE_SEVERITY[f.ruleId] ?? "warn";
      findings.push(
        createFinding({
          ruleId: f.ruleId,
          severity,
          filePath: ARTIFACT_FILE,
          message: `${f.component}: ${f.detail}`,
          metadata: { component: f.component },
        }),
      );
    }

    const errorCount = findings.filter((x) => x.severity === "error").length;
    const warnCount = findings.filter((x) => x.severity === "warn").length;

    return {
      failed: errorCount > 0,
      findings,
      jsonPayload: {
        componentCount: artifact.componentCount ?? 0,
        consoleErrorCount: artifact.consoleErrorCount ?? 0,
        errorCount,
        warnCount,
        url: artifact.url,
      },
      report: [
        `# ${TITLE}`,
        "",
        `- **URL:** ${artifact.url}`,
        `- **Components scanned:** ${artifact.componentCount ?? 0}`,
        `- **Browser console messages:** ${artifact.consoleErrorCount ?? 0}`,
        `- **Errors:** ${errorCount}`,
        `- **Warnings:** ${warnCount}`,
        "",
        findings.length === 0
          ? "✅ Every SPL26 primitive renders a non-degenerate preview — no render errors, name leaks, collapsed boxes, or placeholder leaks."
          : "",
      ].join("\n"),
    };
  },
};

function skipResult(message, jsonPayload) {
  return {
    failed: false,
    findings: [
      createFinding({
        ruleId: "spl-visual-skipped",
        severity: "info",
        filePath: ARTIFACT_FILE,
        message,
      }),
    ],
    jsonPayload: { skipped: true, ...jsonPayload },
    report: [`# ${TITLE}`, "", `⏭️  ${message}`].join("\n"),
  };
}
