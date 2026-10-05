import path from "node:path";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import type { Manager } from "../manager";
import { readSettings, writeSettings, type RuntimePref } from "../runtime";
import { applyUpdate, checkForUpdate } from "../updater";
import {
  setAutoUpdateEnabled,
  setAutoUpdateIntervalSecs,
  setUpdateNotifyEnabled,
} from "../auto-update";
import {
  DASHBOARD_WINDOW_SIZE,
  FOCUS_PATH_PREFIX,
  FOCUS_WINDOW_SIZE,
  WINDOW_SIZE_HINT_PARAM,
} from "../constants";
import { ROUTES } from "../routes";
import { windowSizeHintFor } from "../window-size";
import {
  instanceFilePath,
  readInstanceInfo,
  updateInstanceInfo,
  writeShutdownRequest,
} from "../instance";
import { openPortableWindow } from "../portable-window.mjs";
import { exitSafeMode, getSafeMode } from "../crash-sentinel";
import type { SafeModeExitResult } from "../../../shared/dto";
import { openInEditor } from "../open-in-editor";

export interface Client {
  send: (event: string, data: unknown) => Promise<void>;
}

export interface CreateAppOptions {
  requestShutdown?: () => Promise<void> | void;
  shutdownToken?: string;
  /** Enforce local auth (cookie file or paired key) on /api/*; see server/src/local-auth.ts. */
  requireAuth?: boolean;
  /** Port the daemon itself bound to (its own same-origin GUI origin) — see allowedOrigins(). */
  port?: number;
}

/** Parse the JSON request body, defaulting to `{}` on missing/invalid JSON. */
// biome-ignore lint/suspicious/noExplicitAny: handlers read loosely-typed fields off the body
export const readBody = (c: Context): Promise<any> => c.req.json().catch(() => ({}));

/** Standard error response: `{ error: message }` with the given status (400 by default). */
export const fail = (c: Context, message: string, status: ContentfulStatusCode = 400) =>
  c.json({ error: message }, status);

/**
 * Origins allowed to make cross-origin calls into the daemon: the daemon's own
 * bound port (belt-and-suspenders; the GUI is normally served same-origin, which
 * needs no CORS grant at all) plus the Vite dev-server origin (web/vite.config.ts,
 * `bun run dev`'s HMR proxy target) on localhost/127.0.0.1. Anything else — in
 * particular an arbitrary third-party site the user has open in another tab — is
 * rejected by both the CORS middleware and the Origin-gate below.
 */
export function allowedOrigins(port?: number): string[] {
  const origins = ["http://localhost:4010", "http://127.0.0.1:4010"];
  if (port) origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  return origins;
}

// The cross-site (CSRF) guard is now the shared kit primitive — see server/src/loopback-guard.mjs,
// wired in http/index.ts. `allowedOrigins` above stays: it still narrows the CORS allowlist
// (defense-in-depth for reads). DevWebUI's former hand-rolled requireAllowedOrigin was removed when
// it adopted the shared guard.

/**
 * Run a block that may throw and turn any throw into a 400 `{ error }` (via {@link fail}).
 * The block returns the success response; the wrapper returns it untouched.
 */
export const guard = async (
  c: Context,
  fn: () => Response | Promise<Response>,
): Promise<Response> => {
  try {
    return await fn();
  } catch (e) {
    return fail(c, (e as Error).message);
  }
};

/**
 * Wire the manager's live events (status/log/projects/errors) out to connected SSE
 * clients, and register the `/stream` endpoint they connect through.
 */
