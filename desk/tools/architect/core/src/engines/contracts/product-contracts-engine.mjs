import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { UI_PACKAGE_COMPONENTS_ROOT } from "@saydeploy/architect/core/primitive-locations";

const DEFAULT_SOURCE_EXTENSIONS = Object.freeze([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".vue",
  ".json",
  ".yml",
  ".yaml",
  ".html",
  ".sql",
  ".txt",
]);
const DEFAULT_SCAN_ROOTS = Object.freeze(["src", "infra/aws/lib", "infra/lambda/src", "public", "config", ".github"]);
const DEFAULT_SKIP_SEGMENTS = Object.freeze([".git", "cdk.out", "coverage", "dist", "node_modules", "tmp"]);

let ROOT = process.cwd();
let SOURCE_EXTENSIONS = new Set(DEFAULT_SOURCE_EXTENSIONS);
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];
let SKIP_SEGMENTS = new Set(DEFAULT_SKIP_SEGMENTS);

const RULES = {
  "explore-route-contract": {
    severity: "error",
    description: "Explore is the canonical public discovery route and /discover redirects to it.",
  },
  "reserved-events-route-contract": {
    severity: "error",
    description: "/events stays reserved for workspace event workflows.",
  },
  "llms-acquisition-surface": {
    severity: "error",
    description: "llms.txt exposes only deliberate acquisition surfaces.",
  },
  "platform-split-no-relay": {
    severity: "error",
    description: "Obsolete Relay/second-product references must not return to shipped source.",
  },
  "retired-artifact-prune-contract": {
    severity: "error",
    description: "Deleted one-off OAuth repair and Cloudflare worker artifacts must stay deleted.",
  },
  "canonical-shared-helper-contract": {
    severity: "error",
    description: "Repeated Lambda/app text, HTML, and hosted-event URL helpers stay centralized.",
  },
  "verified-identity-contract": {
    severity: "error",
    description: "Verified RSVP identity linking keeps profile contact methods and admin drift signals wired.",
  },
  "hosted-event-url-builder-contract": {
    severity: "error",
    description: "Hosted-event public URLs are built through the canonical Lambda helper.",
  },
  "app-table-inline-detail-contract": {
    severity: "error",
    description: "AppTable keeps its reusable inline row-detail contract covered by unit tests.",
  },
  "myconnect-email-signature-contract": {
    severity: "error",
    description: "MyConnect email signatures keep reliability warnings and multiple compact templates.",
  },
  "host-calendar-refactor-contract": {
    severity: "error",
    description:
      "Recurring-series management stays out of the main host editor tab list and host calendar routes stay wired.",
  },
  "hosted-event-public-experience-contract": {
    severity: "error",
    description:
      "Hosted-event public registration keeps celebration, wallet, calendar, and social-proof affordances wired.",
  },
  "deleted-shared-primitive-contract": {
    severity: "error",
    description: "Collapsed shared primitive wrapper components must stay deleted.",
  },
  "public-field-required-contract": {
    severity: "error",
    description: "Public field primitives and hosted-event registration renderers preserve required indicators.",
  },
  "shared-primitives-live-split-contract": {
    severity: "error",
    description: "The shared primitives live harness keeps heavyweight preview sections split out.",
  },
  "runtime-audit-entrypoint-contract": {
    severity: "error",
    description: "Runtime mobile, memory, and perf audit entrypoints remain runnable from package scripts.",
  },
  "system-audit-suite-contract": {
    severity: "error",
    description: "The portable Arkitect registry keeps static checks complete and environment diagnostics separate.",
  },
  "m3-foundation-tokens-contract": {
    severity: "error",
    description:
      "M3 foundation tokens (elevation levels 0-5, typescale roles, motion durations and easings) must stay declared in the central token file so downstream consumers keep a stable spec-aligned vocabulary.",
  },
  "mobile-sheet-contract": {
    severity: "error",
    description:
      "UnifiedMobileSheet keeps its shared detent/spring contract, full-screen close affordance, and wrapper imports centralized.",
  },
  "workspace-route-startup-contract": {
    severity: "error",
    description:
      "Workspace route switchboards keep inactive heavy views lazy-loaded, and async data views show loading state instead of empty-state flashes.",
  },
  "workspace-surface-counts-contract": {
    severity: "error",
    description:
      "Workspace shell sidebar counts use the shared workspaceSurfaceCounts fast-count lane instead of rendered row arrays.",
  },
};

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function relativePath(filePath) {
  return normalizePath(path.relative(ROOT, filePath));
}

async function readText(relativeFilePath) {
  return readFile(path.join(ROOT, relativeFilePath), "utf8");
}

function firstExistingPath(relativeFilePaths) {
  return relativeFilePaths.find((relativeFilePath) => existsSync(path.join(ROOT, relativeFilePath))) ?? "";
}

