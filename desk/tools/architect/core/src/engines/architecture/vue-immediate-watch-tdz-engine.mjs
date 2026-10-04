// Audit: find Vue `watch(..., { immediate: true })` and `watchEffect(...)` calls
// that reference setup-scope identifiers declared LATER in the same file. The
// `immediate` callback fires SYNCHRONOUSLY during setup execution, so any
// identifier referenced from the callback that hasn't been initialized yet
// crashes at runtime with "Cannot access 'X' before initialization" (TDZ).
//
// Why this exists: a real production bug surfaced as
//   "Cannot access 'betaPaywallPreviewLoaded' before initialization"
// in WorkspaceSettingsPanelContent.vue, where an immediate-watch at line 204
// referenced refs destructured from a composable at line 504. ESLint's
// `no-use-before-define` does NOT catch this — it sees the callback as a
// lazy-evaluated function. Only Vue's runtime knows the callback fires sync.
//
// Registered by packages/connections-arkitect/src/checks/vue-immediate-watch-tdz.mjs.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { walkFiles, toPosixPath } from "@saydeploy/architect/core/files";

const __filename = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(__filename), "../../..");

// Watch APIs whose callback runs synchronously during setup.
// `watch(..., { immediate: true })` is detected by inspecting the options arg;
// the names below ALWAYS run their callback during setup, no options needed.
const ALWAYS_IMMEDIATE_NAMES = new Set([
  "watchEffect",
  "watchSyncEffect",
  "watchPostFlush", // some custom wrappers
]);

// Plain `watch(...)` is conditional on `{ immediate: true }`.
const CONDITIONAL_NAMES = new Set(["watch"]);

// JS reserved / common globals we never want to flag as "referenced identifier".
const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "void",
  "this",
  "super",
  "class",
  "extends",
  "function",
  "const",
  "let",
  "var",
  "async",
  "await",
  "yield",
  "true",
  "false",
  "null",
  "undefined",
  "import",
  "export",
  "from",
  "as",
  "with",
  "debugger",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Math",
  "JSON",
  "Date",
  "Error",
  "console",
  "window",
  "document",
  "globalThis",
  "process",
]);

/** Strip JS/TS comments and string contents (preserve newlines + offsets). */
function stripJsCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out += quote;
          i++;
          break;
        }
        // For template literals we'd lose ${...} expressions if we blanked
        // them — but referenced identifiers inside string interpolation are
        // edge cases for this check, and blanking keeps the parser simple.
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Extract `<script setup>` body from a .vue SFC; for non-Vue files, return the whole source. */
function extractSetupScript(src, isVue) {
  if (!isVue) return { script: src, startLine: 1 };
  const open = /<script\b[^>]*\bsetup\b[^>]*>/i.exec(src);
  if (!open) return null;
  const startIdx = open.index + open[0].length;
  const closeRe = /<\/script\s*>/gi;
  closeRe.lastIndex = startIdx;
  const close = closeRe.exec(src);
  if (!close) return null;
  const startLine = src.slice(0, startIdx).split("\n").length;
  return { script: src.slice(startIdx, close.index), startLine };
}

/** Build per-character brace depth across the source. Setup-scope = depth 0. */
function buildDepthArray(src) {
  const depth = new Int32Array(src.length + 1);
  let d = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    depth[i] = d;
    if (c === "{" || c === "(" || c === "[") d++;
    else if (c === "}" || c === ")" || c === "]") d = Math.max(0, d - 1);
  }
  depth[src.length] = d;
  return depth;
}

