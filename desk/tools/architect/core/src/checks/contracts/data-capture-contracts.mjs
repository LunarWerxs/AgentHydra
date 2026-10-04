import fs from "node:fs/promises";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";
import { normalizePath, relativePath } from "@saydeploy/architect/core/path";

const DEFAULT_CONTRACTS = [
  {
    id: "public-field-capture-settings",
    label: "Public field capture settings",
    frontendPath: "src/components/public/shared/fields/types.ts",
    frontendInterface: "PublicField",
    backendPath: "infra/lambda/src/_shared/canonical-fields.ts",
    backendInterface: "CanonicalFieldInput",
    frontendKeys: [
      "numberMin",
      "numberMax",
      "numberStep",
      "numberAllowDecimals",
      "dateMode",
      "dateMin",
      "dateMax",
      "ratingMax",
      "ratingStyle",
      "linearScaleMin",
      "linearScaleMax",
      "linearScaleStartLabel",
      "linearScaleEndLabel",
      "fileUploadMultiple",
      "fileUploadMaxFiles",
      "fileUploadMaxFileSizeMb",
      "fileUploadAllowedMimeTypes",
      "choiceAllowOther",
    ],
  },
  {
    id: "file-upload-value",
    label: "Canonical file upload value",
    frontendPath: "src/lib/fields/canonical-field.ts",
    frontendInterface: "CanonicalFileUploadValue",
    backendPath: "infra/lambda/src/_shared/canonical-fields.ts",
    backendInterface: "CanonicalFileUploadValue",
  },
];

const DEFAULT_STORAGE_CONTRACTS = [];

function lineNumberForIndex(source, index) {
  if (index < 0) return 0;
  return source.slice(0, index).split(/\r?\n/u).length;
}

function extractInterfaceKeys(source, interfaceName) {
  const match =
    source.match(
      new RegExp(`export\\s+interface\\s+${interfaceName}(?:\\s+extends\\s+[^\\{]+)?\\s*\\{([\\s\\S]*?)\\n\\}`, "u"),
    ) ??
    source.match(new RegExp(`export\\s+type\\s+${interfaceName}\\s*=\\s*[\\s\\S]*?\\{([\\s\\S]*?)\\n\\}\\s*;`, "u"));
  if (!match || match.index === undefined) {
    return null;
  }

  const body = match[1] ?? "";
  const values = [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\??\s*:/gmu)].map((entry) => entry[1]);
  return {
    values: [...new Set(values)],
    line: lineNumberForIndex(source, match.index),
  };
}

async function readSource(root, filePath) {
  return fs.readFile(path.resolve(root, filePath), "utf8");
}

function resolveExportSpecifier(filePath, specifier) {
  if (specifier.startsWith("@infra-shared/")) {
    return normalizePath(`infra/shared/${specifier.slice("@infra-shared/".length)}.ts`);
  }
  if (specifier.startsWith(".")) {
    const base = path.dirname(filePath);
    return normalizePath(path.join(base, `${specifier}.ts`));
  }
  return "";
}

async function readReExportedSource(root, filePath, source, exportName) {
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
      return {
        filePath: resolvedPath,
        source: await readSource(root, resolvedPath),
      };
    } catch {
      // Keep scanning; the caller will report the original missing export if no
      // re-export source can be read.
    }
  }
  return null;
}

function normalizeMarker(marker) {
  return typeof marker === "string" ? marker.trim() : "";
}

function lineNumberForMarker(source, marker) {
  const index = source.indexOf(marker);
  return index >= 0 ? lineNumberForIndex(source, index) : 0;
}

function sourceMissingFinding({ contract, filePath, interfaceName, kind, error }) {
  return createFinding({
    ruleId: "data-capture-contract-source-missing",
    severity: "error",
    filePath,
    line: 0,
    message: `${contract.label} ${kind} contract ${interfaceName} could not be read: ${error.message}`,
    metadata: {
      contractId: contract.id,
      interfaceName,
      kind,
    },
  });
}