export function registerRealtime(app: Hono, manager: Manager) {
  const clients = new Set<Client>();
  // Mirror the live client count onto the manager so its port-probe loop can pause while
  // nobody is watching and nothing is running (see ManagerBase.sseClients).
  const syncClientCount = () => {
    manager.sseClients = clients.size;
  };
  const broadcast = (event: string, data: unknown) => {
    for (const c of clients)
      c.send(event, data).catch(() => {
        clients.delete(c);
        syncClientCount();
      });
  };
  manager.on("status", (v) => broadcast("status", v));
  manager.on("log", (l) => broadcast("log", l));
  manager.on("projects", (p) => broadcast("projects", p));
  manager.on("errors", (e) => broadcast("errors", e));
  manager.on("alerts", (e) => broadcast("alerts", e));
  // Auto-update lifecycle events (see server/src/auto-update.ts): the module itself has no
  // transport, so server/src/index.ts wires its broadcast hook to `manager.emit("autoUpdate", …)`,
  // relayed out to SSE clients here exactly like every other manager event.
  manager.on("autoUpdate", (v: { event: string; data: unknown }) => broadcast(v.event, v.data));

  // ---- live stream ----
  app.get(ROUTES.stream, (c) =>
    streamSSE(c, async (stream) => {
      const client: Client = {
        send: (event, data) => stream.writeSSE({ event, data: JSON.stringify(data) }),
      };
      clients.add(client);
      syncClientCount();
      await stream.writeSSE({ event: "projects", data: JSON.stringify(manager.listProjects()) });
      await stream.writeSSE({ event: "errors", data: JSON.stringify(manager.listErrors()) });
      await stream.writeSSE({ event: "alerts", data: JSON.stringify(manager.listAlertEvents()) });
      const ping = setInterval(() => void client.send("ping", Date.now()), 15000);
      stream.onAbort(() => {
        clearInterval(ping);
        clients.delete(client);
        syncClientCount();
      });
      while (true) await stream.sleep(60000);
    }),
  );
}

/** GET updates: `?fresh=1` bypasses the 5-minute status cache. A user clicking "Check for
 *  updates" is explicitly asking us to look NOW, and answering from a cache that predates a
 *  release makes the menu item lie ("up to date") until the tab is reloaded. Automatic
 *  background checks still take the cached path. */
async function handleUpdatesStatus(c: Context) {
  const status = await checkForUpdate({ fresh: c.req.query("fresh") === "1" });
  return c.json(status);
}

async function handleApplyUpdate(c: Context) {
  return guard(c, async () => {
    const result = await applyUpdate();
    return c.json(result);
  });
}

// NOT an auth boundary, and deliberately so. `x-devwebui-shutdown-source: ui` is a ROUTING
// signal ("this is a whole-app shutdown, not a tray-managed restart"), not a credential —
// the CLI's `devwebui stop` sends it too (server/src/cli.ts). What actually gates this route
// is the transport: the daemon binds 127.0.0.1 only (server/src/index.ts) and loopbackGuard
// rejects browser cross-site requests, so the only callers left are same-machine tools the
// user ran, which could kill the process directly anyway. The tray token below is a
// DISAMBIGUATOR (is this OUR tray's restart?), not a lock.
async function handleShutdown(c: Context, options: CreateAppOptions) {
  const token = options.shutdownToken ?? "";
  const trayHeader = c.req.header("x-devwebui-shutdown-token") ?? "";
  const uiHeader = c.req.header("x-devwebui-shutdown-source") === "ui";
  if (!options.requestShutdown || (!uiHeader && (!token || trayHeader !== token)))
    return fail(c, "forbidden", 403);
  // A UI-source shutdown WITHOUT the tray's session token is a user "Shut Down" from the web
  // menu (or `devwebui stop`) — a request to terminate the WHOLE app, tray included. Drop a
  // sentinel the tray host polls so it disposes its notification-area icon and exits too. The
  // tray's own Restart/Rebuild/Quit carry the token, so they don't trip this; harmless when no
  // tray is running (cleared on the next daemon boot).
  if (uiHeader && (!token || trayHeader !== token)) writeShutdownRequest();
  await options.requestShutdown();
  return c.json({ ok: true });
}

