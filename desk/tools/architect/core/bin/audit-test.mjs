#!/usr/bin/env bun
import process from "node:process";

import { AUDITS, getAudit } from "@saydeploy/architect/cli/registry";
import { hasFixtureFailures, printFixtureSummary, runAuditFixtureScenarios } from "@saydeploy/architect/fixtures/harness";

const { results, uncoveredEngines } = await runAuditFixtureScenarios({
  audits: AUDITS,
  getAudit,
});

printFixtureSummary(results, uncoveredEngines, AUDITS.length);

process.exitCode = hasFixtureFailures(results) ? 1 : 0;
