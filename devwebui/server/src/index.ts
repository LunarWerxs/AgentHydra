import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDetachedSpawn } from "./detached-spawn.mjs";
import { buildRelaunchArgv } from "./relaunch-argv.mjs";
import { materializeTrayToolkit, startTrayHostIfMissing } from "./tray-bootstrap.mjs";
import { Manager } from "./manager";
import { DAEMON_ERROR_INFO } from "./manager/base";
import { createApp } from "./http";
import { applyToManager } from "./http/connections-routes";
import { proxySocketHandlers, upgradeProxySocket, type UpgradeServer } from "./http/port-proxy";
import { readDevWebUIFile, readRegistry } from "./projects";
import { startProjectWatch } from "./project-watch";
import { materializeSettings, readSettings } from "./runtime";
import { flushPending, initConnections, pullNow, syncStatus } from "./connections";
import { daemonPort } from "./constants";
import { isCompiledBinary } from "./launch-vector";
import { parseDaemonArgs, stripFlagPair } from "./daemon-args";
import { findFreePort, isPortListening } from "./ports";
import { skipSingleInstanceGuard } from "./single-instance";
import {
  clearInstanceInfo,
  clearShutdownRequest,
  findLiveInstance,
  writeInstanceInfo,
} from "./instance";
import {
  setAutoUpdateEnabled,
  setAutoUpdateIntervalSecs,
  setUpdateNotifyEnabled,
  setAutoUpdateBroadcast,
  setAutoUpdateHooks,
  startAutoUpdate,
  stopAutoUpdate,
} from "./auto-update";
import { initFileLogging } from "./log-file.mjs";
import { dataDir } from "./data-dir";
import { openUi } from "./open-ui";
import { cleanupStaleUpdateArtifacts } from "./updater";
import {
  armCrashSentinel,
  disarmCrashSentinel,
  noteCrashReason,
  setSafeMode,
} from "./crash-sentinel";
import { authRequired, removeCookieFile, writeCookieFile } from "./local-auth";
import pkg from "../../package.json";