async function handlePutSettings(c: Context, manager: Manager) {
  const body = await readBody(c);
  if (body.runtime !== undefined && !["auto", "node", "bun"].includes(body.runtime))
    return fail(c, "runtime must be one of: auto, node, bun");
  const optBool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const saved = writeSettings({
    runtime: body.runtime as RuntimePref | undefined,
    freePortOnStart: optBool(body.freePortOnStart),
    autoStartOnLaunch: optBool(body.autoStartOnLaunch),
    monitorResources: optBool(body.monitorResources),
    linkHost: typeof body.linkHost === "string" ? body.linkHost : undefined,
    autoScan: optBool(body.autoScan),
    firstScanDone: optBool(body.firstScanDone),
    scanExclude: Array.isArray(body.scanExclude) ? body.scanExclude : undefined,
    skipWindows: optBool(body.skipWindows),
    skipMac: optBool(body.skipMac),
    skipLinux: optBool(body.skipLinux),
    osSkip: body.osSkip && typeof body.osSkip === "object" ? body.osSkip : undefined,
    autoUpdate: optBool(body.autoUpdate),
    autoUpdateIntervalSecs:
      typeof body.autoUpdateIntervalSecs === "number" &&
      Number.isFinite(body.autoUpdateIntervalSecs)
        ? body.autoUpdateIntervalSecs
        : undefined,
    updateNotify: optBool(body.updateNotify),
    updateCooldownDays:
      typeof body.updateCooldownDays === "number" && Number.isFinite(body.updateCooldownDays)
        ? body.updateCooldownDays
        : undefined,
    portableMode: optBool(body.portableMode),
    hideTrayIcon: optBool(body.hideTrayIcon),
  });
  manager.globalRuntime = saved.runtime;
  manager.freePortOnStart = saved.freePortOnStart;
  manager.monitorResources = saved.monitorResources;
  manager.applyMonitorResources(); // start/stop the metrics loop to match the new setting
  // Auto-update timer: toggling this starts/stops the daemon-wide auto-update timer (see
  // server/src/auto-update.ts). The interval setter clamps — persist the value it settled on.
  setAutoUpdateEnabled(saved.autoUpdate);
  setAutoUpdateIntervalSecs(saved.autoUpdateIntervalSecs);
  setUpdateNotifyEnabled(saved.updateNotify);
  // Keep the runtime pointer's launcher-facing flags current so the tray sees the new
  // values within its next poll/timer tick without waiting for a daemon restart.
  updateInstanceInfo({ portableMode: saved.portableMode, hideTrayIcon: saved.hideTrayIcon });
  // Apply to anything already running — fire-and-forget so this response can't hang on
  // a stubborn kill; the GUI sees the restarts via SSE status events.
  if (body.restart) void manager.restartRunning();
  return c.json(saved);
}

// ---- portable window (chromeless app window instead of a browser tab) ----
async function handlePortableWindow(c: Context, options: CreateAppOptions) {
  // Optional `path` opens the window on a specific in-app view rather than the
  // dashboard root (the desktop-shortcut launcher passes "/focus/<id>" to get
  // the single-process focus view). Constrained to a same-origin relative path
  // beginning with "/" and carrying no "//" authority, so a caller can never
  // redirect this window at an arbitrary external origin.
  const body = await readBody(c);
  const rel = typeof body.path === "string" && /^\/(?!\/)/.test(body.path) ? body.path : "";
  return guard(c, async () => {
    const base = readInstanceInfo()?.url ?? `http://localhost:${options.port ?? ""}`;
    const url = `${base}${rel}`;
    // Dedicated profile so Chromium remembers the app window's size/position across
    // launches instead of sharing (and fighting over) the user's main browser profile.
    // Family convention: <configDir>/portable-profile, a sibling of runtime.json — the
    // PS tray derives the identical path from the same runtime.json location so both
    // open paths share one profile.
    const profileDir = path.join(path.dirname(instanceFilePath()), "portable-profile");
    // First-run sizes, measured per view (shared/constants.ts): the focus view is a
    // small single-process launcher; every other path renders the dashboard, whose
    // layout caps at --container-max, so Chromium's never-seen-window default (~the
    // whole work area) is wrong for it too. Either way this yields to the user's own
    // resize once they make one (openPortableWindow checks the profile's saved
    // placement).
    const initialSize = rel.startsWith(FOCUS_PATH_PREFIX)
      ? FOCUS_WINDOW_SIZE
      : DASHBOARD_WINDOW_SIZE;
    // Neither of those mechanisms reaches a window whose profile already has a
    // Chromium instance running: the forwarded --app launch inherits the EXISTING
    // window's geometry, ignoring --window-size and the saved placement alike (the
    // launcher's "Open dashboard" always lands here — the launcher is that instance).
    // So also tell the page what size this window should be, and it corrects itself
    // with resizeTo (web/src/lib/window-size-hint.ts). Which size — remembered vs
    // first-run vs "none, the window is maximized" — is windowSizeHintFor's one job.
    // The query string is not part of Chromium's placement key, so the hint can't
    // re-key the window; a URL that won't parse just goes out without one.
    let target = url;
    try {
      const hint = windowSizeHintFor(profileDir, url, initialSize);
      if (hint) {
        const u = new URL(url);
        u.searchParams.set(WINDOW_SIZE_HINT_PARAM, hint);
        target = u.toString();
      }
    } catch {
      /* unparseable base URL: open it un-hinted rather than fail the route */
    }
    const result = await openPortableWindow(target, { profileDir, initialSize });
    return c.json(result);
  });
}

