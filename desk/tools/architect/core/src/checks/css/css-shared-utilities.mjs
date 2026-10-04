import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const DEFAULT_SHARED_DECLARATION_FILES = [
  "src/styles/shared-declarations.css",
];

export const audit = {
  id: "css-shared-utilities",
  title: "CSS Shared Utilities",
  category: "maintainability",
  outputContract: "parsed-findings",
  defaultConfig: {
    utilityScriptPath: "packages/connections-arkitect/runners/fix-css-shared-utilities.mjs",
    sharedDeclarationFiles: DEFAULT_SHARED_DECLARATION_FILES,
    maxSharedDeclarationFileLines: 900,
    maxSharedDeclarationTotalLines: 3200,
    outputPath: "tmp/audits/CSS_SHARED_UTILITIES_AUDIT.md",
  },
  async run(context) {
    const result = await runCssSharedUtilitiesAudit({
      maxSharedDeclarationFileLines: context.checkConfig.maxSharedDeclarationFileLines,
      maxSharedDeclarationTotalLines: context.checkConfig.maxSharedDeclarationTotalLines,
      root: context.root,
      sharedDeclarationFiles: context.checkConfig.sharedDeclarationFiles,
      utilityScriptPath: context.checkConfig.utilityScriptPath,
    });

    return {
      failed: result.failed,
      jsonPayload: result.jsonPayload,
      outputPath: context.checkConfig.outputPath,
      report: renderReport(result.jsonPayload),
    };
  },
};

export async function runCssSharedUtilitiesAudit({
  maxSharedDeclarationFileLines,
  maxSharedDeclarationTotalLines,
  root,
  sharedDeclarationFiles = DEFAULT_SHARED_DECLARATION_FILES,
  utilityScriptPath,
}) {
  const lineCounts = sharedDeclarationFiles.map((filePath) => {
    const absolutePath = path.resolve(root, filePath);
    const lineCount = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8").split(/\r?\n/).length : 0;
    return { filePath, lineCount };
  });

  const totalSharedDeclarationLines = lineCounts.reduce((sum, entry) => sum + entry.lineCount, 0);
  const commandResult = await runUtilityDryRun(root, utilityScriptPath);
  const parsed = parseUtilityOutput(commandResult.stdout);
  const findings = [];

  if (commandResult.exitCode !== 0) {
    findings.push({
      detail: commandResult.stderr || commandResult.stdout || "The shared utility codemod exited non-zero.",
      kind: "codemod-error",
    });
  }

  if (parsed.migratedSelectors > 0) {
    findings.push({
      changedSharedCssFiles: parsed.changedSharedCssFiles,
      changedVueFiles: parsed.changedVueFiles,
      fixCommand: "bun run audit:css-shared-utilities:fix",
      kind: "pending-utility-migrations",
      migratedSelectors: parsed.migratedSelectors,
    });
  }

  for (const entry of lineCounts) {
    if (entry.lineCount > maxSharedDeclarationFileLines) {
      findings.push({
        filePath: entry.filePath,
        kind: "shared-declaration-file-too-large",
        lineCount: entry.lineCount,
        maxLines: maxSharedDeclarationFileLines,
      });
    }
  }

  if (totalSharedDeclarationLines > maxSharedDeclarationTotalLines) {
    findings.push({
      kind: "shared-declaration-total-too-large",
      lineCount: totalSharedDeclarationLines,
      maxLines: maxSharedDeclarationTotalLines,
    });
  }

  return {
    failed: findings.length > 0,
    jsonPayload: {
      changedSharedCssFiles: parsed.changedSharedCssFiles,
      changedVueFiles: parsed.changedVueFiles,
      findings,
      lineCounts,
      migratedSelectors: parsed.migratedSelectors,
      totalSharedDeclarationLines,
    },
  };
}

function runUtilityDryRun(root, utilityScriptPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [utilityScriptPath], {
      cwd: root,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ exitCode: 1, stderr: String(error), stdout });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 0, stderr, stdout });
    });
  });
}

function parseUtilityOutput(output) {
  return {
    changedSharedCssFiles: parseCount(output, /Changed shared CSS files:\s*(\d+)/),
    changedVueFiles: parseCount(output, /Changed Vue files:\s*(\d+)/),
    migratedSelectors: parseCount(output, /Migrated selectors:\s*(\d+)/),
  };
}

function parseCount(output, pattern) {
  const match = String(output ?? "").match(pattern);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function renderReport(payload) {
  const findings = payload.findings ?? [];
  const lines = [];
  lines.push("# CSS Shared Utilities Audit");
  lines.push("");
  lines.push(`- Findings: **${findings.length}**`);
  lines.push(`- Pending utility migrations: **${payload.migratedSelectors ?? 0}**`);
  lines.push(`- Shared declaration lines: **${payload.totalSharedDeclarationLines ?? 0}**`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No shared utility drift found.");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
      "Shared declaration CSS should not grow by restating utility-shaped declarations. Run the fix command, then keep only selector-specific styling in shared declaration CSS.",
  );
  lines.push("");

  for (const finding of findings) {
    if (finding.kind === "pending-utility-migrations") {
      lines.push(
        `- ${finding.migratedSelectors} selector utilities can be migrated across ${finding.changedVueFiles} Vue files and ${finding.changedSharedCssFiles} shared CSS files.`,
      );
      lines.push(`  Fix: \`${finding.fixCommand}\``);
      continue;
    }

    if (finding.kind === "shared-declaration-file-too-large") {
      lines.push(`- ${finding.filePath} has ${finding.lineCount} lines; budget is ${finding.maxLines}.`);
      continue;
    }

    if (finding.kind === "shared-declaration-total-too-large") {
      lines.push(`- Shared declaration CSS has ${finding.lineCount} total lines; budget is ${finding.maxLines}.`);
      continue;
    }

    lines.push(`- ${finding.kind}: ${finding.detail ?? "No detail provided."}`);
  }

  lines.push("");
  lines.push("Current shared declaration sizes:");
  for (const entry of payload.lineCounts ?? []) {
    lines.push(`- ${entry.filePath}: ${entry.lineCount}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
