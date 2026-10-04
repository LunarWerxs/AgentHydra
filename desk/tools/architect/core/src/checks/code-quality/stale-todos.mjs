/**
 * Stale TODOs — connections-arkitect check
 * =========================================
 * Scans production source for TODO/FIXME/HACK markers and flags
 * stale, untagged, or migration-related TODOs that indicate
 * incomplete refactors or abandoned work.
 *
 * Rules:
 *   1. stale-todo-migration
 *      A TODO tagged with "migration", "shell", or "billing" —
 *      these track incomplete architectural migrations.
 *
 *   2. stale-todo-untagged
 *      A TODO without a tag in production code. Untagged TODOs
 *      are easily forgotten and should have an owner tag.
 *
 *   3. stale-todo-fixme-hack
 *      FIXME or HACK markers in production code. These are stronger
 *      signals than TODO and warrant immediate attention.
 *
 *   4. stale-todo-concentration
 *      A file has 3+ TODOs — likely a component that was shipped
 *      before it was finished.
 *
 * Because this scans many files, it is opt-in. Run with:
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check stale-todos
 */

import {
  runTodoDetector,
  DEFAULT_TODO_SOURCE_DIRS,
} from "@saydeploy/architect/engines/code-quality/todo-detector-engine";

const RULES = {
  "stale-todo-migration": {
    severity: "warning",
    description:
      "TODO tagged with migration/refactor marker — incomplete architectural migration. Track in the migration ledger.",
  },
  "stale-todo-untagged": {
    severity: "info",
    description: "Untagged TODO in production code. Add a tag like TODO(scope): so it can be tracked.",
  },
  "stale-todo-fixme-hack": {
    severity: "warning",
    description: "FIXME or HACK marker in production code. These indicate known brokenness that should be resolved.",
  },
  "stale-todo-concentration": {
    severity: "warning",
    description: "File has 3+ TODOs — likely shipped before it was finished. Prioritize completing this file.",
  },
};

function buildReport(findings, result) {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;
  const lines = [
    `# Stale TODO Detection`,
    ``,
    `**Scanned:** ${result.total} TODOs across source directories`,
    ``,
    `Errors: ${errors}. Warnings: ${warnings}. Info: ${infos}.`,
    ``,
  ];
  if (findings.length === 0) {
    lines.push(`## No stale TODOs found — codebase is clean!`);
    return lines.join("\n");
  }
  const byRule = new Map();
  for (const f of findings) {
    const list = byRule.get(f.ruleId) || [];
    list.push(f);
    byRule.set(f.ruleId, list);
  }
  for (const [ruleId, items] of byRule) {
    const sev = items[0].severity;
    lines.push(`## ${ruleId} — ${items.length} (${sev})`);
    for (const item of items) {
      lines.push(`- ${item.message}`);
    }
    lines.push("");
  }
  lines.push(`## Summary`);
  lines.push(`- Tagged TODOs: ${result.taggedCount || Object.values(result.byTag).flat().length}`);
  lines.push(`- Untagged TODOs: ${result.untaggedCount || result.untagged.length}`);
  lines.push(`- FIXME/HACK: ${result.fixmeHackCount || result.fixmeHacks.length}`);
  return lines.join("\n");
}

export const audit = {
  id: "stale-todos",
  title: "Stale TODO Detection",
  category: "code-quality",
  defaultConfig: {
    includeInAll: false,
    sourceDirs: DEFAULT_TODO_SOURCE_DIRS,
    /** Only flag tagged migration TODOs (less noisy) */
    strictMode: false,
    outputPath: "tmp/audits/STALE_TODOS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const sourceDirs = cfg.sourceDirs || DEFAULT_TODO_SOURCE_DIRS;

    let result;
    try {
      result = await runTodoDetector({ root, sourceDirs });
    } catch (err) {
      return {
        findings: [
          {
            ruleId: "stale-todo-migration",
            severity: "error",
            message: `TODO detection failed: ${err.message}`,
            filePath: root,
          },
        ],
        filesScanned: 0,
      };
    }

    const findings = [];
    let filesScanned = 0;

    // Rule: Migration TODOs
    for (const [tag, todos] of Object.entries(result.byTag)) {
      const migrationTodos = todos.filter(
        (_t) =>
          tag.includes("migration") || tag.includes("shell") || tag.includes("billing") || tag.includes("httpOnly"),
      );
      if (migrationTodos.length > 0) {
        for (const todo of migrationTodos) {
          findings.push({
            ruleId: "stale-todo-migration",
            severity: RULES["stale-todo-migration"].severity,
            message: `TODO(${tag}): ${todo.message} — ${todo.filePath}:${todo.line}`,
            filePath: todo.filePath,
            line: todo.line,
          });
        }
        filesScanned++;
      }
    }

    // Rule: Untagged TODOs
    if (!cfg.strictMode) {
      for (const todo of result.untagged) {
        findings.push({
          ruleId: "stale-todo-untagged",
          severity: RULES["stale-todo-untagged"].severity,
          message: `${todo.type}: ${todo.message} — ${todo.filePath}:${todo.line}`,
          filePath: todo.filePath,
          line: todo.line,
        });
      }
    }

    // Rule: FIXME/HACK
    for (const todo of result.fixmeHacks) {
      findings.push({
        ruleId: "stale-todo-fixme-hack",
        severity: RULES["stale-todo-fixme-hack"].severity,
        message: `${todo.type}: ${todo.message} — ${todo.filePath}:${todo.line}`,
        filePath: todo.filePath,
        line: todo.line,
      });
    }

    // Rule: TODO concentration (3+ per file)
    const byFile = new Map();
    for (const todo of result.allTodos) {
      const list = byFile.get(todo.filePath) || [];
      list.push(todo);
      byFile.set(todo.filePath, list);
    }
    for (const [filePath, todos] of byFile) {
      if (todos.length >= 3) {
        findings.push({
          ruleId: "stale-todo-concentration",
          severity: RULES["stale-todo-concentration"].severity,
          message: `${filePath}: ${todos.length} TODOs — ${todos.map((t) => `L${t.line}:${t.message.slice(0, 40)}`).join("; ")}`,
          filePath,
        });
      }
    }

    return {
      findings,
      filesScanned,
      report: buildReport(findings, result),
      failed: findings.some((f) => f.severity === "error"),
      summary: {
        totalTodos: result.total,
        taggedCount: Object.values(result.byTag).flat().length,
        untaggedCount: result.untagged.length,
        fixmeHackCount: result.fixmeHacks.length,
      },
    };
  },
};