// ---------------------------------------------------------------------------
// CLI dispatch — must stay the FIRST side effect in this file.
//
// scripts/build.ts compiles THIS module into dist/devwebui.exe, so without this
// branch the shipped binary could only ever boot the daemon: a machine with the
// portable exe (no repo, no Bun) would have no CLI at all, and a desktop shortcut
// would have nothing to invoke. Any argv beyond the program name is handed to the
// CLI, which exits without ever starting a server.
//
// A bare launch falls through to the daemon below, unchanged — and every existing
// launcher is bare: the tray, dev.ts, and the auto-update relaunch all respawn with
// `process.argv.slice(1)`, which carries no verb (index.ts:~169).
//
// Ordering matters: this sits above initFileLogging so a one-shot CLI invocation
// doesn't tee its output into the long-running daemon's log file.
// ---------------------------------------------------------------------------
// …unless every extra token is one of the DAEMON's own flags. The auto-update relaunch has to
// pass its port and its relaunch signal as ARGUMENTS now (win32 hands the launch to WMI, which
// does not carry an environment block), and without this guard the successor would run the CLI,
// print something, and exit — an applied update leaving ZERO daemons. parseDaemonArgs is
// all-or-nothing, so every existing CLI invocation still lands in the branch below untouched.
const DAEMON_ARGS = parseDaemonArgs(process.argv.slice(2));
if (process.argv.length > 2 && DAEMON_ARGS === null) {
  const { run } = await import("./cli");
  await run(process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}
/** True when this process is the auto-update successor (flag, or the inherited env var on POSIX). */
const IS_RELAUNCH = DAEMON_ARGS?.relaunch === true || process.env.DEVWEBUI_RELAUNCH === "1";

cleanupStaleUpdateArtifacts();

const releaseDoubleClick =
  (globalThis as { __DEVWEBUI_RELEASE_BUILD__?: boolean }).__DEVWEBUI_RELEASE_BUILD__ === true &&
  !IS_RELAUNCH &&
  !process.env.DEVWEBUI_TRAY_SHUTDOWN_TOKEN;

// Persist console output to <CONFIG_DIR>/logs/daemon.log BEFORE anything else can throw, so
// the crash reason logged just below actually survives the process (the tray runs us with a
// hidden console, so without this the output would vanish). Best-effort; never throws. The
// config dir comes from dataDir() (the shared kit lib takes it as a required argument).
initFileLogging(dataDir());

// Last-resort crash handlers: an unhandled throw/rejection anywhere in the daemon logs what
// happened and exits non-zero instead of dying silently (or, for a rejection, limping on in an
// unknown state). The tray's health watchdog sees the daemon go unresponsive and relaunches it;
// the console.error above is now teed to daemon.log, so the reason is on disk even after the
// process is gone.
//
// They also take the managed children down with us. DevWebUI's core promise is that it owns
// the lifecycle of the servers it launches; exiting on a stray throw while leaving a fleet of
// orphaned dev servers holding their ports is the loudest possible way to break it, and the
// user is then hunting PIDs by hand. `killAllSync` is deliberately synchronous — these
// handlers exit immediately, so there is no event loop left to await the normal `stopAll()`.
// Assigned after the Manager is constructed below; null before that, when nothing has spawned.
let liveManager: Manager | null = null;
const killChildrenOnCrash = () => {
  try {
    const killed = liveManager?.killAllSync() ?? [];
    if (killed.length) console.error(`[devwebui] killed ${killed.length} managed process(es).`);
  } catch (e) {
    console.error("[devwebui] failed to kill managed processes during crash exit:", e);
  }
};
process.on("uncaughtException", (err) => {
  console.error("[devwebui] uncaught exception:", err);
  noteCrashReason(err); // the next boot's safe-mode banner names this
  killChildrenOnCrash();
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[devwebui] unhandled rejection:", reason);
  noteCrashReason(reason);
  killChildrenOnCrash();
  process.exit(1);
});

// Single instance: if a DevWebUI daemon is already serving, don't start a second
// one (a second would just hop to another port and confuse the launcher/MCP about
// which instance is "the" one). The dev launcher (DEVWEBUI_PORT_FIXED) and the
// auto-update successor (DEVWEBUI_RELAUNCH) are exempt; see skipSingleInstanceGuard
// for why, and single-instance.test.ts for the regression guard on that exemption.
if (!skipSingleInstanceGuard()) {
  const live = await findLiveInstance();
  if (live) {
    console.log(
      `\n  DevWebUI is already running  →  ${live.url}\n  Not starting a second instance.\n`,
    );
    if (releaseDoubleClick && process.env.DEVWEBUI_NO_OPEN !== "1") openUi(live.url);
    process.exit(0);
  }
}

/** Poll until `port` is free (the predecessor released it), up to timeoutMs. Used by the
 *  auto-update relaunch: a daemon respawned with DEVWEBUI_RELAUNCH=1 waits for its predecessor
 *  to free the preferred port so it rebinds the SAME port — an open browser tab's SSE then
 *  reconnects seamlessly instead of the daemon hopping to a port the tab can't reach. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Pick a port the same way we treat the dev servers we manage: prefer the
// configured one, but if it's busy (a stale daemon, or anything else holding it)
// move to the next free port instead of crashing on bind. The chosen port is
// published to ~/.devwebui/runtime.json so the launcher opens the right URL.
// `--port` from our predecessor wins: it is the port actually being SERVED, where daemonPort()
// is only the configured preference, and those diverge for good after a single hop.
const DESIRED_PORT = DAEMON_ARGS?.port ?? daemonPort();
// A daemon relaunched by the auto-updater (DEVWEBUI_RELAUNCH=1) waits for its predecessor to
// free the preferred port BEFORE probing/binding, so it rebinds the SAME port.
if (IS_RELAUNCH) await waitForPortFree(DESIRED_PORT, 8000);
// Normally probe for a free port and hop if the preferred one is busy. The dev
// launcher (server/src/dev.ts) instead RESERVES a free port up front and pins it
// via DEVWEBUI_PORT_FIXED so the daemon and the Vite proxy bind the same port —
// in that case bind it directly (a second probe could diverge from Vite's target).
const PORT =
  process.env.DEVWEBUI_PORT_FIXED === "1" ? DESIRED_PORT : await findFreePort(DESIRED_PORT);

materializeSettings(); // write the full settings file (incl. editable osSkip lists) on first run
const manager = new Manager();
liveManager = manager; // arm the crash handlers registered above
const startupSettings = readSettings();
manager.globalRuntime = startupSettings.runtime;
manager.freePortOnStart = startupSettings.freePortOnStart;
manager.monitorResources = startupSettings.monitorResources;
manager.applyMonitorResources(); // honour the saved toggle (constructor starts it on by default)
// Auto-update: opt-in (it restarts the daemon) → absent/false = off. Prime the runtime flags now;
// the timer itself only STARTS after boot (startAutoUpdate below), one interval out.
setAutoUpdateEnabled(startupSettings.autoUpdate === true);
setAutoUpdateIntervalSecs(startupSettings.autoUpdateIntervalSecs);
// Update-notify: the opposite default — absent/true = on. It only announces (SSE
// `update_available`), so the check timer runs even when auto-update stays off.
setUpdateNotifyEnabled(startupSettings.updateNotify !== false);

// Crash sentinel (server/src/crash-sentinel.ts): a run file left by a daemon that never reached
// shutdown() means it crashed, and the tray will keep reviving us into the same crash if boot
// auto-starts whatever caused it. So that boot, or one launched with --safe-mode /
// DEVWEBUI_SAFE_MODE=1, is SAFE MODE: projects load, nothing auto-starts, and the GUI offers
// "Leave safe mode". The dev launcher is exempt: `bun --watch` hard-restarts the daemon on every
// save, and each of those would otherwise read as a crash.
const previousCrash = process.env.DEVWEBUI_PORT_FIXED === "1" ? null : armCrashSentinel();
const safeModeRequested = DAEMON_ARGS?.safeMode === true || process.env.DEVWEBUI_SAFE_MODE === "1";
const SAFE_MODE = safeModeRequested || previousCrash !== null;
if (SAFE_MODE) {
  const crashFingerprint = previousCrash
    ? manager.recordDaemonCrash(previousCrash.reason ?? null)
    : null;
  setSafeMode({
    active: true,
    trigger: previousCrash ? "crash" : "requested",
    crashedRunStartedAt: previousCrash?.startedAt || null,
    reason: previousCrash?.reason ?? null,
    crashProcessId: crashFingerprint ? DAEMON_ERROR_INFO.processId : null,
    crashFingerprint,
  });
  console.warn(
    `[devwebui] SAFE MODE (${previousCrash ? "the previous run did not shut down cleanly" : "requested"}): no process will auto-start.`,
  );
}

// Auto-load every remembered .devwebui file. Only auto-START them when the user has
// opted in (autoStartOnLaunch) — otherwise a daemon boot would stampede every server.
let loaded = 0;
for (const file of readRegistry()) {
  try {
    manager.addProject(readDevWebUIFile(file), {
      autostart: startupSettings.autoStartOnLaunch && !SAFE_MODE,
    });
    loaded += 1;
  } catch (e) {
    console.error(`[devwebui] skipping ${file}: ${(e as Error).message}`);
  }
}

// Auto-update continuity: our predecessor handed us the ids it had RUNNING when it stepped
// aside (see the relaunch hook below). Applying an update otherwise silently took every dev
// server down and left it down, because the successor only auto-starts when the separate
// `autoStartOnLaunch` setting happens to be on — so the one feature whose whole promise is
// "update without you noticing" was the one that stopped your work. Resume exactly that set,
// nothing more: processes the user had stopped stay stopped.
const resumeIds = DAEMON_ARGS?.resume.length
  ? DAEMON_ARGS.resume
  : (process.env.DEVWEBUI_RELAUNCH_RESUME ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
if (IS_RELAUNCH && resumeIds.length && !SAFE_MODE) {
  manager.startProcesses(resumeIds);
  console.log(`[devwebui] resuming ${resumeIds.length} process(es) after auto-update.`);
}

// That loop is the ONLY time a project's file is read at boot, and the daemon outlives
// any edit — so from here on, watch each loaded file and re-read it when it changes.
// Without this, a `.devwebui` edit stays invisible until the daemon restarts: the GUI
// renders what the daemon holds, so reloading the browser can't surface it.
const projectWatcher = startProjectWatch(manager);

// Advertise where we actually landed, then keep it tidy on a clean exit. (A hard
// kill skips this; readers re-validate the pointer with /api/health, so a stale
// file is harmless.) `portableMode`/`hideTrayIcon` ride along as launcher-facing
// extras so the tray can decide app-window vs. tab and icon visibility without a
// round-trip to the daemon.
writeInstanceInfo(PORT, {
  portableMode: startupSettings.portableMode === true,
  hideTrayIcon: startupSettings.hideTrayIcon === true,
});
// Clear any stale "full shutdown" sentinel left by a previous (possibly hard-killed) run so a
// leftover can't make a freshly-launched tray quit the instant it starts. Only a genuine
// in-session UI shutdown (the /api/shutdown route) writes a fresh one; the tray watches for it.
clearShutdownRequest();
// The cookie file the CLI and MCP shim authenticate with; a fresh secret every boot, removed on a
// clean exit (a hard kill leaves a stale one, which the next boot overwrites). Best-effort: without
// it only an enforcing daemon is affected, and that one then refuses the CLI instead of not booting.
try {
  writeCookieFile();
} catch (e) {
  console.error(`[devwebui] could not write the auth cookie file: ${(e as Error).message}`);
}
const cleanup = () => {
  clearInstanceInfo();
  removeCookieFile();
};
process.on("exit", cleanup);

let shuttingDown = false;
async function shutdown(exitCode = 0, exitDelayMs = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Disarm FIRST: an orderly stop is not a crash even when it is cut short. The tray's Quit
  // bounds its graceful POST at 3s and then force-kills, while the settings flush below may take
  // up to 6s, so disarming at the end would put the next launch in safe mode after a plain Quit.
  disarmCrashSentinel();
  let code = exitCode;
  try {
    await Promise.race([
      flushPending().catch((error) => {
        console.error(
          `[devwebui] final settings sync failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
    ]);
    cleanup();
    stopAutoUpdate();
    projectWatcher.stop();
    await manager.stopAll();
  } catch (e) {
    console.error(`[devwebui] clean shutdown failed: ${(e as Error).message}`);
    if (code === 0) code = 1;
  } finally {
    manager.dispose();
    setTimeout(() => process.exit(code), exitDelayMs);
  }
}

// SIGHUP too: a closed console or ended session is an orderly stop, and letting it kill us
// without shutdown() would leave the crash sentinel armed and boot the next launch in safe mode.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    void shutdown(0);
  });

const app = createApp(manager, {
  shutdownToken: process.env.DEVWEBUI_TRAY_SHUTDOWN_TOKEN,
  requireAuth: authRequired(),
  requestShutdown: () => shutdown(0, 250),
  port: PORT,
});
if (authRequired())
  console.log(
    "[devwebui] local API auth is ON: /api needs the cookie file (CLI/MCP) or a paired browser.",
  );

// Auto-update loop (opt-in; see server/src/auto-update.ts). When it applies an update it must
// restart the daemon ITSELF — the tray is a bare supervisor that never relaunches us. So hand it a
// relaunch that spawns a DETACHED copy of this exact launch command (DEVWEBUI_RELAUNCH=1 so the
// successor waits for our port), then gracefully shuts THIS daemon down to free the port. Its
// broadcast is wired to the Manager's EventEmitter so registerRealtime relays it out over SSE
// exactly like every other manager event.
setAutoUpdateBroadcast((event, data) => manager.emit("autoUpdate", { event, data }));
setAutoUpdateHooks({
  relaunch: () => {
    // Snapshot what's running BEFORE we shut down, and hand it to the successor so the
    // update doesn't leave the user's fleet stopped. Env var rather than a file: nothing
    // to clean up, nothing to go stale, and it dies with the process if the spawn fails.
    const resume = manager.runningIds();
    try {
      // daemonLaunchVector(), NOT process.argv[0..1]. Inside a `bun build --compile` binary
      // process.argv is the placeholder pair ["bun", "B:/~BUN/root/devwebui.exe"] — argv[0] is the
      // literal string "bun" (not a path) and argv[1] is a virtual path that exists only inside the
      // running binary's own filesystem. Respawning that pair fails with `Module not found
      // "B:/~BUN/root/devwebui.exe"` on a machine that has Bun, and cannot resolve "bun" at all on
      // the machines this exe exists FOR. The spawn itself still "succeeds" (the child starts and
      // then dies), so the catch below never fires and we shut down 800ms later believing a
      // successor is coming up — an applied update leaving ZERO daemons. launch-vector.ts already
      // owns this exact question for the CLI and shortcuts; the relaunch just never asked it.
      // The resume list is recomputed every generation, so any inherited one is stripped before
      // the fresh one is appended — otherwise the successor's argv (which is the NEXT
      // generation's input) would grow a stale pair on every update.
      // --safe-mode is dropped too: the update may be the fix, and a successor that crashes
      // again is caught by its own crash sentinel.
      const inherited = stripFlagPair(process.argv, "--resume").filter((a) => a !== "--safe-mode");
      const relaunchArgv = buildRelaunchArgv(inherited, {
        execPath: process.execPath,
        isCompiled: isCompiledBinary(),
        boundPort: PORT,
      });
      if (resume.length) relaunchArgv.push("--resume", resume.join(","));
      // Through buildDetachedSpawn, not a plain spawn. `detached: true` is NOT a process-tree
      // escape on Windows — the shared primitive's own header says so, and that is the reason it
      // exists. Left as a plain spawn the successor stays inside THIS process's tree for the whole
      // ~800ms handoff, so a tray Quit (`taskkill /T /F`) landing in that window kills the outgoing
      // daemon AND its replacement, leaving the user with none. Going through WMI is also why the
      // port, the relaunch signal and the resume list ride as FLAGS: it carries no environment.
      // hideWindow: the successor is a CONSOLE program - without ShowWindow=0 every auto-update relaunch pops a visible console hosting the daemon (kit fix 2026-08-30).
      const plan = buildDetachedSpawn(process.platform, relaunchArgv, { hideWindow: true });
      const child = spawn(plan.argv[0] as string, plan.argv.slice(1), {
        cwd: process.cwd(),
        detached: plan.detached,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          DEVWEBUI_RELAUNCH: "1",
          DEVWEBUI_RELAUNCH_RESUME: resume.join(","),
          DEVWEBUI_SAFE_MODE: "0",
          // The port we are actually SERVING on, not the one we preferred. DESIRED_PORT is
          // daemonPort() (config/env); PORT is where findFreePort actually landed, and they diverge
          // for every daemon that has ever hopped. The successor derives BOTH its waitForPortFree()
          // target and its bind from DEVWEBUI_PORT, so without this it waits out the full 8s on a
          // port its predecessor never held and then binds that port — relocating the app away from
          // whatever port the user's open tab is talking to. Pinning it here also means a daemon
          // that hopped once STAYS on the hopped port across updates instead of drifting back.
          DEVWEBUI_PORT: String(PORT),
        },
      });
      child.unref();
    } catch (e) {
      console.error(
        "[devwebui] auto-update relaunch failed to spawn — staying on the running version.",
        e,
      );
      return; // never shut down without a successor
    }
    console.log("[devwebui] auto-update applied — relaunching the daemon…");
    setTimeout(() => void shutdown(0), 800); // let the successor start, then free the port
  },
});
startAutoUpdate();

// "Sync my settings with Connections" — load the persisted refresh token, then (if the owner
// enabled sync) pull the cloud copy in the BACKGROUND so a fresh machine converges without
// blocking boot on the network; a landed pull is applied to the live manager.
initConnections();
if (syncStatus().enabled) {
  void pullNow()
    .then(({ applied }) => applied && applyToManager(manager, applied))
    .catch(() => {}); // best-effort boot converge — boot must not block on the network; a failed
  // pull just leaves local settings in place until the next sync attempt
}

const moved = PORT !== DESIRED_PORT ? `  (port ${DESIRED_PORT} was busy)` : "";
const modeLine = SAFE_MODE ? "\n  mode            →  SAFE MODE (auto-start skipped)" : "";
console.log(`
  DevWebUI daemon  →  http://localhost:${PORT}${moved}
  loaded          →  ${loaded} project(s) from registry${modeLine}
`);

const bunRuntime = (
  globalThis as unknown as {
    Bun: {
      serve(options: {
        hostname: string;
        port: number;
        fetch: (
          request: Request,
          server: UpgradeServer,
        ) => Response | Promise<Response> | undefined;
        websocket: typeof proxySocketHandlers;
        idleTimeout: number;
      }): { port: number };
    };
  }
).Bun;
const server = bunRuntime.serve({
  // LOOPBACK ONLY, and not optional. Bun.serve defaults to 0.0.0.0 when `hostname` is
  // omitted, which put the daemon on every interface — reachable from anything sharing the
  // network. The API is unauthenticated by design (single-user, own machine) and the CSRF
  // guard in loopback-guard.mjs explicitly assumes this bind: it trusts any request without
  // browser provenance headers, so a LAN client only had to send `Host: 127.0.0.1` to drive
  // every mutating route, including the ones that spawn configured commands. Binding
  // loopback is what makes that guard's threat model true. See tests/bind-address.test.ts.
  hostname: "127.0.0.1",
  port: PORT,
  // A WebSocket upgrade addressed to a managed `<target>.localhost` (a dev server's HMR socket)
  // must be taken here, before Hono; see http/port-proxy.ts. Everything else is the app.
  fetch: (request, srv) =>
    upgradeProxySocket(request, srv, manager, PORT) ? undefined : app.fetch(request, srv),
  websocket: proxySocketHandlers,
  idleTimeout: 255, // keep SSE connections alive (Bun max)
});

// Tray icon: a compiled release exe embeds the tray toolkit (scripts/build.ts's
// __DEVWEBUI_EMBEDDED_TRAY__) but nothing ever unpacked or started it — every kit app shipped a
// compiled exe that could never show its icon, and each README wrote that down as a known
// limitation (found live 2026-09-11). materializeTrayToolkit()/startTrayHostIfMissing() are the
// shared kit primitive (server/src/tray-bootstrap.mjs) that actually closes that gap.
const embeddedTray =
  (globalThis as { __DEVWEBUI_EMBEDDED_TRAY__?: Readonly<Record<string, string>> })
    .__DEVWEBUI_EMBEDDED_TRAY__ ?? null;
const compiled = isCompiledBinary();
const appRoot = compiled
  ? dirname(process.execPath)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tray = await materializeTrayToolkit({
  appRoot,
  compiled,
  stateDir: dataDir(),
  version: pkg.version,
  exePath: process.execPath,
  configFile: "DevWebUI-Tray.json",
  iconFile: "DevWebUI.ico",
  embedded: embeddedTray,
});
if (tray.wrote.length) {
  console.log(`[devwebui] placed the tray toolkit in ${tray.dir} (${tray.wrote.join(", ")})`);
}
void startTrayHostIfMissing({
  appRoot,
  compiled,
  configFile: "DevWebUI-Tray.json",
  hideTray: () => readSettings().hideTrayIcon === true,
  toolkitDir: tray.dir,
})
  .then((r) => {
    if (r.start) console.log(`[devwebui] started the tray host (${r.exe}) - nothing else had`);
  })
  .catch((e) => console.error("[devwebui] tray host start failed:", e));

if (releaseDoubleClick && process.env.DEVWEBUI_NO_OPEN !== "1") {
  const url = `http://127.0.0.1:${server.port}/`;
  if (!openUi(url))
    console.error(`[devwebui] Could not open a browser automatically. Open ${url} manually.`);
}
