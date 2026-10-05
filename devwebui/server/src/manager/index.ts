import { ManagerWithProjects } from "./projects";

// `FreePortResult` (the outcome of a manual "free this port" request) is a shared
// DTO; re-export it so `import { FreePortResult } from "./manager"` works.
export type { FreePortResult } from "../types";
export { START_STAGGER_MS } from "./types";

/**
 * Single source of truth for every managed project + process. The HTTP/SSE
 * surface (GUI) and the MCP surface (agents) both read and command through this.
 * Emits "status" (ProcessView), "log" (LogLine), and "projects" (ProjectView[]
 * — on any structural add/remove).
 */
export class Manager extends ManagerWithProjects {}
