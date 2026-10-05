import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import type { Manager } from "../manager";
import {
  browseForDevWebUIFile,
  browseForFolder,
  cloneRepo,
  ignoreProject,
  projectIdFromPath,
  readDevWebUIFile,
  readIgnoredProjects,
  readRegistry,
  registryAdd,
  resolveLoadTarget,
  scaffoldDevWebUIFile,
  suggestCloneDest,
  unignoreProject,
} from "../projects";
import type { LoadTarget } from "../projects";
import {
  canRestoreAutostart,
  detectAutostartTriggers,
  restoreAutostart,
  takeOverAutostart,
} from "../takeover";
import { scanForDevWebUI, SCAN_PRESETS, type ScanPreset } from "../scan";
import { readSettings } from "../runtime";
import type { ProjectView } from "../types";
import { ROUTES } from "../routes";
import { fail, guard, readBody } from "./core";

/** True the first time a given .devwebui path is loaded on this machine. */
function isFirstLoad(absPath: string): boolean {
  const id = projectIdFromPath(absPath);
  return !readRegistry().some((p) => projectIdFromPath(p) === id);
}

/**
 * Read a .devwebui file, register it, persist it to the registry.
 *
 * A FIRST-EVER load never auto-starts, even for processes marked `autostart: true`.
 * "Add project" reads to a user as *register this*, not *execute this* — but a
 * `.devwebui` is arbitrary shell, and the clone flow's whole purpose is pointing this
 * at a repo the user hasn't read yet. Registering it silently ran that repo's command
 * as the user, with no preview. Now the processes appear stopped, with their commands
 * visible, and starting them is an explicit click. Re-loads of an ALREADY-known project
 * keep auto-starting per their toggles (the user has seen it before, and the boot loop
 * has its own `autoStartOnLaunch` gate).
 */
function loadProject(
  manager: Manager,
  filePath: string,
): { project: ProjectView; firstLoad: boolean } {
  const lp = readDevWebUIFile(filePath);
  const firstLoad = isFirstLoad(lp.path);
  manager.addProject(lp, { autostart: !firstLoad });
  registryAdd(lp.path);
  return { project: manager.listProjects().find((p) => p.id === lp.id)!, firstLoad };
}

/**
 * Attach any external auto-start triggers (VS Code tasks.json folderOpen, the
 * "Vite" extension's vite.autoStart) found in the project's folder, so the GUI
 * can offer to retire them. `dir` rides along so the GUI can call take-over.
 */
function withTriggers(body: Record<string, unknown>, dir: string) {
  const autostartTriggers = detectAutostartTriggers(dir);
  return autostartTriggers.length ? { ...body, autostartTriggers, dir } : body;
}

// Turn a resolved target into a JSON body: load the file, offer a scaffold, or error.
function targetBody(manager: Manager, t: LoadTarget, extra: Record<string, unknown> = {}) {
  if (t.kind === "file") {
    try {
      const body = withTriggers(
        { ok: true, ...loadProject(manager, t.file), ...extra },
        path.dirname(t.file),
      );
      return { body, status: 200 as const };
    } catch (e) {
      return { body: { error: (e as Error).message, ...extra }, status: 400 as const };
    }
  }
  if (t.kind === "scaffold")
    return {
      body: {
        needsScaffold: true,
        dir: t.dir,
        fileName: t.fileName,
        proposal: t.proposal,
        ...extra,
      },
      status: 200 as const,
    };
  return { body: { error: t.message, ...extra }, status: 400 as const };
}

async function handleProjectsBrowse(c: Context, manager: Manager) {
  const file = await browseForDevWebUIFile(c.req.raw.signal);
  if (!file) return c.json({ cancelled: true });
  return guard(c, () =>
    c.json(withTriggers({ ok: true, ...loadProject(manager, file) }, path.dirname(file))),
  );
}

// Load from a pasted/dropped path — a .devwebui file, a folder holding one, or
// a folder we can scaffold a .devwebui for from its dev scripts.
async function handleProjectsLoad(c: Context, manager: Manager) {
  const body = await readBody(c);
  if (!body.path) return fail(c, "path required");
  const { body: out, status } = targetBody(manager, await resolveLoadTarget(String(body.path)));
  return c.json(out, status);
}

// Write a proposed .devwebui (from detection) into a folder, then load it.
async function handleProjectsScaffold(c: Context, manager: Manager) {
  const body = await readBody(c);
  const dir = String(body.dir ?? "").trim();
  const fileName = String(body.fileName ?? "").trim();
  if (!dir || !body.project) return fail(c, "dir and project required");
  let file: string;
  try {
    file = scaffoldDevWebUIFile(dir, fileName, body.project);
  } catch (e) {
    return fail(c, (e as Error).message);
  }
  try {
    return c.json(withTriggers({ ok: true, ...loadProject(manager, file), created: file }, dir));
  } catch (e) {
    // We wrote the file but couldn't load it — don't leave an orphan that blocks retries.
    try {
      unlinkSync(file);
    } catch {
      /* best-effort cleanup */
    }
    return fail(c, (e as Error).message);
  }
}

