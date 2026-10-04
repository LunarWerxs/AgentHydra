/**
 * no-vue-style-blocks engine
 * ==========================
 * Scans .vue and .ts files for <style> blocks. Style belongs in the
 * global CSS architecture (src/styles/, packages/connections-ui/src/styles/primitives/),
 * not inside component files.
 *
 * Rules:
 *   1. vue-style-block — a <style> tag found in a .vue or .ts file
 *
 * Usage (via check):
 *   bun packages/connections-arkitect/bin/audit.mjs --check no-vue-style-blocks
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";

/**
 * Match actual <style> tags, not comments or string literals.
 * We match:
 *   <style scoped>
 *   <style scoped lang="...">
 *   <style>
 *   <style lang="...">
 * And skip:
 *   // <style ...>  (in JS comments)
 *   `<style ...>`   (in template literals - but these would be inside script strings)
 *
 * Strategy: match lines containing <style that are not inside // comments.
 * A simpler approach: match <style at the start of a line (after optional whitespace).
 */
const STYLE_TAG_RE = /^\s*<style\b/m;

export async function runNoVueStyleBlocksAudit({ root, roots, extensions }) {
  const findings = [];
  const files = await walkFiles({ root, roots, extensions });
  const fileList = [...files];

  for (const file of fileList) {
    const absolutePath = path.resolve(root, file);
    const content = await fs.readFile(absolutePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip JS/TS single-line comments
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

      if (STYLE_TAG_RE.test(line)) {
        // Confirm it's a real <style> tag (not inside a string/comment)
        const restOfFile = lines.slice(i).join("\n");
        const tagMatch = restOfFile.match(/<style(\b[^>]*)>/);
        if (tagMatch) {
          // Make sure this isn't inside a template literal or string
          // by checking that the line isn't entirely inside backticks/quotes
          if (trimmed.startsWith("`") || trimmed.startsWith("'") || trimmed.startsWith('"')) continue;

          findings.push(
            createFinding({
              ruleId: "vue-style-block",
              severity: "error",
              filePath: file,
              line: i + 1,
              message: `<style> block detected. Move styles to the global CSS architecture.`,
              snippet: line.trim(),
            }),
          );
          break; // One finding per file is enough
        }
      }
    }
  }

  const failed = findings.length > 0;

  const report = findings.length > 0
    ? `# No Vue Style Blocks\n\n- **Files with <style> blocks:** ${findings.length}\n\n## Findings\n\n`
      + findings.map(f => `- **${f.ruleId}** \`${f.filePath}:${f.line}\` — ${f.message}\n`).join("")
    : `# No Vue Style Blocks\n\n✅ No <style> blocks found in .vue or .ts files.\n`;

  return {
    failed,
    findings,
    report,
    jsonPayload: { findings: findings.map((f) => ({ filePath: f.filePath, line: f.line, ruleId: f.ruleId })) },
  };
}
