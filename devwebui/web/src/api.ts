import type {
  AlertEvent,
  AlertRule,
  AlertRuleInput,
  ErrorEvent,
  LogLine,
  ProcessInput,
  ProjectMetaInput,
  ProjectView,
} from "./types";
import { ROUTES } from "../../shared/routes";
import { httpFetch, httpJson } from "@/lib/httpClient";
export { ApiError } from "@/lib/httpClient";
import type {
  AddResult,
  DetectedProcess,
  FreePortResult,
  OpenInEditorResult,
  ScanPreset,
  SafeModeExitResult,
  SafeModeStatus,
  ScanResult,
  Settings,
  ShortcutResult,
  TakeOverResult,
  UpdateApplyResult,
  UpdateStatus,
} from "../../shared/dto";

// Re-export the shared DTOs so existing `import { ScanResult } from "@/api"`
// call sites across the GUI keep resolving here (the definitions now live in
// ../../shared/dto — this module no longer declares them).
export type {
  AddResult,
  AutostartTrigger,
  DetectedProcess,
  FoundFile,
  FreePortResult,
  PortOwner,
  ProjectProposal,
  RuntimePref,
  ScanPreset,
  ScanResult,
  Settings,
  ShortcutFailure,
  ShortcutResult,
  TakeOverResult,
  UpdateApplyResult,
  UpdateStatus,
} from "../../shared/dto";

// The paired-browser key a daemon enforcing local auth (server/src/local-auth.ts) wants as a
// Bearer header. It lives in this origin's localStorage, never in a cookie: browsers do not scope
// cookies by port, so every localhost dev server opened from the dashboard would receive one.
const PAIRED_KEY_STORAGE = "devwebui.pairedKey";

export function getPairedKey(): string | null {
  try {
    return localStorage.getItem(PAIRED_KEY_STORAGE);
  } catch {
    return null;
  }
}

function withPairedKey(init?: RequestInit): RequestInit | undefined {
  const key = getPairedKey();
  if (!key) return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
  return { ...init, headers };
}

const req = (url: string, init?: RequestInit) => httpFetch(url, withPairedKey(init));
const reqJson = <T>(url: string, init?: RequestInit) => httpJson<T>(url, withPairedKey(init));

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// ---- reads (consumed by the store) ----
export const getProjects = () => reqJson<ProjectView[]>(ROUTES.projects);
export const getErrors = () => reqJson<ErrorEvent[]>(ROUTES.errors);
export const getAlertRules = () => reqJson<AlertRule[]>(ROUTES.alertRules);
export const getAlertEvents = () => reqJson<AlertEvent[]>(ROUTES.alertEvents);
export const getProcessLogs = (id: string) =>
  reqJson<{ lines: LogLine[] }>(ROUTES.processLogs.build(id));

/** Tail the on-disk rotating log file for a process (Time-Travel Log Vault; survives restarts). */
export const getProcessLogFile = (id: string, lines?: number) =>
  reqJson<{ id: string; lines: string[] }>(ROUTES.processLogFile.build(id, lines));

// ---- process / project actions (state arrives back via SSE) ----
const post = (path: string) => req(path, { method: "POST" });
/**
 * Start a process. `coStarted` lists the linked/companion processes the action
 * also set in motion.
 */
export const start = (id: string) =>
  reqJson<{ ok: boolean; coStarted?: string[] }>(ROUTES.processAction.build(id, "start"), {
    method: "POST",
  });
/** Stop a process. `coStopped` lists the linked processes brought down with it. */
export const stop = (id: string) =>
  reqJson<{ ok: boolean; coStopped?: string[] }>(ROUTES.processAction.build(id, "stop"), {
    method: "POST",
  });
export const restart = (id: string) => post(ROUTES.processAction.build(id, "restart"));
export const enableProcess = (id: string) => post(ROUTES.processAction.build(id, "enable"));
export const disableProcess = (id: string) => post(ROUTES.processAction.build(id, "disable"));
export const startAll = () => post(ROUTES.startAll);
export const stopAll = () => post(ROUTES.stopAll);
export const shutdownServer = () =>
  req(ROUTES.shutdown, {
    method: "POST",
    headers: { "x-devwebui-shutdown-source": "ui" },
  });