async function auditContract(root, contract) {
  const findings = [];
  let frontendSource = "";
  let backendSource = "";

  try {
    frontendSource = await readSource(root, contract.frontendPath);
  } catch (error) {
    findings.push(
      sourceMissingFinding({
        contract,
        filePath: contract.frontendPath,
        interfaceName: contract.frontendInterface,
        kind: "frontend",
        error,
      }),
    );
  }

  try {
    backendSource = await readSource(root, contract.backendPath);
  } catch (error) {
    findings.push(
      sourceMissingFinding({
        contract,
        filePath: contract.backendPath,
        interfaceName: contract.backendInterface,
        kind: "backend",
        error,
      }),
    );
  }

  if (!frontendSource || !backendSource) {
    return {
      contract,
      frontendKeys: [],
      backendKeys: [],
      missingBackendKeys: [],
      missingFrontendKeys: [],
      findings,
    };
  }

  const frontend = extractInterfaceKeys(frontendSource, contract.frontendInterface);
  let backendFilePath = contract.backendPath;
  let backend = extractInterfaceKeys(backendSource, contract.backendInterface);
  if (!backend) {
    const reExport = await readReExportedSource(root, contract.backendPath, backendSource, contract.backendInterface);
    if (reExport) {
      backendFilePath = reExport.filePath;
      backendSource = reExport.source;
      backend = extractInterfaceKeys(backendSource, contract.backendInterface);
    }
  }

  if (!frontend) {
    findings.push(
      sourceMissingFinding({
        contract,
        filePath: contract.frontendPath,
        interfaceName: contract.frontendInterface,
        kind: "frontend",
        error: new Error("exported interface was not found"),
      }),
    );
  }

  if (!backend) {
    findings.push(
      sourceMissingFinding({
        contract,
        filePath: backendFilePath,
        interfaceName: contract.backendInterface,
        kind: "backend",
        error: new Error("exported interface was not found"),
      }),
    );
  }

  if (!frontend || !backend) {
    return {
      contract,
      frontendKeys: frontend?.values ?? [],
      backendKeys: backend?.values ?? [],
      missingBackendKeys: [],
      missingFrontendKeys: [],
      findings,
    };
  }

  const hasFocusedFrontendKeys = Array.isArray(contract.frontendKeys) && contract.frontendKeys.length > 0;
  const frontendKeys = hasFocusedFrontendKeys ? contract.frontendKeys : frontend.values;
  const backendSet = new Set(backend.values);
  const frontendSet = new Set(frontendKeys);
  const missingBackendKeys = frontendKeys.filter((value) => !backendSet.has(value));
  const missingFrontendKeys = hasFocusedFrontendKeys ? [] : backend.values.filter((value) => !frontendSet.has(value));

  for (const key of missingBackendKeys) {
    findings.push(
      createFinding({
        ruleId: "data-capture-key-missing-backend",
        severity: "error",
        filePath: contract.frontendPath,
        line: frontend.line,
        message: `${contract.label} key "${key}" is collected by ${contract.frontendInterface} but is missing from ${contract.backendInterface}.`,
        metadata: {
          contractId: contract.id,
          key,
          frontendInterface: contract.frontendInterface,
          backendInterface: contract.backendInterface,
        },
      }),
    );
  }

  for (const key of missingFrontendKeys) {
    findings.push(
      createFinding({
        ruleId: "data-capture-key-missing-frontend",
        severity: "error",
        filePath: backendFilePath,
        line: backend.line,
        message: `${contract.label} key "${key}" is accepted by ${contract.backendInterface} but is missing from ${contract.frontendInterface}.`,
        metadata: {
          contractId: contract.id,
          key,
          frontendInterface: contract.frontendInterface,
          backendInterface: contract.backendInterface,
        },
      }),
    );
  }

  return {
    contract,
    frontendKeys,
    backendKeys: backend.values,
    missingBackendKeys,
    missingFrontendKeys,
    findings,
  };
}

function storageSourceMissingFinding({ contract, role, filePath, error }) {
  return createFinding({
    ruleId: "data-capture-storage-source-missing",
    severity: "error",
    filePath,
    line: 0,
    message: `${contract.label} ${role} source could not be read: ${error.message}`,
    metadata: {
      contractId: contract.id,
      role,
    },
  });
}

function storageMarkerMissingFinding({ contract, role, filePath, marker }) {
  return createFinding({
    ruleId: "data-capture-storage-marker-missing",
    severity: "error",
    filePath,
    line: 0,
    message: `${contract.label} ${role} marker "${marker}" was not found.`,
    metadata: {
      contractId: contract.id,
      role,
      marker,
    },
  });
}

function storageRoleMissingFinding({ contract, ruleId, message }) {
  return createFinding({
    ruleId,
    severity: "error",
    filePath:
      contract.storagePath ||
      contract.capturePath ||
      "packages/connections-arkitect/src/checks/data-capture-contracts.mjs",
    line: 0,
    message,
    metadata: {
      contractId: contract.id,
    },
  });
}

