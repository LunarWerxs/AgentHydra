import { createFinding } from "@saydeploy/architect/core/finding";

const DEFAULT_ROUTES = [
  { id: "home", label: "Home", path: "/", expectedStatuses: [200] },
  { id: "explore", label: "Explore", path: "/explore", expectedStatuses: [200] },
  { id: "pricing", label: "Pricing", path: "/pricing", expectedStatuses: [200] },
  { id: "account-billing", label: "Account billing", path: "/account/billing", expectedStatuses: [200] },
];

const DEFAULT_ENDPOINTS = [
  {
    id: "billing-entitlement",
    label: "Billing entitlement endpoint",
    path: "/functions/billing-api/entitlement",
    method: "POST",
    expectedStatuses: [200, 401, 403],
    body: {},
  },
];

function hasLiveFlag(checkArgs) {
  return checkArgs.includes("--live");
}

function normalizeBaseUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/u, "");
}

function resolveBaseUrl(checkConfig) {
  const envName = String(checkConfig.baseUrlEnv || "ARKITECT_LIVE_BASE_URL");
  return normalizeBaseUrl(checkConfig.baseUrl || process.env[envName] || process.env.ARKITECT_LIVE_BASE_URL);
}

function timestampForFileName(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, "-");
}

function explicitModeFinding() {
  return createFinding({
    ruleId: "arkitect-live-smoke-not-explicit",
    severity: "error",
    filePath: "packages/connections-arkitect/src/checks/arkitect-live-smoke.mjs",
    line: 0,
    message: "Arkitect live smoke must be run explicitly with --live.",
  });
}

function missingConfigFinding(envName) {
  return createFinding({
    ruleId: "arkitect-live-smoke-missing-config",
    severity: "error",
    filePath: "packages/connections-arkitect/policies/connections/connections.audit.config.json",
    line: 0,
    message: `Arkitect live smoke needs a deployed base URL. Set ${envName} or configure checks.arkitect-live-smoke.baseUrl.`,
    metadata: { envName },
  });
}

function missingEnvFinding(envName) {
  return createFinding({
    ruleId: "arkitect-live-smoke-missing-env",
    severity: "error",
    filePath: "packages/connections-arkitect/policies/connections/connections.audit.config.json",
    line: 0,
    message: `Arkitect live smoke requires environment variable ${envName}.`,
    metadata: { envName },
  });
}

function statusFinding(target, actualStatus, expectedStatuses) {
  return createFinding({
    ruleId: "arkitect-live-smoke-status",
    severity: "error",
    filePath: "packages/connections-arkitect/policies/connections/connections.audit.config.json",
    line: 0,
    message: `${target.label || target.id} returned HTTP ${actualStatus}; expected one of ${expectedStatuses.join(", ")}.`,
    metadata: { targetId: target.id, actualStatus, expectedStatuses },
  });
}

function bodyFinding(target, marker) {
  return createFinding({
    ruleId: "arkitect-live-smoke-body",
    severity: "error",
    filePath: "packages/connections-arkitect/policies/connections/connections.audit.config.json",
    line: 0,
    message: `${target.label || target.id} response did not include expected marker "${marker}".`,
    metadata: { targetId: target.id, marker },
  });
}

function requestFinding(target, error) {
  return createFinding({
    ruleId: "arkitect-live-smoke-request-failed",
    severity: "error",
    filePath: "packages/connections-arkitect/policies/connections/connections.audit.config.json",
    line: 0,
    message: `${target.label || target.id} request failed: ${error.message}`,
    metadata: { targetId: target.id },
  });
}

function configuredTargets(checkConfig) {
  const routes = Array.isArray(checkConfig.routes) ? checkConfig.routes : DEFAULT_ROUTES;
  const endpoints = Array.isArray(checkConfig.endpoints) ? checkConfig.endpoints : DEFAULT_ENDPOINTS;
  return [
    ...routes.map((target) => ({ method: "GET", kind: "route", ...target })),
    ...endpoints.map((target) => ({ method: "GET", kind: "endpoint", ...target })),
  ];
}