export const startProject = (id: string) => post(ROUTES.projectAction.build(id, "start"));
export const stopProject = (id: string) => post(ROUTES.projectAction.build(id, "stop"));
export const enableProject = (id: string) => post(ROUTES.projectAction.build(id, "enable"));
export const disableProject = (id: string) => post(ROUTES.projectAction.build(id, "disable"));
export const clearErrors = (processId?: string) =>
  post(`${ROUTES.errorsClear}${processId ? `?processId=${encodeURIComponent(processId)}` : ""}`);
export const dismissError = (fingerprint: string) =>
  req(ROUTES.errorsDismiss, jsonInit("POST", { fingerprint }));
/** Open a logged source frame in the developer's running editor; `processId` resolves a relative path. */
export const openInEditor = (frame: {
  file: string;
  line: number;
  column?: number;
  processId?: string;
}) => reqJson<OpenInEditorResult>(ROUTES.openInEditor, jsonInit("POST", frame));

// ---- local API auth pairing (server/src/local-auth.ts; matters only when enforced) ----
export const getPairingStatus = () =>
  reqJson<{ required: boolean; authorized: boolean }>(ROUTES.pairingStatus);
export const requestPairing = (label: string) =>
  reqJson<{ requestId: string; expiresInSecs: number }>(
    ROUTES.pairingRequest,
    jsonInit("POST", { label }),
  );
/** On success keep the returned key: every later request sends it (see withPairedKey). */
export async function verifyPairing(requestId: string, code: string): Promise<void> {
  const { key } = await reqJson<{ clientId: string; label: string; key: string }>(
    ROUTES.pairingVerify,
    jsonInit("POST", { requestId, code }),
  );
  localStorage.setItem(PAIRED_KEY_STORAGE, key);
}
/** A single-use ticket for the live stream: EventSource cannot send the Bearer header. */
export const getStreamTicket = () =>
  reqJson<{ ticket: string; expiresInSecs: number }>(ROUTES.pairingStreamTicket, {
    method: "POST",
  });

// ---- alert rules (threshold alerting on process CPU/memory) ----
export const addAlertRule = (input: AlertRuleInput) =>
  reqJson<AlertRule>(ROUTES.alertRules, jsonInit("POST", input));
export const updateAlertRule = (id: string, input: Partial<AlertRuleInput>) =>
  reqJson<AlertRule>(ROUTES.alertRule.build(id), jsonInit("PUT", input));
export const removeAlertRule = (id: string) =>
  req(ROUTES.alertRule.build(id), { method: "DELETE" });
export const clearAlertEvents = (processId?: string) =>
  post(
    `${ROUTES.alertEventsClear}${processId ? `?processId=${encodeURIComponent(processId)}` : ""}`,
  );

/**
 * Free a process's declared port. Without `confirm`, a managed holder is stopped cleanly
 * but EXTERNAL owners are reported back (`needsConfirm`) rather than killed; pass
 * `confirm: true` to kill those exact PIDs.
 */
export const freePort = (processId: string, confirm = false) =>
  reqJson<FreePortResult>(ROUTES.processFreePort.build(processId), jsonInit("POST", { confirm }));

/** Read global settings. */
export const getSettings = () => reqJson<Settings>(ROUTES.settings);

/**
 * Check the public source remote for an app update. The daemon caches its answer
 * briefly (see server/src/github-updater.ts); pass `force: true` (the explicit
 * "Check for updates" menu action) to bypass that cache and hit the remote now.
 */
export const checkUpdate = (opts?: { force?: boolean }) =>
  reqJson<UpdateStatus>(opts?.force ? `${ROUTES.updates}?fresh=1` : ROUTES.updates);

/** Apply an available source update. The daemon should be restarted afterward. */
export const applyUpdate = () =>
  reqJson<UpdateApplyResult>(ROUTES.updatesApply, { method: "POST" });

/** Is the daemon in safe mode (booted after a crash, launch-time auto-start skipped)? */
export const getSafeMode = () => reqJson<SafeModeStatus>(ROUTES.safeMode);

/** "Leave safe mode": leave safe mode and run the auto-start a normal boot would have run. */
export const exitSafeMode = () =>
  reqJson<SafeModeExitResult>(ROUTES.safeModeExit, { method: "POST" });

