export function createFinding({
  ruleId,
  severity = "warn",
  filePath = "",
  line = 0,
  column = 0,
  endLine = 0,
  message = "",
  snippet = "",
  metadata = {},
  sourceAnchor = null,
  confidence = undefined,
  resource = undefined,
  arn = undefined,
  account = undefined,
  region = undefined,
  location = undefined,
  why = undefined,
  fix = undefined,
  blastRadius = undefined,
  compliance = undefined,
  source = undefined,
  mapNodeId = undefined,
  exposure = undefined,
  dataAccess = undefined,
  noSafetyNet = undefined,
}) {
  const finding = {
    ruleId,
    severity,
    filePath,
    line,
    column,
    endLine,
    message,
    snippet,
    metadata,
  };
  for (const [key, value] of Object.entries({
    confidence,
    resource,
    arn,
    account,
    region,
    location,
    why,
    fix,
    blastRadius,
    compliance,
    source,
    mapNodeId,
    exposure,
    dataAccess,
    noSafetyNet,
  })) {
    if (value !== undefined) {
      finding[key] = value;
    }
  }
  if (sourceAnchor) {
    finding.sourceAnchor = sourceAnchor;
  }
  return finding;
}

export function countFindingsByRuleAndFile(findings) {
  const counts = {};
  for (const finding of findings) {
    counts[finding.ruleId] ??= {};
    counts[finding.ruleId][finding.filePath] = (counts[finding.ruleId][finding.filePath] ?? 0) + 1;
  }
  return counts;
}

const SEVERITY_FOR_OUTPUT = Object.freeze({
  critical: "error",
  high: "error",
  error: "error",
  err: "error",
  fatal: "error",
  medium: "warn",
  warning: "warn",
  warn: "warn",
  moderate: "warn",
  low: "info",
  note: "info",
  info: "info",
  informational: "info",
  hint: "info",
});

const RISK_SEVERITY_WEIGHT = Object.freeze({
  critical: 70,
  high: 50,
  medium: 30,
  low: 12,
  info: 4,
});

function canonicalSeverity(value) {
  const raw = String(value ?? "warn")
    .toLowerCase()
    .trim();
  return SEVERITY_FOR_OUTPUT[raw] ?? "warn";
}

function riskSeverity(value) {
  const raw = String(value ?? "warn")
    .toLowerCase()
    .trim();
  if (raw === "critical" || raw === "crit" || raw === "fatal" || raw === "blocker") return "critical";
  if (raw === "high" || raw === "error" || raw === "err") return "high";
  if (raw === "medium" || raw === "warning" || raw === "warn" || raw === "moderate") return "medium";
  if (raw === "low" || raw === "note" || raw === "minor") return "low";
  return "info";
}