function markerRole({ role, path: filePath, markers }) {
  return { role, path: filePath, markers };
}

async function auditStorageContract(root, contract) {
  const roles = [
    markerRole({ role: "capture", path: contract.capturePath, markers: contract.captureMarkers }),
    markerRole({ role: "storage", path: contract.storagePath, markers: contract.storageMarkers }),
    markerRole({ role: "read", path: contract.readPath, markers: contract.readMarkers }),
    markerRole({ role: "export", path: contract.exportPath, markers: contract.exportMarkers }),
    markerRole({ role: "admin", path: contract.adminPath, markers: contract.adminMarkers }),
    markerRole({ role: "report", path: contract.reportPath, markers: contract.reportMarkers }),
    markerRole({
      role: "privacy",
      path:
        contract.privacyPath || (contract.privacyMarkers?.length ? contract.storagePath || contract.capturePath : ""),
      markers: contract.privacyMarkers,
    }),
    markerRole({
      role: "ephemeral",
      path: contract.ephemeralPath || (contract.ephemeralMarkers?.length ? contract.capturePath : ""),
      markers: contract.ephemeralMarkers,
    }),
  ].filter((entry) => entry.path);
  const findings = [];
  const roleResults = [];

  const hasCaptureRole = Boolean(contract.capturePath);
  const hasStorageRole = Boolean(contract.storagePath);
  const hasEphemeralRole = Boolean(contract.ephemeralPath || contract.ephemeralMarkers?.length);
  const hasAccessRole = Boolean(contract.readPath || contract.exportPath || contract.adminPath || contract.reportPath);

  if (hasCaptureRole && !hasStorageRole && !hasEphemeralRole) {
    findings.push(
      storageRoleMissingFinding({
        contract,
        ruleId: "data-capture-storage-role-missing",
        message: `${contract.label} captures data but has no durable storage marker or explicit ephemeral marker.`,
      }),
    );
  }

  if (hasStorageRole && !hasAccessRole) {
    findings.push(
      storageRoleMissingFinding({
        contract,
        ruleId: "data-capture-access-role-missing",
        message: `${contract.label} stores data but has no read, export, admin, or report marker.`,
      }),
    );
  }

  if ((contract.sensitive === true || contract.sensitiveFields?.length) && !contract.privacyMarkers?.length) {
    findings.push(
      storageRoleMissingFinding({
        contract,
        ruleId: "data-capture-sensitive-privacy-missing",
        message: `${contract.label} is marked sensitive but has no privacy/redaction marker.`,
      }),
    );
  }

  for (const entry of roles) {
    const filePath = normalizePath(entry.path);
    const markers = (Array.isArray(entry.markers) ? entry.markers : []).map(normalizeMarker).filter(Boolean);
    let source = "";
    try {
      source = await readSource(root, filePath);
    } catch (error) {
      findings.push(storageSourceMissingFinding({ contract, role: entry.role, filePath, error }));
      roleResults.push({
        role: entry.role,
        filePath,
        markers,
        missingMarkers: markers,
      });
      continue;
    }

    const missingMarkers = markers.filter((marker) => !source.includes(marker));
    for (const marker of missingMarkers) {
      findings.push(storageMarkerMissingFinding({ contract, role: entry.role, filePath, marker }));
    }

    roleResults.push({
      role: entry.role,
      filePath,
      markers,
      missingMarkers,
      firstMarkerLine: markers.length ? lineNumberForMarker(source, markers[0]) : 0,
    });
  }

  return {
    contract,
    roles: roleResults,
    findings,
  };
}