// Retire a folder's external auto-start triggers (VS Code tasks.json folderOpen,
// the "Vite" extension's vite.autoStart) so DevWebUI is the sole launcher.
async function handleProjectsTakeOver(c: Context) {
  const body = await readBody(c);
  const dir = String(body.dir ?? "").trim();
  if (!dir) return fail(c, "dir required");
  if (!existsSync(dir)) return fail(c, `Path not found: ${dir}`);
  return guard(c, () =>
    c.json({ ok: true, ...takeOverAutostart(dir), canRestore: canRestoreAutostart(dir) }),
  );
}

// Undo a take-over: put the backed-up VS Code config back. The backups have always been
// written; until now nothing could restore them.
async function handleProjectsRestoreAutostart(c: Context) {
  const body = await readBody(c);
  const dir = String(body.dir ?? "").trim();
  if (!dir) return fail(c, "dir required");
  if (!existsSync(dir)) return fail(c, `Path not found: ${dir}`);
  return guard(c, () => c.json({ ok: true, ...restoreAutostart(dir) }));
}

// Clone a git repo into `dest`, then load (or offer to scaffold) inside the clone.
async function handleProjectsClone(c: Context, manager: Manager) {
  const body = await readBody(c);
  const url = String(body.url ?? "").trim();
  const dest = String(body.dest ?? "").trim();
  if (!url) return fail(c, "url required");
  if (!dest) return fail(c, "dest required");
  let cloned: string;
  try {
    cloned = await cloneRepo(url, dest, { signal: c.req.raw.signal });
  } catch (e) {
    return fail(c, (e as Error).message);
  }
  const { body: out, status } = targetBody(manager, await resolveLoadTarget(cloned), { cloned });
  return c.json(out, status);
}

// Native "choose folder" picker (clone destination) + a suggested default.
async function handleProjectsBrowseFolder(c: Context) {
  const dir = await browseForFolder(c.req.raw.signal);
  return dir ? c.json({ ok: true, path: dir }) : c.json({ cancelled: true });
}

// Fast, bounded sweep of the machine for existing .devwebui files. Serialized and
// abort-aware in scan.ts — passing the request signal stops this caller's walk if
// the client navigates away without cancelling another caller's scan.
async function handleProjectsScan(c: Context) {
  const body = await readBody(c);
  const roots = Array.isArray(body.roots) ? body.roots.map(String).filter(Boolean) : undefined;
  const bodyExclude = Array.isArray(body.exclude) ? body.exclude.map(String) : [];
  const preset: ScanPreset | undefined =
    typeof body.preset === "string" && body.preset in SCAN_PRESETS
      ? (body.preset as ScanPreset)
      : undefined;
  const s = readSettings();
  return c.json(
    await scanForDevWebUI({
      roots,
      preset,
      detectPackages: typeof body.detectPackages === "boolean" ? body.detectPackages : undefined,
      // Explicit numbers override the preset (scan.ts applies them on top of it).
      maxDepth: typeof body.maxDepth === "number" ? body.maxDepth : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      budgetMs: typeof body.budgetMs === "number" ? body.budgetMs : undefined,
      signal: c.req.raw.signal,
      // Saved excludes + the (editable) OS system-folder lists whose toggle is on.
      exclude: [
        ...bodyExclude,
        ...s.scanExclude,
        ...(s.skipWindows ? s.osSkip.windows : []),
        ...(s.skipMac ? s.osSkip.mac : []),
        ...(s.skipLinux ? s.osSkip.linux : []),
      ],
    }),
  );
}

async function handleProjectsIgnore(c: Context) {
  const body = await readBody(c);
  const dir = String(body?.dir ?? "");
  if (!dir) return fail(c, "dir required", 400);
  ignoreProject(dir);
  return c.json({ ok: true });
}

async function handleProjectsUnignore(c: Context) {
  const body = await readBody(c);
  const dir = String(body?.dir ?? "");
  if (!dir) return fail(c, "dir required", 400);
  unignoreProject(dir);
  return c.json({ ok: true });
}

/** Register project discovery/load/scaffold/take-over/clone/scan routes. */
export function registerProjectRoutes(app: Hono, manager: Manager) {
  app.get(ROUTES.projects, (c) => c.json(manager.listProjects()));

  app.post(ROUTES.projectsBrowse, (c) => handleProjectsBrowse(c, manager));
  app.post(ROUTES.projectsLoad, (c) => handleProjectsLoad(c, manager));
  app.post(ROUTES.projectsScaffold, (c) => handleProjectsScaffold(c, manager));
  app.post(ROUTES.projectsTakeOver, handleProjectsTakeOver);
  app.post(ROUTES.projectsRestoreAutostart, handleProjectsRestoreAutostart);
  app.post(ROUTES.projectsClone, (c) => handleProjectsClone(c, manager));

  app.post(ROUTES.projectsBrowseFolder, handleProjectsBrowseFolder);
  app.get(ROUTES.projectsSuggestDest, (c) => c.json({ dest: suggestCloneDest() }));

  app.post(ROUTES.projectsScan, handleProjectsScan);

  // Ignore list for detected (not-yet-added) projects — keeps the background scan
  // from re-surfacing folders the user dismissed. Keyed by absolute directory path.
  app.get(ROUTES.projectsIgnored, (c) => c.json(readIgnoredProjects()));
  app.post(ROUTES.projectsIgnore, handleProjectsIgnore);
  app.post(ROUTES.projectsUnignore, handleProjectsUnignore);
}
