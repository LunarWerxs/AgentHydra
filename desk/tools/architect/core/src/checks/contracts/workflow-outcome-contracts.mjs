import fs from "node:fs/promises";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";
import { normalizePath, relativePath } from "@saydeploy/architect/core/path";

const DEFAULT_WORKFLOWS = [
  {
    id: "hosted-event-settings-delete",
    label: "Hosted event settings delete",
    filePath: "src/components/workspace/views/host/WorkspaceHostConsoleView.vue",
    functionName: "confirmAndDeleteSelectedEvent",
    acknowledgementMarkers: ["const deleted = await hostEvents.deleteSelectedEvent();"],
    successGateMarkers: ["if (deleted) {"],
    successSideEffectMarkers: [
      "insertHostedEventTrashEntry(deletedEvent);",
      'emit("hostedEventDeleted", deletedEvent);',
      'showHostConsoleToast(tr("deletedEventToast"));',
    ],
    failureMarkers: ['showHostConsoleToast(hostEvents.deleteError || tr("deleteErrorFallback"));'],
  },
  {
    id: "hosted-event-row-delete",
    label: "Hosted event row delete",
    filePath: "src/components/workspace/views/host/console/useHostConsoleRowActions.ts",
    functionName: "deleteHostEventFromRow",
    acknowledgementMarkers: [
      "let deleted = false;",
      "deleted = await hostEvents.deleteSelectedEvent();",
      "deleted = true;",
    ],
    successGateMarkers: ["if (!deleted) {"],
    successSideEffectMarkers: [
      "insertHostedEventTrashEntry(row);",
      'emit("hostedEventDeleted", row);',
      'showHostConsoleToast(tr("deletedEventToast"));',
    ],
    failureMarkers: [
      "hostEvents.events = previousEvents;",
      'hostEvents.listError = hostEvents.deleteError || tr("deleteErrorFallback");',
    ],
  },
  {
    id: "saved-hosted-event-unsave",
    label: "Saved hosted event unsave",
    filePath: "src/components/workspace/views/events/WorkspaceEventScheduleView.vue",
    functionName: "unsaveHostedEventFromDirectory",
    acknowledgementMarkers: ["await setHostedEventAccountSave(slug, false);"],
    successGateMarkers: ["await setHostedEventAccountSave(slug, false);"],
    optimisticSideEffectMarkers: ["optimisticallyRemovedSavedHostedEventIds.value = new Set(["],
    successSideEffectMarkers: ['state.value.showToast(tr("actions.unsavedHostedEvent"));'],
    rollbackMarkers: [
      "removedIds.delete(savedEventKey);",
      "optimisticallyRemovedSavedHostedEventIds.value = removedIds;",
    ],
    failureMarkers: [
      'state.value.setActionError(error instanceof Error ? error.message : tr("errors.unsaveHostedEventFailed"));',
    ],
  },
  {
    id: "shared-calendar-event-unlink",
    label: "Shared calendar event unlink",
    filePath: "src/composables/workspace/calendar/useSharedCalendarEvents.ts",
    functionName: "useSharedCalendarEvents",
    acknowledgementMarkers: [
      "const unlinkEventMutation = useSharedCalendarUnlinkEventMutation<UnlinkSnapshot>({",
      "unlinkEventMutation.mutate(",
    ],
    successGateMarkers: [
      `onSuccess: () => {
          insertTrashedWorkspaceEntry?.({`,
    ],
    optimisticSideEffectMarkers: [
      "applyOptimistic: (calendarId, eventId) => {",
      "eventIds: calendar.eventIds.filter((value) => value !== eventId),",
    ],
    successSideEffectMarkers: ["insertTrashedWorkspaceEntry?.({", "selectedScheduleEventId.value = null;"],
    rollbackMarkers: [
      "rollback: (calendarId, eventId, snapshot) => {",
      "snapshot.hadEventId && !calendar.eventIds.includes(eventId)",
      "snapshot.link && !calendar.eventLinks.some((l) => l.eventId === eventId)",
    ],
    failureMarkers: ['toErrorMessage(error, "Unable to remove the event from this shared calendar.")'],
  },
  {
    id: "workspace-form-delete",
    label: "Workspace form delete",
    filePath: "src/components/workspace/views/forms/WorkspaceFormsView.vue",
    functionName: "deleteForm",
    acknowledgementMarkers: [
      "pendingDeleteFormId.value = selectedWorkspaceForm.id;",
      "await deleteWorkspaceForm({ formId: selectedWorkspaceForm.id, ownerProfileId: ownerProfileId.value });",
    ],
    successGateMarkers: [
      "await deleteWorkspaceForm({ formId: selectedWorkspaceForm.id, ownerProfileId: ownerProfileId.value });",
    ],
    successSideEffectMarkers: [
      "await invalidateWorkspaceFormsQuery(appQueryClient, ownerProfileId.value);",
      "forms.value = forms.value.filter((entry) => entry.id !== selectedWorkspaceForm.id);",
      "closeDetail();",
      'notice.value = "Form deleted.";',
    ],
    failureMarkers: ['error.value = err instanceof Error ? err.message : "Unable to delete this form.";'],
  },
  {
    id: "workspace-form-save-publish",
    label: "Workspace form save/publish",
    filePath: "src/components/workspace/views/forms/WorkspaceFormsView.vue",
    functionName: "saveForm",
    acknowledgementMarkers: [
      "const saved = await updateWorkspaceForm(selectedWorkspaceForm.id, {",
      "isActive: draft.isActive,",
    ],
    successGateMarkers: ["const saved = await updateWorkspaceForm(selectedWorkspaceForm.id, {"],
    successSideEffectMarkers: [
      "await invalidateWorkspaceFormsQuery(appQueryClient, ownerProfileId.value);",
      "updateFormInState(saved);",
      "syncDraft(saved);",
      'notice.value = "Form saved.";',
    ],
    failureMarkers: ['error.value = err instanceof Error ? err.message : "Unable to save this form.";'],
  },
  {
    id: "hosted-event-order-refund",
    label: "Hosted event order refund",
    filePath: "src/composables/workspace/host/useWorkspaceHostedEventTicketingState.ts",
    functionName: "refundOrder",
    acknowledgementMarkers: [
      "const refundedOrder = await refundHostedEventOrder(normalizedOrderId, refundReason, refundAmountCents);",
    ],
    successGateMarkers: [
      "const refundedOrder = await refundHostedEventOrder(normalizedOrderId, refundReason, refundAmountCents);",
    ],
    successSideEffectMarkers: [
      "orders: (selectedEvent.value.orders ?? []).map(replaceOrder),",
      "orders: (selectedEventDraft.value.orders ?? []).map(replaceOrder),",
    ],
    failureMarkers: [
      'ticketingActionError.value = error instanceof Error ? error.message : "Unable to refund the hosted event order.";',
    ],
  },
  {
    id: "billing-checkout-redirect",
    label: "Billing checkout redirect",
    filePath: "src/lib/vault-api/billing.ts",
    functionName: "startBillingCheckout",
    acknowledgementMarkers: [
      "const { data, error } = await getApiClient().functions.invoke<{ url?: string }>(",
      '"billing-api/checkout"',
    ],
    successGateMarkers: ['if (!data?.url) throw new Error("Stripe did not return a checkout URL.");'],
    successSideEffectMarkers: ["return data.url;"],
    failureMarkers: [
      'if (error) throw toInvokeError(error, "Unable to start checkout.");',
      'if (!data?.url) throw new Error("Stripe did not return a checkout URL.");',
    ],
  },
  {
    id: "billing-portal-redirect",
    label: "Billing portal redirect",
    filePath: "src/lib/vault-api/billing.ts",
    functionName: "openBillingPortal",
    acknowledgementMarkers: [
      "const { data, error } = await getApiClient().functions.invoke<{ url?: string }>(",
      '"billing-api/portal"',
    ],
    successGateMarkers: ['if (!data?.url) throw new Error("Stripe did not return a portal URL.");'],
    successSideEffectMarkers: ["return data.url;"],
    failureMarkers: [
      'if (error) throw toInvokeError(error, "Unable to open billing portal.");',
      'if (!data?.url) throw new Error("Stripe did not return a portal URL.");',
    ],
  },
  {
    id: "shared-calendar-paid-access-toggle",
    label: "Shared calendar paid access toggle",
    filePath: "src/composables/workspace/calendar/useSharedCalendarCrud.ts",
    functionName: "setSharedCalendarPaidAccess",
    acknowledgementMarkers: ["const updatedCalendar = await updateSharedCalendarBilling(calendarId, {"],
    successGateMarkers: ["const updatedCalendar = await updateSharedCalendarBilling(calendarId, {"],
    successSideEffectMarkers: [
      "sharedCalendars.value = sharedCalendars.value.map((calendar) =>",
      'showToast(enabled ? "Paid calendar access is on." : "Paid calendar access is off.");',
      "return true;",
    ],
    failureMarkers: [
      'error instanceof Error ? error.message : "Unable to update shared calendar paid access.";',
      "return false;",
    ],
  },
];

