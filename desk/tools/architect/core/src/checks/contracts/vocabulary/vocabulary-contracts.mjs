import fs from "node:fs/promises";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";
import { normalizePath, relativePath } from "@saydeploy/architect/core/path";

const ANALYTICS_CONTRACTS = [
  {
    id: "explore",
    label: "Explore analytics",
    frontendPath: "src/lib/vault-types.ts",
    frontendType: "ExploreAnalyticsAction",
    backendPath: "infra/lambda/src/_shared/analytics-validation.ts",
    backendConst: "DISCOVER_ANALYTICS_EVENTS",
  },
  {
    id: "hosted-event",
    label: "Hosted event analytics",
    frontendPath: "src/lib/vault-types.ts",
    frontendType: "HostedEventAnalyticsCaptureAction",
    backendPath: "infra/lambda/src/_shared/analytics-validation.ts",
    backendConst: "HOSTED_EVENT_ANALYTICS_EVENTS",
  },
  {
    id: "myconnect",
    label: "MyConnect analytics",
    frontendPath: "src/lib/vault-types.ts",
    frontendType: "MyLinkAnalyticsAction",
    backendPath: "infra/lambda/src/_shared/analytics-validation.ts",
    backendConst: "MYCONNECT_ANALYTICS_EVENTS",
  },
];

const RUNNYKNOWS_CONTRACTS = [
  {
    id: "levels",
    label: "Runnyknows levels",
    frontendPath: "src/lib/runnyknows/schema.ts",
    frontendType: "RunnyknowsLevel",
    backendPath: "infra/lambda/src/_shared/analytics-validation.ts",
    backendConst: "RUNNYKNOWS_LEVELS",
  },
  {
    id: "sources",
    label: "Runnyknows sources",
    frontendPath: "src/lib/runnyknows/schema.ts",
    frontendType: "RunnyknowsSource",
    backendPath: "infra/lambda/src/_shared/analytics-validation.ts",
    backendConst: "RUNNYKNOWS_SOURCES",
  },
];

const FIELD_CONTRACTS = [
  {
    id: "canonical-field-kinds",
    label: "Canonical field kinds",
    frontendPath: "src/lib/fields/canonical-field.ts",
    frontendConst: "CANONICAL_FIELD_KINDS",
    backendPath: "infra/lambda/src/_shared/canonical-fields.ts",
    backendConst: "CANONICAL_FIELD_KINDS",
  },
];

const VOCABULARY_AUDITS = [
  {
    id: "analytics-contracts",
    title: "Analytics Contracts",
    category: "product",
    outputPath: "tmp/audits/ANALYTICS_CONTRACTS_AUDIT.md",
    contracts: ANALYTICS_CONTRACTS,
    frontendExtractor: "union",
    valueNoun: "event",
    sourceMissingRuleId: "analytics-contract-source-missing",
    missingBackendRuleId: "analytics-event-missing-backend",
    missingFrontendRuleId: "analytics-event-missing-frontend",
    reportTitle: "Analytics Contracts Audit",
    description:
      "Checks that frontend analytics event types and backend analytics validation allowlists describe the same event vocabulary.",
    noFindingsText: "No analytics contract drift found.",
    tableLabels: { frontend: "Frontend events", backend: "Backend events" },
    payloadAliases: {
      frontendValues: "frontendEvents",
      backendValues: "backendEvents",
      missingBackendValues: "missingBackendEvents",
      missingFrontendValues: "missingFrontendEvents",
    },
  },
  {
    id: "runnyknows-contracts",
    title: "Runnyknows Contracts",
    category: "observability",
    outputPath: "tmp/audits/RUNNYKNOWS_CONTRACTS_AUDIT.md",
    contracts: RUNNYKNOWS_CONTRACTS,
    frontendExtractor: "union",
    valueNoun: "value",
    sourceMissingRuleId: "runnyknows-contract-source-missing",
    missingBackendRuleId: "runnyknows-vocabulary-missing-backend",
    missingFrontendRuleId: "runnyknows-vocabulary-missing-frontend",
    reportTitle: "Runnyknows Contracts Audit",
    description:
      "Checks that frontend runnyknows runtime vocabulary and backend capture validation describe the same levels and sources.",
    noFindingsText: "No runnyknows contract drift found.",
  },
  {
    id: "field-contracts",
    title: "Field Contracts",
    category: "product",
    outputPath: "tmp/audits/FIELD_CONTRACTS_AUDIT.md",
    contracts: FIELD_CONTRACTS,
    frontendExtractor: "const-array",
    valueNoun: "value",
    sourceMissingRuleId: "field-contract-source-missing",
    missingBackendRuleId: "field-kind-missing-backend",
    missingFrontendRuleId: "field-kind-missing-frontend",
    reportTitle: "Field Contracts Audit",
    description:
      "Checks that frontend canonical field vocabulary and Lambda canonical field validation describe the same field kinds.",
    noFindingsText: "No field contract drift found.",
  },
];