function stableFindingId(parts) {
  const raw = parts
    .map((part) => String(part ?? ""))
    .filter(Boolean)
    .join("|");
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = (hash * 31 + raw.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeCompliance(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return [String(value)];
}

function normalizeLocation(finding) {
  const explicit = finding?.location;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    return {
      file: firstDefined(explicit.file, explicit.filePath, finding.filePath),
      line: Number(firstDefined(explicit.line, finding.line, 0)) || 0,
      column: Number(firstDefined(explicit.column, finding.column, 0)) || 0,
      label: firstDefined(explicit.label, explicit.path, explicit.resource, null),
    };
  }
  const file = firstDefined(finding?.filePath, explicit);
  const line = Number(finding?.line ?? 0) || 0;
  return {
    file,
    line,
    column: Number(finding?.column ?? 0) || 0,
    label: file ? (line > 0 ? `${file}:${line}` : file) : firstDefined(explicit, finding?.resource, null),
  };
}

function textForRisk(finding) {
  return [
    finding.ruleId,
    finding.message,
    finding.why,
    finding.fix,
    finding.resource,
    finding.arn,
    finding.mapNodeId,
    JSON.stringify(finding.metadata ?? {}),
  ]
    .join(" ")
    .toLowerCase();
}

function valueSignalsPublic(value) {
  if (value === true) return true;
  const text = String(value ?? "").toLowerCase();
  return /\b(public|internet|0\.0\.0\.0\/0|::\/0|unauth|anonymous|external)\b/.test(text);
}

function riskSignals(finding) {
  const metadata = finding.metadata && typeof finding.metadata === "object" ? finding.metadata : {};
  const text = textForRisk(finding);
  const exposure = firstDefined(finding.exposure, metadata.exposure, metadata.public, metadata.internetFacing);
  const dataAccess = firstDefined(finding.dataAccess, metadata.dataAccess, metadata.data, metadata.sensitiveData);
  const noSafetyNet = firstDefined(finding.noSafetyNet, metadata.noSafetyNet, metadata.missingSafetyNet);
  const blastRadius = firstDefined(finding.blastRadius, metadata.blastRadius, "");

  const publicExposure =
    valueSignalsPublic(exposure) ||
    valueSignalsPublic(blastRadius) ||
    /\b(public|internet|world-open|without auth|missing auth|anonymous|0\.0\.0\.0\/0|::\/0)\b/.test(text);
  const touchesData =
    dataAccess === true ||
    /\b(rds|aurora|database|db|secret|secretsmanager|kms|s3|bucket|dynamodb|exfiltration|backup|snapshot)\b/.test(text);
  const reachable =
    /\b(route|api gateway|apigateway|cloudfront|lambda url|url|webhook|public route|external principal)\b/.test(text);
  const lacksSafetyNet =
    noSafetyNet === true ||
    /\b(no dlq|missing dlq|without dlq|no alarm|missing alarm|without alarm|missing waf|no waf|retry|redrive)\b/.test(
      text,
    );

  return { publicExposure, touchesData, reachable, lacksSafetyNet };
}

export function scoreNormalizedFinding(finding) {
  const signals = riskSignals(finding);
  const confidence = normalizeConfidence(finding.confidence);
  const severity = riskSeverity(finding.severity);
  const factors = {
    severityWeight: RISK_SEVERITY_WEIGHT[severity] ?? RISK_SEVERITY_WEIGHT.medium,
    exposureWeight: signals.publicExposure ? 20 : 0,
    dataWeight: signals.touchesData ? 15 : 0,
    reachabilityWeight: signals.reachable ? 10 : 0,
    noSafetyNetWeight: signals.lacksSafetyNet ? 10 : 0,
    confidencePenalty: Math.round((100 - confidence) / 5),
  };
  const raw =
    factors.severityWeight +
    factors.exposureWeight +
    factors.dataWeight +
    factors.reachabilityWeight +
    factors.noSafetyNetWeight -
    factors.confidencePenalty;
  return {
    score: Math.max(0, Math.min(100, raw)),
    severity,
    factors,
  };
}

export function normalizeFinding(finding, { check = {}, index = 0 } = {}) {
  const metadata = finding?.metadata && typeof finding.metadata === "object" ? finding.metadata : {};
  const location = normalizeLocation(finding ?? {});
  const ruleId = firstDefined(finding?.ruleId, check.id, "unknown");
  const resource = firstDefined(finding?.resource, metadata.resource, finding?.arn, finding?.mapNodeId, location.label);
  const confidence = normalizeConfidence(firstDefined(finding?.confidence, metadata.confidence));
  const normalized = {
    id:
      finding?.id ??
      `${check.id ?? "check"}:${ruleId}:${stableFindingId([
        ruleId,
        resource,
        location.label,
        finding?.message,
        index,
      ])}`,
    check: check.id ?? null,
    ruleId,
    severity: canonicalSeverity(finding?.severity),
    confidence,
    resource,
    arn: firstDefined(finding?.arn, metadata.arn),
    account: firstDefined(finding?.account, metadata.account, metadata.accountId),
    region: firstDefined(finding?.region, metadata.region),
    location,
    message: firstDefined(finding?.message, ""),
    why: firstDefined(finding?.why, metadata.why),
    fix: firstDefined(finding?.fix, metadata.fix, metadata.remediation),
    blastRadius: firstDefined(finding?.blastRadius, metadata.blastRadius),
    compliance: normalizeCompliance(firstDefined(finding?.compliance, metadata.compliance)),
    source: firstDefined(finding?.source, metadata.source) ?? {
      checkId: check.id ?? null,
      checkTitle: check.title ?? null,
      category: check.category ?? null,
    },
    mapNodeId: firstDefined(finding?.mapNodeId, metadata.mapNodeId),
    sourceAnchor: finding?.sourceAnchor ?? null,
    gating: check.gatesUnderStrict !== false,
  };
  const risk = scoreNormalizedFinding(normalized);
  return {
    ...normalized,
    riskScore: risk.score,
    threatScore: risk.score,
    risk,
  };
}

export function normalizeFindings(checkResults = []) {
  const out = [];
  for (const result of checkResults) {
    const findings = Array.isArray(result?.findings) ? result.findings : [];
    for (let index = 0; index < findings.length; index += 1) {
      out.push(normalizeFinding(findings[index], { check: result, index }));
    }
  }
  out.sort((a, b) => b.riskScore - a.riskScore || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));
  return out;
}

