// Guardrail for the break that shipped v0.6.0 with red CI (2026-07-16): a kit sync wrote both
// src/portable-window.mjs and its hand-maintained sibling src/portable-window.d.mts, but only the
// .mjs got committed. The author's working tree still held the .d.mts, so THEIR typecheck was
// green (94cf131's message says so in good faith); CI's clean checkout had a runtime module
// exporting appWindowPlacementKey + hasRememberedBounds whose declarations did not exist, and went
// red for three commits until someone read the log.
//
// THE RULE: for every vendored lib, the `.mjs` (what runs) and the `.d.mts` (what TypeScript
// believes) MUST agree on their VALUE exports, in BOTH directions. The two directions fail very
// differently:
//   · .mjs exports X, .d.mts omits it  -> TS cannot see X. Loud IF something imports it (TS2305,
//     plus implicit-any cascades where the untyped value flows on), silent while nothing does.
//     This is exactly what happened above.
//   · .d.mts declares X, .mjs lacks it -> THE DANGEROUS ONE, and the reason this is not redundant
//     with tsc. An ambient declaration is an unchecked promise: TS resolves the import, typechecks
//     every call, and ships. The value is `undefined` at runtime and blows up on first call, in
//     production, with types that swore it was fine. tsc CANNOT catch this by construction: it
//     trusts the .d.mts and never reads the .mjs.
//
// Type-only declarations (`export interface`, `export type`) exist ONLY in the .d.mts by design
// (WindowSize, PortableWindowOptions...) and are ignored; they have no runtime counterpart.
//
// DEPENDENCY-FREE on purpose. The .mjs side uses Bun's own transpiler (exact, and present wherever
// bun runs). The .d.mts side is a focused classifier over its narrow grammar — and it FLAGS any
// export form it does not recognize (e.g. `export *`, a renamed clause) as a finding rather than
// skipping it, because for a drift check the dangerous failure is a SILENT miss (a value dropped
// from one side would read as agreement). We do not import `typescript`: ccmanagerui has none at
// its root (it lives in the web/ and server/ workspaces), so an import there would not resolve, and
// this check is meant to run identically in all four consumers with zero install.
//
// Self-contained (same rationale as this repo's other guardrails): imports only node builtins, so
// it runs standalone in CI with no runner and no network.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage", ".testtmp"]);

/** Every *.d.mts under `dir`, skipping vendor/output dirs. */
function findDeclarationFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) findDeclarationFiles(full, out);
    } else if (e.isFile() && e.name.endsWith(".d.mts")) {
      out.push(full);
    }
  }
  return out;
}

/** Value exports of a runtime .mjs — exact, via Bun's transpiler. */
function runtimeValueExports(file) {
  const src = readFileSync(file, "utf8");
  const { exports } = new Bun.Transpiler({ loader: "js" }).scan(src);
  return new Set(exports);
}

/** Strip block and line comments so `// export foo` in prose is never matched. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * Value export names declared in a .d.mts, plus any export form we cannot analyze (returned as
 * `unsupported` so it becomes a loud finding, never a silent skip). Type-only declarations are
 * excluded. Handles the kit's grammar (`export function`, `export const`) and the standard forms
 * around it (class/enum/let/var/default, and a named `export { a as b, type T }` clause).
 */
