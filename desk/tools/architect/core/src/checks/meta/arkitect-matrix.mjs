import { createFinding } from "@saydeploy/architect/core/finding";

const REQUIRED_SURFACE_FIELDS = [
  "id",
  "label",
  "staticAudits",
  "tests",
  "runnyknows",
  "analytics",
  "persistence",
  "workflows",
  "smokePath",
];

const DEFAULT_SURFACES = [
  {
    id: "public-hosted-event-page",
    label: "Public hosted event page",
    staticAudits: [
      "product-contracts",
      "field-contracts",
      "data-capture-contracts",
      "endpoint-contracts",
      "mobile-audit",
    ],
    tests: ["src/components/public/HostedEventPublicPage.*.spec.ts", "src/lib/vault-api/host.public-api.spec.ts"],
    runnyknows: ["resource-error", "network-response", "vue-error"],
    analytics: ["hosted-event:page-view", "hosted-event:cta-click"],
    persistence: ["host_events", "host_event_registration_fields", "host_event_hosts"],
    workflows: ["public render", "ticket/RSVP entry", "calendar/add-to-calendar links"],
    smokePath: "/e/:slug",
  },
  {
    id: "hosted-event-registration",
    label: "Hosted event registration",
    staticAudits: ["field-contracts", "data-capture-contracts", "endpoint-contracts", "persistence-parity"],
    tests: [
      "src/components/public/HostedEventPublicPage.fields.spec.ts",
      "src/components/public/hosted-event-public/useHostedEventPublicRegistration.*.spec.ts",
      "infra/lambda/src/host-event-public-api/index.spec.ts",
    ],
    runnyknows: ["network-response", "vue-error"],
    analytics: ["hosted-event:form-start", "hosted-event:form-submit", "hosted-event:save"],
    persistence: ["host_event_attendees", "host_event_registrations", "host_event_registration_answers"],
    workflows: ["registration submit", "plus-one submit", "paid ticket checkout handoff"],
    smokePath: "/e/:slug/register",
  },
  {
    id: "discover",
    label: "Discover",
    staticAudits: ["analytics-contracts", "endpoint-contracts", "product-contracts", "i18n-hardcoded"],
    tests: ["src/components/public/explore-browse/ExploreBrowsePage.*.spec.ts"],
    runnyknows: ["network-response", "resource-error"],
    analytics: ["discover:page-view", "discover:result-click", "discover:save"],
    persistence: ["discover analytics tables", "saved hosted events"],
    workflows: ["search/filter", "result open", "save event"],
    smokePath: "/explore",
  },
  {
    id: "myconnect-public-page",
    label: "MyConnect public page",
    staticAudits: ["analytics-contracts", "data-capture-contracts", "mobile-audit"],
    tests: ["src/components/public/MyConnectPublicPage.*.spec.ts", "src/lib/myconnect-public/validation.*.spec.ts"],
    runnyknows: ["network-response", "vue-error"],
    analytics: ["myconnect:page-view", "myconnect:link-click", "myconnect:contact-exchange-submit"],
    persistence: ["profiles", "myconnect links", "contact exchange submissions"],
    workflows: ["public profile render", "link click", "contact exchange"],
    smokePath: "/:handle",
  },
  {
    id: "public-forms",
    label: "Public forms",
    staticAudits: ["surface-size-coverage", "field-contracts", "data-capture-contracts"],
    tests: ["src/components/public/HostedFormPage.*.spec.ts", "infra/lambda/src/forms-public-api/index.spec.ts"],
    runnyknows: ["network-response", "vue-error"],
    analytics: ["form:page-view", "form:submit"],
    persistence: ["workspace_forms", "workspace_form_submissions", "workspace_form_answers"],
    workflows: ["form render", "file upload", "form submit", "webhook delivery"],
    smokePath: "/f/:slug",
  },
  {
    id: "public-booking",
    label: "Public booking",
    staticAudits: ["lambda-contracts", "field-contracts", "data-capture-contracts", "endpoint-contracts"],
    tests: [
      "src/components/public/HostedBookingPage.spec.ts",
      "src/lib/vault-api/booking-public.spec.ts",
      "infra/lambda/src/booking-public-api/index.spec.ts",
    ],
    runnyknows: ["network-response", "vue-error"],
    analytics: ["booking funnel events as available"],
    persistence: ["availability_windows", "booking_settings", "schedule_events", "touches (booking_created)"],
    workflows: ["slot pick", "reserve", "manage", "cancel", "reschedule"],
    smokePath: "/book/:handle",
  },
  {
    id: "ai-network",
    label: "AI Network",
    staticAudits: ["lambda-contracts", "persistence-parity", "endpoint-contracts"],
    tests: [
      "src/lib/ai/ai-network.spec.ts",
      "src/composables/workspace/ai/useWorkspaceAiNetwork.spec.ts",
      "src/components/workspace/views/ai/WorkspaceAiNetworkView.spec.ts",
      "infra/lambda/src/intro-request-notifications/index.spec.ts",
      "infra/lambda/src/vault-ai-network-search/ranker.spec.ts",
    ],
    runnyknows: ["network-response", "vue-error"],
    analytics: ["ai-network search/request/consent events as available"],
    persistence: ["intro_requests", "intro_request_targets", "intro_target_consents", "training labels"],
    workflows: [
      "search",
      "request",
      "broker approve/select or decline",
      "target accept/decline",
      "requester completed/revealed or closed",
    ],
    smokePath: "/workspace/ai/network",
  },
  {
    id: "outbound-webhooks",
    label: "Outbound webhooks (Forms + Host)",
    staticAudits: ["lambda-contracts", "endpoint-contracts"],
    tests: ["infra/lambda/src/host-event-integrations/index.spec.ts", "infra/lambda/src/_shared/outbound-http.spec.ts"],
    runnyknows: ["network-response"],
    analytics: ["webhook delivery attempt/result as available"],
    persistence: ["workspace_webhooks", "workspace_webhook_deliveries", "form_webhooks"],
    workflows: ["subscribe to event type", "deliver with signed payload", "retry on failure", "manual replay"],
    smokePath: "/workspace/developer/webhooks",
  },
  {
    id: "workspace-contacts",
    label: "Workspace contacts",
    staticAudits: ["persistence-parity", "ui-drift", "vue-layering"],
    tests: ["src/components/workspace/views/contacts/*.spec.ts", "src/lib/vault-api/contacts.*.spec.ts"],
    runnyknows: ["network-response", "vue-error"],
    analytics: ["workspace contact events as available"],
    persistence: ["contacts", "contact_manual_touches", "contact provenance"],
    workflows: ["create/update contact", "drag/drop map update", "merge/delete/restore"],
    smokePath: "/workspace/contacts",
  },
  {
    id: "workspace-hosted-event-console",
    label: "Workspace hosted-event console",
    staticAudits: ["surface-size-coverage", "persistence-parity", "field-contracts", "workflow-outcome-contracts"],
    tests: ["src/components/workspace/views/host/*.spec.ts", "src/lib/vault-api/host.*.spec.ts"],
    runnyknows: ["network-response", "vue-error"],
    analytics: ["host console events as available"],
    persistence: ["host_events", "host_event_registration_fields", "host_event_attendees", "host_event_tickets"],
    workflows: ["draft edit/save", "registration field builder", "check-in", "ticketing"],
    smokePath: "/workspace/host/events/:eventId",
  },
  {
    id: "billing-subscriptions",
    label: "Billing/subscriptions",
    staticAudits: ["lambda-contracts", "product-contracts"],
    tests: ["infra/lambda/src/billing-api/*.spec.ts", "src/components/public/*Billing*.spec.ts"],
    runnyknows: ["network-response"],
    analytics: ["billing funnel events as available"],
    persistence: ["stripe customers", "memberships", "calendar subscriptions", "admin audit log"],
    workflows: ["checkout", "webhook entitlement update", "membership approval"],
    smokePath: "/account/billing",
  },
  {
    id: "ai-enrich-search-network",
    label: "AI enrich/search/network",
    staticAudits: ["lambda-contracts", "persistence-parity", "bundle-size-budget"],
    tests: ["infra/lambda/src/ai-*.spec.ts", "src/composables/workspace/ai/*.spec.ts"],
    runnyknows: ["network-response", "vue-error"],
    analytics: ["ml-ops capture", "AI workspace events as available"],
    persistence: ["contact AI enrich records", "vector/search indexes", "ml ops logs"],
    workflows: ["AI enrich", "AI search", "AI network graph"],
    smokePath: "/workspace/ai",
  },
];

