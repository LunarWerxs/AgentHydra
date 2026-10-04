/**
 * no-define-options-outside-setup — detects `defineOptions()` calls in Vue SFCs
 * that use `<script lang="ts">` (Options API / defineComponent) instead of
 * `<script setup>`.
 *
 * `defineOptions` is a Vue 3.3+ **compiler macro** that is only transformed in
 * `<script setup>` blocks. In a regular `<script>` block it is undefined at
 * runtime and causes a `ReferenceError: defineOptions is not defined`.
 *
 * A batch migration (commit 1a0ed2c55) added `defineOptions({ inheritAttrs:
 * false })` to ~80 components without checking the script type, breaking every
 * Options API component that received the macro. This check prevents that class
 * of breakage from happening again.
 *
 * Fix for violations:
 *   <script lang="ts">  →  move `inheritAttrs: false` into `defineComponent({})`
 *   <script setup>     →  `defineOptions()` is correct, this check will NOT flag it
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Extract the <script> block(s) from a Vue SFC. Returns an array of
 * { content, isSetup, startLine }.
 */
function extractScriptBlocks(src) {
  const blocks = [];
  const regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(src)) !== null) {
    const attrs = match[1];
    const content = match[2];
    const isSetup = /\bsetup\b/.test(attrs);
    const precedingNewlines = (src.slice(0, match.index).match(/\n/g) || []).length;
    blocks.push({ content, isSetup, startLine: precedingNewlines + 1 });
  }
  return blocks;
}

export async function run({ root, files } = {}) {
  const repoRoot = root || process.cwd();
  const findings = [];

  // If specific files are provided, use them; otherwise scan all .vue files
  let targetFiles = files;
  if (!targetFiles) {
    targetFiles = [];
    await walkVueFiles(repoRoot, targetFiles);
  }

  for (const file of targetFiles) {
    const fullPath = path.resolve(repoRoot, file);
    let src;
    try {
      src = await fs.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    const blocks = extractScriptBlocks(src);
    for (const block of blocks) {
      if (block.isSetup) continue; // defineOptions is valid in <script setup>

      const defineOptionsMatch = block.content.match(/defineOptions\s*\(/);
      if (!defineOptionsMatch) continue;

      const relativePath = path.relative(repoRoot, fullPath);
      const blockLine = block.startLine;
      const macroLineInBlock = (block.content.slice(0, defineOptionsMatch.index).match(/\n/g) || []).length;
      const macroLine = blockLine + macroLineInBlock;

      findings.push({
        file: relativePath,
        line: macroLine,
        severity: "error",
        message:
          `defineOptions() used in a non-setup <script> block. ` +
          `defineOptions is a compiler macro only available in <script setup>. ` +
          `Move inheritAttrs into defineComponent() options instead.`,
      });
    }
  }

  return findings;
}

async function walkVueFiles(dir, out = [], skipDirs = new Set(["node_modules", "__tests__", "dist", ".git"])) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkVueFiles(full, out, skipDirs);
    } else if (entry.isFile() && entry.name.endsWith(".vue")) {
      out.push(full);
    }
  }
  return out;
}

export const audit = {
  id: "no-define-options-outside-setup",
  title: "No defineOptions() Outside <script setup>",
  category: "codeRisk",
  defaultConfig: {
    includeInAll: true,
  },
  async run(context) {
    const root = context.root || process.cwd();
    const findings = await run({ root });

    const passed = findings.length === 0;
    return {
      passed,
      findings,
      summary: passed
        ? "No defineOptions() calls found outside <script setup> blocks."
        : `Found ${findings.length} defineOptions() call(s) in non-setup <script> blocks.`,
    };
  },
};