function summarizeBy(findings, key) {
  const counts = {};
  for (const finding of findings) {
    const value = finding[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function matchesAny(finding, patterns) {
  const haystack = [finding.ruleId, finding.message, finding.resource, finding.mapNodeId, finding.source?.checkId]
    .join(" ")
    .toLowerCase();
  return patterns.some((pattern) => pattern.test(haystack));
}

function matchesAllGroups(finding, patternGroups) {
  return patternGroups.every((patterns) => matchesAny(finding, patterns));
}

function briefFinding(finding, index) {
  return {
    rank: index + 1,
    id: finding.id,
    ruleId: finding.ruleId,
    severity: finding.severity,
    riskScore: finding.riskScore,
    resource: finding.resource,
    arn: finding.arn,
    account: finding.account,
    region: finding.region,
    location: finding.location,
    message: finding.message,
    why: finding.why,
    fix: finding.fix,
    blastRadius: finding.blastRadius,
    compliance: finding.compliance,
    source: finding.source,
    mapNodeId: finding.mapNodeId,
    sourceAnchor: finding.sourceAnchor,
  };
}

function topMatching(findings, patterns, limit = 10) {
  return findings
    .filter((finding) => matchesAny(finding, patterns))
    .slice(0, limit)
    .map(briefFinding);
}

function topMatchingGroups(findings, patternGroups, limit = 10) {
  return findings
    .filter((finding) => matchesAllGroups(finding, patternGroups))
    .slice(0, limit)
    .map(briefFinding);
}

export function buildDecisionBrief({ findings = [], manifest = {}, toolName = "arkitect" } = {}) {
  const sorted = [...findings].sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id));
  const nextActions = sorted.slice(0, 20).map((finding, index) => ({
    rank: index + 1,
    findingId: finding.id,
    ruleId: finding.ruleId,
    riskScore: finding.riskScore,
    action: finding.fix || finding.message,
    resource: finding.resource,
    source: finding.source,
  }));

  return {
    generatedAt: manifest.generatedAt ?? new Date().toISOString(),
    tool: toolName,
    mode: manifest.mode ?? "unknown",
    nextAction: manifest.pass?.nextAction ?? "unknown",
    severityRollup: summarizeBy(sorted, "severity"),
    riskRollup: {
      critical: sorted.filter((finding) => finding.riskScore >= 80).length,
      high: sorted.filter((finding) => finding.riskScore >= 60 && finding.riskScore < 80).length,
      medium: sorted.filter((finding) => finding.riskScore >= 30 && finding.riskScore < 60).length,
      low: sorted.filter((finding) => finding.riskScore < 30).length,
    },
    totals: {
      findings: sorted.length,
      errors: sorted.filter((finding) => finding.severity === "error").length,
      warnings: sorted.filter((finding) => finding.severity === "warn").length,
      info: sorted.filter((finding) => finding.severity === "info").length,
      byCheck: sorted.reduce((acc, finding) => {
        const checkId = finding.source?.checkId ?? "unknown";
        acc[checkId] ??= { errors: 0, warnings: 0, info: 0 };
        if (finding.severity === "error") acc[checkId].errors += 1;
        else if (finding.severity === "warn") acc[checkId].warnings += 1;
        else acc[checkId].info += 1;
        return acc;
      }, {}),
    },
    topRiskPaths: topMatching(sorted, [
      /\battack\b/,
      /\bpath\b/,
      /\bpublic\b/,
      /\binternet\b/,
      /\broute\b/,
      /\blambda url\b/,
      /\bmissing auth\b/,
    ]),
    topStaleResources: topMatching(sorted, [/\bstale\b/, /\borphan\b/, /\bunused\b/, /\bunreferenced\b/, /\bstray\b/]),
    topOverbroadIamGrants: topMatchingGroups(sorted, [
      [/\biam\b/, /\bpolicy\b/, /\bpermission\b/, /\bpermissions\b/, /\brole\b/, /\bprincipal\b/],
      [/\bwildcard\b/, /\bprivilege\b/, /\bassumable\b/, /\bcross-account\b/, /\badmin\b/, /\b\*:\*\b/],
    ]),
    costHotSpots: topMatching(sorted, [
      /\bcost\b/,
      /\bwaste\b/,
      /\bmemory\b/,
      /\bnat\b/,
      /\bretention\b/,
      /\boverprovision/,
    ]),
    ranked: sorted.slice(0, 50).map(briefFinding),
    nextActions,
  };
}