function lineNumberForIndex(source, index) {
  if (index < 0) return 0;
  return source.slice(0, index).split(/\r?\n/u).length;
}

async function readSource(root, filePath) {
  return fs.readFile(path.resolve(root, filePath), "utf8");
}

function sourceMissingFinding({ workflow, error }) {
  return createFinding({
    ruleId: "workflow-contract-source-missing",
    severity: "error",
    filePath: workflow.filePath,
    line: 0,
    message: `${workflow.label} source could not be read: ${error.message}`,
    metadata: {
      workflowId: workflow.id,
    },
  });
}

function markerMissingFinding({ workflow, marker, markerRole, source, functionStart }) {
  return createFinding({
    ruleId: "workflow-contract-marker-missing",
    severity: "error",
    filePath: workflow.filePath,
    line: lineNumberForIndex(source, functionStart),
    message: `${workflow.label} is missing ${markerRole} marker "${marker}".`,
    metadata: {
      workflowId: workflow.id,
      marker,
      markerRole,
      functionName: workflow.functionName,
    },
  });
}

function functionMissingFinding({ workflow }) {
  return createFinding({
    ruleId: "workflow-contract-function-missing",
    severity: "error",
    filePath: workflow.filePath,
    line: 0,
    message: `${workflow.label} function "${workflow.functionName}" could not be found.`,
    metadata: {
      workflowId: workflow.id,
      functionName: workflow.functionName,
    },
  });
}

