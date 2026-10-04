#!/usr/bin/env bun
import { runScreenshotCli } from "@saydeploy/architect/screenshot/runner";

runScreenshotCli(process.argv.slice(2)).catch((error) => {
  console.error("[audit-screenshot] failed:", error);
  process.exitCode = 1;
});
