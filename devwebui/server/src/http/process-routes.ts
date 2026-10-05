import type { Context, Hono } from "hono";
import type { Manager } from "../manager";
import {
  addProcessToFile,
  readDevWebUIFile,
  registryRemove,
  removeProcessFromFile,
  setProcessStarred,
  updateProcessInFile,
  updateProjectMeta,
} from "../projects";
import type { ProjectView } from "../types";
import { ROUTES } from "../routes";
import { createProcessShortcut, createProjectShortcut } from "../shortcuts";
import { fail, guard, readBody } from "./core";

/** Re-read a project's file and apply it, preserving unchanged running processes. */
function reloadProject(manager: Manager, id: string): ProjectView | null {
  const filePath = manager.getProjectPath(id);
  if (!filePath) return null;
  manager.reconcileProject(readDevWebUIFile(filePath));
  return manager.listProjects().find((p) => p.id === id) ?? null;
}

/**
 * Resolve a project's .devwebui path, or a 404 `{ error: "unknown project" }` to
 * return. Call sites must `return` the {@link Response} when one comes back:
 * `if (p instanceof Response) return p;`.
 */
function requireProjectPath(c: Context, manager: Manager, id: string): string | Response {
  const filePath = manager.getProjectPath(id);
  return filePath ?? fail(c, "unknown project", 404);
}

async function handleProjectUpdate(c: Context, manager: Manager) {
  const { id } = c.req.param();
  const filePath = requireProjectPath(c, manager, id);
  if (filePath instanceof Response) return filePath;
  const body = await readBody(c);
  return guard(c, () => {
    updateProjectMeta(filePath, {
      name: typeof body?.name === "string" ? body.name : undefined,
      color: typeof body?.color === "string" ? body.color : undefined,
    });
    return c.json({ ok: true, project: reloadProject(manager, id) });
  });
}

async function handleAddProcess(c: Context, manager: Manager) {
  const { id } = c.req.param();
  const filePath = requireProjectPath(c, manager, id);
  if (filePath instanceof Response) return filePath;
  const body = await readBody(c);
  return guard(c, () => {
    addProcessToFile(filePath, body);
    return c.json({ ok: true, project: reloadProject(manager, id) });
  });
}

async function handleUpdateProcess(c: Context, manager: Manager) {
  const { id, localId } = c.req.param();
  const filePath = requireProjectPath(c, manager, id);
  if (filePath instanceof Response) return filePath;
  const body = await readBody(c);
  return guard(c, () => {
    updateProcessInFile(filePath, localId, body);
    return c.json({ ok: true, project: reloadProject(manager, id) });
  });
}

async function handleRemoveProcess(c: Context, manager: Manager) {
  const { id, localId } = c.req.param();
  const filePath = requireProjectPath(c, manager, id);
  if (filePath instanceof Response) return filePath;
  return guard(c, () => {
    removeProcessFromFile(filePath, localId);
    return c.json({ ok: true, project: reloadProject(manager, id) });
  });
}

async function handleStarProcess(c: Context, manager: Manager) {
  const { id, localId } = c.req.param();
  const filePath = requireProjectPath(c, manager, id);
  if (filePath instanceof Response) return filePath;
  const body = await readBody(c);
  return guard(c, () => {
    setProcessStarred(filePath, localId, !!body?.starred);
    return c.json({ ok: true, project: reloadProject(manager, id) });
  });
}

// Desktop shortcut for a whole codebase. Registered BEFORE projectAction: Hono
// matches in registration order, and `/:id/:action` would otherwise claim
// `/:id/shortcut` and reject it as an unknown action.
async function handleProjectShortcut(c: Context, manager: Manager) {
  const { id } = c.req.param();
  const proj = manager.listProjects().find((p) => p.id === id);
  if (!proj) return fail(c, "unknown project", 404);
  return c.json(await createProjectShortcut({ devwebuiPath: proj.path, projectName: proj.name }));
}

/** One entry per POST /projects/:id/:action value. A data-driven table in place of the
 *  original if/else-if chain — same behaviour, unrecognized actions simply have no entry. */
const PROJECT_ACTIONS: Record<
  string,
  (manager: Manager, id: string, proj: ProjectView) => unknown
> = {
  start: (manager, id) => manager.startProject(id),
  stop: (manager, id) => manager.stopProject(id),
  enable: (manager, id) => manager.setProjectEnabled(id, true),
  disable: (manager, id) => manager.setProjectEnabled(id, false),
  remove: async (manager, id, proj) => {
    await manager.removeProject(id);
    registryRemove(proj.path);
  },
};

async function handleProjectAction(c: Context, manager: Manager) {
  const { id, action } = c.req.param();
  const proj = manager.listProjects().find((p) => p.id === id);
  if (!proj) return fail(c, "unknown project", 404);
  // guard(): an unexpected manager throw becomes the same `{ error }` shape every other
  // route returns, instead of Hono's bare text/plain 500 — the CLI and MCP surface the
  // message verbatim, so a raw 500 loses the only diagnostic the caller ever sees.
  return guard(c, async () => {
    const run = Object.hasOwn(PROJECT_ACTIONS, action) ? PROJECT_ACTIONS[action] : undefined;
    if (!run) return fail(c, "unknown action");
    await run(manager, id, proj);
    return c.json({ ok: true });
  });
}

function handleProcessLogFile(c: Context, manager: Manager) {
  const { id } = c.req.param();
  if (!manager.view(id)) return fail(c, "unknown process", 404);
  const linesParam = Number(c.req.query("lines"));
  const lines = Number.isFinite(linesParam) && linesParam > 0 ? Math.floor(linesParam) : 200;
  return c.json({ id, lines: manager.getLogFileTail(id, lines) });
}

