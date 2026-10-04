/**
 * Compatibility shim — delegates to auto-discovery.
 *
 * All imports of @saydeploy/architect/cli/registry still work,
 * but the underlying mechanism is now filesystem auto-discovery.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAudits } from "./discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checksRoot = path.resolve(__dirname, "..", "checks");

const _discovered = await discoverAudits(checksRoot);

export const AUDITS = _discovered.audits;
export const AUDIT_GROUPS = _discovered.groups;

export function getAudit(checkId) {
  return AUDITS.find((audit) => audit.id === checkId) ?? null;
}
