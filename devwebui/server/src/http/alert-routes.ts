// Adapted from PostHog products/alerts/ (threshold alerting on insights/dashboards, MIT) -
// the REST surface for server/src/alerts.ts's rule CRUD + fired-event history, following
// this codebase's own process-routes.ts / core.ts conventions (readBody/fail/guard, one
// handler per route, a thin registration function).
import type { Context, Hono } from "hono";
import type { AlertMetric, AlertRuleInput } from "../alerts";
import { ROUTES } from "../routes";
import type { Manager } from "../manager";
import { fail, guard, readBody } from "./core";

const METRICS: AlertMetric[] = ["cpu", "memory"];

const isNonNegativeNumber = (v: unknown): boolean => Number.isFinite(Number(v)) && Number(v) >= 0;

/** Validate a full rule-creation body; returns the typed input or a 400 Response to return. */
function parseRuleInput(c: Context, body: unknown): AlertRuleInput | Response {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.processId !== "string" || !b.processId) return fail(c, "processId is required");
  if (typeof b.metric !== "string" || !METRICS.includes(b.metric as AlertMetric))
    return fail(c, "metric must be one of: cpu, memory");
  if (!isNonNegativeNumber(b.threshold)) return fail(c, "threshold must be a non-negative number");
  if (b.forMs !== undefined && !isNonNegativeNumber(b.forMs))
    return fail(c, "forMs must be a non-negative number");
  return {
    processId: b.processId,
    metric: b.metric as AlertMetric,
    threshold: Number(b.threshold),
    forMs: Number(b.forMs ?? 0),
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
  };
}

async function handleAddRule(c: Context, manager: Manager) {
  const body = await readBody(c);
  const input = parseRuleInput(c, body);
  if (input instanceof Response) return input;
  if (!manager.view(input.processId)) return fail(c, "unknown process", 404);
  return guard(c, () => c.json(manager.addAlertRule(input)));
}

/** Validate an update patch's OPTIONAL fields: the error message, or null when they're fine.
 *  An absent field is always valid — a caller may just flip `enabled`. */
function rulePatchError(b: Record<string, unknown>): string | null {
  if (b.metric !== undefined && !METRICS.includes(b.metric as AlertMetric))
    return "metric must be one of: cpu, memory";
  if (b.threshold !== undefined && !isNonNegativeNumber(b.threshold))
    return "threshold must be a non-negative number";
  if (b.forMs !== undefined && !isNonNegativeNumber(b.forMs))
    return "forMs must be a non-negative number";
  return null;
}

/** The subset of a patch body the caller actually sent, coerced to the manager's input shape. */
function rulePatchFrom(b: Record<string, unknown>): Partial<AlertRuleInput> {
  return {
    processId: typeof b.processId === "string" ? b.processId : undefined,
    metric: b.metric as AlertMetric | undefined,
    threshold: b.threshold !== undefined ? Number(b.threshold) : undefined,
    forMs: b.forMs !== undefined ? Number(b.forMs) : undefined,
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
  };
}

async function handleUpdateRule(c: Context, manager: Manager) {
  const { id } = c.req.param();
  const body = await readBody(c);
  // Every field is optional here (unlike create) - a caller may just flip `enabled`.
  const b = (body ?? {}) as Record<string, unknown>;
  const invalid = rulePatchError(b);
  if (invalid) return fail(c, invalid);
  return guard(c, () => {
    const updated = manager.updateAlertRule(id, rulePatchFrom(b));
    if (!updated) return fail(c, "unknown alert rule", 404);
    return c.json(updated);
  });
}

function handleRemoveRule(c: Context, manager: Manager) {
  const { id } = c.req.param();
  if (!manager.removeAlertRule(id)) return fail(c, "unknown alert rule", 404);
  return c.json({ ok: true });
}

/** Register the alert-rule CRUD routes + fired-event history routes. */
export function registerAlertRoutes(app: Hono, manager: Manager) {
  app.get(ROUTES.alertRules, (c) => c.json(manager.listAlertRules()));
  app.post(ROUTES.alertRules, (c) => handleAddRule(c, manager));
  app.put(ROUTES.alertRule.pattern, (c) => handleUpdateRule(c, manager));
  app.delete(ROUTES.alertRule.pattern, (c) => handleRemoveRule(c, manager));

  app.get(ROUTES.alertEvents, (c) => c.json(manager.listAlertEvents()));
  app.post(ROUTES.alertEventsClear, (c) => {
    manager.clearAlertEvents(c.req.query("processId") || undefined);
    return c.json({ ok: true });
  });
}