/** Find the matching closer for the opener at `startIdx` (must point at `(`). */
function findMatchingParen(src, startIdx) {
  if (src[startIdx] !== "(") return -1;
  let d = 0;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") d++;
    else if (c === ")") {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/**
 * Find setup-scope declarations: a map of identifier -> first declaration line.
 * Only counts declarations at brace depth 0 (top of setup script).
 *   - `const foo = ...`, `let foo`, `var foo`, `function foo(...)`
 *   - destructured: `const { foo, bar: baz } = ...`, `const [a, b] = ...`
 */
function collectSetupBindings(cleanScript, depth) {
  const decls = new Map();
  const lines = cleanScript.split("\n");
  let offset = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineStart = offset;
    offset += line.length + 1;
    if (depth[lineStart] !== 0) continue;

    // const/let simple: `const foo = ...`
    // We deliberately EXCLUDE `var` (hoisted-to-undefined, no TDZ) and
    // `function foo()` declarations (fully hoisted to top of scope). Both can
    // be referenced before their source position without crashing.
    let m = /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/.exec(line);
    if (m && !decls.has(m[1])) decls.set(m[1], li + 1);

    if (depth[lineStart] === 0) {
      // single-line destructure: `const { foo, bar } = ...`
      const singleLine = /^\s*(?:export\s+)?(?:const|let)\s*\{([^}]+)\}\s*=/.exec(line);
      if (singleLine) {
        for (const raw of singleLine[1].split(",")) {
          const name = raw
            .split(":")
            .pop()
            .trim()
            .replace(/^\.\.\./, "");
          if (/^[A-Za-z_$][\w$]*$/.test(name) && !decls.has(name)) decls.set(name, li + 1);
        }
      }
    }
  }

  // Multi-line destructure block scan.
  // Pattern: a depth-0 line opening with `const {` or `let {`, whose `}` lands later.
  const destructureOpenRe = /^(\s*(?:export\s+)?(?:const|let)\s*)\{/gm;
  let m;
  while ((m = destructureOpenRe.exec(cleanScript)) !== null) {
    const openIdx = m.index + m[0].length - 1; // position of `{`
    if (depth[m.index] !== 0) continue;
    // find matching `}`
    let d = 0;
    let end = -1;
    for (let i = openIdx; i < cleanScript.length; i++) {
      const c = cleanScript[i];
      if (c === "{") d++;
      else if (c === "}") {
        d--;
        if (d === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const body = cleanScript.slice(openIdx + 1, end);
    // Iterate identifier names: handle aliasing `foo: bar`, rest `...rest`,
    // and skip nested object patterns by tracking inner braces.
    let nest = 0;
    let token = "";
    const flushToken = () => {
      const raw = token.trim();
      token = "";
      if (!raw) return;
      // strip default value: `foo = bar`
      const noDefault = raw.split("=")[0].trim();
      // alias `foo: bar` -> bar is the binding name
      const aliasParts = noDefault.split(":");
      const bindName = aliasParts.length > 1 ? aliasParts[1].trim() : noDefault;
      const cleaned = bindName.replace(/^\.\.\./, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(cleaned) && !decls.has(cleaned)) {
        // Compute line where this token sits.
        const absIdx = openIdx + 1 + body.indexOf(raw);
        if (absIdx >= 0) {
          const line = cleanScript.slice(0, absIdx).split("\n").length;
          decls.set(cleaned, line);
        }
      }
    };
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === "{" || c === "[") nest++;
      else if (c === "}" || c === "]") nest--;
      if (c === "," && nest === 0) {
        flushToken();
        continue;
      }
      token += c;
    }
    flushToken();
  }

  return decls;
}

/**
 * Find every setup-scope `watch(...)` / `watchEffect(...)` etc. call whose
 * callback runs synchronously during setup. Returns [{ name, startIdx, endIdx,
 * callbackStartIdx, callbackEndIdx, line }].
 */
function findImmediateWatches(cleanScript, depth) {
  const calls = [];
  // Generic call-name regex: `<name>(`.
  const callRe = /\b(watch|watchEffect|watchSyncEffect|watchPostFlush|watchPostEffect)\s*\(/g;
  let m;
  while ((m = callRe.exec(cleanScript)) !== null) {
    const name = m[1];
    const callStart = m.index;
    if (depth[callStart] !== 0) continue; // not at setup scope
    const openParenIdx = callStart + m[0].length - 1;
    const closeParenIdx = findMatchingParen(cleanScript, openParenIdx);
    if (closeParenIdx === -1) continue;
    const argsBlock = cleanScript.slice(openParenIdx + 1, closeParenIdx);

    let immediate = false;
    if (ALWAYS_IMMEDIATE_NAMES.has(name)) {
      immediate = true;
    } else if (CONDITIONAL_NAMES.has(name)) {
      // Look for `immediate: true` anywhere in the args block. Could be in the
      // 3rd-arg options object, possibly across multiple lines. The flush
      // option `flush: 'post'` overrides immediate behavior — Vue still runs
      // immediate sync, but it's the explicit intent path so we still flag.
      if (/\bimmediate\s*:\s*true\b/.test(argsBlock)) immediate = true;
    }
    // `watchPostEffect` defers the FIRST run to after mount, so referenced
    // bindings will exist by then — NOT a TDZ risk.
    if (name === "watchPostEffect") immediate = false;

    if (!immediate) continue;

    calls.push({
      name,
      startIdx: callStart,
      endIdx: closeParenIdx,
      argsStartIdx: openParenIdx + 1,
      argsEndIdx: closeParenIdx,
      line: cleanScript.slice(0, callStart).split("\n").length,
    });
  }
  return calls;
}

/**
 * Walk the args block and, for every `await` keyword found, blank out
 * everything from that `await` to the closing `}` of the function body it
 * sits in. Anything after `await` runs in a deferred microtask (post-setup),
 * so identifier references there don't TDZ.
 *
 * The block here is already string/comment-stripped, so a literal `await`
 * regex is safe (no in-string false matches).
 */
function blankAfterAwait(block) {
  let out = block;
  // Repeatedly find the FIRST `await` and blank to its containing `}`. The
  // loop is needed because blanking one async callback may leave another
  // `await` elsewhere in the args block.
  while (true) {
    const m = /\bawait\b/.exec(out);
    if (!m) return out;
    const start = m.index;
    // Walk forward to find the closing `}` at the innermost enclosing brace.
    // We start at depth 0 relative to the `await` position; the first `}`
    // that drops us below 0 is the function body's close.
    let d = 0;
    let close = out.length;
    for (let i = start; i < out.length; i++) {
      const c = out[i];
      if (c === "{") d++;
      else if (c === "}") {
        if (d === 0) {
          close = i;
          break;
        }
        d--;
      }
    }
    const chunk = out.slice(start, close);
    const blanked = chunk.replace(/[^\n]/g, " ");
    out = out.slice(0, start) + blanked + out.slice(close);
  }
}

/**
 * Extract the callback expression(s) from a watch's args block. For `watch(src,
 * cb, opts)` the callback is the 2nd arg; for `watchEffect(cb)` it's the 1st.
 * We don't need to perfectly isolate it — referencing a later-declared binding
 * from the SOURCE expression is ALSO a TDZ bug (it runs immediately to compute
 * the initial value). So we treat ALL args as "synchronously evaluated" except
 * the options-object literal.
 */
function identifiersReferencedSynchronously(cleanScript, argsStartIdx, argsEndIdx) {
  const block = cleanScript.slice(argsStartIdx, argsEndIdx);
  // Best-effort: blank out the options-object literal `{ immediate: ..., flush: ... }`
  // so its keys are not mistaken for setup-scope identifier references. We
  // ONLY blank `{...}` blocks at top-level paren depth whose `{` is preceded
  // by a `,` (with optional whitespace) — that signals an args-position object
  // literal. Function bodies (`(args) => { ... }`) are preceded by `=>` and
  // must be preserved so we can scan the identifiers inside.
  let blanked = "";
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === "{" && depth === 0) {
      let j = i - 1;
      while (j >= 0 && /\s/.test(block[j])) j--;
      const prev = j >= 0 ? block[j] : ",";
      if (prev === ",") {
        let braceDepth = 1;
        blanked += " ";
        i++;
        while (i < block.length && braceDepth > 0) {
          const cc = block[i];
          if (cc === "{") braceDepth++;
          else if (cc === "}") braceDepth--;
          blanked += cc === "\n" ? "\n" : " ";
          i++;
        }
        i--; // for loop will ++
        continue;
      }
    }
    blanked += c;
  }
  // Async-callback escape hatch: anything after `await` inside the callback
  // body defers to a microtask, which runs AFTER setup completes — referenced
  // bindings have been initialized by then, so it's not a TDZ risk. Blank
  // from each `await` to the closing `}` of its containing function body.
  blanked = blankAfterAwait(blanked);

  const ids = new Map(); // name -> first offset within block
  const idRe = /\b([A-Za-z_$][\w$]*)\b/g;
  let m;
  while ((m = idRe.exec(blanked)) !== null) {
    // Skip when preceded by `.` (property access, e.g. `foo.bar` - bar is not a binding lookup)
    if (m.index > 0 && blanked[m.index - 1] === ".") continue;
    // Skip when followed by `:` inside an object literal expression (key shorthand) — rare in args, ignore
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    if (!ids.has(name)) ids.set(name, argsStartIdx + m.index);
  }
  return ids;
}

export async function runVueImmediateWatchTdzAudit({ root, roots, extensions }) {
  const scanRoot = root ?? defaultRoot;
  const files = await walkFiles({
    root: scanRoot,
    roots: roots ?? ["src"],
    extensions: extensions ?? [".vue", ".ts"],
  });

  const findings = [];
  let scannedFiles = 0;
  let scriptsScanned = 0;

  for (const rel of files) {
    if (/\.(spec|test)\.[cm]?[tj]sx?$/.test(rel)) continue;
    const abs = path.join(scanRoot, rel);
    let text;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    scannedFiles++;

    const isVue = rel.endsWith(".vue");
    const setup = extractSetupScript(text, isVue);
    if (!setup) continue;
    scriptsScanned++;

    const clean = stripJsCommentsAndStrings(setup.script);
    const depth = buildDepthArray(clean);
    const decls = collectSetupBindings(clean, depth);
    const watches = findImmediateWatches(clean, depth);

    for (const w of watches) {
      const ids = identifiersReferencedSynchronously(clean, w.argsStartIdx, w.argsEndIdx);
      const wLine = w.line;
      for (const name of ids.keys()) {
        const declLine = decls.get(name);
        if (!declLine) continue;
        // Only flag declarations strictly later than the watch call.
        if (declLine <= wLine) continue;
        // Cross-reference to file line (account for SFC offset).
        const fileWatchLine = setup.startLine + wLine - 1;
        const fileDeclLine = setup.startLine + declLine - 1;
        findings.push({
          file: toPosixPath(rel),
          watchKind: w.name,
          watchLine: fileWatchLine,
          identifier: name,
          declLine: fileDeclLine,
        });
      }
    }
  }

  // De-dupe identical findings (same file/identifier/watchLine) just in case.
  const dedup = new Map();
  for (const f of findings) {
    const key = `${f.file}:${f.watchLine}:${f.identifier}`;
    if (!dedup.has(key)) dedup.set(key, f);
  }
  const unique = [...dedup.values()];

  // Group findings by file for the markdown report.
  const byFile = new Map();
  for (const f of unique) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  const lines = [];
  lines.push("# Vue Immediate-Watch TDZ Audit");
  lines.push("");
  lines.push(
    `**Scanned:** ${scannedFiles} files — **with setup script:** ${scriptsScanned} — **files with findings:** ${byFile.size} — **total findings:** ${unique.length}`,
  );
  lines.push("");
  lines.push(
    "_Rule:_ `watch(..., { immediate: true })`, `watchEffect(...)`, and `watchSyncEffect(...)` execute their callback (and source expression) SYNCHRONOUSLY during setup. Any setup-scope `const` or `let` referenced from those callbacks must be declared BEFORE the watch call, or the page crashes at mount with `Cannot access 'X' before initialization` (TDZ). `function` declarations and `var` bindings are hoisted and exempt; references inside an `async` callback that come AFTER `await` defer to a microtask and are also exempt. ESLint's `no-use-before-define` does not catch this because it treats the callback as lazily evaluated.",
  );
  lines.push("");

  if (unique.length === 0) {
    lines.push("## ✅ No TDZ-style immediate-watch references detected.");
    lines.push("");
  } else {
    lines.push("## ❌ Files with TDZ-style immediate-watch references");
    lines.push("");
    for (const [file, list] of byFile) {
      lines.push(`### \`${file}\``);
      lines.push("");
      lines.push("| Watch kind | Watch line | Referenced identifier | Declared at line |");
      lines.push("| --- | --- | --- | --- |");
      for (const f of list) {
        lines.push(`| \`${f.watchKind}\` | ${f.watchLine} | \`${f.identifier}\` | ${f.declLine} |`);
      }
      lines.push("");
    }
    lines.push(
      "**Fix:** move the watch BELOW the declaration of every identifier it references, OR initialize those bindings before the watch. For composable destructures, the simplest fix is to place the `watch(...)` block right after the `} = useXxx()` line.",
    );
    lines.push("");
  }

  return {
    failed: unique.length > 0,
    jsonPayload: {
      scannedFiles,
      scriptsScanned,
      filesWithFindings: byFile.size,
      totalFindings: unique.length,
      findings: unique,
    },
    report: `${lines.join("\n")}\n`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runVueImmediateWatchTdzAudit({
    root: defaultRoot,
    roots: process.argv.slice(2).filter((arg) => !arg.startsWith("--")),
  })
    .then((result) => {
      console.log(JSON.stringify(result.jsonPayload, null, 2));
      if (process.argv.includes("--fail-on-drift") && result.failed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