function lineNumberForIndex(source, index) {
  return index < 0 ? 0 : source.slice(0, index).split(/\r?\n/u).length;
}

function extractQuotedValues(text) {
  return [...text.matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]).filter(Boolean);
}

function extractVocabulary(source, exportName, kind) {
  const pattern =
    kind === "union"
      ? `export\\s+type\\s+${exportName}\\s*=([\\s\\S]*?);`
      : `export\\s+const\\s+${exportName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`;
  const match = source.match(new RegExp(pattern, "u"));
  if (!match || match.index === undefined) return null;
  return {
    values: [...new Set(extractQuotedValues(match[1] ?? ""))],
    line: lineNumberForIndex(source, match.index),
  };
}

function resolveExportSpecifier(filePath, specifier) {
  if (specifier.startsWith("@infra-shared/")) {
    return normalizePath(`infra/shared/${specifier.slice("@infra-shared/".length)}.ts`);
  }
  if (specifier.startsWith(".")) {
    return normalizePath(path.join(path.dirname(filePath), `${specifier}.ts`));
  }
  return "";
}

async function readReExportedVocabulary({ root, filePath, source, exportName, extractor }) {
  const reExportPattern = /export\s+(?:\*\s+|\{([^}]+)\}\s+)from\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(reExportPattern)) {
    const names = match[1] ?? "";
    const specifier = match[2] ?? "";
    if (names && !new RegExp(`(?:^|[,\\s])${exportName}(?:\\s+as\\s+\\w+)?(?:[,\\s]|$)`, "u").test(names)) {
      continue;
    }

    const resolvedPath = resolveExportSpecifier(filePath, specifier);
    if (!resolvedPath) continue;
    try {
      const resolvedSource = await fs.readFile(path.resolve(root, resolvedPath), "utf8");
      const vocabulary = extractVocabulary(resolvedSource, exportName, extractor);
      if (vocabulary) {
        return { filePath: resolvedPath, exportName, ...vocabulary, findings: [] };
      }
    } catch {
      // Keep scanning; the caller reports the original source/export failure.
    }
  }
  return null;
}

function exportNameFor(contract, side) {
  return side === "frontend" ? (contract.frontendType ?? contract.frontendConst) : contract.backendConst;
}

function extractorFor(contract, side, definition) {
  const configured = side === "frontend" ? contract.frontendExtractor : contract.backendExtractor;
  if (configured) return configured;
  if (side === "frontend") return definition.frontendExtractor ?? (contract.frontendType ? "union" : "const-array");
  return definition.backendExtractor ?? "const-array";
}

function sourceFinding({ definition, contract, filePath, exportName, kind, error }) {
  return createFinding({
    ruleId: definition.sourceMissingRuleId,
    severity: "error",
    filePath,
    line: 0,
    message: `${contract.label} ${kind} contract ${exportName} could not be read: ${error.message}`,
    metadata: { contractId: contract.id, exportName, kind },
  });
}

async function readVocabulary({ root, contract, side, definition }) {
  const filePath = normalizePath(side === "frontend" ? contract.frontendPath : contract.backendPath);
  const exportName = exportNameFor(contract, side);
  const extractor = extractorFor(contract, side, definition);

  try {
    const source = await fs.readFile(path.resolve(root, filePath), "utf8");
    const vocabulary = extractVocabulary(source, exportName, extractor);
    if (vocabulary) return { filePath, exportName, ...vocabulary, findings: [] };
    const reExported = await readReExportedVocabulary({ root, filePath, source, exportName, extractor });
    if (reExported) return reExported;
    const message =
      extractor === "union" ? "exported string union was not found" : "exported const string array was not found";
    return {
      filePath,
      exportName,
      values: [],
      line: 0,
      findings: [sourceFinding({ definition, contract, filePath, exportName, kind: side, error: new Error(message) })],
    };
  } catch (error) {
    return {
      filePath,
      exportName,
      values: [],
      line: 0,
      findings: [sourceFinding({ definition, contract, filePath, exportName, kind: side, error })],
    };
  }
}

function driftFinding({ ruleId, contract, value, filePath, line, message }) {
  return createFinding({
    ruleId,
    severity: "error",
    filePath,
    line,
    message,
    metadata: { contractId: contract.id, value },
  });
}