/** Patch global settings; `restart` re-launches running processes to apply a runtime change now. */
export const saveSettings = (patch: Partial<Settings> & { restart?: boolean }) =>
  reqJson<Settings>(ROUTES.settings, jsonInit("PUT", patch));

/**
 * Open the app UI in a chromeless Chromium app window (Portable mode). Best-effort:
 * resolves `{ ok: false, reason }` instead of throwing when no Edge/Chrome is installed
 * or the spawn fails — the caller surfaces that to the user instead of treating it as fatal.
 *
 * `path` opens the window on a specific view (e.g. "/focus/<id>") instead of the
 * dashboard root; the server only honours a same-origin relative path.
 */
export const openPortableWindow = (path?: string) =>
  reqJson<{ ok: true; browser: string } | { ok: false; reason: "no-browser" | "spawn-failed" }>(
    ROUTES.portableWindow,
    jsonInit("POST", path ? { path } : {}),
  );

/**
 * Create a Desktop shortcut that starts this process (plus its linked group) later,
 * without the dashboard. Windows-only; other platforms resolve `{ ok: false }`.
 */
export const createProcessShortcut = (id: string) =>
  reqJson<ShortcutResult>(ROUTES.processShortcut.build(id), { method: "POST" });

/** Create a Desktop shortcut that starts every process in this project. */
export const createProjectShortcut = (id: string) =>
  reqJson<ShortcutResult>(ROUTES.projectShortcut.build(id), { method: "POST" });

/**
 * Toggle the opt-in silent auto-update (checks the update remote on a schedule and, when a
 * newer commit is available on a CLEAN tree, applies it and self-relaunches the daemon). Default
 * OFF. Pass `intervalSecs` to also set the check cadence (clamped server-side to [900, 604800]).
 */
export const setAutoUpdate = (enabled: boolean, intervalSecs?: number) =>
  reqJson<Settings>(
    ROUTES.settings,
    jsonInit("PUT", {
      autoUpdate: enabled,
      ...(intervalSecs !== undefined ? { autoUpdateIntervalSecs: intervalSecs } : {}),
    }),
  );

// ---- project add/load/clone/scaffold/remove (raw — the store calls refresh after) ----
export const removeProjectRequest = (id: string) => post(ROUTES.projectAction.build(id, "remove"));

/** Rename + recolor a project (rewrites the .devwebui file's top-level name/color). */
export const updateProjectRequest = (id: string, meta: ProjectMetaInput) =>
  reqJson<AddResult>(ROUTES.projectUpdate.build(id), jsonInit("PUT", meta));

export const browseProjectRequest = () =>
  reqJson<AddResult>(ROUTES.projectsBrowse, { method: "POST" });

export const loadProjectRequest = (path: string) =>
  reqJson<AddResult>(ROUTES.projectsLoad, jsonInit("POST", { path }));

export const cloneProjectRequest = (url: string, dest: string) =>
  reqJson<AddResult>(ROUTES.projectsClone, jsonInit("POST", { url, dest }));

export const scaffoldProjectRequest = (
  dir: string,
  fileName: string,
  project: { name: string; processes: DetectedProcess[] },
) => reqJson<AddResult>(ROUTES.projectsScaffold, jsonInit("POST", { dir, fileName, project }));

/** Retire a folder's external auto-start triggers so DevWebUI is the sole launcher. */
export const takeOverAutostartRequest = (dir: string) =>
  reqJson<TakeOverResult>(ROUTES.projectsTakeOver, jsonInit("POST", { dir }));

/** Native "choose folder" picker for the git clone destination. */
export const browseForFolder = () =>
  reqJson<{ ok?: boolean; cancelled?: boolean; path?: string }>(ROUTES.projectsBrowseFolder, {
    method: "POST",
  });

/** Fast, bounded sweep of the machine for existing .devwebui files. */
export const scanForDevWebUI = (
  opts: {
    roots?: string[];
    preset?: ScanPreset;
    maxDepth?: number;
    limit?: number;
    budgetMs?: number;
    detectPackages?: boolean;
  } = {},
) => reqJson<ScanResult>(ROUTES.projectsScan, jsonInit("POST", opts));

