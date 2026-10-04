import fs from "node:fs/promises";
import path from "node:path";

import { ANTIPATTERNS, detectText } from "@saydeploy/architect/arkitect-core/rules/ui-antipatterns/index.mjs";
import { walkFiles } from "@saydeploy/architect/core/files";

const DEFAULT_EXTENSIONS = [".html", ".vue", ".tsx", ".jsx", ".svelte", ".astro", ".css", ".scss"];
const RULE_INDEX = new Map(ANTIPATTERNS.map((rule) => [rule.id, rule]));

export async function scanForUiAntipatterns({ root, roots, extensions, allowlist, skipSegments }) {
  const files = await walkFiles({
    root,
    roots,
    extensions: extensions ?? DEFAULT_EXTENSIONS,
    skipSegments,
  });

  const findingsByRule = new Map();
  const allFindings = [];
  let scannedFiles = 0;

  for (const file of files) {
    scannedFiles += 1;
    const absolutePath = path.resolve(root, file);
    let content;
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const fileFindings = detectText(content, file);

    for (const finding of fileFindings) {
      if (allowlistMatches(finding, allowlist)) {
        continue;
      }
      allFindings.push(finding);
      const bucket = findingsByRule.get(finding.antipattern) ?? [];
      bucket.push(finding);
      findingsByRule.set(finding.antipattern, bucket);
    }
  }

  return {
    scannedFiles,
    totalFiles: files.length,
    findings: allFindings,
    findingsByRule,
    ruleCatalog: ANTIPATTERNS,
  };
}

export function ruleFor(id) {
  return RULE_INDEX.get(id) ?? null;
}

function allowlistMatches(finding, allowlist) {
  if (!allowlist) {
    return false;
  }
  const ruleAllow = allowlist[finding.antipattern];
  if (!ruleAllow) {
    return false;
  }
  if (ruleAllow === "*" || ruleAllow === true) {
    return true;
  }
  if (Array.isArray(ruleAllow)) {
    return ruleAllow.some((pattern) => matchesPattern(finding.file, pattern));
  }
  if (typeof ruleAllow === "object" && Array.isArray(ruleAllow.files)) {
    return ruleAllow.files.some((pattern) => matchesPattern(finding.file, pattern));
  }
  return false;
}

function matchesPattern(filePath, pattern) {
  if (!pattern) {
    return false;
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*") +
        "$",
    );
    return regex.test(filePath);
  }
  return filePath === pattern || filePath.endsWith(pattern);
}