async function handleProcessFreePort(c: Context, manager: Manager) {
  const { id } = c.req.param();
  const v = manager.view(id);
  if (!v) return fail(c, "unknown process", 404);
  if (!v.port) return fail(c, "process has no declared port");
  // Stop a managed holder cleanly; require explicit confirm to kill external owners.
  const body = await readBody(c);
  return c.json(await manager.freeProcessPort(id, { confirm: !!body.confirm }));
}

async function handleProcessDiagnose(c: Context, manager: Manager) {
  const { id } = c.req.param();
  const diagnosis = await manager.diagnoseProcess(id);
  if (!diagnosis) return fail(c, "unknown process", 404);
  return c.json(diagnosis);
}

// Desktop shortcut for ONE process. Registered BEFORE processAction for the same
// `/:id/:action` shadowing reason as free-port/diagnose above. Returns the shortcut
// module's result verbatim, including its non-throwing `{ ok: false, reason }`
// shapes (a Mac/Linux caller, or a PowerShell that refused) — the GUI reports those
// rather than treating them as a request failure.
async function handleProcessShortcut(c: Context, manager: Manager) {
  const { id } = c.req.param();
  const v = manager.view(id);
  if (!v) return fail(c, "unknown process", 404);
  const filePath = manager.getProjectPath(v.projectId);
  if (!filePath) return fail(c, "unknown project", 404);
  return c.json(
    await createProcessShortcut({
      devwebuiPath: filePath,
      localId: v.localId,
      processName: v.name,
      projectName: v.projectName,
    }),
  );
}

type ProcessActionResult = { coStarted?: string[]; coStopped?: string[] } | undefined;

/** One entry per POST /processes/:id/:action value. A linked group acts as one unit:
 *  startWithLinks also brings up the linked group + project companions; stopWithLinks
 *  brings the linked group down. `coStarted`/`coStopped` list the OTHER processes the
 *  action set in motion, so the GUI (and MCP callers) can surface the ripple. */
const PROCESS_ACTIONS: Record<
  string,
  (manager: Manager, id: string) => ProcessActionResult | Promise<ProcessActionResult>
> = {
  start: (manager, id) => ({ coStarted: manager.startWithLinks(id).coStarted }),
  stop: async (manager, id) => ({ coStopped: await manager.stopWithLinks(id) }),
  restart: async (manager, id) => {
    await manager.restart(id);
  },
  enable: (manager, id) => {
    manager.setProcessEnabled(id, true);
  },
  disable: (manager, id) => {
    manager.setProcessEnabled(id, false);
  },
};

async function handleProcessAction(c: Context, manager: Manager) {
  const { id, action } = c.req.param();
  if (!manager.view(id)) return fail(c, "unknown process", 404);
  // guard(): see the note on projectAction above — same reason, same shape.
  return guard(c, async () => {
    const run = Object.hasOwn(PROCESS_ACTIONS, action) ? PROCESS_ACTIONS[action] : undefined;
    if (!run) return fail(c, "unknown action");
    const result = (await run(manager, id)) ?? {};
    return c.json({
      ok: true,
      process: manager.view(id),
      coStarted: result.coStarted,
      coStopped: result.coStopped,
    });
  });
}

/** Register project-process-editing routes and live-process-instance routes. */
export function registerProcessRoutes(app: Hono, manager: Manager) {
  // ---- project meta editing (rename + recolor — rewrites the file, then reconciles) ----
  app.put(ROUTES.projectUpdate.pattern, (c) => handleProjectUpdate(c, manager));

  // ---- process editing (rewrites the .devwebui file, then reconciles) ----
  app.post(ROUTES.projectProcesses.pattern, (c) => handleAddProcess(c, manager));
  app.put(ROUTES.projectProcess.pattern, (c) => handleUpdateProcess(c, manager));
  app.delete(ROUTES.projectProcess.pattern, (c) => handleRemoveProcess(c, manager));
  app.post(ROUTES.projectProcessStar.pattern, (c) => handleStarProcess(c, manager));

  app.post(ROUTES.projectShortcut.pattern, (c) => handleProjectShortcut(c, manager));
  app.post(ROUTES.projectAction.pattern, (c) => handleProjectAction(c, manager));

  // ---- processes ----
  app.get(ROUTES.processes, (c) => c.json(manager.list()));
  app.get(ROUTES.processLogs.pattern, (c) =>
    c.json({ id: c.req.param("id"), lines: manager.getLogs(c.req.param("id")) }),
  );
  // Time-Travel Log Vault: tail the on-disk rotating log file (survives daemon
  // restarts and the in-memory 500-line cap). No search/indexing — just a tail.
  app.get(ROUTES.processLogFile.pattern, (c) => handleProcessLogFile(c, manager));
  app.post(ROUTES.startAll, (c) => {
    manager.startAll();
    return c.json({ ok: true });
  });
  app.post(ROUTES.stopAll, async (c) => {
    await manager.stopAll();
    return c.json({ ok: true });
  });
  app.post(ROUTES.processFreePort.pattern, (c) => handleProcessFreePort(c, manager));

  // The origin the CALLER reached the daemon on is, by construction, a URL that works from the
  // caller's side, which is the point of the block (the GUI's linkHost is the browser's view).
  app.get(ROUTES.runtimeServices, (c) =>
    c.json(manager.runtimeServices(new URL(c.req.url).origin, c.req.query("all") === "1")),
  );

  // Incident Autopilot: composite root-cause guess + remediation suggestion (never auto-executed).
  app.get(ROUTES.processDiagnose.pattern, (c) => handleProcessDiagnose(c, manager));

  app.post(ROUTES.processShortcut.pattern, (c) => handleProcessShortcut(c, manager));

  app.post(ROUTES.processAction.pattern, (c) => handleProcessAction(c, manager));
}
