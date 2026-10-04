import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

// Regression guard for `maskNonCode`: imports that live inside a backtick
// template literal (example code in a doc-string / guide) or inside a comment
// are NOT live code and must never register as import edges — while real
// imports, including a dynamic import() inside a `${ … }` interpolation, must.
// This is the exact false positive that flagged `resend` / `@/emails` as phantom
// dependencies from a guide string in SayDeploy.
async function scratch() {
  return mkdtemp(path.join(tmpdir(), "arkitect-mask-"));
}

const FIXTURE = [
  'import { real } from "real-pkg";', // real edge → kept
  "const guide = `", // opens a template-literal doc-string
  "import { Fake } from 'fake-pkg';", // EXAMPLE code inside the template → masked
  "import Welcome from '@/emails/welcome';", // EXAMPLE code inside the template → masked
  "`;", // closes the template literal
  '// import { commented } from "line-commented-pkg";', // line comment → masked
  "/* import { blocked } from 'block-commented-pkg'; */", // block comment → masked
  'async function load() { return `${await import("dyn-pkg")}`; }', // real dynamic import in interpolation → kept
  "export const x = real + guide + load;",
].join("\n");

test("maskNonCode: template-literal and commented imports are not edges; real + interpolated-dynamic imports are", async () => {
  const root = await scratch();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), FIXTURE);

    const graph = await buildImportGraph({ root, roots: ["src"], tsconfigPath: null });
    const node = graph.nodes.get("src/a.ts");
    const specifiers = node.imports.map((edge) => edge.specifier);

    assert.ok(specifiers.includes("real-pkg"), "real top-level import must be an edge");
    assert.ok(specifiers.includes("dyn-pkg"), "dynamic import() inside ${} interpolation must be an edge");
    assert.ok(!specifiers.includes("fake-pkg"), "import inside a template literal must NOT be an edge");
    assert.ok(!specifiers.some((s) => s.includes("emails")), "default import inside a template literal must NOT be an edge");
    assert.ok(!specifiers.includes("line-commented-pkg"), "import in a line comment must NOT be an edge");
    assert.ok(!specifiers.includes("block-commented-pkg"), "import in a block comment must NOT be an edge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A top-level require() runs at load (a real cycle edge); a require() nested in a
// function body is the deliberate lazy-require cycle-breaker and must be tagged
// "dynamic" so circular-deps ignores it — the exact case of the false
// `workspace-intelligence ↔ extension` cycle (a require() inside a method).
test("require kind: top-level require is a load-time edge; function-scoped require is deferred", async () => {
  const root = await scratch();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const src = [
      'const top = require("top-pkg");', // top-level → load-time
      "function lazy() {",
      '  const x = require("lazy-pkg");', // nested → deferred (cycle-breaker)
      "  return x;",
      "}",
      "module.exports = { top, lazy };",
    ].join("\n");
    await writeFile(path.join(root, "src", "b.js"), src);

    const graph = await buildImportGraph({ root, roots: ["src"], tsconfigPath: null });
    const edges = graph.nodes.get("src/b.js").imports;
    const top = edges.find((e) => e.specifier === "top-pkg");
    const lazy = edges.find((e) => e.specifier === "lazy-pkg");

    assert.equal(top.importKind, "value", "top-level require is a load-time edge");
    assert.equal(lazy.importKind, "dynamic", "function-scoped require is deferred (not a load-time cycle)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
