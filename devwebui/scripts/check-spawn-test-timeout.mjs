// Guardrail against a test that does REAL subprocess work on bun's 5s default timeout.
//
// Not a style rule. A test that spawns a process is not measuring its own assertions; it is
// measuring the machine, and a cold, loaded Windows CI runner has been measured at ~9.5x local on
// this exact class. AgentHydra's sessions-scan-cache suite runs in 533ms locally and took 5083.99ms
// on windows-latest, failing the 2026-08-08 run 84ms over the line. That is the worst kind of
// failure: red on a commit that changed nothing related, green again on re-run, and a maintainer
// who learns to re-run CI instead of reading it.
//
// This repo had four (fixed 2026-08-09, all now 20s): regenerating and resolving the root .lnk
// through COM (882ms), spawning a real keep-alive bun.exe then WMI-probing its pid (752ms), the
// tray self-test loading an icon into a NotifyIcon (462ms), and — the instructive one — "launcher
// machinery exists, is non-empty, and is COMMITTED" (176ms), which READS like pure existsSync /
// statSync assertions but calls must(tracked(...)), and tracked() shells out to `git ls-files` once
// per required file. Three of the four are win32-gated, so they only ever run on the slowest leg.
//
// THE RULE: if a test reaches a subprocess, it must state a timeout. Any value counts; the point is
// that somebody chose it instead of inheriting 5s by accident. A repo-wide `bun test --timeout N`
// counts as choosing, for every test at once, and stands this check down entirely (see
// globalTimeoutMs) — for a suite where nearly everything spawns, that is the better answer, and a
// check that could not see it called a sibling repo 230 times broken for solving this properly.
//
// WHY A HELPER HOP MATTERS: tracked() above is the whole difficulty. A scan for `Bun.spawn(` inside
// the test body finds NOTHING there, because the spawn is one call away — and in AgentHydra's case
// two (listOne -> child -> Bun.spawnSync). Module-level helpers are resolved first, transitively.
//
// DELIBERATELY NOT FLAGGED:
//   · A test that spawns only INDIRECTLY through imported production code. Following imports is a
//     much larger problem, and guessing would trade this check's precision for coverage.
//   · Anything inside a comment or a string. Both are blanked before the scan: these tests embed
//     PowerShell and VBS source in template literals and describe their own spawns in prose.
//
// Dependency-free on purpose, same as check-lib-types.mjs: node stdlib only, so it runs identically
// in every consumer with zero install.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "subprocess-test-without-explicit-timeout";