function declaredValueExports(file) {
  const text = stripComments(readFileSync(file, "utf8"));
  const values = new Set();
  const unsupported = [];

  // Top-level exports in a .d.mts begin a line (optional indent). Continuation lines of a
  // multi-line signature never start with `export`, so a first-line scan sees every declaration.
  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("export")) continue;
    let rest = line.slice("export".length);
    if (!/^\s/.test(rest) && !rest.startsWith("{") && !rest.startsWith("*")) continue; // `exported` etc.
    rest = rest.trimStart();
    rest = rest.replace(/^declare\s+/, "").replace(/^async\s+/, "");

    if (/^(interface|type)\b/.test(rest)) continue; // type-only: `type X =` and `type { ... }`
    if (rest.startsWith("*")) {
      unsupported.push("`export *` re-export is not analyzable — enumerate it or exclude the file");
      continue;
    }
    if (rest.startsWith("default")) {
      values.add("default");
      continue;
    }
    if (rest.startsWith("{")) {
      // Named clause. Kit uses single-line clauses; join forward defensively if a `}` is missing.
      let clause = rest;
      if (!clause.includes("}")) clause += " " + line; // best-effort; flagged below if still open
      const inner = clause.slice(clause.indexOf("{") + 1, clause.indexOf("}"));
      if (clause.indexOf("}") === -1) {
        unsupported.push("multi-line `export { ... }` clause is not analyzable");
        continue;
      }
      for (const specRaw of inner.split(",")) {
        const spec = specRaw.trim();
        if (!spec || spec.startsWith("type ") || spec === "type") continue; // inline type export
        const asMatch = spec.match(/\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
        const name = asMatch ? asMatch[1] : (spec.match(IDENT)?.[0] ?? null);
        if (name) values.add(name);
      }
      continue;
    }
    // Value declaration: function / class / enum / const / let / var. Strip the keyword, then the
    // name is the leading identifier (before any `<generic>` or `(`).
    const kw = rest.match(/^(function\*?|class|enum|const|let|var|abstract\s+class)\s+/);
    if (kw) {
      const after = rest.slice(kw[0].length).trimStart();
      const name = after.match(IDENT)?.[0];
      if (name) values.add(name);
      // `export const a: T, b: T` — capture further top-level declarators for const/let/var.
      if (/^(const|let|var)\b/.test(kw[1])) {
        for (const part of after.split(",").slice(1)) {
          const n = part.trim().match(IDENT)?.[0];
          if (n) values.add(n);
        }
      }
      continue;
    }
    unsupported.push(`unrecognized export form: \`${line.slice(0, 60)}\``);
  }
  return { values, unsupported };
}

export const audit = {
  id: "kit-lib-type-drift",
  title: "A vendored lib's .mjs and .d.mts must agree on value exports",
  category: "custom",
  domain: "code",
  requires: {},
  // Gating: this is the check that exists BECAUSE a kit sync once shipped a runtime export with no
  // matching declaration and CI went red for three commits before anyone read the log (see header).
  // A non-gating drift check would have let that exact regression back in silently.
  gating: true,
  run({ root = process.cwd() } = {}) {
    const findings = [];
    const checked = [];
    const rel = (p) => relative(root, p).replace(/\\/g, "/");

    for (const dts of findDeclarationFiles(root)) {
      const mjs = dts.replace(/\.d\.mts$/, ".mjs");

      if (!existsSync(mjs)) {
        findings.push({
          file: rel(dts),
          message: `declares types for ${basename(mjs)}, which does not exist. An ambient declaration with no runtime module behind it lets every import of it typecheck and then fail at runtime.`,
        });
        continue;
      }

      const runtime = runtimeValueExports(mjs);
      const declared = declaredValueExports(dts);
      checked.push(rel(mjs));

      for (const u of declared.unsupported) findings.push({ file: rel(dts), message: u });

      const undeclared = [...runtime].filter((n) => !declared.values.has(n)).sort();
      const phantom = [...declared.values].filter((n) => !runtime.has(n)).sort();

      if (undeclared.length) {
        findings.push({
          file: rel(dts),
          message: `${basename(mjs)} exports ${undeclared.map((n) => `\`${n}\``).join(", ")}, but ${basename(dts)} does not declare ${undeclared.length === 1 ? "it" : "them"}. TypeScript cannot see ${undeclared.length === 1 ? "it" : "them"} (TS2305 on import). Did a kit sync land the .mjs without its .d.mts?`,
        });
      }
      if (phantom.length) {
        findings.push({
          file: rel(dts),
          message: `declares ${phantom.map((n) => `\`${n}\``).join(", ")}, which ${basename(mjs)} does NOT export. tsc cannot catch this (it trusts the declaration and never reads the .mjs): every import typechecks and is \`undefined\` at runtime.`,
        });
      }
    }

    const failed = findings.length > 0;
    const report = failed
      ? `Found ${findings.length} .mjs/.d.mts export disagreement(s):\n` +
        findings.map((f) => `- ${f.file}: ${f.message}`).join("\n")
      : `Every vendored lib's .mjs and .d.mts agree on value exports (${checked.length} pair${checked.length === 1 ? "" : "s"} checked). ✓`;

    return { failed, findings, report };
  },
};

// Standalone CLI (used by CI): `bun <thisfile>` prints the report and exits 1 on any violation.
// When imported (by an arkitect run), process.argv[1] is the runner, so this block is inert.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = audit.run({ root: process.cwd() });
  console.log(res.report);
  if (res.failed) process.exit(1);
}