async function handleErrorsDismiss(c: Context, manager: Manager) {
  const body = await readBody(c);
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
  if (fingerprint) manager.dismissError(fingerprint);
  return c.json({ ok: true });
}

// Safe mode's "Leave safe mode": leave safe mode and run exactly the auto-start a normal boot
// would have run (only when the owner has autoStartOnLaunch on), without bouncing the daemon and
// dropping every open tab's SSE stream.
function handleSafeModeExit(c: Context, manager: Manager) {
  const reply: SafeModeExitResult = { ok: true, started: [] };
  if (!exitSafeMode()) return c.json(reply);
  if (readSettings().autoStartOnLaunch) reply.started = manager.startLaunchAutostart();
  console.log(`[devwebui] left safe mode; auto-starting ${reply.started.length} process(es).`);
  return c.json(reply);
}

// A frame logged by a process is usually relative to that process's cwd (Vite, tsc, eslint), so
// the caller names the process and the daemon resolves against the cwd only it knows.
async function handleOpenInEditor(c: Context, manager: Manager) {
  const body = await readBody(c);
  const processId = typeof body.processId === "string" ? body.processId : "";
  const cwd = processId ? manager.view(processId)?.cwd : undefined;
  const result = await openInEditor(body, cwd);
  return c.json(result, !result.ok && result.reason === "bad-input" ? 400 : 200);
}

/** Register health/update/shutdown/settings/error-log routes. */
export function registerSystemRoutes(app: Hono, manager: Manager, options: CreateAppOptions) {
  // `service` is the identity the launchers match on. Without it a responder is indistinguishable
  // from any other server that happens to answer this path -- a Vite dev server returns its SPA
  // fallback (200, text/html) for /api/health, and misc/Restart-Daemon.ps1 has to be able to tell
  // that apart from us before it kills anything. Every app in the family stamps this; DevWebUI was
  // the last one that didn't, which is why its daemon could not be found by the restart scripts.
  app.get(ROUTES.health, (c) => c.json({ ok: true, service: "devwebui", ts: Date.now() }));
  app.get(ROUTES.updates, handleUpdatesStatus);
  app.post(ROUTES.updatesApply, handleApplyUpdate);
  app.post(ROUTES.shutdown, (c) => handleShutdown(c, options));

  // ---- settings (global runtime default) ----
  app.get(ROUTES.settings, (c) => c.json(readSettings()));
  app.put(ROUTES.settings, (c) => handlePutSettings(c, manager));

  app.post(ROUTES.portableWindow, (c) => handlePortableWindow(c, options));

  // ---- error log ----
  app.get(ROUTES.errors, (c) => c.json(manager.listErrors()));
  app.post(ROUTES.errorsClear, (c) => {
    manager.clearErrors(c.req.query("processId") || undefined);
    return c.json({ ok: true });
  });
  app.post(ROUTES.errorsDismiss, (c) => handleErrorsDismiss(c, manager));

  // ---- safe mode (crash sentinel, see server/src/crash-sentinel.ts) ----
  app.get(ROUTES.safeMode, (c) => c.json(getSafeMode()));
  app.post(ROUTES.safeModeExit, (c) => handleSafeModeExit(c, manager));
  app.post(ROUTES.openInEditor, (c) => handleOpenInEditor(c, manager));
}