// The spawn APIs this repo's tests actually use are Bun.spawn, Bun.spawnSync and node's spawn; the
// child_process siblings are listed so a future test reaching for one is caught on its first day
// rather than on its first cold-runner flake. `Bun.$` and a bare `$\`` are Bun's shell.
//
// The `execFileSync` family also matches through a NAMESPACE: `import cp from "node:child_process"`
// then `cp.execFileSync(...)` is the same spawn, and the leading `(?<![\w.$])` rejected it outright
// because the preceding character is a dot. Not hypothetical: that is ReDesign's tray-launcher hook
// exactly, the one that held its windows-latest leg red on 2026-08-12 while this check said ✓. Any
// identifier may qualify the four unambiguous names (nothing but child_process exports an
// `execFileSync`); a BARE `spawn` stays unqualified-only, since `queue.spawn(` and friends are
// common enough that widening it would trade real precision for no recall.
const SPAWN_CALL =
  /(?<![\w.$])(?:Bun\.spawnSync|Bun\.spawn|Bun\.\$|(?:[A-Za-z_$][\w$]*\.)?(?:spawnSync|execFileSync|execSync|execFile)|spawn)\s*\(|\$`/;

// `test(`, `it(`, and the modifier forms. `.if`/`.skipIf` are CURRIED — test.skipIf(c)(name, fn, ms)
// — which is handled at the call site below, not here.
const TEST_HEAD =
  /(?<![\w.$])(?:test|it)(?:\.(?:skipIf|todoIf|if|only|failing|each|skip|todo))?\s*\(/g;

// Lifecycle hooks spawn too, and a hook on the 5s default is WORSE than a test on it: bun reports
// the timeout against an unnamed test ("a beforeEach/afterEach hook timed out for this test"), so
// the failure does not even name the hook that caused it. Missing this cost ReDesign a red
// windows-latest leg (2026-08-12): its tray-launcher beforeAll shells out to PowerShell to
// regenerate a .lnk, 0.35s locally, 5057ms there, while this check reported clean throughout.
//
// Their timeout is the SECOND argument, not the third: beforeAll(fn, ms).
const HOOK_HEAD = /(?<![\w.$])(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/g;

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "tmp", "coverage", "build", ".vite"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Recursively yield every test file under `dir`. */
function* testFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* testFiles(p);
    } else if (TEST_FILE.test(e.name)) {
      yield p;
    }
  }
}

/** A repo-wide timeout, if this project sets one: `bun test --timeout 20000` in package.json's test
 *  script, or `timeout = N` under bunfig.toml's [test]. Returns the ms value, or null. */
export function globalTimeoutMs(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const script = pkg?.scripts?.test;
    const m = typeof script === "string" && script.match(/--timeout[=\s]+(\d+)/);
    if (m) return Number(m[1]);
  } catch {}
  try {
    const bunfig = readFileSync(join(root, "bunfig.toml"), "utf8");
    // Only under a [test] table; a timeout elsewhere in bunfig means something else entirely.
    const testTable = bunfig.split(/^\s*\[/m).find((s) => s.startsWith("test]"));
    const m = testTable?.match(/^\s*timeout\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {}
  return null;
}

/** Index just past the regex literal opening at `start`, or -1 if it does not close on that line. */
function endOfRegex(text, start) {
  let inClass = false;
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "\n") return -1;
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "/") return j + 1;
  }
  return -1;
}

// A `/` opens a regex only where an expression is expected. A missed one can carry a bare quote,
// which opens a string that never closes and inverts code/string for the rest of the file.
const REGEX_OPENS_AFTER = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
]);
const REGEX_OPENS_AFTER_KEYWORD =
  /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/;

/** One step of the in-string scan at `i` (quote char `quote`, tracked `prev`). Blanks into `out`
 *  as needed and returns where to resume + the string state to carry forward. */
function blankStringStep(text, out, i, quote, prev) {
  const ch = text[i];
  if (ch === "\\") {
    if (text[i] !== "\n") out[i] = " ";
    if (text[i + 1] !== "\n") out[i + 1] = " ";
    return { i: i + 2, quote, prev };
  }
  if (ch === quote) return { i: i + 1, quote: null, prev: ch };
  if (ch !== "\n") out[i] = " ";
  return { i: i + 1, quote, prev };
}

/** Blank a `//` line comment starting at `i`; returns the index just past it. */
function blankLineComment(text, out, i) {
  while (i < text.length && text[i] !== "\n") out[i++] = " ";
  return i;
}

/** Blank a `/* … *‍/` block comment starting at `i`; returns the index just past it. */
function blankBlockComment(text, out, i) {
  const end = text.indexOf("*/", i + 2);
  const stop = end === -1 ? text.length : end + 2;
  for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
  return stop;
}

/** If a regex literal opens at `i` (given the previous significant char `prev`), blank it and
 *  return the index just past it; otherwise null (caller falls through to default handling). */
function blankRegexIfOpens(text, out, i, prev) {
  const opens =
    prev === "" ||
    REGEX_OPENS_AFTER.has(prev) ||
    REGEX_OPENS_AFTER_KEYWORD.test(text.slice(0, i).trimEnd());
  if (!opens) return null;
  const end = endOfRegex(text, i);
  if (end === -1) return null;
  for (let j = i; j < end; j++) if (text[j] !== "\n") out[j] = " ";
  return end;
}

/** Blank comments and the INTERIOR of every string/template literal, index-for-index (line numbers
 *  are computed against the untouched text). Quotes and brackets survive so call spans still
 *  balance. A spawn cannot happen inside a comment or a string, so removing both is what makes this
 *  precise for a suite that embeds PowerShell source in template literals. */
function blankNonCode(text) {
  const out = text.split("");
  let inString = null;
  let prev = "";
  let i = 0;
  while (i < text.length) {
    if (inString) {
      const next = blankStringStep(text, out, i, inString, prev);
      i = next.i;
      inString = next.quote;
      prev = next.prev;
      continue;
    }
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = blankLineComment(text, out, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = blankBlockComment(text, out, i);
      continue;
    }
    if (ch === "/") {
      const regexEnd = blankRegexIfOpens(text, out, i, prev);
      if (regexEnd !== null) {
        i = regexEnd;
        prev = "/";
        continue;
      }
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out.join("");
}

/** Extract from `open` (a bracket) through its match. Operates on already-blanked code. */
function extractBalanced(text, open, oc = "(", cc = ")") {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === oc) depth++;
    else if (c === cc) {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** Top-level arguments of a call span like `(a, b, c)`, so "is there a third argument" does not
 *  depend on how the formatter wrapped it. */
function topLevelArgs(call) {
  const args = [];
  let depth = 0;
  let start = 1;
  for (let i = 1; i < call.length; i++) {
    const c = call[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (c === ")" && depth === 0) {
        args.push(call.slice(start, i));
        break;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(call.slice(start, i));
      start = i + 1;
    }
  }
  return args.map((a) => a.trim());
}

/** Module-level helpers whose body reaches a spawn, closed transitively so tracked() and a two-hop
 *  chain both resolve. Operates on blanked code. */
function spawnyHelpers(code) {
  const bodies = new Map();
  for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/g)) {
    const brace = code.indexOf("{", m.index + m[0].length - 1);
    if (brace !== -1) bodies.set(m[1], extractBalanced(code, brace, "{", "}"));
  }
  for (const m of code.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g,
  )) {
    const after = m.index + m[0].length;
    const brace = code.indexOf("{", after);
    const nl = code.indexOf("\n", after);
    bodies.set(
      m[1],
      brace !== -1 && (nl === -1 || brace < nl)
        ? extractBalanced(code, brace, "{", "}")
        : code.slice(after, nl === -1 ? code.length : nl),
    );
  }
  const spawny = new Set();
  for (const [n, b] of bodies) if (SPAWN_CALL.test(b)) spawny.add(n);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [n, b] of bodies) {
      if (spawny.has(n)) continue;
      for (const s of spawny) {
        if (new RegExp(`(?<![\\w.$])${s}\\s*[(<]`).test(b)) {
          spawny.add(n);
          changed = true;
          break;
        }
      }
    }
  }
  return spawny;
}

/** Every test in `text` that reaches a subprocess (directly, or through a module-level helper) and
 *  does not pass an explicit timeout. Exported so the rule can be unit-tested against fixture
 *  strings rather than only against the live tree. */
export function findViolations(text) {
  const code = blankNonCode(text);
  const helpers = spawnyHelpers(code);
  const helperHit = (span) =>
    [...helpers].find((h) => new RegExp(`(?<![\\w.$])${h}\\s*[(<]`).test(span));

  const hits = [];
  // `test(name, fn, ms)` puts the timeout third; `beforeAll(fn, ms)` puts it second. Everything else
  // about the rule is identical, so the two differ only by which argument has to be present.
  for (const [head, timeoutArg, kind] of [
    [TEST_HEAD, 2, "test"],
    [HOOK_HEAD, 1, "hook"],
  ]) {
    head.lastIndex = 0;
    for (const m of code.matchAll(head)) {
      const open = m.index + m[0].length - 1;
      let call = extractBalanced(code, open);
      // `test.skipIf(cond)(name, fn, ms)`: the first span is the condition, the real call is next.
      const after = open + call.length;
      if (code[after] === "(") call = extractBalanced(code, after);

      const direct = SPAWN_CALL.test(call);
      const via = direct ? null : helperHit(call);
      if (!direct && !via) continue;

      const args = topLevelArgs(call);
      // an explicit timeout, whatever its value
      if (args.length > timeoutArg && args[timeoutArg].length > 0) continue;

      hits.push({ index: m.index, via, kind });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

export const audit = {
  id: ID,
  title: "a test that spawns a subprocess must set an explicit timeout, not inherit the 5s default",
  category: "custom",
  domain: "code",
  requires: {},
  gating: true,
  run(ctx) {
    const root = ctx?.root ?? process.cwd();
    const findings = [];

    // A repo-wide allowance settles it for every test at once; there is no 5s default left to
    // inherit, so per-test annotations would be ceremony rather than protection.
    const global = globalTimeoutMs(root);
    if (global !== null) {
      return {
        failed: false,
        findings: [],
        report:
          `This project sets a repo-wide test timeout of ${global}ms, so no test inherits the 5s ` +
          "default and this check has nothing to enforce. ✓",
      };
    }

    for (const file of testFiles(root)) {
      const rel = relative(root, file).replace(/\\/g, "/");
      let text;
      try {
        if (statSync(file).size > 2_000_000) continue;
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!SPAWN_CALL.test(text)) continue; // cheap reject before the call-span scan
      for (const hit of findViolations(text)) {
        findings.push({
          id: ID,
          file: rel,
          line: lineAt(text, hit.index),
          severity: "error",
          message:
            `This test reaches a subprocess ${hit.via ? `via ${hit.via}()` : "directly"} but takes ` +
            "bun's 5s default timeout. Its runtime is set by the machine, not by its assertions.",
          fix:
            "Pass an explicit timeout as the third argument: `test(name, fn, 20000)`. Any value " +
            "counts; the point is that it was chosen. Record the measured local cost in a comment, " +
            "as tests/launcher.test.ts does, so the next reader can tell an allowance from a guess. " +
            "If MOST tests here ever spawn, set one repo-wide `bun test --timeout N` instead and " +
            "this check stands down entirely.",
        });
      }
    }

    const failed = findings.length > 0;
    const report = failed
      ? `Found ${findings.length} subprocess test(s) on the 5s default:\n${findings
          .map((f) => `- ${f.file}:${f.line}`)
          .join("\n")}`
      : "Every test that spawns a subprocess sets an explicit timeout. ✓";

    return { failed, findings, report };
  },
};

// Standalone CLI (used by CI): `bun <thisfile>` prints the report and exits 1 on any violation.
// When imported, process.argv[1] is the importer, so this block is inert.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = audit.run({ root: process.cwd() });
  console.log(res.report);
  if (res.failed) process.exit(1);
}
