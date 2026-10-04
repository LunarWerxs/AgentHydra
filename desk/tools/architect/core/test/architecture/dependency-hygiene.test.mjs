import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runDependencyHygieneAudit } from "@saydeploy/architect/engines/architecture/dependency-hygiene-engine";

async function scratch() {
  return mkdtemp(path.join(tmpdir(), "arkitect-hygiene-"));
}

async function setup(root) {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      dependencies: { "real-dep": "1.0.0", "unused-dep": "1.0.0" },
      devDependencies: { "@types/aws-lambda": "1.0.0" },
    }),
  );
  await writeFile(
    path.join(root, "src", "a.ts"),
    [
      'import { thing } from "real-dep";', // used → ok
      'import { gone } from "missing-pkg";', // not declared → unlisted
      'import type { Handler } from "aws-lambda";', // covered by @types/aws-lambda → ok
      'import { readFile } from "node:fs/promises";', // builtin → ignored
      'import sub from "real-dep/submodule";', // still "real-dep"
      "export const x = thing + gone + readFile + sub;",
      "export type H = Handler;",
    ].join("\n"),
  );
  // A spec file importing a test framework must NOT register as a phantom dep.
  await writeFile(path.join(root, "src", "a.spec.ts"), 'import { it } from "vitest";\nit("x", () => {});');
}

test("flags phantom (unlisted) deps, honors @types pairing, builtins, and test-file skip", async () => {
  const root = await scratch();
  try {
    await setup(root);
    const result = await runDependencyHygieneAudit({
      root,
      checkConfig: { manifests: [{ packageJson: "package.json", roots: ["src"] }] },
    });
    const unlisted = result.findings.filter((f) => f.ruleId === "dep-hygiene:unlisted").map((f) => f.metadata.package);
    const unused = result.findings.filter((f) => f.ruleId === "dep-hygiene:unused").map((f) => f.metadata.package);

    assert.deepEqual(unlisted, ["missing-pkg"]); // aws-lambda covered by @types, vitest skipped, node:fs builtin
    assert.deepEqual(unused, ["unused-dep"]); // real-dep is used, @types never flagged unused
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unused findings are advisory (severity info) so they never gate", async () => {
  const root = await scratch();
  try {
    await setup(root);
    const result = await runDependencyHygieneAudit({
      root,
      checkConfig: { manifests: [{ packageJson: "package.json", roots: ["src"] }] },
    });
    const unused = result.findings.filter((f) => f.ruleId === "dep-hygiene:unused");
    assert.ok(unused.every((f) => f.severity === "info"));
    // The gating counter the runner parses must read 0 phantom-equivalent warnings.
    assert.match(result.report, /Warnings: 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
