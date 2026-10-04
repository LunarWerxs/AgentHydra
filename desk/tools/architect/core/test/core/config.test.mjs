import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseAuditCliArgs } from "@saydeploy/architect/cli/args";
import { loadAuditConfig, resolveAuditConfigPath } from "@saydeploy/architect/core/config";

test("parseAuditCliArgs captures config and policy selectors", () => {
  const options = parseAuditCliArgs([
    "--all",
    "--config",
    ".arkitect/custom.json",
    "--policy-dir=policies",
    "--policy",
    "portable",
  ]);

  assert.equal(options.command, "run");
  assert.equal(options.all, true);
  assert.equal(options.configPath, ".arkitect/custom.json");
  assert.equal(options.policyDir, "policies");
  assert.equal(options.policy, "portable");
});

test("loadAuditConfig resolves explicit config paths before root defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkitect-config-explicit-"));
  try {
    await writeFile(path.join(root, "arkitect.config.json"), JSON.stringify({ project: { name: "root" } }), "utf8");
    await mkdir(path.join(root, ".arkitect"), { recursive: true });
    await writeFile(
      path.join(root, ".arkitect", "custom.json"),
      JSON.stringify({ project: { name: "custom" } }),
      "utf8",
    );

    const config = await loadAuditConfig({ root, configPath: ".arkitect/custom.json" });

    assert.equal(config.project.name, "custom");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAuditConfigPath supports named policy packs in a policy directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkitect-config-policy-"));
  try {
    await mkdir(path.join(root, "policies", "portable"), { recursive: true });
    await writeFile(
      path.join(root, "policies", "portable", "portable.audit.config.json"),
      JSON.stringify({ project: { name: "portable" } }),
      "utf8",
    );

    const configPath = await resolveAuditConfigPath(root, { policyDir: "policies", policy: "portable" });

    assert.equal(
      path.relative(root, configPath).replaceAll(path.sep, "/"),
      "policies/portable/portable.audit.config.json",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
