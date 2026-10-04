/**
 * no-keystroke-trim-on-input — connections-arkitect check
 * =======================================================
 * Flags `String.prototype.trimStart()` / `trimEnd()` applied to the typed value
 * inside a controlled-input writer — a writable `set(...)` accessor (the Vue
 * `computed({ set })` / `defineModel` pattern) or a v-model template handler
 * (`@update:model-value` / `@input` / `@change`).
 *
 * Why this exact signature: a controlled input renders its value FROM state. If
 * the writer strips edge whitespace on every keystroke, the trailing space is
 * gone the instant it is typed, the input re-renders without it, and the next
 * character can never land after it — so "ab cd" collapses to "abcd". This is
 * the bug that shipped in the MyConnect link "Display label" and the contact
 * name fields (the latter used `value.trimStart()` in a computed setter).
 *
 * `trimStart`/`trimEnd` specifically — not `.trim()` — because trimStart/trimEnd
 * exist precisely to "keep internal spaces but strip the edge while typing,"
 * which in an input writer is always the bug. Plain `.trim()` is also used for
 * legitimately space-free fields (a slug, or a `<select>` whose value is a
 * complete catalog entry), so it would be noisy; this check stays zero-noise.
 * The indirected form (a handler calling a helper that trims) is not statically
 * detectable here and is covered by per-surface "preserves spaces" unit tests.
 *
 * Escape hatch:
 *   // arkitect-ignore-next-line no-keystroke-trim-on-input — <reason>
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check no-keystroke-trim-on-input
 */

import fs from "node:fs";
import path from "node:path";

const TRIM_RE = /\.(?:trimStart|trimEnd)\(\)/g;
const VMODEL_HANDLER_RE = /@(?:update:model-value|update:modelValue|input|change)\s*=/;
// The opening of a writable accessor: `set: (v) => {` or `set(v) {` (method
// shorthand). Matched against the text immediately preceding the enclosing `{`.
const SETTER_OPENER_RE = /\bset\s*:?\s*\([^)]*\)\s*(?:=>\s*)?$/;
const IGNORE_RE = /arkitect-ignore-next-line\s+no-keystroke-trim-on-input\b/;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", "tmp"]);
const EXTENSIONS = new Set([".ts", ".vue"]);

const RULES = {
  "no-keystroke-trim-on-input": {
    severity: "error",
    description: "trimStart()/trimEnd() in a controlled-input writer eats spaces as the user types.",
  },
};

function collectFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectFiles(path.join(dir, entry.name), out);
    } else if (EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".spec.ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

// Replace the *contents* of string literals and comments with spaces (length
// and newlines preserved, indices unchanged) so brace counting and trim
// matching ignore braces / `.trimStart(` text that live inside strings/comments.
function blankStringsAndComments(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (j) => {
    if (src[j] !== "\n") out[j] = " ";
  };
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < n && src[i] !== "\n") blank(i++);
    } else if (two === "/*") {
      blank(i++);
      blank(i++);
      while (i < n && src.slice(i, i + 2) !== "*/") blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      blank(i++); // opening quote
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          blank(i++);
          if (i < n) blank(i++);
          continue;
        }
        blank(i++);
      }
      if (i < n) blank(i++); // closing quote
    } else {
      i += 1;
    }
  }
  return out.join("");
}

// Walk backwards (over brace-safe source) from `index` to the opening `{` of the
// immediately enclosing block, balancing nested braces. Returns that brace's
// index, or -1.
function enclosingBlockOpenIndex(safe, index) {
  let depth = 0;
  for (let i = index; i >= 0; i -= 1) {
    const ch = safe[i];
    if (ch === "}") {
      depth += 1;
    } else if (ch === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

export const audit = {
  id: "no-keystroke-trim-on-input",
  title: "No Keystroke Trim On Controlled Input",
  category: "codeRisk",
  rules: RULES,
  defaultConfig: {
    includeInAll: true,
    roots: ["src", "packages/connections-ui/src"],
    outputPath: "tmp/audits/NO_KEYSTROKE_TRIM_ON_INPUT.md",
  },
  async run(context) {
    const root = context.root;
    const cfg = context.checkConfig ?? {};
    const roots = cfg.roots || ["src"];

    const files = [];
    for (const rel of roots) {
      const dir = path.resolve(root, rel);
      if (fs.existsSync(dir)) collectFiles(dir, files);
    }

    const findings = [];
    for (const filePath of files) {
      let source;
      try {
        source = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      if (!source.includes("trimStart(") && !source.includes("trimEnd(")) continue;

      const lines = source.split("\n");
      // Brace-safe copy: matches and brace counting ignore strings/comments.
      const safe = blankStringsAndComments(source);
      TRIM_RE.lastIndex = 0;
      let match;
      while ((match = TRIM_RE.exec(safe)) !== null) {
        const lineNo = lineNumberAt(source, match.index);
        const lineText = lines[lineNo - 1] ?? "";

        const inTemplateHandler = VMODEL_HANDLER_RE.test(lineText);
        const openIndex = enclosingBlockOpenIndex(safe, match.index);
        const inSetter = openIndex >= 0 && SETTER_OPENER_RE.test(source.slice(Math.max(0, openIndex - 80), openIndex));
        if (!inTemplateHandler && !inSetter) continue;

        if (IGNORE_RE.test(lineText) || (lineNo > 1 && IGNORE_RE.test(lines[lineNo - 2]))) continue;

        findings.push({
          ruleId: "no-keystroke-trim-on-input",
          severity: RULES["no-keystroke-trim-on-input"].severity,
          message:
            "trimStart()/trimEnd() on a controlled input's value eats the trailing space as the user types " +
            '(multi-word values like "ab cd" become "abcd"). Store the value as typed; normalise on commit, not per keystroke.',
          filePath: path.relative(root, filePath),
          line: lineNo,
          snippet: lineText.trim(),
        });
      }
    }

    const failed = findings.length > 0;
    const report = failed
      ? `# No Keystroke Trim On Controlled Input\n\n` +
        `## no-keystroke-trim-on-input — ${findings.length} (error)\n\n` +
        findings.map((f) => `- \`${f.filePath}:${f.line}\` — ${f.message}\n  \`${f.snippet}\`\n`).join("")
      : `# No Keystroke Trim On Controlled Input\n\nNo controlled-input writers strip edge whitespace per keystroke.\n`;

    return {
      failed,
      findings,
      report,
      outputPath: cfg.outputPath,
      jsonPayload: { findings: findings.map((f) => ({ filePath: f.filePath, line: f.line })) },
      metadata: { filesScanned: files.length },
    };
  },
};
