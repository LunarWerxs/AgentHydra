/**
 * Editor Model Reconcile Guard — connections-arkitect
 * ===================================================
 * A controlled rich-text editor (Tiptap/ProseMirror) must NOT reconcile its
 * document from the model prop while the user is actively editing.
 *
 * The bug class ("rubber-banding"): a `watch(() => props.modelValue, …)` that
 * calls `editor.commands.setContent(…)` whenever the model changes. Because the
 * editor emits → a parent stores → the value flows back as the prop, and an
 * async write-back (e.g. an autosave echoing the server's canonical HTML) lands
 * mid-edit, that setContent resets the document and jumps the caret.
 *
 * The fix/invariant: guard the reconcile with the editor's focus state, e.g.
 *   if (editor.value?.isFocused) return;
 * so the model only reconciles into the editor when the user is NOT typing
 * (external loads happen while blurred). See AppRichTextEditor.vue.
 *
 * Rule: any `watch(() => props.<x>, …)` whose body calls `setContent(` must also
 * reference `isFocused`. Annotate a justified exception with
 *   // arkitect-ignore-next-line editor-model-reconcile-guard — <reason>
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";
import { collectSuppressions, matchingSuppression } from "@saydeploy/architect/core/suppressions";

const DEFAULTS = {
  root: ".",
  roots: ["src", "packages/connections-ui/src"],
  extensions: [".vue", ".ts"],
  skipSegments: ["__tests__", ".spec.", "node_modules", "dist", "tmp", "vendor"],
};

const RULE_ID = "editor-model-reconcile-guard";

export const audit = {
  id: "editor-model-reconcile-guard",
  title: "Editor Model Reconcile Guard",
  category: "surface",
  requires: { frameworks: ["vue", "vue3"] },
  defaultConfig: {
    ...DEFAULTS,
    outputPath: "tmp/audits/EDITOR_MODEL_RECONCILE_GUARD.md",
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
    let scannedEditors = 0;

    for (const filePath of allFiles) {
      let content;
      try {
        content = readFileSync(path.resolve(config.root, filePath), "utf-8");
      } catch {
        continue;
      }

      // Cheap pre-filter: only files that reconcile editor content are relevant.
      if (!/setContent\s*\(/.test(content)) continue;
      scannedEditors += 1;

      const suppressions = collectSuppressions(content);

      for (const watchCall of findModelPropWatchCalls(content)) {
        if (!/setContent\s*\(/.test(watchCall.body)) continue;
        if (/\bisFocused\b/.test(watchCall.body)) continue;

        const line = lineNumberAt(content, watchCall.index);
        if (matchingSuppression(suppressions, line, RULE_ID)) continue;

        findings.push(
          createFinding({
            filePath,
            line,
            severity: "error",
            ruleId: RULE_ID,
            message:
              `\`setContent(\` is called inside \`watch(() => props.${watchCall.prop}, …)\` without an ` +
              `\`editor.isFocused\` guard. An async model write-back (autosave echo, parent re-store) will ` +
              `reset the document mid-edit and jump the caret ("rubber-banding"). Guard the reconcile with ` +
              `\`if (editor.value?.isFocused) return;\` so the model only reconciles while the editor is blurred, ` +
              `or annotate a justified exception with \`arkitect-ignore-next-line ${RULE_ID} — <reason>\`.`,
            meta: { prop: watchCall.prop, guard: "isFocused" },
          }),
        );
      }
    }

    const failed = findings.some((finding) => finding.severity === "error");

    const reportLines = [
      "# Editor Model Reconcile Guard",
      "",
      "_A controlled Tiptap editor must guard `setContent` in a model-prop watch with `editor.isFocused`, " +
        "so async write-backs (autosave echoes) don't reset the document mid-edit (rubber-banding)._",
      "",
      `- Files with \`setContent\` scanned: ${scannedEditors}`,
      `- Unguarded model-prop reconciles: ${findings.length}`,
      "",
    ];
    if (findings.length > 0) {
      reportLines.push("## Findings", "");
      for (const finding of findings) {
        reportLines.push(
          `- **${finding.filePath}:${finding.line}** — unguarded \`setContent\` in \`watch(props.${finding.meta.prop})\`.`,
        );
      }
      reportLines.push("");
    } else {
      reportLines.push("## ✅ All editor model-prop reconciles are focus-guarded.", "");
    }

    return {
      failed,
      findings,
      report: reportLines.join("\n"),
      jsonPayload: { findings, scannedEditors },
      outputPath: config.outputPath,
    };
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Yield each `watch(() => props.<name>, …)` call in the source, with the full
 * balanced text of the watch(...) call (so we can inspect its callback body).
 */
function* findModelPropWatchCalls(content) {
  const opener = /\bwatch(?:Effect)?\s*\(\s*\(\)\s*=>\s*props\.(\w+)/g;
  let match;
  while ((match = opener.exec(content)) !== null) {
    const parenStart = content.indexOf("(", match.index);
    if (parenStart < 0) continue;
    const body = extractBalanced(content, parenStart);
    if (body == null) continue;
    yield { index: match.index, prop: match[1], body };
  }
}

/** Return the substring inside the balanced parentheses starting at `openIndex`. */
function extractBalanced(content, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < content.length; i += 1) {
    const char = content[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return content.slice(openIndex, i + 1);
    }
  }
  return null;
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}