function successNotGatedFinding({ workflow, marker, source, markerIndex }) {
  return createFinding({
    ruleId: "workflow-success-not-gated",
    severity: "error",
    filePath: workflow.filePath,
    line: lineNumberForIndex(source, markerIndex),
    message: `${workflow.label} success-only side effect "${marker}" must be gated behind a configured success acknowledgement.`,
    metadata: {
      workflowId: workflow.id,
      marker,
      functionName: workflow.functionName,
    },
  });
}

function optimisticRollbackMissingFinding({ workflow, marker, source, markerIndex }) {
  return createFinding({
    ruleId: "workflow-optimistic-rollback-missing",
    severity: "error",
    filePath: workflow.filePath,
    line: lineNumberForIndex(source, markerIndex),
    message: `${workflow.label} optimistic side effect "${marker}" must have a configured rollback marker.`,
    metadata: {
      workflowId: workflow.id,
      marker,
      functionName: workflow.functionName,
    },
  });
}

function findMatchingBrace(source, openBraceIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    // Skip line comments — apostrophes inside `// don't` would otherwise open a quote.
    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) return -1;
      index = newline;
      continue;
    }
    // Skip block comments.
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) return -1;
      index = close + 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function extractFunctionSource(source, functionName) {
  const escapedFunctionName = functionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`\\bfunction\\s+${escapedFunctionName}\\s*\\(`, "u");
  const match = source.match(pattern);
  if (!match || match.index === undefined) {
    return null;
  }

  const openBraceIndex = source.indexOf("{", match.index);
  if (openBraceIndex < 0) {
    return null;
  }

  const closeBraceIndex = findMatchingBrace(source, openBraceIndex);
  if (closeBraceIndex < 0) {
    return null;
  }

  return {
    start: match.index,
    source: source.slice(match.index, closeBraceIndex + 1),
  };
}

function configuredMarkers(value) {
  return (Array.isArray(value) ? value : []).map((marker) => String(marker ?? "").trim()).filter(Boolean);
}

