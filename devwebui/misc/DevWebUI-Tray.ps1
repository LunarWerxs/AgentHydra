# DevWebUI system-tray host (Windows). Thin adapter over the shared Tray-Host engine
# (misc/Tray-Host.ps1). This file owns only what's genuinely app-specific: names,
# paths, the daemon start command, and a few documented behavior tweaks. Everything
# else -- mutex/tray lifecycle, watchdog, rebuild/restart worker, hide-tray live-sync,
# open path, full-shutdown sentinel -- lives in the shared engine.
#
# Launch it via Tray-Launch.vbs (which auto-discovers the sibling *-Tray.ps1 and runs it
# hidden) so there's no console flash; the port comes from this file's own param() default,
# not the .vbs. The daemon serves the built GUI + API on one port. The shortcut launches
# FAST with the existing build; use the tray's "Rebuild & Restart" to rebuild from source.
param([int]$Port = 4000, [switch]$SelfTest)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir
Set-Location $root

# Drag-and-drop: Tray-Launch.vbs (shared engine) puts any paths dropped onto the .lnk into
# LUNARWERX_TRAY_DROP ('|'-joined). A FOLDER is scanned and its projects/dev-servers ADDED; a
# .devwebui file is loaded and STARTED. Each is handed to the `devwebui open` CLI verb
# (server/src/cli.ts), which boots the daemon if needed. A drop is an ACTION on a project, not a
# request to sit in the tray, so we do the action(s) and exit — matching the existing per-project
# and per-process desktop shortcuts, which also don't raise a tray icon.
if ($env:LUNARWERX_TRAY_DROP) {
  $dropped = $env:LUNARWERX_TRAY_DROP
  $env:LUNARWERX_TRAY_DROP = $null  # don't leak it into any daemon we spawn
  foreach ($p in $dropped.Split('|')) {
    if ([string]::IsNullOrWhiteSpace($p)) { continue }
    # Same daemon binary as StartCommand below (cmd.exe /c so bun's PATHEXT shim resolves); hidden
    # + fire-and-forget so several drops don't block each other.
    Start-Process -FilePath "cmd.exe" `
      -ArgumentList @("/c", "bun server\src\index.ts open `"$p`"") `
      -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  }
  exit 0
}

# Config dir honours DEVWEBUI_HOME (matches server/src/data-dir.ts), else ~/.devwebui — so
# the runtime pointer + crash-log + sentinel paths the engine reads always track wherever
# the daemon actually writes.
$dwHome = if ($env:DEVWEBUI_HOME) { $env:DEVWEBUI_HOME } else { Join-Path $env:USERPROFILE ".devwebui" }

