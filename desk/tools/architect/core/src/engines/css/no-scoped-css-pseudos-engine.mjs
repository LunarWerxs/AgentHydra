/**
 * no-scoped-css-pseudos engine
 * ============================
 * Scans global `.css` files for Vue scoped-CSS pseudos `:deep(...)` and
 * `:global(...)`. These are SFC-compiler constructs — in plain (non-SFC)
 * global CSS they are invalid selectors, so the browser silently discards
 * the ENTIRE rule and the styling never applies.
 *
 * This is the failure mode the scoped→global style extraction left behind
 * (see scripts/_extract-vue-styles.mjs). The fix is mechanical: strip the
 * wrapper — `.parent :deep(.child)` was meant to be `.parent .child`.
 *
 * Companion to `no-vue-style-blocks` (which enforces that styles live in
 * global CSS in the first place).
 *
 * Rules:
 *   1. scoped-css-pseudo-in-global-css — a :deep()/:global() in a .css file
 *
 * Usage (via check):
 *   bun packages/connections-arkitect/bin/audit.mjs --check no-scoped-css-pseudos
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";

const PSEUDO_RE = /:(deep|global)\(/g;

/**
 * Blank out `/* … *\/` comment regions while preserving newlines and length,
 * so prose that merely mentions the pattern (e.g. an explanatory header
 * comment) is not flagged and line numbers stay accurate.
 */
function blankBlockComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

export async function runNoScopedCssPseudosAudit({ root, roots, extensions }) {
  const findings = [];
  const files = await walkFiles({ root, roots, extensions });

  for (const file of [...files]) {
    const absolutePath = path.resolve(root, file);
    const content = await fs.readFile(absolutePath, "utf-8");
    const lines = blankBlockComments(content).split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      PSEUDO_RE.lastIndex = 0;
      let match;
      while ((match = PSEUDO_RE.exec(line))) {
        const pseudo = match[1];
        findings.push(
          createFinding({
            ruleId: "scoped-css-pseudo-in-global-css",
            severity: "error",
            filePath: file,
            line: i + 1,
            message:
              `\`:${pseudo}()\` is a Vue scoped-CSS pseudo and is invalid in global CSS — ` +
              `the browser silently drops the whole rule. Strip the wrapper ` +
              `(\`.parent :${pseudo}(.child)\` → \`.parent .child\`).`,
            snippet: line.trim(),
          }),
        );
      }
    }
  }

  const failed = findings.length > 0;

  const report = failed
    ? `# No Scoped CSS Pseudos In Global CSS\n\n- **Invalid \`:deep()\`/\`:global()\` selectors:** ${findings.length}\n\n## Findings\n\n` +
      findings.map((f) => `- **${f.ruleId}** \`${f.filePath}:${f.line}\` — ${f.message}\n  \`${f.snippet}\`\n`).join("")
    : `# No Scoped CSS Pseudos In Global CSS\n\n✅ No \`:deep()\`/\`:global()\` selectors found in global CSS.\n`;

  return {
    failed,
    findings,
    report,
    jsonPayload: {
      findings: findings.map((f) => ({ filePath: f.filePath, line: f.line, ruleId: f.ruleId })),
    },
  };
}
