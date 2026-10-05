import type { ProcessDef, ProcessView, Status } from "./types";

/** The live runtime fields of a managed process that a {@link ProcessView} projects. */
export interface ProcessRuntime {
  status: Status;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  exitCode: number | null;
  cpu: number | null;
  memory: number | null;
  portInUse: boolean;
  waitingOnPort: number | null;
  configChanged: boolean;
}

/**
 * Project a process's persisted definition + live runtime state into the client-facing
 * {@link ProcessView}. Pure: same inputs → same output, no manager state touched.
 * `enabled` is the resolved run-intent (the manager computes it from the toggles).
 */
export function toProcessView(def: ProcessDef, e: ProcessRuntime, enabled: boolean): ProcessView {
  const conflict = !!(def.port && e.portInUse && e.status !== "running" && e.status !== "starting");
  return {
    id: def.id,
    localId: def.localId,
    name: def.name,
    command: def.command,
    cwd: def.cwd,
    cwdRaw: def.cwdRaw,
    color: def.color,
    autostart: def.autostart,
    starred: def.starred,
    enabled,
    port: def.port,
    url: def.url,
    runtime: def.runtime,
    waitForPort: def.waitForPort,
    links: def.links,
    companion: def.companion,
    projectId: def.projectId,
    projectName: def.projectName,
    status: e.status,
    pid: e.pid,
    startedAt: e.startedAt,
    restarts: e.restarts,
    exitCode: e.exitCode,
    cpu: e.cpu,
    memory: e.memory,
    conflict,
    waitingOnPort: e.waitingOnPort ?? undefined,
    configChanged: e.configChanged || undefined,
  };
}