/** A sensible default clone destination from the daemon (`~/dev`). */
export async function suggestDest(): Promise<string> {
  try {
    return (await reqJson<{ dest?: string }>(ROUTES.projectsSuggestDest)).dest ?? "";
  } catch {
    return "";
  }
}

/** Detected-project ignore list (absolute dirs the user dismissed from scans). */
export const getIgnoredProjects = () => reqJson<string[]>(ROUTES.projectsIgnored);
export const ignoreProjectRequest = (dir: string) =>
  reqJson<{ ok: boolean }>(ROUTES.projectsIgnore, jsonInit("POST", { dir }));
export const unignoreProjectRequest = (dir: string) =>
  reqJson<{ ok: boolean }>(ROUTES.projectsUnignore, jsonInit("POST", { dir }));

// ---- process editing (mutates the .devwebui file; SSE pushes the reload) ----
export const addProcess = (projectId: string, proc: ProcessInput) =>
  reqJson<AddResult>(ROUTES.projectProcesses.build(projectId), jsonInit("POST", proc));

export const updateProcess = (projectId: string, localId: string, proc: ProcessInput) =>
  reqJson<AddResult>(ROUTES.projectProcess.build(projectId, localId), jsonInit("PUT", proc));

export const deleteProcess = (projectId: string, localId: string) =>
  reqJson<AddResult>(ROUTES.projectProcess.build(projectId, localId), { method: "DELETE" });

/** Set (or clear) a process's starred flag — starred processes float to the top. */
export const setProcessStarred = (projectId: string, localId: string, starred: boolean) =>
  reqJson<AddResult>(
    ROUTES.projectProcessStar.build(projectId, localId),
    jsonInit("POST", { starred }),
  );

// ---- "Sync my settings with Connections" (optional, opt-in) ----

/** Status shape returned by every settings-sync endpoint. */
export interface SyncStatus {
  ok: true;
  /** Sync is turned on (independent of whether a Connections credential exists). */
  enabled: boolean;
  /** The daemon holds a Connections credential (owner is signed in). */
  connected: boolean;
  /** Signed-in display name, or null when not connected (or a pre-name connection pending refresh). */
  name: string | null;
  /** Privacy-relay email — third-party apps never receive the real inbox; shown only as a fallback. */
  email: string | null;
  /** Avatar image URL from the IdP (`photo` scope), or null when not granted/available. */
  picture: string | null;
  /** ISO timestamp of the last successful sync, or null. */
  lastSyncedAt: string | null;
  version: number;
  /** Last-synced appearance blob (e.g. `{ theme }`) to apply locally, or null. */
  appearance: Record<string, unknown> | null;
}

/** A handled sync failure — returned at HTTP 200 so it's non-blocking. */
export interface SyncErrorResult {
  ok: false;
  error: string;
  retryAfterSeconds?: number;
}

export type SyncResult = SyncStatus | SyncErrorResult;

/** Read the current sync status (enabled/connected/email/appearance/etc). */
export const getSyncStatus = () => reqJson<SyncStatus>(ROUTES.settingsSync);

/**
 * Turn sync on/off, disconnect, or push an updated appearance blob.
 * `{ enabled: true, appearance }` seeds/pulls; `{ enabled: false }` turns off
 * (keeps the connection); `{ enabled: false, forget: true }` disconnects fully.
 */
export const setSync = (body: {
  enabled?: boolean;
  forget?: boolean;
  appearance?: Record<string, unknown>;
}) => reqJson<SyncResult>(ROUTES.settingsSync, jsonInit("PUT", body));

/** Force a pull of the remote synced appearance now. */
export const syncPull = () => reqJson<SyncResult>(ROUTES.settingsSyncPull, { method: "POST" });

/** Force a push of the current local appearance now. */
export const syncPush = () => reqJson<SyncResult>(ROUTES.settingsSyncPush, { method: "POST" });

/** Current Connections auth state (independent of sync being enabled). */
export const authMe = () =>
  reqJson<{
    ok: true;
    connected: boolean;
    name: string | null;
    picture: string | null;
    email: string | null;
  }>(ROUTES.authMe);

/** Disconnect the signed-in Connections identity. */
export const authLogout = () => reqJson<{ ok: true }>(ROUTES.authLogout, { method: "POST" });
