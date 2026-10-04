import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { runAuditCli } from "@saydeploy/architect/cli/runner";

test("runAuditCli writes source anchors into structured findings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-runner-anchor-"));
  const previousExitCode = process.exitCode;
  try {
    await writeFile(path.join(root, "src.ts"), ["alpha", "beta", "gamma"].join("\n"), "utf8");

    const audit = {
      id: "demo-anchor",
      title: "Demo anchor",
      category: "meta",
      run: async () => ({
        failed: false,
        findings: [
          {
            ruleId: "demo-anchor/rule",
            severity: "warn",
            filePath: "src.ts",
            line: 2,
            message: "Demo finding",
          },
        ],
      }),
    };

    await runAuditCli({
      argv: ["--check", "demo-anchor", "--quiet"],
      audits: [audit],
      getAudit: () => audit,
      loadConfig: async () => ({ checks: {} }),
      root,
    });

    const findings = JSON.parse(await readFile(path.join(root, "tmp", "audits", "findings.json"), "utf8"));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].sourceAnchor.filePath, "src.ts");
    assert.equal(findings[0].sourceAnchor.line, 2);
    assert.match(findings[0].sourceAnchor.anchor, /^L2:sha256-[0-9a-f]{12}$/);

    const brief = JSON.parse(await readFile(path.join(root, "tmp", "audits", "DECISION_BRIEF.json"), "utf8"));
    assert.equal(brief.ranked[0].sourceAnchor.anchor, findings[0].sourceAnchor.anchor);
  } finally {
    process.exitCode = previousExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("runAuditCli mirrors enriched findings into jsonPayload findings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-runner-anchor-"));
  const previousExitCode = process.exitCode;
  const previousConsoleLog = console.log;
  const logs = [];
  try {
    await writeFile(path.join(root, "src.ts"), ["alpha", "beta", "gamma"].join("\n"), "utf8");
    console.log = (value) => logs.push(String(value));

    const rawFinding = {
      ruleId: "demo-anchor/rule",
      severity: "warn",
      filePath: "src.ts",
      line: 2,
      message: "Demo finding",
    };
    const audit = {
      id: "demo-anchor",
      title: "Demo anchor",
      category: "meta",
      run: async () => ({
        failed: false,
        findings: [rawFinding],
        jsonPayload: { findings: [rawFinding] },
      }),
    };

    await runAuditCli({
      argv: ["--check", "demo-anchor", "--format=json", "--quiet"],
      audits: [audit],
      getAudit: () => audit,
      loadConfig: async () => ({ checks: {} }),
      root,
    });

    const payload = JSON.parse(logs[0]);
    assert.match(payload.findings[0].sourceAnchor.anchor, /^L2:sha256-[0-9a-f]{12}$/);
  } finally {
    console.log = previousConsoleLog;
    process.exitCode = previousExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("runAuditCli writes the DevOpz decision brief when requested", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-runner-devopz-"));
  const previousExitCode = process.exitCode;
  try {
    const audit = {
      id: "infra-public-exposure",
      title: "Public Exposure",
      category: "infra",
      run: async () => ({
        failed: false,
        findings: [
          {
            ruleId: "lambda-url-public",
            severity: "warn",
            confidence: 80,
            resource: "PublicFunctionUrl",
            message: "Public Lambda URL has no auth guard",
            fix: "require IAM auth or route through API Gateway",
            blastRadius: "public",
            mapNodeId: "lambda:PublicFunctionUrl",
          },
        ],
      }),
    };

    await runAuditCli({
      argv: ["--check", "infra-public-exposure", "--quiet"],
      audits: [audit],
      getAudit: () => audit,
      loadConfig: async () => ({ checks: {} }),
      root,
      toolName: "devopz",
    });

    const brief = JSON.parse(await readFile(path.join(root, "tmp", "audits", "DEVOPZ_DECISION_BRIEF.json"), "utf8"));
    assert.equal(brief.tool, "devopz");
    assert.equal(brief.ranked[0].ruleId, "lambda-url-public");
    assert.equal(brief.ranked[0].riskScore, 56);
    assert.equal(brief.nextActions[0].action, "require IAM auth or route through API Gateway");
  } finally {
    process.exitCode = previousExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("runAuditCli counts structured findings when markdown has no summary lines", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-runner-structured-counts-"));
  const previousExitCode = process.exitCode;
  try {
    const audit = {
      id: "opaque-report",
      title: "Opaque Report",
      category: "product",
      defaultConfig: { outputPath: "tmp/audits/OPAQUE_REPORT.md" },
      run: async () => ({
        failed: true,
        findings: [
          { ruleId: "opaque-error", severity: "error", message: "Missing contract" },
          { ruleId: "opaque-warning", severity: "warn", message: "Risky contract" },
          { ruleId: "opaque-info", severity: "info", message: "Context only" },
        ],
        report: "# Opaque Report\n\nHuman-readable findings without runner summary lines.\n",
      }),
    };

    await runAuditCli({
      argv: ["--all", "--fail-on-drift", "--quiet"],
      audits: [audit],
      getAudit: () => audit,
      loadConfig: async () => ({ checks: {} }),
      root,
    });

    const manifest = JSON.parse(await readFile(path.join(root, "tmp", "audits", "manifest.json"), "utf8"));
    assert.equal(manifest.totalErrors, 1);
    assert.equal(manifest.totalWarnings, 1);
    assert.equal(manifest.gatingErrors, 1);
    assert.equal(manifest.gatingWarnings, 1);
    assert.equal(manifest.reports[0].totalFindings, 2);
    assert.equal(manifest.pass.nextAction, "fix-errors");
  } finally {
    process.exitCode = previousExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("runAuditCli reports dirty posture in non-strict all runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-runner-nonstrict-dirty-"));
  const previousExitCode = process.exitCode;
  try {
    const audit = {
      id: "dirty-posture",
      title: "Dirty Posture",
      category: "meta",
      defaultConfig: { outputPath: "tmp/audits/DIRTY_POSTURE.md" },
      run: async () => ({
        failed: true,
        findings: [{ ruleId: "dirty-warning", severity: "warn", message: "Actionable finding" }],
        report: "# Dirty Posture\n\nErrors: 0\nWarnings: 1\n",
      }),
    };

    await runAuditCli({
      argv: ["--all", "--quiet"],
      audits: [audit],
      getAudit: () => audit,
      loadConfig: async () => ({ checks: {} }),
      root,
    });

    const manifest = JSON.parse(await readFile(path.join(root, "tmp", "audits", "manifest.json"), "utf8"));
    assert.equal(manifest.pass.clean, false);
    assert.equal(manifest.pass.complete, false);
    assert.equal(manifest.pass.nextAction, "fix-errors");
  } finally {
    process.exitCode = previousExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("runAuditCli configured suite mode only runs configured checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-runner-configured-suite-"));
  const previousExitCode = process.exitCode;
  try {
    const seen = [];
    const configuredAudit = {
      id: "configured-check",
      title: "Configured Check",
      category: "meta",
      run: async () => {
        seen.push("configured-check");
        return { failed: false };
      },
    };
    const otherAudit = {
      id: "other-check",
      title: "Other Check",
      category: "meta",
      run: async () => {
        seen.push("other-check");
        return { failed: false };
      },
    };

    await runAuditCli({
      argv: ["--all", "--quiet"],
      audits: [configuredAudit, otherAudit],
      getAudit: (id) => [configuredAudit, otherAudit].find((audit) => audit.id === id) ?? null,
      loadConfig: async () => ({
        project: { name: "portable" },
        suite: { mode: "configured" },
        groups: { default: { checks: ["configured-check"] } },
        checks: {},
      }),
      root,
    });

    assert.deepEqual(seen, ["configured-check"]);
    const manifest = JSON.parse(await readFile(path.join(root, "tmp", "audits", "manifest.json"), "utf8"));
    assert.equal(manifest.pass.ran, 1);
  } finally {
    process.exitCode = previousExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("runAuditCli skips checks whose requires block does not match project shape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-runner-requires-"));
  const previousExitCode = process.exitCode;
  try {
    const seen = [];
    const vueAudit = {
      id: "vue-only",
      title: "Vue Only",
      category: "surface",
      requires: { frameworks: ["vue", "vue3"] },
      run: async () => {
        seen.push("vue-only");
        return { failed: false };
      },
    };
    const genericAudit = {
      id: "generic",
      title: "Generic",
      category: "meta",
      run: async () => {
        seen.push("generic");
        return { failed: false };
      },
    };

    await runAuditCli({
      argv: ["--all", "--quiet"],
      audits: [vueAudit, genericAudit],
      getAudit: (id) => [vueAudit, genericAudit].find((audit) => audit.id === id) ?? null,
      loadConfig: async () => ({ project: { name: "portable", frameworks: ["react"] }, checks: {} }),
      root,
    });

    assert.deepEqual(seen, ["generic"]);
  } finally {
    process.exitCode = previousExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("runAuditCli lets policy config override built-in requires blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-runner-requires-override-"));
  const previousExitCode = process.exitCode;
  try {
    const seen = [];
    const connectionsAudit = {
      id: "connections-default",
      title: "Connections Default",
      category: "product",
      requires: { projectNames: ["connections"] },
      run: async () => {
        seen.push("connections-default");
        return { failed: false };
      },
    };

    await runAuditCli({
      argv: ["--all", "--quiet"],
      audits: [connectionsAudit],
      getAudit: (id) => (id === connectionsAudit.id ? connectionsAudit : null),
      loadConfig: async () => ({
        project: { name: "portable" },
        checks: {
          "connections-default": {
            requires: {},
          },
        },
      }),
      root,
    });

    assert.deepEqual(seen, ["connections-default"]);
  } finally {
    process.exitCode = previousExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});