$TrayConfig = @{
  DisplayName          = "DevWebUI"
  ServiceName          = "devwebui"                            # /api/health stamps this; the tray requires it to match
  IconFile             = "DevWebUI.ico"
  Port                 = $Port
  UrlHost              = "localhost"
  InfoFile             = Join-Path $dwHome "runtime.json"
  DaemonLogPath        = Join-Path $dwHome "logs\daemon.log"

  # Daemon launch: cmd.exe /c so bun's PATHEXT shim resolves; engine substitutes {PORT}.
  StartCommand         = "bun server/src/index.ts"
  PortEnvVar           = "DEVWEBUI_PORT"
  EntryFile            = "server\src\index.ts"

  # First run only (cold start, blocking, tray icon already visible): install deps and
  # build the GUI if there's no build yet. Subsequent launches use the existing build;
  # "Rebuild & Restart" is the on-demand path.
  FirstRun             = {
    param($appRoot)
    if (-not (Test-Path (Join-Path $appRoot "node_modules"))) { & cmd.exe /c "bun install" | Out-Null }
    if (-not (Test-Path (Join-Path $appRoot "web\dist"))) { & cmd.exe /c "bun run build" | Out-Null }
  }

  # "Rebuild & Restart" rebuilds the GUI from SOURCE — a developer convenience so UI edits
  # show up without a manual build. Public/end users get a prebuilt web\dist and no
  # server\src tree (or necessarily bun) to build with, so this is gated by IsDevTree
  # below; end users do their own rebuilds with the standalone misc\rebuild_devwebui.bat instead.
  RebuildCommand       = "bun run build"
  RebuildLogName       = "DevWebUI-Rebuild.log"

  # Dev-only gate for the "Rebuild & Restart" menu item: a distributed build ships a
  # prebuilt web\dist and no server\src tree to rebuild from, so offering that menu item
  # there would just fail. Shows ONLY when DEVWEBUI_DEV=1 is explicitly set — public users,
  # including source-checkout users, never see it; devs opt in with DEVWEBUI_DEV=1 or use
  # the standalone misc\rebuild_devwebui.bat instead.
  IsDevTree            = ($env:DEVWEBUI_DEV -eq "1")

  # Full-shutdown sentinel: the daemon drops this when a user picks "Shut Down" in the web
  # UI (or runs `devwebui stop`) — a request to terminate the WHOLE app, this tray
  # included. The engine polls for it and reuses Quit's teardown so the watchdog doesn't
  # resurrect the daemon the user just stopped. Cleared at startup by the engine.
  SentinelFile         = Join-Path $dwHome "shutdown.request"

  # Shutdown protocol: HTTP token, graceful-first then port-sweep fallback (not a force-kill
  # app). The daemon only honours a shutdown POST bearing the token it was spawned with.
  ShutdownTokenEnvVar  = "DEVWEBUI_TRAY_SHUTDOWN_TOKEN"
  ShutdownHeaderPrefix = "x-devwebui"

  # A live daemon without our tray is adopted (host a tray for it, don't spawn a second
  # daemon, leave it running at Quit) rather than treated as an orphan to refuse.
  OnStrayDaemon        = "attach"

  # Portable-window sizing (engine: Open-AppUi). First-run size = the daemon's measured
  # DASHBOARD_WINDOW_SIZE (shared/constants.ts — the layout hard-caps content at
  # --container-max = 800px, so 840 outer; 760 tall fits the top bar + 13 process rows),
  # so a COLD tray start (tray boots the daemon and opens the window itself, before the
  # daemon's own POST /api/portable-window path exists) stops opening a never-seen
  # profile at ~the whole work area. The hint opt-in is safe here because this web build
  # applies ?window-size via resizeTo (web/src/lib/window-size-hint.ts) — the only fix
  # that reaches a forwarded launch (a window already open on the profile).
  PortableWindowSize     = @{ Width = 840; Height = 760 }
  PortableWindowSizeHint = $true

  # Tray "Stop all processes" — the same POST the web UI's More menu and `devwebui stop-all`
  # make (shared/routes.ts stopAll). Labelled "processes" rather than the web UI's bare "Stop
  # all" because in a tray menu that also holds Restart and Quit, "Stop all" reads as "stop
  # DevWebUI itself"; this stops every managed dev server and LEAVES the daemon running.
  # /api/* is unauthenticated on loopback (loopback-guard.mjs only blocks browser cross-site
  # requests), so the tray needs no token for it — unlike /api/shutdown.
  ActionPath           = "/api/processes/stop-all"
  ActionLabel          = "Stop all processes"
  ActionOkText         = "All managed processes stopped."
  ActionFailText       = "Couldn't stop everything - open {APP} to check."

  SelfTestMarker       = "DEVWEBUI_TRAY_SELFTEST"
  MenuOpenLabel        = "Open DevWebUI"
  MutexName            = "DevWebUITrayHost"

  # OLD standalone script waited 12s (Wait-ForUrl ... 12000) for the daemon to bind on cold
  # start before opening the browser. Pin it so the shared engine's 15s family default doesn't
  # silently change this app's cold-start timing. (Hide-tray icon re-sync intentionally rides
  # the engine's 5s health-timer cadence, family-standard — a deliberate consistency choice.)
  StartupWaitSec       = 12

  ScriptDir            = $scriptDir
  Root                 = $root
}

. (Join-Path $scriptDir "Tray-Host.ps1")

if ($SelfTest) {
  Invoke-TrayHostSelfTest $TrayConfig
} else {
  Start-TrayHost $TrayConfig
}