function list(value) {
  if (!Array.isArray(value)) return "";
  return value.join(", ");
}

function validateSurface(surface, index) {
  const findings = [];
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    findings.push(
      createFinding({
        ruleId: "arkitect-matrix-surface-invalid",
        severity: "error",
        filePath: "packages/connections-arkitect/policies/connections/connections.audit.config.json",
        line: 0,
        message: `Arkitect matrix surface at index ${index} must be an object.`,
      }),
    );
    return findings;
  }

  for (const field of REQUIRED_SURFACE_FIELDS) {
    const value = surface[field];
    const isMissing = Array.isArray(value) ? value.length === 0 : typeof value !== "string" || value.trim() === "";
    if (isMissing) {
      findings.push(
        createFinding({
          ruleId: "arkitect-matrix-surface-missing-field",
          severity: "error",
          filePath: "packages/connections-arkitect/policies/connections/connections.audit.config.json",
          line: 0,
          message: `${surface.label || surface.id || `surface ${index}`} is missing required Arkitect matrix field "${field}".`,
          metadata: {
            surfaceId: surface.id ?? "",
            field,
          },
        }),
      );
    }
  }

  return findings;
}

function renderReport(surfaces, findings) {
  const lines = [
    "# Arkitect Matrix",
    "",
    "Maps critical product surfaces to the static audits, tests, runtime signals, analytics, persistence surfaces, risk workflows, and smoke paths that should protect them.",
    "",
  ];

  if (findings.length) {
    lines.push("## Findings", "");
    for (const finding of findings) {
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.ruleId}: ${finding.message}`);
    }
    lines.push("");
  }

  lines.push("## Surface Matrix", "");
  lines.push("| Surface | Static audits | Tests | Runnyknows | Analytics | Persistence | Workflows | Smoke path |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const surface of surfaces) {
    lines.push(
      `| ${surface.label} | ${list(surface.staticAudits)} | ${list(surface.tests)} | ${list(
        surface.runnyknows,
      )} | ${list(surface.analytics)} | ${list(surface.persistence)} | ${list(surface.workflows)} | ${
        surface.smokePath
      } |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

export async function runArchitectMatrixAudit({ checkConfig = {} } = {}) {
  const surfaces =
    Array.isArray(checkConfig.surfaces) && checkConfig.surfaces.length ? checkConfig.surfaces : DEFAULT_SURFACES;
  const findings = surfaces.flatMap((surface, index) => validateSurface(surface, index));
  const failed = findings.some((finding) => finding.severity === "error");

  return {
    failed,
    findings,
    outputPath: checkConfig.outputPath,
    report: renderReport(surfaces, findings),
    jsonPayload: {
      failed,
      findings,
      surfaceCount: surfaces.length,
      surfaces,
      actionable: surfaces.map((surface) => ({
        id: surface.id,
        label: surface.label,
        smokePath: surface.smokePath,
      })),
    },
  };
}

export const audit = {
  id: "arkitect-matrix",
  title: "Arkitect Matrix",
  category: "product",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    includeInAll: false,
    outputPath: "tmp/audits/ARKITECT_MATRIX.md",
    surfaces: DEFAULT_SURFACES,
  },
  async run(context) {
    return runArchitectMatrixAudit(context);
  },
};
