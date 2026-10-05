// The REST path table (ROUTES) is the single source of truth in ../../shared/routes —
// the daemon's Hono registrations, the web client's fetches and the MCP client all build
// URLs from it. Re-exported here so a module nested under src/<dir>/ reaches it with a
// one-level import, the same shape ./constants and ./types give the shared constants and
// DTOs.
export { ROUTES } from "../../shared/routes";