async function readCombinedText(relativeFilePaths) {
  const sources = await Promise.all(relativeFilePaths.map((relativeFilePath) => readText(relativeFilePath)));
  return sources.join("\n");
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

function cleanSnippet(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function addFinding(findings, ruleId, filePath, line, message, snippet = "") {
  findings.push({
    ruleId,
    severity: RULES[ruleId].severity,
    filePath,
    line,
    message,
    snippet: cleanSnippet(snippet),
  });
}

function assertPattern(findings, ruleId, filePath, source, pattern, message) {
  if (pattern.test(source)) {
    return;
  }

  addFinding(findings, ruleId, filePath, 1, message);
}

function assertPatternCount(findings, ruleId, filePath, source, pattern, minimumCount, message) {
  const matches = source.match(pattern) ?? [];
  if (matches.length >= minimumCount) {
    return;
  }

  addFinding(findings, ruleId, filePath, 1, message, `Found ${matches.length}; expected ${minimumCount}.`);
}

function assertNoPattern(findings, ruleId, filePath, source, pattern, message) {
  const match = source.match(pattern);
  if (!match) {
    return;
  }

  addFinding(findings, ruleId, filePath, lineNumberAt(source, match.index ?? 0), message, match[0]);
}

async function walk(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
      continue;
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

async function collectScanFiles() {
  const files = [];

  for (const root of SCAN_ROOTS) {
    const fullPath = path.join(ROOT, root);
    if (existsSync(fullPath) && (await stat(fullPath)).isDirectory()) {
      files.push(...(await walk(fullPath)));
    }
  }

  const packageJson = path.join(ROOT, "package.json");
  if (existsSync(packageJson)) {
    files.push(packageJson);
  }

  return files.sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
}

async function auditExploreRoute(findings) {
  const filePath = "src/products/routes.ts";
  const source = await readText(filePath);

  assertPattern(
    findings,
    "explore-route-contract",
    filePath,
    source,
    /path:\s*["']\/explore["'][\s\S]*?name:\s*ROUTE_NAMES\.explore[\s\S]*?ExplorePage\.vue/,
    "Expected /explore to be the canonical public discovery route.",
  );
  assertPattern(
    findings,
    "explore-route-contract",
    filePath,
    source,
    /path:\s*["']\/discover["'][\s\S]*?redirect:\s*\(route\)\s*=>\s*\(\{[\s\S]*?path:\s*["']\/explore["'][\s\S]*?query:\s*route\.query[\s\S]*?hash:\s*route\.hash/,
    "Expected /discover to redirect to /explore while preserving query and hash.",
  );
}

async function auditReservedEventsRoute(findings) {
  const filePath = "src/products/workspace-registry.ts";
  const source = await readText(filePath);

  assertPattern(
    findings,
    "reserved-events-route-contract",
    filePath,
    source,
    /events:\s*["']\/events["']/,
    "Expected WORKSPACE_ROUTE_PATHS.events to reserve /events for workspace event workflows.",
  );
  assertPattern(
    findings,
    "reserved-events-route-contract",
    filePath,
    source,
    /event_schedule:\s*\{[\s\S]*?routeKey:\s*["']events["']/,
    "Expected the event schedule workspace view to keep using the reserved events route key.",
  );
}

async function auditLlmsSurface(findings) {
  const filePath = "public/llms.txt";
  const source = await readText(filePath);

  assertPattern(
    findings,
    "llms-acquisition-surface",
    filePath,
    source,
    /^\/mc\/\[handle\]\s*=/m,
    "Expected llms.txt to include the public MyConnect handle route.",
  );
  assertPattern(
    findings,
    "llms-acquisition-surface",
    filePath,
    source,
    /^\/e\/\[slug\]\s*=/m,
    "Expected llms.txt to include hosted event public pages.",
  );

  const blocked = source.match(/^\/calendar\/\[handle\]\s*=|^\/calendar\/host\/\[handle\]\s*=/m);
  if (blocked) {
    addFinding(
      findings,
      "llms-acquisition-surface",
      filePath,
      lineNumberAt(source, blocked.index ?? 0),
      "Calendar handle pages should stay out of llms.txt until they are deliberate acquisition surfaces.",
      blocked[0],
    );
  }
}

async function auditNoRelayReferences(findings) {
  const files = await collectScanFiles();
  const forbiddenPattern = /\bRelay\b|second-product|second_product/g;

  for (const file of files) {
    const rel = relativePath(file);
    const source = await readFile(file, "utf8");
    forbiddenPattern.lastIndex = 0;
    for (const match of source.matchAll(forbiddenPattern)) {
      addFinding(
        findings,
        "platform-split-no-relay",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Obsolete Relay/second-product reference found in shipped source.",
        match[0],
      );
    }
  }
}

async function auditRetiredArtifacts(findings) {
  const retiredPaths = [
    "infra/accap-integration/fix-accap-oauth.js",
    "infra/accap-integration/fix-accap-oauth.mjs",
    "public/_worker.js",
    "infra/cloudflare/wrangler.jsonc",
    "src/components/public/MyConnectWorker.test-worker.ts",
  ];

  for (const retiredPath of retiredPaths) {
    if (existsSync(path.join(ROOT, retiredPath))) {
      addFinding(findings, "retired-artifact-prune-contract", retiredPath, 1, "Retired one-off artifact has returned.");
    }
  }

  const files = await collectScanFiles();
  const forbiddenPattern = /fix-accap-oauth|public\/_worker\.js|wrangler\.jsonc|MyConnectWorker\.test-worker/g;
  for (const file of files) {
    const rel = relativePath(file);
    const source = await readFile(file, "utf8");
    forbiddenPattern.lastIndex = 0;
    for (const match of source.matchAll(forbiddenPattern)) {
      addFinding(
        findings,
        "retired-artifact-prune-contract",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Retired artifact reference found in shipped source.",
        match[0],
      );
    }
  }
}

async function auditCanonicalSharedHelpers(findings) {
  const helperContracts = [
    [
      "infra/shared/text/normalize.ts",
      /export function normalizeText/,
      "Expected canonical text normalization helper.",
    ],
    ["infra/shared/text/escape.ts", /export function escapeHtml/, "Expected canonical HTML escaping helper."],
    [
      "infra/lambda/src/_shared/html.ts",
      /export \* from ['"]@infra-shared\/text\/escape['"]/,
      "Expected Lambda HTML escaping helper to re-export the canonical implementation.",
    ],
    [
      "src/lib/text/text-utils.ts",
      /from ['"]@infra-shared\/text\/normalize['"]/,
      "Expected app text normalization helper to re-export the canonical implementation.",
    ],
    [
      "src/lib/text/escape.ts",
      /export \* from ['"]@infra-shared\/text\/escape['"]/,
      "Expected app HTML escaping helper to re-export the canonical implementation.",
    ],
    [
      "infra/lambda/src/_shared/positive-integer.ts",
      /normalizePositiveIntegerWithFallback/,
      "Expected Lambda positive integer helper.",
    ],
  ];

  for (const [filePath, pattern, message] of helperContracts) {
    if (!existsSync(path.join(ROOT, filePath))) {
      addFinding(findings, "canonical-shared-helper-contract", filePath, 1, message);
      continue;
    }

    const source = await readText(filePath);
    assertPattern(findings, "canonical-shared-helper-contract", filePath, source, pattern, message);
  }

  const criticalImports = [
    [
      "infra/lambda/src/auth-session/index.ts",
      /from ['"]@infra-shared\/text\/normalize['"]/,
      "Expected auth-session Lambda to consume shared text normalization.",
    ],
    [
      "infra/lambda/src/cognito-custom-message/index.ts",
      /from ['"]\.\.\/_shared\/html['"]/,
      "Expected Cognito custom message Lambda to consume shared HTML escaping.",
    ],
    [
      "src/app/useAppExports.ts",
      /from ["']\.\.\/lib\/text\/escape["']/,
      "Expected app export HTML generation to consume shared app escaping.",
    ],
  ];

  for (const [filePath, pattern, message] of criticalImports) {
    const source = await readText(filePath);
    assertPattern(findings, "canonical-shared-helper-contract", filePath, source, pattern, message);
  }
}

async function auditVerifiedIdentity(findings) {
  const migrationManifestPath = "infra/aws/schema-migrations.manifest.json";
  const migrationManifest = JSON.parse(await readText(migrationManifestPath));
  const adminApiPath = "src/lib/vault-api/admin.ts";
  const adminApi = await readText(adminApiPath);
  const adminSharedPath = "src/lib/vault-api/admin-shared.ts";
  const adminShared = await readText(adminSharedPath);
  const verifiedIdentityMigration = (migrationManifest.migrations ?? []).find(
    (entry) => entry.name === "2026050509_verified_identity_admin_drift.sql",
  );

  if (!verifiedIdentityMigration) {
    addFinding(
      findings,
      "verified-identity-contract",
      migrationManifestPath,
      1,
      "Expected verified identity drift migration in the ledger.",
    );
  } else if (
    verifiedIdentityMigration.sha256 !== "11b98a6e6b324826ae2262becf5b628243b56db87b1d2a3fbc1d5b7eb7e4b9fe" ||
    verifiedIdentityMigration.statementCount !== 18
  ) {
    addFinding(
      findings,
      "verified-identity-contract",
      migrationManifestPath,
      1,
      "Expected verified identity drift migration ledger fingerprint to match the retired SQL archive.",
    );
  }

  assertPattern(
    findings,
    "verified-identity-contract",
    adminApiPath,
    adminApi,
    /refresh_admin_identity_drift_signals/,
    "Expected frontend admin API to expose identity drift refresh.",
  );
  assertPattern(
    findings,
    "verified-identity-contract",
    adminSharedPath,
    adminShared,
    /admin_identity_drift_signals/,
    "Expected admin shared API allowlist/types to include identity drift signals.",
  );
}

async function auditHostedEventUrlBuilder(findings) {
  const helperPath = "infra/lambda/src/_shared/hosted-event-urls.ts";
  if (!existsSync(path.join(ROOT, helperPath))) {
    addFinding(
      findings,
      "hosted-event-url-builder-contract",
      helperPath,
      1,
      "Expected the canonical hosted-event URL helper to exist.",
    );
    return;
  }

  const helper = await readText(helperPath);
  assertPattern(
    findings,
    "hosted-event-url-builder-contract",
    helperPath,
    helper,
    /export function buildHostedEventUrl\(slug: string, options\?: HostedEventUrlOptions\)/,
    "Expected buildHostedEventUrl to remain exported from the canonical helper.",
  );

  const importContracts = [
    "infra/lambda/src/data-router/rsvp-confirmation-email.ts",
    "infra/lambda/src/host-event-registration-manage/index.ts",
    "infra/lambda/src/host-event-public-api/index.ts",
  ];

  for (const filePath of importContracts) {
    const source = await readText(filePath);
    assertPattern(
      findings,
      "hosted-event-url-builder-contract",
      filePath,
      source,
      /import\s+\{\s*buildHostedEventUrl\s*\}\s+from\s+['"][^'"]*_shared\/hosted-event-urls['"]/,
      `Expected ${filePath} to import buildHostedEventUrl from the canonical helper.`,
    );
  }

  const lambdaFiles = await walk(path.join(ROOT, "infra/lambda/src"));
  for (const file of lambdaFiles) {
    const rel = relativePath(file);
    if (rel === helperPath || !SOURCE_EXTENSIONS.has(path.extname(file))) {
      continue;
    }

    const source = await readFile(file, "utf8");
    const localDefinition = source.match(/\b(?:function|const)\s+buildHostedEventUrl\b/);
    if (localDefinition) {
      addFinding(
        findings,
        "hosted-event-url-builder-contract",
        rel,
        lineNumberAt(source, localDefinition.index ?? 0),
        "Hosted event URL building should not be reimplemented outside the canonical helper.",
        localDefinition[0],
      );
    }
  }
}

async function auditAppTableInlineDetails(findings) {
  const tablePath = "src/components/shared/table/AppTable.vue";
  const table = await readText(tablePath);
  const specPath = "src/components/shared/table/AppTable.spec.ts";
  const spec = await readText(specPath);

  const contracts = [
    [
      /import AppTableRowDetail from "\.\/AppTableRowDetail\.vue"/,
      "Expected AppTable to render through AppTableRowDetail.",
    ],
    [
      /type TableExpansionConfig = \{[\s\S]*?expandedIds\?: readonly \(string \| number\)\[\]/,
      "Expected controlled expanded row ids config.",
    ],
    [/"update:expandedRowIds": \[ids: \(string \| number\)\[\]\]/, "Expected expanded-row update emit."],
    [
      /<AppTableRowDetail[\s\S]*?<slot\s+name="row-detail"/,
      "Expected AppTable to expose the row-detail slot through AppTableRowDetail.",
    ],
  ];

  for (const [pattern, message] of contracts) {
    assertPattern(findings, "app-table-inline-detail-contract", tablePath, table, pattern, message);
  }

  assertPattern(
    findings,
    "app-table-inline-detail-contract",
    specPath,
    spec,
    /renders inline row detail content for expanded rows/,
    "Expected AppTable inline detail rendering unit coverage.",
  );
  assertPattern(
    findings,
    "app-table-inline-detail-contract",
    specPath,
    spec,
    /toggles inline row detail from row clicks in single expansion mode/,
    "Expected AppTable inline detail toggle unit coverage.",
  );
}

async function auditMyConnectEmailSignature(findings) {
  const modalPath = "src/components/workspace/views/profile/WorkspaceMyLinkEmailSignatureModal.vue";
  const modal = await readText(modalPath);
  const libPath = "src/lib/profile/email-signatures.ts";
  const lib = await readText(libPath);
  const specPath = "src/lib/profile/email-signatures.spec.ts";
  const spec = await readText(specPath);

  const modalContracts = [
    [/my-link-signature-template-classic/, "Expected classic email signature template option."],
    [/my-link-signature-template-minimal/, "Expected minimal email signature template option."],
    [/my-link-signature-template-stacked/, "Expected stacked email signature template option."],
    [/my-link-signature-template-business-card/, "Expected business-card email signature template option."],
    [/my-link-signature-avatar-warning/, "Expected avatar reliability warning UI."],
    [/my-link-signature-download-html/, "Expected HTML download action."],
  ];

  for (const [pattern, message] of modalContracts) {
    assertPattern(findings, "myconnect-email-signature-contract", modalPath, modal, pattern, message);
  }

  assertPattern(
    findings,
    "myconnect-email-signature-contract",
    libPath,
    lib,
    /inspectMyConnectEmailSignatureAvatarUrl/,
    "Expected reusable avatar URL safety inspection.",
  );
  assertPattern(
    findings,
    "myconnect-email-signature-contract",
    libPath,
    lib,
    /x-amz-signature|x-goog-signature/,
    "Expected signed image URLs to be detected as unreliable in email clients.",
  );
  assertPattern(
    findings,
    "myconnect-email-signature-contract",
    specPath,
    spec,
    /falls back to initials when the avatar URL is not email-safe/,
    "Expected avatar reliability unit coverage.",
  );
}

async function auditHostCalendarRefactor(findings) {
  const tabTypePath = "src/lib/vault-hosted-event-types.ts";
  const tabType = await readText(tabTypePath);
  const editorOptionsPath = "src/lib/host/editor-options.ts";
  const editorOptions = await readText(editorOptionsPath);
  const routesPath = "src/products/routes.ts";
  const routes = await readText(routesPath);
  const routingPath = "src/lib/host/host-routing.ts";
  const routing = await readText(routingPath);
  const routingSpecPath = "src/lib/host/host-routing.spec.ts";
  const routingSpec = await readText(routingSpecPath);
  const settingsSpecPath = "src/components/workspace/views/host/WorkspaceHostConsoleView.settings.spec.ts";
  const settingsSpec = await readText(settingsSpecPath);

  const tabUnionMatch = tabType.match(/export type HostedEventEditorTabId =[\s\S]*?;/);
  if (!tabUnionMatch || /["']series["']/.test(tabUnionMatch[0])) {
    addFinding(
      findings,
      "host-calendar-refactor-contract",
      tabTypePath,
      tabUnionMatch ? lineNumberAt(tabType, tabUnionMatch.index ?? 0) : 1,
      "The main host editor tab union should not reintroduce a series tab.",
      tabUnionMatch?.[0] ?? "",
    );
  }

  const editorTabsMatch = editorOptions.match(/export const editorTabs:[\s\S]*?\n\];/);
  if (!editorTabsMatch || /id:\s*["']series["']/.test(editorTabsMatch[0])) {
    addFinding(
      findings,
      "host-calendar-refactor-contract",
      editorOptionsPath,
      editorTabsMatch ? lineNumberAt(editorOptions, editorTabsMatch.index ?? 0) : 1,
      "The visible host editor tab list should not reintroduce a series tab.",
      editorTabsMatch?.[0] ?? "",
    );
  }

  assertPattern(
    findings,
    "host-calendar-refactor-contract",
    routesPath,
    routes,
    /path:\s*["']\/calendar\/host\/:handle["'][\s\S]*?HostedEventCalendarPage\.vue/,
    "Expected public host calendar page route to remain wired.",
  );
  assertPattern(
    findings,
    "host-calendar-refactor-contract",
    routesPath,
    routes,
    /path:\s*["']\/calendar\/host\/:handle\.ics["'][\s\S]*?HostedEventCalendarFeedRedirectPage\.vue/,
    "Expected public host calendar feed route to remain wired.",
  );
  assertPattern(
    findings,
    "host-calendar-refactor-contract",
    routingPath,
    routing,
    /export function buildHostedEventCalendarHostPath/,
    "Expected canonical host calendar path helper.",
  );
  assertPattern(
    findings,
    "host-calendar-refactor-contract",
    routingSpecPath,
    routingSpec,
    /builds host calendar paths/,
    "Expected host calendar routing unit coverage.",
  );
  assertPattern(
    findings,
    "host-calendar-refactor-contract",
    settingsSpecPath,
    settingsSpec,
    /keeps settings focused on unique controls and leaves deleted repeats controls out/,
    "Expected regression coverage that deleted repeats controls stay out of Settings.",
  );
}

async function auditHostedEventPublicExperience(findings) {
  const registrationPath = "src/components/public/hosted-event-public/useHostedEventPublicRegistration.ts";
  const registration = await readText(registrationPath);
  const statusCardPath = "src/components/public/hosted-event-public/shared/HostedEventRegistrationStatusCard.vue";
  const statusCard = await readText(statusCardPath);
  const manageCardPath = "src/components/public/hosted-event-public/shared/HostedEventRegistrationManageCard.vue";
  const manageCard = await readText(manageCardPath);
  const publicSpecPath = "src/components/public/HostedEventPublicPage.*.spec.ts";
  const publicSpec = await readCombinedText([
    "src/components/public/HostedEventPublicPage.access.spec.ts",
    "src/components/public/HostedEventPublicPage.commerce.spec.ts",
    "src/components/public/HostedEventPublicPage.fields.spec.ts",
    "src/components/public/HostedEventPublicPage.hosts.spec.ts",
    "src/components/public/HostedEventPublicPage.layout.spec.ts",
    "src/components/public/HostedEventPublicPage.manage.spec.ts",
    "src/components/public/HostedEventPublicPage.rendering.spec.ts",
    "src/components/public/HostedEventPublicPage.rsvp.spec.ts",
  ]);
  const ticketSpecPath = "src/components/public/HostedEventTicketPage.spec.ts";
  const ticketSpec = await readText(ticketSpecPath);
  const discoverCardPath = "src/components/public/explore/ExploreEventCard.vue";
  const discoverCard = await readText(discoverCardPath);

  for (const propName of ["celebrationEyebrow", "celebrationHeading", "celebrationSummary"]) {
    assertPattern(
      findings,
      "hosted-event-public-experience-contract",
      registrationPath,
      registration,
      new RegExp(`\\b${propName}\\b`),
      `Expected registration state to expose ${propName}.`,
    );
    assertPattern(
      findings,
      "hosted-event-public-experience-contract",
      statusCardPath,
      statusCard,
      new RegExp(`status\\.${propName}`),
      `Expected the registration status card to render ${propName}.`,
    );
  }

  for (const testId of [
    "hosted-event-registration-apple-wallet",
    "hosted-event-registration-google-wallet",
    "hosted-event-registration-calendar",
  ]) {
    assertPattern(
      findings,
      "hosted-event-public-experience-contract",
      manageCardPath,
      manageCard,
      new RegExp(testId),
      `Expected registration manage card action ${testId}.`,
    );
  }

  assertPattern(
    findings,
    "hosted-event-public-experience-contract",
    publicSpecPath,
    publicSpec,
    /adds a wallet reminder prompt for approved attendees before the event/,
    "Expected public page wallet reminder regression coverage.",
  );
  assertPattern(
    findings,
    "hosted-event-public-experience-contract",
    publicSpecPath,
    publicSpec,
    /renders attendee instructions on the page and repeats them after confirmation/,
    "Expected attendee instruction confirmation regression coverage.",
  );
  assertPattern(
    findings,
    "hosted-event-public-experience-contract",
    ticketSpecPath,
    ticketSpec,
    /hosted-event-ticket-wallet-apple/,
    "Expected ticket wallet action regression coverage.",
  );
  assertPattern(
    findings,
    "hosted-event-public-experience-contract",
    discoverCardPath,
    discoverCard,
    /confirmedAttendeeCount/,
    "Expected Discover event cards to retain attendee social-proof count support.",
  );
}

async function auditDeletedSharedPrimitives(findings) {
  const deletedPrimitivePaths = [
    "src/components/public/shared/PublicTextareaField.vue",
    "src/components/shared/selection/AppSegmentedToggleCount.vue",
    "src/components/shared/selection/AppSegmentedToggleNote.vue",
    "src/components/shared/AppSegmentedToggleCount.vue",
    "src/components/shared/AppSegmentedToggleNote.vue",
  ];

  for (const deletedPath of deletedPrimitivePaths) {
    if (existsSync(path.join(ROOT, deletedPath))) {
      addFinding(
        findings,
        "deleted-shared-primitive-contract",
        deletedPath,
        1,
        "Collapsed wrapper component has returned.",
      );
    }
  }

  const files = await collectScanFiles();
  const forbiddenPattern =
    /\b(?:PublicTextareaField|PublicTextField|AppSegmentedToggleCount|AppSegmentedToggleNote)\b/g;
  for (const file of files) {
    const rel = relativePath(file);
    const source = await readFile(file, "utf8");
    forbiddenPattern.lastIndex = 0;
    for (const match of source.matchAll(forbiddenPattern)) {
      addFinding(
        findings,
        "deleted-shared-primitive-contract",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Collapsed shared primitive wrapper reference found in shipped source.",
        match[0],
      );
    }
  }
}

async function auditPublicFieldRequiredContracts(findings) {
  const publicSelectFieldPath = firstExistingPath([
    "packages/connections-ui/src/components/fields/PublicSelectField.vue",
    "src/components/public/shared/PublicSelectField.vue",
  ]);
  if (publicSelectFieldPath) {
    const publicSelectField = await readText(publicSelectFieldPath);
    assertPatternCount(
      findings,
      "public-field-required-contract",
      publicSelectFieldPath,
      publicSelectField,
      /:required=["']required["']/g,
      2,
      "Expected PublicSelectField to forward required state in floating-label and static-label modes.",
    );
  }

  const publicCheckboxFieldPath = "src/components/public/shared/PublicCheckboxField.vue";
  if (existsSync(path.join(ROOT, publicCheckboxFieldPath))) {
    const publicCheckboxField = await readText(publicCheckboxFieldPath);
    assertPattern(
      findings,
      "public-field-required-contract",
      publicCheckboxFieldPath,
      publicCheckboxField,
      /v-if=["']fieldRequired["'][\s\S]*?\(required\)/,
      "Expected PublicCheckboxField to render a visible and screen-reader required indicator.",
    );
  }

  const registrationFieldRendererPath =
    "src/components/public/hosted-event-public/shared/HostedEventRegistrationFieldRenderer.vue";
  if (existsSync(path.join(ROOT, registrationFieldRendererPath))) {
    const registrationFieldRenderer = await readText(registrationFieldRendererPath);
    assertPatternCount(
      findings,
      "public-field-required-contract",
      registrationFieldRendererPath,
      registrationFieldRenderer,
      /required:\s*field\.isRequired/g,
      4,
      "Expected hosted-event text and checkbox registration fields to pass field.isRequired into public primitives.",
    );
    assertPattern(
      findings,
      "public-field-required-contract",
      registrationFieldRendererPath,
      registrationFieldRenderer,
      /<PublicSelectField[\s\S]*?:required=["']field\.isRequired["']/,
      "Expected hosted-event select registration fields to pass field.isRequired into PublicSelectField.",
    );
    assertPattern(
      findings,
      "public-field-required-contract",
      registrationFieldRendererPath,
      registrationFieldRenderer,
      /v-else-if=["']registration\.isMultiSelectField\(field\)["'][\s\S]*?<label[\s\S]*?field\.isRequired[\s\S]*?\(required\)/,
      "Expected hosted-event multi-select registration fields to render a required indicator.",
    );
  }
}

async function auditSharedPrimitivesLiveSplit(_findings) {
  // The curated baseline harness (SharedPrimitivesLiveHarness.vue) and its sections
  // have been removed. The dynamic playground now owns all SPL26 rendering.
}

async function auditRuntimeAuditEntrypoints(findings) {
  const packageJsonPath = "package.json";
  const packageJson = await readText(packageJsonPath);
  const expectedScripts = [
    ["audit:memory", "packages/connections-arkitect/runners/memory-monitor.mjs", "(?:bun|node)"],
    ["audit:media-cors", "packages/connections_devopz/runners/media-cors.mjs", "bun"],
    ["audit:mobile", "packages/connections-arkitect/bin/audit.mjs --check mobile-audit --full", "bun"],
    ["audit:css-dedupe", "packages/connections-arkitect/bin/audit.mjs --check css-dedupe", "bun"],
    ["audit:aws:sitemap", "packages/connections_devopz/runners/sitemap.mjs", "bun"],
  ];

  for (const [scriptName, scriptPath, runnerPattern] of expectedScripts) {
    assertPattern(
      findings,
      "runtime-audit-entrypoint-contract",
      packageJsonPath,
      packageJson,
      new RegExp(
        `"${scriptName}"\\s*:\\s*"${runnerPattern} ${scriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
      `Expected package script ${scriptName} to run ${scriptPath}.`,
    );

    const entrypointPath = scriptPath.split(/\s+/)[0];
    if (!existsSync(path.join(ROOT, entrypointPath))) {
      addFinding(findings, "runtime-audit-entrypoint-contract", scriptPath, 1, `Expected ${scriptPath} to exist.`);
    }
  }
}

// Per AeroStream's M3 docs (foundations + styles), these are the spec-aligned
// foundation tokens the design system depends on. We don't enforce numeric
// values (those can evolve with the brand) - just that the token names stay
// declared, so downstream surfaces keep a stable vocabulary. M3 explicitly
// deprecates surface-tint in favor of elevation level tokens, which is the
// reason `--md-sys-color-surface-tint` is intentionally not on this list.
const M3_FOUNDATION_TOKENS = {
  elevation: [
    "--md-sys-elevation-level0",
    "--md-sys-elevation-level1",
    "--md-sys-elevation-level2",
    "--md-sys-elevation-level3",
    "--md-sys-elevation-level4",
    "--md-sys-elevation-level5",
  ],
  typescale: [
    "--md-sys-typescale-display-large-size",
    "--md-sys-typescale-display-medium-size",
    "--md-sys-typescale-display-small-size",
    "--md-sys-typescale-headline-large-size",
    "--md-sys-typescale-headline-medium-size",
    "--md-sys-typescale-headline-small-size",
    "--md-sys-typescale-title-large-size",
    "--md-sys-typescale-title-medium-size",
    "--md-sys-typescale-title-small-size",
    "--md-sys-typescale-body-large-size",
    "--md-sys-typescale-body-medium-size",
    "--md-sys-typescale-body-small-size",
    "--md-sys-typescale-label-large-size",
    "--md-sys-typescale-label-medium-size",
    "--md-sys-typescale-label-small-size",
  ],
  motionDuration: [
    "--md-sys-motion-duration-short1",
    "--md-sys-motion-duration-short2",
    "--md-sys-motion-duration-short3",
    "--md-sys-motion-duration-short4",
    "--md-sys-motion-duration-medium1",
    "--md-sys-motion-duration-medium2",
    "--md-sys-motion-duration-medium3",
    "--md-sys-motion-duration-medium4",
    "--md-sys-motion-duration-long1",
    "--md-sys-motion-duration-long2",
    "--md-sys-motion-duration-long3",
    "--md-sys-motion-duration-long4",
    "--md-sys-motion-duration-extra-long1",
    "--md-sys-motion-duration-extra-long2",
    "--md-sys-motion-duration-extra-long3",
    "--md-sys-motion-duration-extra-long4",
  ],
  motionEasing: [
    "--md-sys-motion-easing-standard",
    "--md-sys-motion-easing-standard-accelerate",
    "--md-sys-motion-easing-standard-decelerate",
    "--md-sys-motion-easing-emphasized",
    "--md-sys-motion-easing-emphasized-accelerate",
    "--md-sys-motion-easing-emphasized-decelerate",
  ],
};

async function auditM3FoundationTokens(findings) {
  const tokenFilePath = "src/styles/core/tokens.css";
  const tokenSource = await readText(tokenFilePath);
  const declaredTokens = new Set(
    [...tokenSource.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1]),
  );

  for (const [group, names] of Object.entries(M3_FOUNDATION_TOKENS)) {
    for (const name of names) {
      if (declaredTokens.has(name)) {
        continue;
      }

      addFinding(
        findings,
        "m3-foundation-tokens-contract",
        tokenFilePath,
        1,
        `M3 ${group} token ${name} must stay declared in ${tokenFilePath}.`,
        name,
      );
    }
  }
}

async function auditMobileSheetContract(findings) {
  const contractPath = `${UI_PACKAGE_COMPONENTS_ROOT}/layout/mobileSheet.ts`;
  const sheetPath = `${UI_PACKAGE_COMPONENTS_ROOT}/layout/UnifiedMobileSheet.vue`;
  const wrapperPath = `${UI_PACKAGE_COMPONENTS_ROOT}/layout/AppMobileDetailSheet.vue`;
  const pagerPath = `${UI_PACKAGE_COMPONENTS_ROOT}/layout/AppMobileDetailPagerSheet.vue`;

  const [contract, sheet, wrapper, pager] = await Promise.all([
    readText(contractPath),
    readText(sheetPath),
    readText(wrapperPath),
    readText(pagerPath),
  ]);

  assertPattern(
    findings,
    "mobile-sheet-contract",
    contractPath,
    contract,
    /export const DEFAULT_MOBILE_SHEET_COLLAPSED_RATIO = 0\.88;/,
    "Expected the shared mobile-sheet contract to keep the product-standard 88% initial detent.",
  );
  assertPattern(
    findings,
    "mobile-sheet-contract",
    contractPath,
    contract,
    /export const MOBILE_SHEET_HANDLE_TOUCH_TARGET_PX = 48;/,
    "Expected the shared mobile-sheet contract to keep the 48dp handle target.",
  );
  assertPattern(
    findings,
    "mobile-sheet-contract",
    contractPath,
    contract,
    /resolveSpringConfig\("default-spatial"\)/,
    "Expected the shared mobile-sheet contract to keep the default-spatial spring token.",
  );

  assertPattern(
    findings,
    "mobile-sheet-contract",
    sheetPath,
    sheet,
    /from "\.\/mobileSheet"/,
    "Expected UnifiedMobileSheet to import its shared contract constants from mobileSheet.ts.",
  );
  assertPattern(
    findings,
    "mobile-sheet-contract",
    sheetPath,
    sheet,
    /collapsedRatio:\s*props\.sizing\?\.collapsedRatio \?\? DEFAULT_MOBILE_SHEET_COLLAPSED_RATIO/,
    "Expected UnifiedMobileSheet to default collapsedRatio from the shared mobile-sheet contract.",
  );
  assertPattern(
    findings,
    "mobile-sheet-contract",
    sheetPath,
    sheet,
    /useSpring\(heightPx, \{ token: MOBILE_SHEET_SPRING \}\)/,
    "Expected UnifiedMobileSheet height motion to use the shared mobile-sheet spring contract.",
  );
  assertPattern(
    findings,
    "mobile-sheet-contract",
    sheetPath,
    sheet,
    /shouldShowDefaultCloseAction/,
    "Expected UnifiedMobileSheet to keep the full-screen close affordance contract.",
  );
  assertPattern(
    findings,
    "mobile-sheet-contract",
    sheetPath,
    sheet,
    /aria-label="labels\.closeSheet"/,
    "Expected UnifiedMobileSheet to label the full-screen close affordance via the shared labels prop.",
  );
  assertNoPattern(
    findings,
    "mobile-sheet-contract",
    sheetPath,
    sheet,
    /gc-sheet-resize-transition/,
    "UnifiedMobileSheet must not reintroduce CSS resize-transition ownership on top of its spring motion.",
  );
  assertNoPattern(
    findings,
    "mobile-sheet-contract",
    sheetPath,
    sheet,
    /\bconst\s+(?:DRAG_HANDLE_TOUCH_TARGET_PX|SHEET_VISUAL_SETTLE_TOLERANCE_PX)\s*=/,
    "UnifiedMobileSheet must not duplicate local handle/tolerance constants that belong in mobileSheet.ts.",
  );

  for (const [filePath, source, description] of [
    [wrapperPath, wrapper, "Expected AppMobileDetailSheet to consume the shared collapsed detent constant."],
    [pagerPath, pager, "Expected AppMobileDetailPagerSheet to consume the shared collapsed detent constant."],
  ]) {
    assertPattern(
      findings,
      "mobile-sheet-contract",
      filePath,
      source,
      /DEFAULT_MOBILE_SHEET_COLLAPSED_RATIO/,
      description,
    );
  }
}

async function auditSystemAuditSuiteContract(findings) {
  const packageJsonPath = "package.json";
  const registryPath = "packages/connections-arkitect/src/cli/discovery.mjs";
  const configPath = "packages/connections-arkitect/policies/connections/connections.audit.config.json";
  const readmePath = "packages/connections-arkitect/README.md";
  const packageJson = await readText(packageJsonPath);
  const registry = await readText(registryPath);
  const config = await readText(configPath);
  const readme = await readText(readmePath);

  assertPattern(
    findings,
    "system-audit-suite-contract",
    packageJsonPath,
    packageJson,
    /"audit:all"\s*:\s*"bun packages\/connections-arkitect\/bin\/audit\.mjs --all"/,
    "Expected package script audit:all to run the Arkitect all-suite.",
  );
  assertPattern(
    findings,
    "system-audit-suite-contract",
    packageJsonPath,
    packageJson,
    /"audit:strict"\s*:\s*"bun packages\/connections-arkitect\/bin\/audit\.mjs --all --fail-on-drift --quiet"/,
    "Expected package script audit:strict to run the strict all-suite.",
  );
  assertPattern(
    findings,
    "system-audit-suite-contract",
    packageJsonPath,
    packageJson,
    /"audit:mobile"\s*:\s*"bun packages\/connections-arkitect\/bin\/audit\.mjs --check mobile-audit --full"/,
    "Expected explicit mobile audit script to run the full browser/device pass.",
  );
  assertPattern(
    findings,
    "system-audit-suite-contract",
    packageJsonPath,
    packageJson,
    /"audit:mobile:static"\s*:\s*"bun packages\/connections-arkitect\/bin\/audit\.mjs --check mobile-audit"/,
    "Expected static mobile audit script for no-browser all-suite coverage.",
  );

  // With auto-discovery, all checks are discoverable. Environment-dependent
  // checks (memory-monitor) are gated by includeInAll:false in their own
  // defaultConfig, not by registry exclusion. Verify the gating exists.
  assertPattern(
    findings,
    "system-audit-suite-contract",
    "packages/connections-arkitect/src/checks/performance/memory-monitor.mjs",
    await readText("packages/connections-arkitect/src/checks/performance/memory-monitor.mjs"),
    /includeInAll:\s*false/,
    "Expected memory-monitor to be gated by includeInAll:false.",
  );
  assertPattern(
    findings,
    "system-audit-suite-contract",
    registryPath,
    registry,
    /discoverAudits/,
    "Expected auto-discovery based registry to export discoverAudits.",
  );
  assertPattern(
    findings,
    "system-audit-suite-contract",
    registryPath,
    registry,
    /mobile-audit/,
    "Expected mobile-audit to be documented in the auto-discovery registry for static mobile coverage.",
  );
  assertPattern(
    findings,
    "system-audit-suite-contract",
    configPath,
    config,
    /"mobile-audit"\s*:\s*\{/,
    "Expected mobile-audit policy config.",
  );
  assertPattern(
    findings,
    "system-audit-suite-contract",
    configPath,
    config,
    /"outputPath"\s*:\s*"tmp\/audits\/MOBILE_AUDIT\.md"/,
    "Expected static mobile audit to emit an actionable fix queue.",
  );
  assertPattern(
    findings,
    "system-audit-suite-contract",
    readmePath,
    readme,
    /explicitly "run the mobile audit".*bun run audit:mobile/s,
    "Expected README guidance that explicit mobile audit requests should run the full browser/device pass.",
  );
}

function isWorkspaceRouteSwitchboardPath(filePath) {
  return (
    /^src\/components\/AppWorkspaceRoot\.vue$/.test(filePath) ||
    /^src\/components\/workspace\/WorkspaceShell\.vue$/.test(filePath) ||
    /^src\/components\/workspace\/shell\/.*(?:Shell|MainRegion|SecondaryViews)\.vue$/.test(filePath)
  );
}

function collectStaticWorkspaceViewImports(source) {
  const imports = [];
  const importPattern =
    /import\s+(?:[^'";]+?\s+from\s+)?["'](@\/components\/workspace\/views\/[^"']+|\.\.?\/[^"']*views\/[^"']+)["']/g;

  for (const match of source.matchAll(importPattern)) {
    const importStatement = match[0];
    if (/import\s*\(/.test(importStatement)) {
      continue;
    }

    imports.push({
      index: match.index ?? 0,
      statement: importStatement,
      specifier: match[1],
    });
  }

  return imports;
}

async function auditWorkspaceRouteStartupContract(findings) {
  const files = await collectScanFiles();

  for (const file of files) {
    const rel = relativePath(file);
    if (!isWorkspaceRouteSwitchboardPath(rel)) {
      continue;
    }

    const source = await readFile(file, "utf8");
    const staticViewImports = collectStaticWorkspaceViewImports(source).filter(
      (entry) => !entry.specifier.includes("/views/shared/"),
    );
    for (const entry of staticViewImports) {
      addFinding(
        findings,
        "workspace-route-startup-contract",
        rel,
        lineNumberAt(source, entry.index),
        "Workspace route switchboards must lazy-load workspace views so secondary routes do not pay for inactive heavy surfaces.",
        entry.statement,
      );
    }
  }

  const mainRegionPath = "src/components/workspace/shell/WorkspaceShellMainRegion.vue";
  const mainRegion = await readText(mainRegionPath);
  assertPattern(
    findings,
    "workspace-route-startup-contract",
    mainRegionPath,
    mainRegion,
    /(?:const\s+WorkspaceContactDirectoryView\s*=\s*defineRecoverableAsyncComponent\(\s*\(\)\s*=>\s*import\(["']@\/components\/workspace\/views\/contacts["']\)|function\s+loadWorkspaceContactDirectoryView\(\)\s*\{[\s\S]*?import\(["']@\/components\/workspace\/views\/contacts["']\)[\s\S]*?const\s+WorkspaceContactDirectoryView\s*=\s*defineRecoverableAsyncComponent\(\(\)\s*=>\s*loadWorkspaceContactDirectoryView\(\)\))/,
    "Expected the contact directory to stay lazy-loaded from the workspace route switchboard.",
  );
  assertPattern(
    findings,
    "workspace-route-startup-contract",
    mainRegionPath,
    mainRegion,
    /const\s+WorkspaceHostConsoleView\s*=\s*defineRecoverableAsyncComponent\(\s*\(\)\s*=>\s*import\(["']@\/components\/workspace\/views\/host["']\)/,
    "Expected the host console to stay lazy-loaded from the workspace route switchboard.",
  );

  const mergeViewPath = "src/components/workspace/views/WorkspaceMergeFixView.vue";
  const mergeView = await readText(mergeViewPath);
  assertPattern(
    findings,
    "workspace-route-startup-contract",
    mergeViewPath,
    mergeView,
    /isLoadingSuggestions\?:\s*boolean/,
    "Expected Merge & Fix to receive explicit loading state from the route/controller.",
  );
  assertPattern(
    findings,
    "workspace-route-startup-contract",
    mergeViewPath,
    mergeView,
    /WorkspaceViewLoadingState/,
    "Expected Merge & Fix to render a loading state before initial matcher suggestions arrive.",
  );
  assertPattern(
    findings,
    "workspace-route-startup-contract",
    mergeViewPath,
    mergeView,
    /suggestion\.duplicateName[\s\S]*suggestion\.primaryName|suggestion\.primaryName[\s\S]*suggestion\.duplicateName/,
    "Expected Merge & Fix rows to use matcher response snapshots before the full contacts bundle hydrates.",
  );

  const controllerPath = "src/composables/workspace/useWorkspaceAppController.ts";
  const controller = await readText(controllerPath);
  assertPattern(
    findings,
    "workspace-route-startup-contract",
    controllerPath,
    controller,
    /activeView\s*!==\s*["']merge_fix["'][\s\S]*directoryBridgeState\.refreshMergeFixSuggestions\(\)/,
    "Expected the workspace controller to start Merge & Fix suggestion loading as soon as the route becomes active.",
  );
}

async function auditWorkspaceSurfaceCountsContract(findings) {
  const backendPath = "infra/lambda/src/_shared/workspace-read-bundles.ts";
  const backend = await readText(backendPath);
  const vaultTypesPath = "src/lib/vault-types.ts";
  const vaultTypes = await readText(vaultTypesPath);
  const normalizerPath = "src/lib/workspace/contact-directory-state.ts";
  const normalizer = await readText(normalizerPath);
  const eventsPath = "src/lib/workspace/event-directory-state.ts";
  const events = await readText(eventsPath);
  const shellLayoutPath = "src/components/workspace/shell/useWorkspaceShellLayoutState.ts";
  const shellLayout = await readText(shellLayoutPath);
  const registryPath = "src/products/workspace-registry.ts";
  const registry = await readText(registryPath);
  const docsPath = "docs/architecture/SYSTEM_CONTRACTS.md";
  const docs = await readText(docsPath);

  for (const [surface, required] of [
    ["connections", true],
    ["events", false],
    ["calendar", false],
    ["bookings", false],
    ["communities", false],
    ["forms", false],
    ["forums", false],
  ]) {
    const pattern = new RegExp(`${surface}${required ? "" : "\\?"}:\\s*Workspace`);
    assertPattern(
      findings,
      "workspace-surface-counts-contract",
      vaultTypesPath,
      vaultTypes,
      pattern,
      `Expected WorkspaceSurfaceCounts to declare the ${surface} count bucket.`,
    );
  }

  for (const loaderName of [
    "loadWorkspaceConnectionsSurfaceCounts",
    "loadWorkspaceEventsSurfaceCounts",
    "loadWorkspaceCalendarSurfaceCounts",
    "loadWorkspaceBookingsSurfaceCounts",
    "loadWorkspaceCommunitiesSurfaceCounts",
    "loadWorkspaceFormsSurfaceCounts",
  ]) {
    assertPattern(
      findings,
      "workspace-surface-counts-contract",
      backendPath,
      backend,
      new RegExp(`${loaderName}\\(`),
      `Expected backend workspace surface counts to call ${loaderName}.`,
    );
  }

  for (const surface of ["bookings", "calendar", "communities", "events", "forms"]) {
    assertPattern(
      findings,
      "workspace-surface-counts-contract",
      backendPath,
      backend,
      new RegExp(`\\b${surface}\\b`),
      `Expected backend loadWorkspaceSurfaceCounts to return the ${surface} bucket.`,
    );
    assertPattern(
      findings,
      "workspace-surface-counts-contract",
      normalizerPath,
      normalizer,
      new RegExp(`["']${surface}["']`),
      `Expected client workspace surface count normalization to preserve the ${surface} bucket.`,
    );
  }

  assertPattern(
    findings,
    "workspace-surface-counts-contract",
    eventsPath,
    events,
    /resolveEventFilterCountFromSurfaceCounts/,
    "Expected Events to resolve active filter counts from workspaceSurfaceCounts.",
  );
  assertPattern(
    findings,
    "workspace-surface-counts-contract",
    shellLayoutPath,
    shellLayout,
    /resolveEventFilterCountFromSurfaceCounts\(unref\(state\.workspaceSurfaceCounts\)/,
    "Expected the workspace sidebar Events badge to prefer indexed surface counts.",
  );

  for (const [surface, key] of [
    ["calendar", "all"],
    ["bookings", "active"],
    ["communities", "all"],
    ["forms", "active"],
  ]) {
    assertPattern(
      findings,
      "workspace-surface-counts-contract",
      shellLayoutPath,
      shellLayout,
      new RegExp(`getWorkspaceSurfaceBucketCount\\(state, ["']${surface}["'], ["']${key}["']\\)`),
      `Expected the ${surface} sidebar badge to use workspaceSurfaceCounts.${surface}.${key}.`,
    );
    assertPattern(
      findings,
      "workspace-surface-counts-contract",
      registryPath,
      registry,
      new RegExp(`count:\\s*["']${surface}["']`),
      `Expected the ${surface} sidebar nav item to declare its count source.`,
    );
  }

  assertPattern(
    findings,
    "workspace-surface-counts-contract",
    docsPath,
    docs,
    /workspaceSurfaceCounts/,
    "Expected the workspace surface count lane to be documented in system contracts.",
  );
}

function renderMarkdown(findings) {
  const counts = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});

  const lines = [];
  lines.push("# Product Contract Audit");
  lines.push("");
  lines.push(`- Total findings: ${findings.length}`);
  lines.push(`- Errors: ${counts.error ?? 0}`);
  lines.push(`- Warnings: ${counts.warning ?? 0}`);
  lines.push("");

  if (!findings.length) {
    lines.push("No product contract drift found.");
    return `${lines.join("\n")}\n`;
  }

  for (const finding of findings) {
    const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
    lines.push(`- ${finding.severity.toUpperCase()}: \`${finding.ruleId}\` - ${location} - ${finding.message}`);
    if (finding.snippet) {
      lines.push(`  - ${finding.snippet}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runProductContractsAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  SOURCE_EXTENSIONS = new Set(options.extensions ?? DEFAULT_SOURCE_EXTENSIONS);
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];
  SKIP_SEGMENTS = new Set(options.skipSegments ?? DEFAULT_SKIP_SEGMENTS);

  const findings = [];

  await auditExploreRoute(findings);
  await auditReservedEventsRoute(findings);
  await auditLlmsSurface(findings);
  await auditNoRelayReferences(findings);
  await auditRetiredArtifacts(findings);
  await auditCanonicalSharedHelpers(findings);
  await auditVerifiedIdentity(findings);
  await auditHostedEventUrlBuilder(findings);
  await auditAppTableInlineDetails(findings);
  await auditMyConnectEmailSignature(findings);
  await auditHostCalendarRefactor(findings);
  await auditHostedEventPublicExperience(findings);
  await auditDeletedSharedPrimitives(findings);
  await auditPublicFieldRequiredContracts(findings);
  await auditSharedPrimitivesLiveSplit(findings);
  await auditRuntimeAuditEntrypoints(findings);
  await auditSystemAuditSuiteContract(findings);
  await auditM3FoundationTokens(findings);
  await auditMobileSheetContract(findings);
  await auditWorkspaceRouteStartupContract(findings);
  await auditWorkspaceSurfaceCountsContract(findings);

  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath) || a.line - b.line);

  return {
    failed: findings.some((finding) => finding.severity === "error"),
    findings,
    jsonPayload: { findings, rules: RULES },
    report: renderMarkdown(findings),
  };
}

async function main() {
  const result = await runProductContractsAudit();

  if (hasFlag("--json")) {
    console.log(JSON.stringify(result.jsonPayload, null, 2));
  } else if (!hasFlag("--quiet") || result.findings.length > 0) {
    console.log(result.report.trimEnd());
  }

  if (hasFlag("--fail-on-drift") && result.failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[product-contracts-engine] failed:", error);
    process.exitCode = 1;
  });
}