async function auditContract(root, contract, definition) {
  const [frontend, backend] = await Promise.all([
    readVocabulary({ root, contract, side: "frontend", definition }),
    readVocabulary({ root, contract, side: "backend", definition }),
  ]);
  const findings = [...frontend.findings, ...backend.findings];
  const result = {
    contract,
    frontendValues: frontend.values,
    backendValues: backend.values,
    missingBackendValues: [],
    missingFrontendValues: [],
    findings,
  };

  if (findings.length > 0) return result;

  const backendSet = new Set(backend.values);
  const frontendSet = new Set(frontend.values);
  result.missingBackendValues = frontend.values.filter((value) => !backendSet.has(value));
  result.missingFrontendValues = backend.values.filter((value) => !frontendSet.has(value));

  for (const value of result.missingBackendValues) {
    findings.push(
      driftFinding({
        ruleId: definition.missingBackendRuleId,
        contract,
        value,
        filePath: frontend.filePath,
        line: frontend.line,
        message: `${contract.label} ${definition.valueNoun} "${value}" exists in ${frontend.exportName} but is not accepted by ${backend.exportName}.`,
      }),
    );
  }

  for (const value of result.missingFrontendValues) {
    findings.push(
      driftFinding({
        ruleId: definition.missingFrontendRuleId,
        contract,
        value,
        filePath: backend.filePath,
        line: backend.line,
        message: `${contract.label} ${definition.valueNoun} "${value}" is accepted by ${backend.exportName} but is missing from ${frontend.exportName}.`,
      }),
    );
  }

  return result;
}

function renderReport(results, findings, definition) {
  const labels = { frontend: "Frontend values", backend: "Backend values", ...(definition.tableLabels ?? {}) };
  const lines = [`# ${definition.reportTitle}`, "", definition.description, ""];

  if (findings.length === 0) {
    lines.push(definition.noFindingsText, "");
  } else {
    lines.push("## Findings", "");
    for (const finding of findings) {
      const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.ruleId} at \`${location}\`: ${finding.message}`);
    }
    lines.push("");
  }

  lines.push("## Contracts", "");
  lines.push(`| Contract | ${labels.frontend} | ${labels.backend} | Missing backend | Missing frontend |`);
  lines.push("| --- | ---: | ---: | --- | --- |");
  for (const result of results) {
    lines.push(
      `| ${result.contract.label} | ${result.frontendValues.length} | ${result.backendValues.length} | ${
        result.missingBackendValues.join(", ") || "-"
      } | ${result.missingFrontendValues.join(", ") || "-"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function payloadFor(root, result, aliases) {
  const payload = {
    id: result.contract.id,
    label: result.contract.label,
    frontendPath: relativePath(root, path.resolve(root, result.contract.frontendPath)),
    backendPath: relativePath(root, path.resolve(root, result.contract.backendPath)),
    frontendValues: result.frontendValues,
    backendValues: result.backendValues,
    missingBackendValues: result.missingBackendValues,
    missingFrontendValues: result.missingFrontendValues,
  };
  for (const [sourceKey, aliasKey] of Object.entries(aliases ?? {})) payload[aliasKey] = payload[sourceKey];
  return payload;
}

async function runVocabularyContractsAudit(context = {}, definition) {
  const { root = process.cwd(), checkConfig = {}, config = {} } = context;
  const contracts = checkConfig.contracts?.length ? checkConfig.contracts : definition.contracts;
  const results = [];
  for (const contract of contracts) results.push(await auditContract(root, contract, definition));

  const findings = results.flatMap((result) => result.findings);
  const failed = findings.some((finding) => finding.severity === "error");
  return {
    failed,
    findings,
    outputPath: checkConfig.outputPath ?? config.checks?.[definition.id]?.outputPath,
    report: renderReport(results, findings, definition),
    jsonPayload: {
      failed,
      findings,
      contracts: results.map((result) => payloadFor(root, result, definition.payloadAliases)),
    },
  };
}

function defineVocabularyAudit(definition) {
  return {
    id: definition.id,
    title: definition.title,
    category: definition.category,
    requires: definition.requires ?? { projectNames: ["connections"] },
    defaultConfig: {
      includeInAll: true,
      outputPath: definition.outputPath,
      contracts: definition.contracts,
    },
    run(context) {
      return runVocabularyContractsAudit(context, definition);
    },
  };
}

export const [analyticsContractsAudit, runnyknowsContractsAudit, fieldContractsAudit] =
  VOCABULARY_AUDITS.map(defineVocabularyAudit);
