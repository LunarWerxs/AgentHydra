import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runModuleRulesAudit } from "@saydeploy/architect/engines/architecture/module-rules-engine";

async function scratch() {
  return mkdtemp(path.join(tmpdir(), "arkitect-modrules-"));
}

// back/ → mid/ → leaf/ which imports the external "browser-lib".
async function setup(root) {
  await mkdir(path.join(root, "back"), { recursive: true });
  await mkdir(path.join(root, "shared"), { recursive: true });
  await writeFile(path.join(root, "back", "handler.ts"), 'import { mid } from "../shared/mid";\nexport const h = mid;');
  await writeFile(path.join(root, "shared", "mid.ts"), 'import { leaf } from "./leaf";\nexport const mid = leaf;');
  await writeFile(path.join(root, "shared", "leaf.ts"), 'import bl from "browser-lib";\nexport const leaf = bl;');
  // A shared component used exactly once (single-use) and one used twice.
  await writeFile(path.join(root, "shared", "Single.ts"), "export const single = 1;");
  await writeFile(path.join(root, "shared", "Double.ts"), "export const double = 2;");
  await writeFile(
    path.join(root, "back", "useDouble1.ts"),
    'import { double } from "../shared/Double";\nexport const a = double;',
  );
  await writeFile(
    path.join(root, "back", "useDouble2.ts"),
    'import { double } from "../shared/Double";\nexport const b = double;',
  );
  await writeFile(
    path.join(root, "back", "useSingle.ts"),
    'import { single } from "../shared/Single";\nexport const c = single;',
  );
  // A test reaching the browser lib must NOT trip the reachable gate.
  await writeFile(path.join(root, "back", "probe.spec.ts"), 'import bl from "browser-lib";\nit("x", () => bl);');
}

test("reachable rule catches a TRANSITIVE external reach and ships the via-path", async () => {
  const root = await scratch();
  try {
    await setup(root);
    const result = await runModuleRulesAudit({
      root,
      checkConfig: {
        roots: ["."],
        rules: [
          {
            name: "no-browser-lib",
            kind: "reachable",
            severity: "error",
            from: { path: "^back/" },
            to: { path: "browser-lib" },
            reachable: false,
          },
        ],
      },
    });
    const reach = result.findings.filter((f) => f.metadata.ruleName === "no-browser-lib");
    // handler.ts reaches it 3 hops away; probe.spec.ts is skipped (test file).
    const handler = reach.find((f) => f.filePath === "back/handler.ts");
    assert.ok(handler, "handler.ts should violate");
    assert.deepEqual(handler.metadata.via, ["back/handler.ts", "shared/mid.ts", "shared/leaf.ts", "browser-lib"]);
    assert.ok(!reach.some((f) => f.filePath.includes(".spec.")), "test files must not source a reachable violation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependents rule flags single-use modules as advisory info (never gates)", async () => {
  const root = await scratch();
  try {
    await setup(root);
    const result = await runModuleRulesAudit({
      root,
      checkConfig: {
        roots: ["."],
        rules: [
          {
            name: "single-use",
            kind: "dependents",
            from: {},
            module: { path: "^shared/(Single|Double)" },
            numberOfDependentsLessThan: 2,
          },
        ],
      },
    });
    const dep = result.findings.filter((f) => f.metadata.ruleName === "single-use");
    const flagged = dep.map((f) => f.filePath);
    assert.ok(flagged.includes("shared/Single.ts"), "Single (1 dependent) is flagged");
    assert.ok(!flagged.includes("shared/Double.ts"), "Double (2 dependents) is not flagged");
    assert.ok(
      dep.every((f) => f.severity === "info"),
      "dependents findings are advisory info",
    );
    assert.match(result.report, /Warnings: 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