function targetUrl(baseUrl, target) {
  const path = String(target.path || "/");
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function fixtureResponse(checkConfig, target) {
  const responses = checkConfig.fixtureResponses ?? {};
  return target.fixture ?? responses[target.id] ?? responses[target.path] ?? null;
}

async function fetchTarget(baseUrl, target, checkConfig) {
  if (checkConfig.mode === "fixture") {
    const fixture = fixtureResponse(checkConfig, target) ?? {};
    return {
      status: Number(fixture.status ?? 200),
      body: String(fixture.body ?? ""),
      url: targetUrl(baseUrl, target),
    };
  }

  const controller = new AbortController();
  const timeoutMs = Number(checkConfig.timeoutMs ?? 10000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = String(target.method || "GET").toUpperCase();
    const response = await fetch(targetUrl(baseUrl, target), {
      method,
      headers:
        method === "POST"
          ? {
              "content-type": "application/json",
            }
          : undefined,
      body: method === "POST" ? JSON.stringify(target.body ?? {}) : undefined,
      signal: controller.signal,
    });
    return {
      status: response.status,
      body: await response.text(),
      url: response.url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function auditTarget(baseUrl, target, checkConfig) {
  const expectedStatuses = Array.isArray(target.expectedStatuses)
    ? target.expectedStatuses.map(Number)
    : [Number(target.expectedStatus ?? 200)];
  try {
    const response = await fetchTarget(baseUrl, target, checkConfig);
    const findings = [];
    if (!expectedStatuses.includes(response.status)) {
      findings.push(statusFinding(target, response.status, expectedStatuses));
    }
    for (const marker of Array.isArray(target.bodyIncludes) ? target.bodyIncludes : []) {
      if (!response.body.includes(marker)) {
        findings.push(bodyFinding(target, marker));
      }
    }
    return {
      id: target.id,
      label: target.label || target.id,
      kind: target.kind,
      method: target.method || "GET",
      path: target.path,
      url: response.url,
      status: response.status,
      findings,
    };
  } catch (error) {
    return {
      id: target.id,
      label: target.label || target.id,
      kind: target.kind,
      method: target.method || "GET",
      path: target.path,
      url: targetUrl(baseUrl, target),
      status: 0,
      findings: [requestFinding(target, error)],
    };
  }
}

function renderReport({ baseUrl, results, findings, explicit, unavailableReason }) {
  const lines = [
    "# Arkitect Live Smoke",
    "",
    "Explicit deployed-state smoke check for routes and endpoint reachability. This is intentionally outside the default local Arkitect gate.",
    "",
  ];

  if (!explicit) {
    lines.push("Live smoke was not explicit. Re-run with `bun run audit:arkitect:live`.", "");
  }

  if (unavailableReason) {
    lines.push(unavailableReason, "");
  } else {
    lines.push(`Base URL: \`${baseUrl}\``, "");
  }

  if (findings.length === 0) {
    lines.push("No live smoke drift found.", "");
  } else {
    lines.push("## Findings", "");
    for (const finding of findings) {
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.ruleId}: ${finding.message}`);
    }
    lines.push("");
  }

  if (results.length > 0) {
    lines.push("## Smoke Targets", "");
    lines.push("| Target | Kind | Method | Path | Status |");
    lines.push("| --- | --- | --- | --- | ---: |");
    for (const result of results) {
      lines.push(`| ${result.label} | ${result.kind} | ${result.method} | ${result.path} | ${result.status} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function runArchitectLiveSmokeAudit({ checkArgs = [], checkConfig = {} } = {}) {
  const explicit =
    hasLiveFlag(checkArgs) || checkConfig.mode === "fixture" || checkConfig.allowWithoutLiveFlag === true;
  const findings = [];
  if (!explicit) {
    findings.push(explicitModeFinding());
  }

  const requiredEnv = Array.isArray(checkConfig.requiredEnv) ? checkConfig.requiredEnv : [];
  for (const envName of requiredEnv) {
    if (!process.env[envName]) {
      findings.push(missingEnvFinding(envName));
    }
  }

  const envName = String(checkConfig.baseUrlEnv || "ARKITECT_LIVE_BASE_URL");
  const baseUrl = resolveBaseUrl(checkConfig);
  if (!baseUrl) {
    findings.push(missingConfigFinding(envName));
  }

  const canRunTargets = explicit && baseUrl && findings.length === 0;
  const results = canRunTargets
    ? await Promise.all(configuredTargets(checkConfig).map((target) => auditTarget(baseUrl, target, checkConfig)))
    : [];
  findings.push(...results.flatMap((result) => result.findings));

  const failed = findings.some((finding) => finding.severity === "error");
  const unavailableReason = baseUrl ? "" : `Missing deployed base URL. Set ${envName} before running live smoke.`;
  const outputPath =
    checkConfig.outputPath ||
    `tmp/audits/ARKITECT_LIVE_SMOKE_${timestampForFileName(checkConfig.now ? new Date(checkConfig.now) : new Date())}.md`;

  return {
    failed,
    findings,
    outputPath,
    report: renderReport({ baseUrl, results, findings, explicit, unavailableReason }),
    jsonPayload: {
      failed,
      findings,
      baseUrl,
      results,
      explicit,
    },
  };
}

export const audit = {
  id: "arkitect-live-smoke",
  title: "Arkitect Live Smoke",
  category: "product",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    enabled: true,
    includeInAll: false,
    outputPath: "",
    baseUrlEnv: "ARKITECT_LIVE_BASE_URL",
    timeoutMs: 10000,
    routes: DEFAULT_ROUTES,
    endpoints: DEFAULT_ENDPOINTS,
  },
  async run(context) {
    return runArchitectLiveSmokeAudit(context);
  },
};