function renderReport(results, storageResults, findings) {
  const lines = [
    "# Data Capture Contracts Audit",
    "",
    "Checks that frontend-collected data settings and value shapes are accepted by backend validation before they can be relied on for storage/export.",
    "",
  ];

  if (findings.length === 0) {
    lines.push("No data capture contract drift found.", "");
  } else {
    lines.push("## Findings", "");
    for (const finding of findings) {
      const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.ruleId} at \`${location}\`: ${finding.message}`);
    }
    lines.push("");
  }

  lines.push("## Contracts", "");
  lines.push("| Contract | Frontend keys | Backend keys | Missing backend | Missing frontend |");
  lines.push("| --- | ---: | ---: | --- | --- |");
  for (const result of results) {
    lines.push(
      `| ${result.contract.label} | ${result.frontendKeys.length} | ${result.backendKeys.length} | ${
        result.missingBackendKeys.join(", ") || "-"
      } | ${result.missingFrontendKeys.join(", ") || "-"} |`,
    );
  }
  lines.push("");

  if (storageResults.length > 0) {
    lines.push("## Storage Contracts", "");
    lines.push("| Contract | Capture | Storage | Access | Privacy | Missing markers |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const result of storageResults) {
      const capture = result.roles.find((role) => role.role === "capture");
      const storage = result.roles.find((role) => role.role === "storage");
      const access = result.roles
        .filter((role) => ["read", "export", "admin", "report"].includes(role.role))
        .map((role) => `${role.role}:${role.filePath}`)
        .join(", ");
      const privacy = result.roles.find((role) => role.role === "privacy");
      const missing = result.roles.flatMap((role) => role.missingMarkers.map((marker) => `${role.role}:${marker}`));
      lines.push(
        `| ${result.contract.label} | ${capture?.filePath ?? "-"} | ${storage?.filePath ?? "-"} | ${
          access || "-"
        } | ${privacy?.filePath ?? "-"} | ${missing.join(", ") || "-"} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function runDataCaptureContractsAudit({ root = process.cwd(), checkConfig = {}, config = {} } = {}) {
  const contracts = Array.isArray(checkConfig.contracts) ? checkConfig.contracts : DEFAULT_CONTRACTS;
  const storageContracts = Array.isArray(checkConfig.storageContracts)
    ? checkConfig.storageContracts
    : DEFAULT_STORAGE_CONTRACTS;
  const normalizedContracts = contracts.map((contract) => ({
    ...contract,
    frontendPath: normalizePath(contract.frontendPath),
    backendPath: normalizePath(contract.backendPath),
  }));
  const normalizedStorageContracts = storageContracts.map((contract) => ({
    ...contract,
    capturePath: contract.capturePath ? normalizePath(contract.capturePath) : "",
    storagePath: contract.storagePath ? normalizePath(contract.storagePath) : "",
    readPath: contract.readPath ? normalizePath(contract.readPath) : "",
    exportPath: contract.exportPath ? normalizePath(contract.exportPath) : "",
    adminPath: contract.adminPath ? normalizePath(contract.adminPath) : "",
    reportPath: contract.reportPath ? normalizePath(contract.reportPath) : "",
    privacyPath: contract.privacyPath ? normalizePath(contract.privacyPath) : "",
    ephemeralPath: contract.ephemeralPath ? normalizePath(contract.ephemeralPath) : "",
  }));

  const results = [];
  for (const contract of normalizedContracts) {
    results.push(await auditContract(root, contract));
  }
  const storageResults = [];
  for (const contract of normalizedStorageContracts) {
    storageResults.push(await auditStorageContract(root, contract));
  }

  const findings = [
    ...results.flatMap((result) => result.findings),
    ...storageResults.flatMap((result) => result.findings),
  ];
  const failed = findings.some((finding) => finding.severity === "error");
  const outputPath = checkConfig.outputPath ?? config.checks?.["data-capture-contracts"]?.outputPath;

  return {
    failed,
    findings,
    outputPath,
    report: renderReport(results, storageResults, findings),
    jsonPayload: {
      failed,
      findings,
      contracts: results.map((result) => ({
        id: result.contract.id,
        label: result.contract.label,
      frontendPath: relativePath(root, path.resolve(root, result.contract.frontendPath)),
        backendPath: relativePath(root, path.resolve(root, result.contract.backendPath)),
        frontendKeys: result.frontendKeys,
        backendKeys: result.backendKeys,
        missingBackendKeys: result.missingBackendKeys,
        missingFrontendKeys: result.missingFrontendKeys,
      })),
      storageContracts: storageResults.map((result) => ({
        id: result.contract.id,
        label: result.contract.label,
        roles: result.roles,
      })),
    },
  };
}

export const audit = {
  id: "data-capture-contracts",
  title: "Data Capture Contracts",
  category: "product",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    includeInAll: true,
    outputPath: "tmp/audits/DATA_CAPTURE_CONTRACTS_AUDIT.md",
    contracts: DEFAULT_CONTRACTS,
    storageContracts: DEFAULT_STORAGE_CONTRACTS,
  },
  async run(context) {
    return runDataCaptureContractsAudit(context);
  },
};