function auditFunctionContract(source, workflow) {
  const findings = [];
  const functionSource = extractFunctionSource(source, workflow.functionName);
  if (!functionSource) {
    return {
      findings: [functionMissingFinding({ workflow })],
      markerCount: 0,
    };
  }

  const markerRoles = [
    ["acknowledgement", configuredMarkers(workflow.acknowledgementMarkers)],
    ["success gate", configuredMarkers(workflow.successGateMarkers)],
    ["optimistic side effect", configuredMarkers(workflow.optimisticSideEffectMarkers)],
    ["success side effect", configuredMarkers(workflow.successSideEffectMarkers)],
    ["rollback", configuredMarkers(workflow.rollbackMarkers)],
    ["failure/rollback", configuredMarkers(workflow.failureMarkers)],
  ];
  const foundMarkers = [];

  for (const [markerRole, markers] of markerRoles) {
    for (const marker of markers) {
      const markerIndex = functionSource.source.indexOf(marker);
      if (markerIndex < 0) {
        findings.push(
          markerMissingFinding({
            workflow,
            marker,
            markerRole,
            source,
            functionStart: functionSource.start,
          }),
        );
        continue;
      }
      foundMarkers.push(marker);
    }
  }

  const gateIndexes = configuredMarkers(workflow.successGateMarkers)
    .map((marker) => functionSource.source.indexOf(marker))
    .filter((index) => index >= 0);

  for (const marker of configuredMarkers(workflow.successSideEffectMarkers)) {
    const markerIndex = functionSource.source.indexOf(marker);
    if (markerIndex < 0) continue;

    const hasPriorGate = gateIndexes.some((gateIndex) => gateIndex < markerIndex);
    if (!hasPriorGate) {
      findings.push(
        successNotGatedFinding({
          workflow,
          marker,
          source,
          markerIndex: functionSource.start + markerIndex,
        }),
      );
    }
  }

  const rollbackIndexes = configuredMarkers(workflow.rollbackMarkers)
    .map((marker) => functionSource.source.indexOf(marker))
    .filter((index) => index >= 0);

  for (const marker of configuredMarkers(workflow.optimisticSideEffectMarkers)) {
    const markerIndex = functionSource.source.indexOf(marker);
    if (markerIndex < 0) continue;

    const hasRollbackAfterOptimisticEffect = rollbackIndexes.some((rollbackIndex) => rollbackIndex > markerIndex);
    if (!hasRollbackAfterOptimisticEffect) {
      findings.push(
        optimisticRollbackMissingFinding({
          workflow,
          marker,
          source,
          markerIndex: functionSource.start + markerIndex,
        }),
      );
    }
  }

  return {
    findings,
    markerCount: foundMarkers.length,
  };
}

async function auditWorkflow(root, workflow) {
  let source;
  try {
    source = await readSource(root, workflow.filePath);
  } catch (error) {
    return {
      workflow,
      markerCount: 0,
      findings: [sourceMissingFinding({ workflow, error })],
    };
  }

  return {
    workflow,
    ...auditFunctionContract(source, workflow),
  };
}

function renderReport(results, findings) {
  const lines = [
    "# Workflow Outcome Contracts Audit",
    "",
    "Checks that destructive/user-visible async workflows gate success-only side effects behind explicit success acknowledgement and preserve failure/rollback handling.",
    "",
  ];

  if (findings.length === 0) {
    lines.push("No workflow outcome contract drift found.", "");
  } else {
    lines.push("## Findings", "");
    for (const finding of findings) {
      const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.ruleId} at \`${location}\`: ${finding.message}`);
    }
    lines.push("");
  }

  lines.push("## Workflows", "");
  lines.push("| Workflow | Function | Markers found | Findings |");
  lines.push("| --- | --- | ---: | ---: |");
  for (const result of results) {
    lines.push(
      `| ${result.workflow.label} | ${result.workflow.functionName} | ${result.markerCount} | ${result.findings.length} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

export async function runWorkflowOutcomeContractsAudit({ root = process.cwd(), checkConfig = {}, config = {} } = {}) {
  const workflows =
    Array.isArray(checkConfig.workflows) && checkConfig.workflows.length ? checkConfig.workflows : DEFAULT_WORKFLOWS;
  const normalizedWorkflows = workflows.map((workflow) => ({
    ...workflow,
    filePath: normalizePath(workflow.filePath),
  }));

  const results = [];
  for (const workflow of normalizedWorkflows) {
    results.push(await auditWorkflow(root, workflow));
  }

  const findings = results.flatMap((result) => result.findings);
  const failed = findings.some((finding) => finding.severity === "error");
  const outputPath = checkConfig.outputPath ?? config.checks?.["workflow-outcome-contracts"]?.outputPath;

  return {
    failed,
    findings,
    outputPath,
    report: renderReport(results, findings),
    jsonPayload: {
      failed,
      findings,
      workflows: results.map((result) => ({
        id: result.workflow.id,
        label: result.workflow.label,
        filePath: relativePath(root, path.resolve(root, result.workflow.filePath)),
        functionName: result.workflow.functionName,
        markerCount: result.markerCount,
        findingsCount: result.findings.length,
      })),
    },
  };
}

export const audit = {
  id: "workflow-outcome-contracts",
  title: "Workflow Outcome Contracts",
  category: "product",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    includeInAll: true,
    outputPath: "tmp/audits/WORKFLOW_OUTCOME_CONTRACTS_AUDIT.md",
    workflows: DEFAULT_WORKFLOWS,
  },
  async run(context) {
    return runWorkflowOutcomeContractsAudit(context);
  },
};
